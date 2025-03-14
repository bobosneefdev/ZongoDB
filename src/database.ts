import * as mongoDB from 'mongodb';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { z, ZodObject } from 'zod';
import { ZongoLog } from './logger';
import { kZongoConfig } from './config';
import { ZongoUtil } from './util';

type ZongoDBSafeUpdate<T extends ZodObject<any>> = {
    $set?: mongoDB.UpdateFilter<z.infer<T>>["$set"],
    $unset?: Array<string | keyof z.infer<T>>,
};

export class ZongoDB<
    Schemas extends Record<string, z.ZodObject<any>>
> {
    readonly name: string;
    readonly schemas: Schemas;
    private client: mongoDB.MongoClient;
    private db: mongoDB.Db;
    private collections: Record<keyof Schemas, mongoDB.Collection>;
    private backupPath: string;

    constructor(
        name: string,
        schemas: Schemas,
        opts?: {
            clientOpts?: mongoDB.MongoClientOptions;
            dbOpts?: mongoDB.DbOptions;
        }
    ) {
        this.name = name;
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
        this.backupPath = path.join(kZongoConfig.BACKUP_DIR, name);
        ZongoLog.debug(`Constructed database "${name}"`);
    }

    async getAllCollectionInfos() {
        return await this.db.listCollections().toArray() as Array<mongoDB.CollectionInfo>;
    }

    async close() {
        await this.client.close();
    }

    /**
     * Inserts document(s) into the collection.
     * @validates Document
     */
    async safeInsert<Collection extends keyof Schemas & string>(
        collection: Collection,
        documents: Array<z.infer<Schemas[Collection]>>
    ) {
        try {
            return await this.collections[collection].insertMany(documents.map(d => this.schemas[collection].parse(d)));
        }
        catch(error) {
            ZongoLog.error(`Error inserting document into collection "${collection}"`, error);
            return null;
        }
    }

    /**
     * Update document(s) in the collection based on the query.
     * @validates Query
     * @validates Update
     * @returns number of documents changed
     */
    async safeUpdate<K extends keyof Schemas & string>(
        collection: K,
        query: Record<string, any>,
        update: ZongoDBSafeUpdate<Schemas[K]> | Array<{
            path: string | null;
            transform: (value: any) => any;
        }>,
        opts?: {
            onlyOne?: boolean;
            upsert?: boolean;
            upsertDefault?: z.infer<Schemas[K]>;
        }
    ) {
        this.verifyQuery(collection, query);
        const updateFunc = opts?.onlyOne ?
            this.updateOne.bind(this) :
            this.updateMany.bind(this);
        const updateIsArray = Array.isArray(update);
        if (!updateIsArray && opts?.upsert === true) {
            if (
                !update.$set ||
                update.$unset ||
                Object.keys(update.$set).length !== Object.keys(this.schemas[collection].shape).length
            ) {
                throw new Error(`Use of upsert only supports a complete $set option. Nothing else.`);
            }
            this.schemas[collection].parse(update.$set);
            const result = await updateFunc(
                collection,
                query,
                update as any,
                {
                    upsert: true
                }
            );
            if (!result?.acknowledged) {
                ZongoLog.error(`Error upserting document into collection "${collection}"`, result);
            }
            return result?.upsertedCount ? 1 : 0;
        }
        try {
            if (!updateIsArray) {
                for (const [operation, options] of Object.entries(update)) {
                    for (const [path, value] of Object.entries(options)) {
                        const valueSchema = this.getSchemaAtPath(collection, path);
                        if (!valueSchema) {
                            throw new Error(`Invalid path ${path}`);
                        }
                        else if (operation === "$set") {
                            valueSchema.parse(value);
                        }
                        else if (operation === "$unset") {
                            valueSchema.parse(undefined);
                        }
                    }
                }
                const result = await updateFunc(
                    collection,
                    query,
                    update as any
                );
                return result ? Math.max(result.modifiedCount, result.upsertedCount) : 0;
            }
            else {
                const docs = (
                    opts?.onlyOne ?
                    [await this.findOne(collection, query)].filter(doc => doc !== null) :
                    await this.findMany(collection, query)
                );
                for (const doc of docs) {
                    for (const { path, transform } of update) {
                        if (!path) {
                            transform(doc);
                        }
                        else {
                            ZongoUtil.updateValueInObject(
                                doc,
                                path,
                                transform
                            );
                        }
                    }
                }
                let changedCount = 0;
                for (const doc of docs) {
                    this.schemas[collection].parse(doc);
                    const result = await this.updateOne(
                        collection,
                        {
                            "_id": doc._id
                        },
                        {
                            "$set": doc
                        },
                        {
                            upsert: opts?.upsert
                        }
                    );
                    if (result?.modifiedCount) {
                        changedCount++;
                    }
                }
                return changedCount;
            }
        }
        catch(error) {
            ZongoLog.error("safeUpdate failed: ", error);
            return null;
        }
    }

    /**
     * NOT SCHEMA SAFE.
     * Updates a single document in the collection based on the query.
     * @validates Query
     * @returns 
     */
    async updateOne<K extends keyof Schemas & string>(
        collection: K,
        query: Record<string, any>,
        update: mongoDB.UpdateFilter<z.infer<Schemas[K]>>,
        options?: mongoDB.UpdateOptions
    ) {
        this.verifyQuery(collection, query);
        for (const operationOptions of Object.values(update)) {
            for (const path of Object.keys(operationOptions)) {
                this.getSchemaAtPath(collection, path);
            }
        }
        try {
            return await this.collections[collection].updateOne(
                query,
                update as any,
                options
            );
        }
        catch (error) {
            ZongoLog.error("updateOne failed: ", error);
            return null;
        }
    }

    /**
     * NOT SCHEMA SAFE.
     * Updates multiple documents in the collection based on the query.
     * @validates Query, Update Paths (NOT THE DATA YOU ARE ASSIGNING TO THE PATHS THOUGH)
     * */
    async updateMany<K extends keyof Schemas & string>(
        collection: K,
        query: Record<string, any>,
        update: mongoDB.UpdateFilter<z.infer<Schemas[K]>>,
        options?: mongoDB.UpdateOptions
    ) {
        this.verifyQuery(collection, query);
        for (const operationOptions of Object.values(update)) {
            for (const path of Object.keys(operationOptions)) {
                this.getSchemaAtPath(collection, path);
            }
        }
        try {
            return await this.collections[collection].updateMany(
                query,
                update as any,
                options
            );
        }
        catch (error) {
            ZongoLog.error("updateMany failed: ", error);
            return null;
        }
    }

    /**
     * Deletes a single document from the collection based on the query.
     * @validates Query
     * */
    async safeDeleteOne<K extends keyof Schemas & string>(
        collection: K,
        query: Record<string, any>
    ) {
        this.verifyQuery(collection, query);
        return await this.collections[collection].deleteOne(query);
    }

    /**
     * Deletes multiple documents from the collection based on the query.
     * @validates Query
     * */
    async deleteMany<K extends keyof Schemas & string>(
        collection: K,
        query: Record<string, any>,
        options?: mongoDB.DeleteOptions
    ) {
        this.verifyQuery(collection, query);
        return await this.collections[collection].deleteMany(query, options);
    }

    /**
     * Finds document(s) in the collection based on the query. Returns schema validated result.
     * @validates Query, Result
     * @returns null if no document is found
     * */
    async safeFind<K extends keyof Schemas & string>(
        collection: K,
        query: Record<string, any>,
        onlyOne: boolean = false,
        options?: mongoDB.FindOptions
    ): Promise<
        typeof onlyOne extends true ?
            Array<z.infer<Schemas[K]> & { _id?: string }> :
            (z.infer<Schemas[K]> & { _id?: string }) | null
    > {
        this.verifyQuery(collection, query);
        const schema = this.schemas[collection].extend({
            _id: z.string().optional(),
        });
        const func = onlyOne ?
            this.findOne.bind(this) :
            this.findMany.bind(this);
        const result = await func(
            collection,
            query,
            options
        );
        return onlyOne === true ?
            (result as any[]).map(doc => schema.parse(doc)) :
            result ? schema.parse(result) as any : null;
    }

    /**
     * Finds multiple documents in the collection based on the query.
     * @validates Query
     * */
    async findMany<K extends keyof Schemas & string>(
        collection: K,
        query: Record<string, any>,
        options?: mongoDB.FindOptions
    ): Promise<Array<z.infer<Schemas[K]> & { _id: string }>> {
        this.verifyQuery(collection, query);
        return await this.collections[collection]
            .find(query, options)
            .toArray() as any;
    }

    /**
     * Finds a single document in the collection based on the query.
     * @validates Query
     * */
    async findOne<K extends keyof Schemas & string>(
        collection: K,
        query: Record<string, any>,
        options?: mongoDB.FindOptions
    ): Promise<z.infer<Schemas[K] & { _id: string }> | null> {
        this.verifyQuery(collection, query);
        return await this.collections[collection].findOne(
            query,
            options
        );
    }

    /**
     * Finds a single document in the collection based on the query and updates it.
     * @validates Query, Update Paths (NOT THE DATA YOU ARE ASSIGNING TO THE PATHS THOUGH)
     * @returns null if no document is found
     * */
    async findOneAndUpdate<K extends keyof Schemas & string>(
        collection: K,
        query: Record<string, any>,
        update: mongoDB.UpdateFilter<z.infer<Schemas[K]>>,
        options?: mongoDB.FindOneAndUpdateOptions
    ): Promise<z.infer<Schemas[K] & { _id: string }> | null> {
        this.verifyQuery(collection, query);
        for (const operationOptions of Object.values(update)) {
            for (const path of Object.keys(operationOptions)) {
                this.getSchemaAtPath(collection, path);
            }
        }
        return await this.collections[collection].findOneAndUpdate(
            query,
            update as any,
            options ?? {}
        );
    }

    /**
     * NOT SCHEMA SAFE.
     * Just a direct layer over the standard mongoDB aggregate
     * */
    async aggregate<K extends keyof Schemas & string>(
        collection: K,
        pipeline: Array<mongoDB.BSON.Document>
    ) {
        return await this.collections[collection].aggregate(pipeline).toArray();
    }

    /**
     * Creates index(es) on the given path for the given collection.
     * @validates Index paths
     * */
    async safeCreateIndexes<K extends keyof Schemas & string>(
        collection: K,
        indexes: Partial<Record<string, 1 | -1>>,
        options?: mongoDB.CreateIndexesOptions,
    ) {
        try {
            for (const path of Object.keys(indexes)) {
                this.getSchemaAtPath(collection, path);
            }
            await this.collections[collection].createIndex(
                indexes as any,
                options
            );
            ZongoLog.debug(`Created compound index ${JSON.stringify(indexes)} for collection ${collection}`);
        }
        catch(error) {
            ZongoLog.error(`Error creating compound index ${JSON.stringify(indexes)} for collection ${collection}: ${error}`);
            throw error;
        }
    }

    /**
     * Deletes all entries in the collection that are older than the given date.
     * @validates Timestamp path is a Date in collection schema
     */
    async deleteOldDocuments<K extends keyof Schemas & string>(
        collection: K,
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
        const result = await this.deleteMany(
            collection,
            {
                $expr: {
                    $lt: [
                        {
                            $toDate: "$timestamp"
                        },
                        olderThan
                    ]
                }
            }
        );
        ZongoLog.debug(`Cleared ${result.deletedCount} old entries from collection ${collection}`);
        return result;
    }

    /**
     * NOT SAFE AT ALL.
     * Performs a bulk write operation on the collection.
     * */
    async bulkWrite<K extends keyof Schemas & string>(
        collection: K,
        operations: Array<mongoDB.AnyBulkWriteOperation>,
        options?: mongoDB.BulkWriteOptions
    ) {
        ZongoLog.info(`Bulk writing ${operations.length} operations to collection ${collection}`);
        try {
            return await this.collections[collection].bulkWrite(
                operations,
                options
            );
        }
        catch(error) {
            ZongoLog.error(`Error bulk writing to collection ${collection}: ${error}`);
            return false;
        }
    }

    /**
     * Finds all documents in the collection that are older than the given date.
     * @validates Timestamp path is a Date in collection schema
     * @returns Array of documents
     */
    async safeFindOldDocuments<K extends keyof Schemas & string>(
        collection: K,
        timestampPath: string,
        olderThan: Date,
        findOpts?: mongoDB.FindOptions,
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
        return await this.findMany(
            collection,
            {
                $expr: {
                    $lt: [
                        {
                            $toDate: "$timestamp"
                        },
                        olderThan
                    ]
                }
            },
            findOpts
        );
    }

    /**
     * Creates a backup of the collection using mongodump.
     * @returns success boolean
     */
    async backupCollection<K extends keyof Schemas & string>(
        collection: K,
        maxBackups = 10,
        opts?: {
            compressed?: boolean;
        }
    ) {
        const backupPath = path.join(
            this.backupPath,
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

    /**
     * Deletes old backups from the backup directory.
     * @returns number of deleted backups
     */
    private async deleteOldBackups<K extends keyof Schemas & string>(
        collection: K,
        maxBackups: number
    ) {
        const dir = path.join(kZongoConfig.BACKUP_DIR, collection);
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

    /** Throws if any of your query ain't right */
    private verifyQuery<K extends keyof Schemas & string>(
        collection: K,
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

    /** Returns the schema at the given path for the given collection */
    private getSchemaAtPath<K extends keyof Schemas & string>(
        collection: K,
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