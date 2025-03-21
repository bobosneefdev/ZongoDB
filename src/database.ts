import * as mongoDB from 'mongodb';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { z, ZodObject } from 'zod';
import { ZongoLog } from './logger';
import { kZongoConfig } from './config';
import { ZongoUtil } from './util';

export type ZongoTransformUpdate = {
    path: string | null;
    transform: (value: any) => any;
};

type AddObjectIdToObject<T extends Object> = T & {
    _id: mongoDB.ObjectId;
}

export class ZongoDB<
    Schemas extends Readonly<Record<string, z.ZodObject<any>>>
> {
    readonly name: string;
    readonly schemas: Schemas;
    readonly client: mongoDB.MongoClient;
    /** Interacting here is not reccomended unless you know what you're doing! */
    readonly db: mongoDB.Db;
    private collections: Readonly<Record<keyof Schemas, mongoDB.Collection>>;
    private backupDir: string;

    constructor(
        name: string,
        schemas: Schemas,
        opts?: {
            clientOpts?: mongoDB.MongoClientOptions;
            dbOpts?: mongoDB.DbOptions;
        }
    ) {
        this.name = name;
        for (const schema of Object.values(schemas)) {
            if ("_id" in schema.shape) {
                throw new Error("Schema cannot contain _id field!");
            }
        }
        this.schemas = schemas;
        this.client = new mongoDB.MongoClient(
            kZongoConfig.MONGO_URI,
            {
                minPoolSize: 6,
                maxPoolSize: 10,
                ...opts?.clientOpts,
            }
        );
        this.db = this.client.db(name, opts?.dbOpts);
        this.collections = Object.entries(schemas).reduce(
            (acc, [key, schema]) => {
                acc[key as keyof Schemas] = this.db.collection<z.infer<typeof schema>>(key);
                return acc;
            },
            {} as Record<keyof Schemas, mongoDB.Collection>
        );
        this.backupDir = path.join(kZongoConfig.BACKUP_DIR, name);
        ZongoLog.debug(`Constructed database "${name}"`);
    }

    /**
     * @returns Array of your databases collection meta-datas.
     */
    async getCollectionInfos() {
        return await this.db.listCollections().toArray() as Array<mongoDB.CollectionInfo>;
    }

    /**
     * Closes mongoClient connection.
     * @param force - If true, forcefully closes the connection.
     * */
    async close(force?: boolean) {
        await this.client.close(force);
    }

    async insertOne<
        Collection extends keyof Schemas & string
    >(
        collection: Collection,
        doc: z.infer<Schemas[Collection]>,
        opts?: mongoDB.InsertOneOptions
    ) {
        const insert = ZongoUtil.removeUndefinedValues(
            this.schemas[collection].parse(doc)
        );
        return await this.collections[collection].insertOne(
            insert,
            opts
        );
    }

    async insertMany<
        Collection extends keyof Schemas & string
    >(
        collection: Collection,
        docs: Array<z.infer<Schemas[Collection]>>,
        opts?: mongoDB.InsertOneOptions
    ) {
        const inserts = docs.map(doc => ZongoUtil.removeUndefinedValues(
            this.schemas[collection].parse(doc)
        ));
        return await this.collections[collection].insertMany(
            inserts,
            opts
        );
    }

    /**
     * Transform the data within a document.
     * @param collection - Name of the collection to insert to.
     * @param query - Path/values to match the document to.
     * @param update - Transformations to apply to given paths
     * @returns Previous/Updated data on success, true if no doc found, false if issue.
     */
    async transformOne<
        Collection extends keyof Schemas & string,
        Update extends Array<ZongoTransformUpdate>
    >(
        collection: Collection,
        query: Record<string, any>,
        update: Update,
    ): Promise<
        {
            previous: z.infer<Schemas[Collection]>;
            updated: z.infer<Schemas[Collection]>;
        } | boolean
    > {
        this.verifyQuery(collection, query);
        const document = await this.collections[collection].findOne(query);
        if (!document) {
            return true;
        }
        const previous = this.schemas[collection].parse(document);
        const updated = await this.transformAndUpdateDoc(
            collection,
            query,
            document,
            update
        );
        if (!updated) {
            return false;
        }
        return {
            previous: previous,
            updated: updated
        };
    }

    /**
     * Transform the data within a document.
     * @param collection - Name of the collection to insert to.
     * @param query - Path/values to match the document to.
     * @param update - Transformations to apply to given paths.
     * @param detailed - Determines whether you get the full array of changed datas, which could be massive. If false you get number of changed docs.
     * @returns Previous/Updated datas on success, true if no docs found, false if issue.
     */
    async transformMany<
        Collection extends keyof Schemas & string,
        Update extends Array<ZongoTransformUpdate>,
        Detailed extends boolean
    >(
        collection: Collection,
        query: Record<string, any>,
        update: Update,
        detailed: Detailed,
    ): Promise<
        (
            Detailed extends true ? {
                success: Array<{
                    previous: z.infer<Schemas[Collection]>;
                    updated: z.infer<Schemas[Collection]>;
                }>
                errors: number,
            } : {
                success: number,
                errors: number,
            }
        ) | boolean
    > {
        this.verifyQuery(collection, query);
        const cursor = this.collections[collection].find(query);
        const documents = await cursor.toArray();
        if (!documents.length) {
            return true;
        }
        const success: Array<true | {
            previous: z.infer<Schemas[Collection]>;
            updated: z.infer<Schemas[Collection]>;
        }> = [];
        let errors: number = 0;
        for (const document of documents) {
            const previous = this.schemas[collection].parse(document);
            const updated = await this.transformAndUpdateDoc(
                collection,
                query,
                document,
                update
            );
            if (!updated) {
                errors++;
            }
            else if (detailed === true) {
                success.push({
                    previous: previous,
                    updated: updated,
                });
            }
            else {
                success.push(true);
            }
        }
        return {
            success: detailed === true ? success : success.length,
            errors: errors,
        } as any;
    }

    /** returns null on error */
    private async transformAndUpdateDoc<
        Collection extends keyof Schemas & string,
        Update extends Array<ZongoTransformUpdate>
    >(
        collection: Collection,
        query: Record<string, any>,
        document: mongoDB.WithId<mongoDB.BSON.Document>,
        update: Update
    ): Promise<AddObjectIdToObject<z.infer<Schemas[Collection]>> | null> {
        const docId = document._id;
        if (!docId) {
            throw new Error("Document doesn't have ID! Can't transform! SHOULDN'T HAPPEN!");
        }
        for (const { path, transform } of update) {
            if (!path) {
                document = transform(document);
            }
            else {
                ZongoUtil.updateValueInObject(
                    document,
                    path,
                    transform
                );
            }
        }
        const { set, unset } = ZongoUtil.separateSetAndUnset(
            this.schemas[collection].parse(document) // this will throw if the user has screwed up
        );
        const result = await this.collections[collection].updateOne(
            {
                "_id": docId,
                ...query,
            },
            {
                "$set": set,
                "$unset": unset,
            },
        );
        if (!result?.acknowledged) {
            ZongoLog.error(`Error updating document in collection "${collection}"`, result);
            return null;
        }
        return document;
    }

    /**
     * Update document in the collection.
     * @param collection - Name of the collection to update.
     * @param query - Query to find the document to update.
     * @param update - Record of paths/new values.
     * @param opts.upsert - If true, insert a new document if no document matches the query. (REQUIRES COMPLETE $SET, NOTHING ELSE ALLOWED)
     * @returns Document changed count, or null on failure.
     * @throws If zod parsing fails for the query, update, or existing document (if using transform type), or if upsert is attempted on incomplete document.
     */
    async updateOne<Collection extends keyof Schemas & string>(
        collection: Collection,
        query: Record<string, any>,
        update: Record<string, any>,
        opts?: {
            upsert?: boolean;
        }
    ): Promise<mongoDB.UpdateResult> {
        this.verifyQuery(collection, query);
        if (opts?.upsert === true) {
            const parsed = this.schemas[collection].safeParse(update);
            if (!parsed.success) {
                throw new Error(`Upsert only possible with complete document. ${parsed.error}`);
            }
            const {set, unset} = ZongoUtil.separateSetAndUnset(update);
            return await this.collections[collection].updateOne(
                query,
                {
                    $set: set,
                    $unset: unset,
                },
                {
                    upsert: true
                }
            );
        }
        else {
            const { set, unset } = ZongoUtil.separateSetAndUnset(update);
            this.verifySet(collection, set);
            this.verifyUnset(collection, unset);
            return await this.collections[collection].updateOne(
                query,
                {
                    $set: set,
                    $unset: unset,
                },
            );
        }
    }

    /**
     * Update documents in the collection.
     * @param collection - Name of the collection to update.
     * @param query - Query to find the documents to update.
     * @param update - Record of paths/new values.
     * @param opts.upsert - If true, insert a new document if no document matches the query. (REQUIRES COMPLETE $SET, NOTHING ELSE ALLOWED)
     * @returns Documents changed count, or null on failure.
     * @throws If zod parsing fails for the query, update, or existing document (if using transform type), or if upsert is attempted on incomplete document.
     */
    async updateMany<Collection extends keyof Schemas & string>(
        collection: Collection,
        query: Record<string, any>,
        update: Record<string, any>,
        opts?: {
            upsert?: boolean;
        }
    ): Promise<mongoDB.UpdateResult> {
        this.verifyQuery(collection, query);
        if (opts?.upsert === true) {
            const parsed = this.schemas[collection].safeParse(update);
            if (!parsed.success) {
                throw new Error(`Upsert only possible with complete document. ${parsed.error}`);
            }
            const { set, unset } = ZongoUtil.separateSetAndUnset(update);
            return await this.collections[collection].updateOne(
                query,
                {
                    $set: set,
                    $unset: unset,
                },
                {
                    upsert: true
                }
            );
        }
        else {
            const { set, unset } = ZongoUtil.separateSetAndUnset(update);
            this.verifySet(collection, set);
            this.verifyUnset(collection, unset);
            return await this.collections[collection].updateOne(
                query,
                {
                    $set: set,
                    $unset: unset,
                },
            );
        }
    }

    /**
     * Deletes a document from the collection based on the query.
     * @param collection - Name of the collection to delete from.
     * @param query - Query to find the document to delete.
     * @returns Delete result, or null on error.
     * @throws If the query has invalid paths.
     * */
    async deleteOne<Collection extends keyof Schemas & string>(
        collection: Collection,
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
    async deleteMany<Collection extends keyof Schemas & string>(
        collection: Collection,
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
     * @returns Zod verified document, true if no document, false if error.
     * @throws If the query has invalid paths.
     * */
    async findOne<Collection extends keyof Schemas & string>(
        collection: Collection,
        query: Record<string, any>,
        options?: mongoDB.FindOptions
    ): Promise<z.infer<AddObjectIdToObject<Schemas[Collection]>> | boolean> {
        this.verifyQuery(collection, query);
        try {
            const result = await this.collections[collection].findOne(
                query,
                options,
            );
            if (!result) {
                ZongoLog.debug(`No document found for query: ${JSON.stringify(query)}`);
                return true;
            }
            return this.getSchemaWithId(collection).parse(result);
        }
        catch (error) {
            ZongoLog.error("findOne failed: ", error);
            if (error instanceof z.ZodError) {
                ZongoLog.error("Zod error: ", error.errors);
            }
            return false;
        }
    }

    /**
     * Finds documents in the collection based on the query.
     * @param collection - Name of the collection to find in.
     * @param query - Query to find the documents to return.
     * @param options - Options for the find operation.
     * @returns Zod verified documents, true if no documents, false if error.
     * @throws If the query has invalid paths.
     * */
    async findMany<Collection extends keyof Schemas & string>(
        collection: Collection,
        query: Record<string, any>,
        options?: mongoDB.FindOptions
    ): Promise<Array<z.infer<AddObjectIdToObject<Schemas[Collection]>>> | boolean> {
        this.verifyQuery(collection, query);
        try {
            const cursor = this.collections[collection].find(
                query,
                options
            );
            const docArray = await cursor.toArray();
            if (!docArray.length) {
                ZongoLog.debug(`No documents found for query: ${JSON.stringify(query)}`);
                return true;
            }
            const schemaWithId = this.getSchemaWithId(collection);
            return docArray.map(d => schemaWithId.parse(d));
        }
        catch (error) {
            ZongoLog.error("findMany failed: ", error);
            if (error instanceof z.ZodError) {
                ZongoLog.error("Zod error: ", error.errors);
            }
            return false;
        }
    }

    /**
     * Creates index(es) on the given path for the given collection.
     * @param collection - Name of the collection to create index on.
     * @param indexes - Indexes to create on the collection.
     * @param options - Options for the index creation.
     * @returns Success boolean.
     * @throws If any index path is invalid.
     * */
    async createIndexes<Collection extends keyof Schemas & string>(
        collection: Collection,
        indexes: Partial<Record<string, 1 | -1>>,
        options?: mongoDB.CreateIndexesOptions,
    ) {
        for (const path of Object.keys(indexes)) {
            this.getSchemaAtPath(collection, path);
        }
        try {
            await this.collections[collection].createIndex(
                indexes as any,
                options
            );
            ZongoLog.debug(`Created index for collection ${collection}`);
            return true;
        }
        catch (error) {
            ZongoLog.error(`Error creating index for collection ${collection}: ${error}`);
            if (error instanceof z.ZodError) {
                ZongoLog.error("Zod error: ", error.errors);
            }
            return false;
        }
    }

    /**
     * Deletes all entries in the collection that are older than the given date.
     * @param collection - Name of the collection to delete from.
     * @param timestampPath - Path to the timestamp field you'd like to evaluate in the document.
     * @param olderThan - Date to compare against for deletion.
     * @returns Delete result, or null on error.
     * @throws If the timestamp path is invalid or not a Date type.
     */
    async deleteOldDocuments<Collection extends keyof Schemas & string>(
        collection: Collection,
        timestampPath: string,
        olderThan: Date
    ) {
        const timestampSchema = this.getSchemaAtPath(collection, timestampPath);
        if (!timestampSchema) {
            throw new Error(`Invalid timestamp path "${timestampPath}" in collection ${collection}`);
        }
        else {
            try {
                timestampSchema.parse(new Date());
            }
            catch (error) {
                throw new Error(`Values are not of Date type at path: ${timestampPath} in collection ${collection}`);
            }
        }
        try {
            const result = await this.collections[collection].deleteMany(
                {
                    $expr: {
                        $lt: [
                            {
                                $toDate: `$${timestampPath}`
                            },
                            olderThan
                        ]
                    }
                }
            );
            ZongoLog.debug(`Cleared ${result.deletedCount} old entries from collection ${collection}`);
            return result;
        }
        catch (error) {
            ZongoLog.error(`Error deleting old documents in collection ${collection}: ${error}`);
            if (error instanceof z.ZodError) {
                ZongoLog.error("Zod error: ", error.errors);
            }
            return null;
        }
    }

    /**
     * Finds all documents in the collection that are older than the given date.
     * @param collection - Name of the collection to find in.
     * @param timestampPath - Path to the timestamp field you'd like to evaluate in the document.
     * @param olderThan - Date to compare against for finding documents.
     * @param findOpts - Options for the find operation.
     * @returns Array of documents with MongoDB id.
     * @throws If the timestamp path is invalid, schema at path is not a date type, or if the found documents aren't parsable by the collection schema.
     */
    async findOldDocuments<Collection extends keyof Schemas & string>(
        collection: Collection,
        timestampPath: string,
        olderThan: Date,
        findOpts?: mongoDB.FindOptions,
    ): Promise<Array<z.infer<AddObjectIdToObject<Schemas[Collection]>>>> {
        const timestampSchema = this.getSchemaAtPath(collection, timestampPath);
        if (!timestampSchema) {
            throw new Error(`Invalid timestamp path "${timestampPath}" in collection ${collection}`);
        }
        else {
            try {
                timestampSchema.parse(new Date());
            }
            catch (error) {
                throw new Error(`Values are not of Date type at path: ${timestampPath} in collection ${collection}`);
            }
        }
        const cursor = this.collections[collection].find(
            {
                $expr: {
                    $lt: [
                        {
                            $toDate: `$${timestampPath}`
                        },
                        olderThan
                    ]
                }
            },
            findOpts
        );
        return (await cursor.toArray()).map(d => this.getSchemaWithId(collection).parse(d));
    }

    /**
     * Used if you'd like to manually interact with the standard MongoDB library.
     * Proceed with caution! Nothing is stopping you from breaking your schema beyond this point.
     * */
    getRawCollection<Collection extends keyof Schemas & string>(
        collection: Collection
    ): mongoDB.Collection<z.infer<Schemas[Collection]>> {
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
    async backupCollection<Collection extends keyof Schemas & string>(
        collection: Collection,
        maxBackups = 10,
        opts?: {
            compressed?: boolean;
        }
    ) {
        const backupPath = path.join(
            this.backupDir,
            collection,
            new Date().toISOString().replaceAll(":", "-")
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

    private async deleteOldBackups<Collection extends keyof Schemas & string>(
        collection: Collection,
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

    private getSchemaWithId<
        K extends keyof Schemas & string
    >(
        collection: K
    ): ZodObject<AddObjectIdToObject<z.infer<Schemas[K]>>> {
        return this.schemas[collection].extend({
            _id: z.instanceof(mongoDB.ObjectId),
        }) as any;
    }

    /** Throws if any of your query ain't right */
    private verifyQuery<Collection extends keyof Schemas & string>(
        collection: Collection,
        query: Record<string, any>
    ) {
        for (const [path, value] of Object.entries(query)) {
            const schema = this.getSchemaAtPath(collection, path);
            if (!schema) {
                throw new Error(`Invalid query path ${path} in collection ${collection}`);
            }
            schema.parse(value);
        }
    }

    private verifySet<Collection extends keyof Schemas & string>(
        collection: Collection,
        set: Record<string, any>
    ) {
        for (const [path, value] of Object.entries(set)) {
            const schema = this.getSchemaAtPath(collection, path);
            if (!schema) {
                throw new Error(`Invalid set path ${path} in collection ${collection}`);
            }
            schema.parse(value);
        }
    }

    private verifyUnset<Collection extends keyof Schemas & string>(
        collection: Collection,
        unset: Record<string, any>
    ) {
        for (const path of Object.keys(unset)) {
            const schema = this.getSchemaAtPath(collection, path);
            if (!schema) {
                throw new Error(`Invalid unset path ${path} in collection ${collection}`);
            }
        }
    }

    /** Returns the schema at the given path for the given collection */
    private getSchemaAtPath<Collection extends keyof Schemas & string>(
        collection: Collection,
        path: string
    ): z.ZodType<any> | null {
        const keys = path.split(".");
        let current = this.schemas[collection];
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (
                keys.length === 1 &&
                key === "_id"
            ) {
                return null;
            }
            else if (current.shape?.[key] === undefined) {
                throw new Error(`Invalid index path [${keys.join(" > ")}]`);
            }
            else if (i === keys.length - 1) {
                return current.shape[key];
            }
            current = current.shape[key];
        }
        return current;
    }
};