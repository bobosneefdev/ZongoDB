import * as mongoDB from 'mongodb';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { ZongoLog } from './logger';
import { kZongoConfig } from './config';
import { ZongoUtil } from './util';

export type ZongoTransformUpdate = Record<string, (value: any) => any>;

type AddObjectIdToObject<T extends Object> = T & {
    _id: mongoDB.ObjectId;
}

export class ZongoDB<T extends Readonly<Record<string, z.ZodObject<any>>>> {
    readonly name: string;
    readonly schemas: T;
    readonly client: mongoDB.MongoClient;
    /** You can easily break schema beyond this point if you don't know what you're doing! */
    readonly db: mongoDB.Db;
    readonly flattenedSchemas: Readonly<Record<keyof T, Readonly<Record<string, z.ZodType<any>>>>>;
    private collections: Readonly<Record<keyof T, mongoDB.Collection>>;
    private backupDir: string;
    private warningMessagesSent: Record<string, number> = {};
    collectionsWithOptionalFields: Set<keyof T> = new Set();

    constructor(
        name: string,
        schemas: T,
        opts?: {
            mongoClientOpts?: mongoDB.MongoClientOptions;
            mongoDbOpts?: mongoDB.DbOptions;
            initIndexes?: Record<keyof T, Record<string, 1 | -1>>;
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
            kZongoConfig.MONGO_URI,
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
            if (ZongoUtil.doesSchemaHaveOptionalFields(schema)) {
                this.collectionsWithOptionalFields.add(collection as keyof T);
            }
        }
        this.backupDir = path.join(kZongoConfig.BACKUP_DIR, name);
        ZongoLog.debug(`Constructed database "${name}"`);
        if (opts?.initIndexes) {
            const now = Date.now();
            Promise.all(Object.entries(opts.initIndexes).map(([collection, indexes]) => this.createIndexes(collection as any, indexes))).then(
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
            this.removeUndefinedValuesAndParse(collection, doc),
            opts
        );
    }

    async insertMany<K extends keyof T & string>(
        collection: K,
        docs: Array<z.infer<T[K]>>,
        opts?: mongoDB.BulkWriteOptions
    ) {
        return await this.collections[collection].insertMany(
            docs.map(doc => this.removeUndefinedValuesAndParse(collection, doc)),
            opts
        );
    }

    private removeUndefinedValuesAndParse<K extends keyof T & string>(
        collection: K,
        doc: z.infer<T[K]>
    ) {
        return this.collectionsWithOptionalFields.has(collection) ?
            ZongoUtil.removeUndefinedValues(this.schemas[collection].parse(doc)) :
            this.schemas[collection].parse(doc);
    }

    /**
     * Transform the data within a document.
     * @param collection - Name of the collection to insert to.
     * @param query - Path/values to match the document to.
     * @param update - Transformations to apply to given paths
     * @returns Data on success, true if no doc found, false if not acknowledged.
     */
    async transformOne<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>,
        update: ZongoTransformUpdate,
    ) {
        this.verifyQuery(collection, query);
        const document = await this.collections[collection].findOne(query);
        if (!document) {
            return true;
        }
        const result = await this.transform(
            collection,
            document,
            update
        );
        if (!result) {
            return false;
        }
        return result;
    }

    /**
     * Transform the data within a document.
     * @param collection - Name of the collection to insert to.
     * @param query - Path/values to match the document to.
     * @param update - Transformations to apply to given paths.
     * @param opts.detailed - Whether the function returns the full array of changed datas instead of number of changed docs. False by default.
     * @returns Data on success, null if no docs found
     */
    async transformMany<
        K extends keyof T & string,
        O extends {
            detailed?: boolean;
        }
    >(
        collection: K,
        query: Record<string, any>,
        update: ZongoTransformUpdate,
        opts?: O,
    ): Promise<
        (
            O["detailed"] extends true ? {
                successes: Array<{
                    previous: z.infer<T[K]>;
                    updated: Record<"$set" | "$unset", Record<string, any>>;
                }>
                notAcknowledged: number,
            } : {
                success: number,
                notAcknowledged: number,
            }
        )
    > {
        this.verifyQuery(collection, query);
        const detailedSuccesses = [];
        let basicSuccesses = 0;
        let notAcknowledged = 0;
        for await (const document of this.collections[collection].find(query)) {
            const result = await this.transform(
                collection,
                document,
                update
            );
            if (result === null) {
                notAcknowledged++;
            }
            else if (opts?.detailed === true) {
                detailedSuccesses.push(result);
            }
            else {
                basicSuccesses++;
            }
        }
        return {
            successes: opts?.detailed === true ? detailedSuccesses : basicSuccesses,
            notAcknowledged: notAcknowledged,
        } as any;
    }

