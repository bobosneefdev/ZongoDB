import * as mongoDB from 'mongodb';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { ZongoLog } from './logger';
import { ZongoUtil } from './util';
import { ZodUtil } from '@bobosneefdev/zodutil';
import { kZongoEnv } from './env';

type ZongoTransformation<T extends z.ZodTypeAny> = (value: z.infer<T>) => z.infer<T>;

type ZongoTransformHelperReturn<T extends z.ZodTypeAny> = {
    previous: z.infer<T>;
    updated: Record<"$set" | "$unset", Record<string, any>>;
    new: z.infer<T>;
    result: mongoDB.UpdateResult<z.infer<T>>;
};

type ZongoTransformStandardReturn = {
    notAcknowledgedCount: number,
    matchedCount: number,
    modifiedCount: number
};

type ZongoTransformDetailedReturn<T extends z.ZodTypeAny> = {
    detailed: Array<ZongoTransformHelperReturn<T>>
} & ZongoTransformStandardReturn;


type AddObjectIdToObject<T extends Object> = T & {
    _id: mongoDB.ObjectId;
}

export class ZongoDB<T extends Readonly<Record<string, z.ZodObject<any>>>> {
    readonly name: string;
    readonly schemas: T;
    readonly client: mongoDB.MongoClient;
    readonly db: mongoDB.Db;
    readonly flattenedSchemas: Readonly<Record<keyof T, Readonly<Record<string, z.ZodTypeAny>>>>;
    private collections: Readonly<Record<keyof T, mongoDB.Collection>>;
    private defaultBackupDir: string;
    private warningMessagesSent: Record<string, number> = {};
    private collectionsWithOptionalFields: Set<keyof T> = new Set();
    private transactionsSupported: boolean | null = null;

    constructor(
        name: string,
        schemas: T,
        opts?: {
            mongoUri?: string;
            mongoClientOpts?: mongoDB.MongoClientOptions;
            mongoDbOpts?: mongoDB.DbOptions;
            initIndexes?: Partial<Record<
                keyof T,
                Array<{
                    index: Record<string, mongoDB.IndexDirection>,
                    options?: mongoDB.CreateIndexesOptions
                }>
            >>;
        }
    ) {
        this.name = name;
        for (const schema of Object.values(schemas)) {
            if ("_id" in schema.shape) {
                throw new Error("Schema cannot contain MongoDB protected _id field!");
            }
        }
        this.schemas = schemas;
        this.flattenedSchemas = this.createSchemaPathMap(schemas);
        this.client = new mongoDB.MongoClient(
            opts?.mongoUri ?? "mongodb://localhost:27017",
            {
                minPoolSize: 6,
                maxPoolSize: 10,
                ...opts?.mongoClientOpts,
            }
        );
        this.db = this.client.db(name, opts?.mongoDbOpts);
        this.collections = Object.entries(schemas).reduce(
            (acc, [key, schema]) => {
                acc[key as keyof T] = this.db.collection<z.infer<typeof schema>>(key);
                return acc;
            },
            {} as Record<keyof T, mongoDB.Collection>
        );
        for (const [collection, schema] of Object.entries(schemas)) {
            if (ZongoUtil.verifySchemaAndCheckIfUndefinedCanExist(schema)) {
                this.collectionsWithOptionalFields.add(collection as keyof T);
            }
        }
        this.defaultBackupDir = path.join(kZongoEnv.get("ZONGO_BACKUP_DIR"), name);
        ZongoLog.debug(`Constructed database "${name}"`);
        if (opts?.initIndexes) {
            const now = Date.now();
            Promise.all(
                Object.entries(opts.initIndexes).reduce(
                    (p, [collection, params]) => {
                        if (params) {
                            p.push(...params.map(p => this.createIndex(collection, p.index, p.options)));
                        }
                        return p;
                    },
                    [] as Promise<void>[]
                )
            ).then(
                _ => ZongoLog.debug(`Initialized indexes for database "${name}" in ${Date.now() - now}ms`),
                err => {
                    ZongoLog.error(`Failed to initialize indexes for database "${name}":`, err);
                }
            );
        }
    }

    /**
     * Closes mongoClient connection.
     * @param force - If true, forcefully closes the connection.
     * */
    async close(force?: boolean) {
        await this.client.close(force);
    }