    private async transform<K extends keyof T & string>(
        collection: K,
        document: mongoDB.WithId<mongoDB.BSON.Document>,
        update: ZongoTransformUpdate
    ): Promise<
        {
            updated: Record<"$set" | "$unset", Record<string, any>>,
            previous: z.infer<T[K]>,
        } | null
    > {
        const docId = document._id;
        const doc: mongoDB.OptionalId<mongoDB.BSON.Document> = document;
        delete doc._id; // so it'll parse
        const previous = this.schemas[collection].parse(doc);
        const updt = Object.entries(update).reduce(
            (acc, [path, transform]) => {
                acc[path] = transform(ZongoUtil.getValueAtPath(document, path));
                return acc;
            },
            {} as Record<string, any>
        );
        const result = await this.collections[collection].updateOne(
            {
                "_id": docId,
            },
            this.getSafeSetAndUnset(collection, updt),
        );
        if (!result.acknowledged) {
            return null;
        }
        return {
            updated: updt,
            previous: previous,
        } 
    }

    /**
     * Update document in the collection.
     * @param collection - Name of the collection to update.
     * @param query - Query to find the document to update.
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
     * @param query - Query to find the documents to update.
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
        this.verifyQuery(collection, query);
        for (const key in update) {
            const schema = this.getSchemaAtPath(collection, key);
            schema.parse(update[key]);
        }
        if (opts?.upsert === true) {
            const parsed = this.schemas[collection].safeParse(update);
            if (!parsed.success) {
                throw new Error(`Upsert only possible with complete document. ${parsed.error}`);
            }
        }
        return await this.collections[collection][type](
            query,
            this.getSafeSetAndUnset(collection, update),
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
    ) {
        this.verifyQuery(collection, query);
        try {
            return await this.collections[collection].deleteMany(query);
        }
        catch (error) {
            ZongoLog.error("deleteOne failed: ", error);
            if (error instanceof z.ZodError) {
                ZongoLog.error("Zod error: ", error.errors);
            }
            return null;
        }
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
    ) {
        this.verifyQuery(collection, query);
        try {
            return await this.collections[collection].deleteMany(query);
        }
        catch (error) {
            ZongoLog.error("deleteMany failed: ", error);
            if (error instanceof z.ZodError) {
                ZongoLog.error("Zod error: ", error.errors);
            }
            return null;
        }
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
        options?: mongoDB.FindOptions
    ): Promise<z.infer<AddObjectIdToObject<T[K]>> | null> {
        this.verifyQuery(collection, query);
        const result = await this.collections[collection].findOne(
            query,
            options,
        );
        if (!result) {
            ZongoLog.debug(`No document found for query: ${JSON.stringify(query)}`);
            return null;
        }
        return this.getSchemaWithObjectId(collection).parse(result);
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
        options?: mongoDB.FindOptions
    ): Promise<Array<z.infer<AddObjectIdToObject<T[K]>>> | null> {
        this.verifyQuery(collection, query);
        const cursor = this.collections[collection].find(query, options);
        const docArray = await cursor.toArray();
        if (!docArray.length) {
            ZongoLog.debug(`No documents found for query: ${JSON.stringify(query)}`);
            return null;
        }
        const schemaWithId = this.getSchemaWithObjectId(collection);
        return docArray.map(d => schemaWithId.parse(d));
    }

    /**
     * Creates index(es) on the given path for the given collection.
     * @param collection - Name of the collection to create index on.
     * @param indexes - Indexes to create on the collection.
     * @param options - Options for the index creation.
     * @throws If any index path is invalid.
     * */
    async createIndexes<K extends keyof T & string>(
        collection: K,
        indexes: Partial<Record<string, 1 | -1>>,
        options?: mongoDB.CreateIndexesOptions,
    ) {
        for (const key in indexes) {
            if (!this.flattenedSchemas[collection][key]) {
                throw new Error(`Invalid index path "${key}" in collection ${collection}`);
            }
        }
        await this.collections[collection].createIndex(
            indexes as any,
            options
        );
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
     * Creates a backup of the collection using mongodump.
     * @param collection - Name of the collection to backup.
     * @param maxBackups - Maximum number of backups to keep.
     * @param opts - Options for the backup operation.
     * @param opts.compressed - If true, compress the backup using gzip.
     * @returns success boolean
     */
    async backupCollection<K extends keyof T & string>(
        collection: K,
        maxBackups = 10,
        opts?: {
            compressed?: boolean;
        }
    ) {
        const backupPath = path.join(
            this.backupDir,
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
            cmd += ` --gzip`;
        }

        const process = exec(cmd, async (error, _, stderr) => {
            if (error) {
                ZongoLog.error(`${collection}: ${error}`);
                return false;
            }
            if (stderr) {
                ZongoLog.error(`${collection}: ${stderr}`);
                return false;
            }
            ZongoLog.info(`Backed up collection ${collection}`);
            await this.deleteOldBackups(
                collection,
                maxBackups
            );
        });

        const backupPromise = new Promise<boolean>((resolve, reject) => {
            process.on('exit', (code) => {
                ZongoLog.info(`Backup process exited with code ${code}`);
                resolve(true);
            });
            process.on('error', (error) => {
                ZongoLog.error(`Backup process errored: ${error}`);
                resolve(false);
            });
        });

        return await backupPromise;
    }

    private async deleteOldBackups<K extends keyof T & string>(
        collection: K,
        maxBackups: number
    ) {
        const dir = path.join(
            this.backupDir,
            collection
        );
        if (!fs.existsSync(dir)) {
            ZongoLog.error(`Backup directory does not exist: ${dir}`);
            return 0;
        }
        const contents = fs.readdirSync(dir);
        ZongoLog.info(`Found ${contents.length} backups in directory ${dir}`);
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

    private getSchemaWithObjectId<K extends keyof T & string>(collection: K): z.ZodObject<AddObjectIdToObject<z.infer<T[K]>>> {
        return this.schemas[collection].extend({
            _id: z.instanceof(mongoDB.ObjectId),
        }) as any;
    }

    private verifyQuery<K extends keyof T & string>(
        collection: K,
        query: Record<string, any>
    ) {
        for (const path in query) {
            const schema = this.getSchemaAtPath(collection, path);
            if (typeof query[path] !== "object") {
                schema.parse(query[path]);
            }
            else if (!this.warningMessagesSent["queryObjectValidationWarning"]) {
                ZongoLog.warn(`ZongoDB does not currently verify query objects with mongoDB methods, but they will still work.`);
                this.warningMessagesSent["queryObjectValidationWarning"] = 1;
            }
        }
    }

    private getSafeSetAndUnset<K extends keyof T & string>(
        collection: K,
        data: Record<string, any>
    ) {
        const {$set, $unset} = ZongoUtil.getSetAndUnset(data);
        for (const key in $set) {
            $set[key] = this.getSchemaAtPath(collection, key).parse($set[key]);
        }
        for (const key in $unset) {
            this.getSchemaAtPath(collection, key).parse(undefined);
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
        const result: Record<string, Record<string, z.ZodType<any>>> = {};
        const traverser = (
            schema: any, 
            path: string, 
            collection: string 
        ) => {
            if (!result[collection]) {
                result[collection] = {};
            }
            if (path !== "") {
                result[collection][path] = schema;
            }
            
            let unwrapped = schema;
            while (true) {
                if (unwrapped?._def?.typeName === "ZodEffects") {
                    unwrapped = unwrapped._def.schema;
                }
                else if (
                    unwrapped._def?.typeName === "ZodNullable" ||
                    unwrapped._def?.typeName === "ZodOptional"
                ) {
                    unwrapped = unwrapped._def.innerType;
                }
                else {
                    break;
                }
            }
            if (unwrapped && typeof unwrapped === "object" && "shape" in unwrapped) {
                for (const key in unwrapped.shape) { 
                    traverser( 
                        unwrapped.shape[key], 
                        path ? `${path}.${key}` : key, 
                        collection 
                    ); 
                }
            }
        };
        for (const [collection, schema] of Object.entries(schemas)) { 
            traverser(schema, "", collection); 
        }
        return result as any; 
    }
}