    async insertOne<K extends keyof T & string>(
        collection: K,
        doc: z.infer<T[K]>,
        opts?: mongoDB.InsertOneOptions
    ) {
        return await this.collections[collection].insertOne(
            await this.removeUndefinedValuesAndParse(collection, doc),
            opts
        );
    }

    async insertMany<K extends keyof T & string>(
        collection: K,
        docs: Array<z.infer<T[K]>>,
        opts?: mongoDB.BulkWriteOptions
    ) {
        return await this.collections[collection].insertMany(
            await Promise.all(docs.map(async (doc) => this.removeUndefinedValuesAndParse(collection, doc))),
            opts
        );
    }

    /**
     * Transform the data within a document.
     * @param collection - Name of the collection to insert to.
     * @param query - Path/values to match the document to.
     * @param update - Transformations to apply to given paths
     * @param opts.maxRetries - Maximum number of retries if document changes. Defaults to 3.
     * @returns null if no document found
     */
    async transformOne<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>,
        transformation: ZongoTransformation<T[K]>,
        opts?: { maxRetries?: number }
    ): Promise<ZongoTransformHelperReturn<T[K]> | null> {
        return await this.transform(collection, query, transformation, opts);
    }

    /**
     * Transform the data within a document.
     * @param collection - Name of the collection to insert to.
     * @param query - Path/values to match the document to.
     * @param update - Transformations to apply to given paths.
     * @param opts.detailed - Whether the function returns the full array of changed datas instead of number of changed docs. False by default.
     * @param opts.maxRetries - Maximum number of retries if document changes. Defaults to 3.
     */
    async transformMany<
        K extends keyof T & string,
        O extends {
            detailed?: boolean;
            maxRetries?: number;
        }
    >(
        collection: K,
        query: Record<string, any>,
        transformation: ZongoTransformation<T[K]>,
        opts?: O,
    ): Promise<
        O["detailed"] extends true ?
            ZongoTransformDetailedReturn<T[K]> :
            ZongoTransformStandardReturn
    > {
        const detailedResult = [];
        const standardResult = {
            notAcknowledgedCount: 0,
            matchedCount: 0,
            modifiedCount: 0,
        };
        const verifiedQuery = await this.getVerifiedQuery(collection, query);
        const cursor = this.collections[collection].find(verifiedQuery);
        
        // Collect document IDs first to avoid cursor issues during updates
        const documentIds: mongoDB.ObjectId[] = [];
        for await (const document of cursor) {
            documentIds.push(document._id);
        }
        
        // Process each document with atomic transform (includes optimistic locking)
        for (const docId of documentIds) {
            try {
                const result = await this.transform(
                    collection, 
                    { "_id": docId }, 
                    transformation,
                    { maxRetries: opts?.maxRetries }
                );
                
                if (result) {
                    if (opts?.detailed === true) {
                        detailedResult.push(result);
                    }
                    if (!result.result.acknowledged) {
                        standardResult.notAcknowledgedCount++;
                    }
                    standardResult.matchedCount += result.result.matchedCount;
                    standardResult.modifiedCount += result.result.modifiedCount;
                }
            } catch (error) {
                // Log the error but continue with other documents
                ZongoLog.error(`Failed to transform document ${docId}:`, error);
                // Don't continue if it's a schema validation error, as it will likely affect all documents
                if (error instanceof Error && (
                    error.message.includes('ZodError') || 
                    error.message.includes('Path') ||
                    error.message.includes('does not exist')
                )) {
                    throw error;
                }
                // For retry exhaustion errors, also continue with other documents
                // but log a warning that this specific document couldn't be transformed
                if (error instanceof Error && error.message.includes('retries due to concurrent modifications')) {
                    ZongoLog.warn(`Document ${docId} could not be transformed due to high contention`);
                }
            }
        }
        
        return (opts?.detailed === true ?
            {
                detailed: detailedResult,
                ...standardResult,
            } :
            standardResult
        ) as any;
    }

    /**
     * @param collection - Name of the collection to transform.
     * @param query - Path/values to match the document to.
     * @param transformations - Transformations to apply to given paths
     * @param opts.maxRetries - Maximum number of retries if document changes. Defaults to 3.
     * @returns null if no document found
     */
    async transform<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>,
        transformation: ZongoTransformation<T[K]>,
        opts?: {
            maxRetries?: number,
            nonAtomic?: true,
        }
    ): Promise<ZongoTransformHelperReturn<T[K]> | null> {
        const maxRetries = opts?.maxRetries ?? 3;
        let attempt = 0;
        
        while (attempt <= maxRetries) {
            const verifiedQuery = await this.getVerifiedQuery(collection, query);
            const document = await this.collections[collection].findOne(verifiedQuery);
            if (!document) return null;
            
            // Create a copy of the document for parsing (remove _id)
            const doc: mongoDB.OptionalId<mongoDB.BSON.Document> = { ...document };
            delete doc._id;
            const previous = await this.schemas[collection].parseAsync(doc);
            
            const setAndUnset = await this.getSafeSetAndUnset(collection, transformation(previous));
            
            // Use optimistic locking: update only if the document hasn't changed
            // Query with the complete original document to ensure atomicity
            const updateQuery = opts?.nonAtomic ? { _id: document._id } : { ...document };
            
            const result = await this.collections[collection].findOneAndUpdate(
                updateQuery,
                setAndUnset,
                { 
                    returnDocument: 'after',
                    includeResultMetadata: true
                }
            );
            
            if (result.value) {
                // Success - document was updated
                const updateResult: mongoDB.UpdateResult = {
                    acknowledged: true,
                    matchedCount: 1,
                    modifiedCount: result.lastErrorObject?.updatedExisting ? 1 : 0,
                    upsertedCount: 0,
                    upsertedId: null
                };
                
                return {
                    updated: setAndUnset,
                    previous: previous,
                    result: updateResult,
                    new: result.value,
                };
            }
            
            // Document was modified by another operation - retry if attempts remain
            attempt++;
            if (attempt <= maxRetries) {
                // Brief delay before retry to reduce contention
                await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
            }
        }
        
        // Max retries exceeded - document keeps being modified
        throw new Error(`Transform operation failed after ${maxRetries} retries due to concurrent modifications`);
    }

    /**
     * Update document in the collection.
     * @param collection - Name of the collection to update.
     * @param query - Query to find the document to update. If a nested path is used, Zongo will automatically add necessary $exists operators for the parent paths.
     * @param update - Data to update, must be complete document if using upsert.
     * @param opts.upsert - If true, insert a new document if no document matches the query. Full document required.
     * @returns Document changed count, or null on failure.
     * @throws If zod parsing fails for the query, update, or existing document (if using transform type), or if upsert is attempted on incomplete document.
     */
    async updateOne<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>,
        update: Record<string, any>,
        opts?: {
            upsert?: boolean;
        }
    ): Promise<mongoDB.UpdateResult> {
        return await this.update(
            collection,
            query,
            update,
            "updateOne",
            opts
        );
    }

    /**
     * Update documents in the collection.
     * @param collection - Name of the collection to update.
     * @param query - Query to find the document to update. If a nested path is used, Zongo will automatically add necessary $exists operators for the parent paths.
     * @param update - Data to update, must be complete document if using upsert.
     * @param opts.upsert - If true, insert a new document if no document matches the query.
     * @returns Documents changed count, or null on failure.
     * @throws If zod parsing fails for the query, update, or existing document (if using transform type), or if upsert is attempted on incomplete document.
     */
    async updateMany<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>,
        update: Record<string, any>,
        opts?: {
            upsert?: boolean;
        }
    ): Promise<mongoDB.UpdateResult> {
        return await this.update(
            collection,
            query,
            update,
            "updateMany",
            opts
        );
    }

    private async update<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>,
        update: Record<string, any>,
        type: "updateOne" | "updateMany",
        opts?: {
            upsert?: boolean;
        }
    ) {
        const verifiedQuery = await this.getVerifiedQuery(collection, query);
        let parsedUpdate: Record<string, any>;
        if (opts?.upsert === true) {
            const parsed = await this.schemas[collection].safeParseAsync(update);
            if (!parsed.success) {
                throw new Error(`Upsert only possible with complete document. ${parsed.error}`);
            }
            parsedUpdate = parsed.data;
        }
        else {
            parsedUpdate = {};
            for (const path in update) {
                parsedUpdate[path] = await this.getSchemaAtPath(collection, path).parseAsync(update[path]);
                this.addPathParentsToQuery(path, query);
            }
        }
        return await this.collections[collection][type](
            verifiedQuery,
            await this.getSafeSetAndUnset(collection, parsedUpdate),
            opts
        );
    }

    /**
     * Deletes a document from the collection based on the query.
     * @param collection - Name of the collection to delete from.
     * @param query - Query to find the document to delete.
     * @returns Delete result, or null on error.
     * @throws If the query has invalid paths.
     * */
    async deleteOne<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>,
        opts?: mongoDB.DeleteOptions
    ) {
        const verifiedQuery = await this.getVerifiedQuery(collection, query);
        return await this.delete(collection, verifiedQuery, "deleteOne", opts);
    }

    /**
     * Deletes a document from the collection based on the query.
     * @param collection - Name of the collection to delete from.
     * @param query - Query to find the document to delete.
     * @returns Delete result, or null on error.
     * @throws If the query has invalid paths.
     * */
    async deleteMany<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>,
        opts?: mongoDB.DeleteOptions
    ) {
        const verifiedQuery = await this.getVerifiedQuery(collection, query);
        return await this.delete(collection, verifiedQuery, "deleteMany", opts);
    }

    private async delete<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>,
        type: "deleteOne" | "deleteMany",
        opts?: mongoDB.DeleteOptions
    ) {
        this.getVerifiedQuery(collection, query);
        return await this.collections[collection][type](query, opts);
    }

    /**
     * Finds a document in the collection based on the query.
     * @param collection - Name of the collection to find in.
     * @param query - Query to find the document to return.
     * @param options - Options for the find operation.
     * @returns Zod verified document, or null if no document.
     * @throws If the query has invalid paths.
     * */
    async findOne<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>,
        options?: mongoDB.FindOptions<z.infer<T[K]>>
    ): Promise<z.infer<AddObjectIdToObject<T[K]>> | null> {
        const verifiedQuery = await this.getVerifiedQuery(collection, query);
        const result = await this.collections[collection].findOne(
            verifiedQuery,
            options,
        );
        if (!result) {
            ZongoLog.debug(`No document found for query: ${JSON.stringify(query)}`);
            return null;
        }
        return await this.getSchemaWithObjectId(collection).parseAsync(result);
    }

    /**
     * Finds documents in the collection based on the query.
     * @param collection - Name of the collection to find in.
     * @param query - Query to find the documents to return.
     * @param options - Options for the find operation.
     * @returns Zod verified documents, or null if no documents.
     * */
    async findMany<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>,
        options?: mongoDB.FindOptions<z.infer<T[K]>> & {
            maxResults?: number;
        }
    ): Promise<Array<z.infer<AddObjectIdToObject<T[K]>>> | null> {
        const verifiedQuery = await this.getVerifiedQuery(collection, query);
        const cursor = this.collections[collection].find(verifiedQuery, options);
        const docArray: Array<z.infer<AddObjectIdToObject<T[K]>>> = [];
        for await (const document of cursor) {
            docArray.push(await this.getSchemaWithObjectId(collection).parseAsync(document));
            if (options?.maxResults && docArray.length >= options.maxResults) {
                break;
            }
        }
        if (!docArray.length) {
            ZongoLog.debug(`No documents found for query: ${JSON.stringify(query)}`);
            return null;
        }
        return docArray;
    }

    /**
     * Creates index(es) on the given path for the given collection.
     * @param collection - Name of the collection to create index on.
     * @param index - Index keys (multiple to make compound index) to create on the collection.
     * @param options - Options for the index creation.
     * @throws If any index path is invalid.
     * */
    async createIndex<K extends keyof T & string>(
        collection: K,
        index: Record<string, mongoDB.IndexDirection>,
        options?: mongoDB.CreateIndexesOptions,
    ) {
        for (const key in index) {
            if (!(key in this.flattenedSchemas[collection])) {
                throw new Error(`Invalid index path "${key}" in collection ${collection}`);
            }
        }
        await this.collections[collection].createIndex(index, options);
        ZongoLog.debug(`Created index for collection ${collection}`);
    }

    /**
     * Used if you'd like to manually interact with the standard MongoDB library.
     * Proceed with caution! Nothing is stopping you from breaking your schema beyond this point.
     * */
    getRawCollection<K extends keyof T & string>(
        collection: K
    ): mongoDB.Collection<z.infer<T[K]>> {
        return this.collections[collection];
    }

    /**
     * Creates a backup of the database using mongodump.
     * @param maxBackups - Maximum number of backups to keep. Defaults to 10.
     * @param opts - Options for the backup operation.
     * @param opts.compressed - If true, compress the backup using gzip.
     * @returns success boolean
     */
    async backupDatabase(
        maxBackups = 10,
        opts?: {
            dirOverride?: string;
            compressed?: boolean;
        }
    ) {
        const all = await Promise.all(Object.keys(this.schemas).map(collection => this.backupCollection(collection, maxBackups, opts)));
        const successes = all.filter(Boolean);
        return {
            successes: successes.length,
            failures: all.length - successes.length,
        };
    }

    /**
     * Creates a backup of the collection using mongodump.
     * @param collection - Name of the collection to backup.
     * @param maxBackups - Maximum number of backups to keep. Defaults to 10.
     * @param opts - Options for the backup operation.
     * @param opts.compressed - If true, compress the backup using gzip.
     * @returns success boolean
     */
    async backupCollection<K extends keyof T & string>(
        collection: K,
        maxBackups = 10,
        opts?: {
            dirOverride?: string;
            compressed?: boolean;
        }
    ) {
        const mongoDumpAvailable = await this.checkMongoToolAvailable("mongodump");
        if (!mongoDumpAvailable) {
            ZongoLog.error(`mongodump not available!`);
            return false;
        }

        const backupPath = path.join(
            opts?.dirOverride ?? this.defaultBackupDir,
            collection,
            new Date().toISOString().replace(/:/g, "-")
        );
        fs.mkdirSync(
            backupPath,
            {
                recursive: true
            }
        );
        let cmd = `mongodump --db ${this.name} --collection ${collection} --out ${backupPath}`;
        if (opts?.compressed) {
            cmd += " --gzip";
        }

        const process = exec(cmd, async (error) => {
            if (error) {
                ZongoLog.error(`${collection}: ${error}`);
                return false;
            }
            await this.deleteOldBackups(
                collection,
                maxBackups
            );
        });

        const backupPromise = new Promise<boolean>((resolve) => {
            process.on('exit', (code) => {
                ZongoLog.info(`Backup for "${collection}" completed ${code ? `unsuccessfully with code ${code}` : "successfully"}`);
                resolve(true);
            });
            process.on('error', (error) => {
                ZongoLog.error(`Backup process error: ${error}`);
                resolve(false);
            });
        });

        return await backupPromise;
    }

    private async checkMongoToolAvailable(tool: "mongodump" | "mongorestore"): Promise<boolean> {
        return new Promise<boolean>((resolve) => exec(`${tool} --version`, (error) => resolve(!error)));
    }

    private async removeUndefinedValuesAndParse<K extends keyof T & string>(
        collection: K,
        doc: z.infer<T[K]>
    ) {
        return this.collectionsWithOptionalFields.has(collection) ?
            ZongoUtil.removeExplicitUndefined(await this.schemas[collection].parseAsync(doc)) :
            await this.schemas[collection].parseAsync(doc);
    }

    private async deleteOldBackups<K extends keyof T & string>(
        collection: K,
        maxBackups: number
    ) {
        const dir = path.join(
            this.defaultBackupDir,
            collection
        );
        if (!fs.existsSync(dir)) {
            ZongoLog.error(`Backup directory does not exist: ${dir}`);
            return 0;
        }

        const contents = fs.readdirSync(dir);
        ZongoLog.debug(`Backups: ${contents.join(', ')}`);

        let deletedCount = 0;
        if (contents.length > maxBackups) {
            const fileStats = contents.map((file) => {
                const filePath = path.join(dir, file);
                const stats = fs.statSync(filePath);
                return { file, filePath, mtime: stats.mtime };
            });

            // Sort files by modification time (oldest first)
            fileStats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

            // Get files to delete (those beyond the max backups limit)
            const filesToDelete = fileStats.slice(0, fileStats.length - maxBackups);

            // Delete the old backups
            for (const { filePath } of filesToDelete) {
                fs.rmSync(filePath, { recursive: true });
                ZongoLog.debug(`Deleted old backup: ${filePath}`);
                deletedCount++;
            }
        }
        ZongoLog.info(`Deleted ${deletedCount} old backups from collection ${collection}`);
        return deletedCount;
    }

    private addPathParentsToQuery(
        path: string,
        query: Record<string, any>
    ) {
        const parts = path.split(".");
        for (let i = 1; i < parts.length; i++) {
            const part = parts.slice(0, i).join(".");
            if (query[part] === undefined) {
                query[part] = {};
            }
            query[part].$exists = true;
        }
    }

    private getSchemaWithObjectId<K extends keyof T & string>(collection: K): z.ZodObject<AddObjectIdToObject<z.infer<T[K]>>> {
        return this.schemas[collection].extend({
            _id: z.instanceof(mongoDB.ObjectId),
        }) as any;
    }

    private async getVerifiedQuery<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>
    ) {
        const verifiedQuery: Record<string, any> = {};
        for (const [path, value] of Object.entries(query)) {
            // Handle MongoDB's _id field specially
            if (path === "_id") {
                verifiedQuery[path] = value;
                continue;
            }
            
            const schema = this.getSchemaAtPath(collection, path);
            if (value === null || value instanceof Date || typeof value !== "object") {
                verifiedQuery[path] = await schema.parseAsync(value);
            }
            else {
                if (!this.warningMessagesSent["queryObjectValidationWarning"]) {
                    ZongoLog.warn(`ZongoDB does not currently verify query objects with mongoDB methods, but they will still work.`);
                    this.warningMessagesSent["queryObjectValidationWarning"] = 1;
                }
                verifiedQuery[path] = value;
            }
        }
        return verifiedQuery;
    }

    private async getSafeSetAndUnset<K extends keyof T & string>(
        collection: K,
        data: Record<string, any>
    ) {
        const {$set, $unset} = ZongoUtil.getSetAndUnset(data);
        for (const key in $set) {
            $set[key] = await this.getSchemaAtPath(collection, key).parseAsync($set[key]);
        }
        for (const key in $unset) {
            $unset[key] = await this.getSchemaAtPath(collection, key).parseAsync(undefined);
        }
        return { $set, $unset };
    }

    private getSchemaAtPath<K extends keyof T & string>(
        collection: K,
        path: string
    ) {
        if (!this.flattenedSchemas[collection][path]) {
            throw new Error(`Path "${path}" does not exist in collection "${collection}"`);
        }
        return this.flattenedSchemas[collection][path];
    }

    private createSchemaPathMap(schemas: T): Record<keyof T, Record<string, z.ZodType<any>>> {
        const result = Object.keys(schemas).reduce(
            (p, c: keyof T) => {
                p[c] = {};
                return p;
            },
            {} as Record<keyof T, Record<string, z.ZodType<any>>>
        );
        for (const [collection, schema] of Object.entries(schemas)) {
            const stack: Array<{schema: any; path: string }> = [{ schema, path: "" }];
            const nativeUnionPaths: Set<string> = new Set();
            while (stack.length > 0) {
                const { schema, path } = stack.pop()!;
                if (path !== "") {
                    if (!result[collection][path]) {
                        result[collection][path] = schema;
                    }
                    else if (!nativeUnionPaths.has(path)) {
                        if (ZodUtil.isSchemaOfType(result[collection][path], z.ZodFirstPartyTypeKind.ZodUnion)) {
                            const existingOptions = result[collection][path]._def.options;
                            result[collection][path] = z.union(([...existingOptions, schema] as any));
                        }
                        else {
                            result[collection][path] = z.union([result[collection][path], schema]);
                        }
                    }
                }
                const unwrapped = ZodUtil.unwrapSchema(schema);
                if (ZodUtil.isSchemaOfType(unwrapped, z.ZodFirstPartyTypeKind.ZodObject)) {
                    for (const key in unwrapped.shape) {
                        stack.push({
                            schema: unwrapped.shape[key],
                            path: path ? `${path}.${key}` : key
                        });
                    }
                }
                else if (
                    ZodUtil.isSchemaOfType(unwrapped, z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion) ||
                    ZodUtil.isSchemaOfType(unwrapped, z.ZodFirstPartyTypeKind.ZodUnion)
                ) {
                    nativeUnionPaths.add(path);
                    for (const option of unwrapped.options) {
                        stack.push({ schema: option, path: path });
                    }
                }
                else if (ZodUtil.isSchemaOfType(unwrapped, z.ZodFirstPartyTypeKind.ZodTuple)) {
                    for (let i = 0; i < unwrapped._def.items.length; i++) {
                        stack.push({
                            schema: unwrapped._def.items[i],
                            path: path ? `${path}.${i}` : String(i)
                        });
                    }
                }
            }
        }
        
        return result;
    }
}