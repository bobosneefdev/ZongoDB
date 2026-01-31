import z from "zod"
import { Collection, CreateIndexesOptions, Db, DbOptions, IndexDirection, MongoClient, MongoClientOptions } from "mongodb"
import { DEFAULT_MONGO_URI } from "./constants";
import { JsonToBsonTypes, Paths } from "./types";
import { typedObjectEntries } from "./util";
import { zodToMongoValidator } from "./util/zod_to_mongo_validator";

export class Zongo<
    T extends ZongoSchemas,
    U extends ZongoOptions<T>
> {
    readonly schemas: T;
    readonly options: U;
    readonly client: MongoClient;
    readonly db: Db;
    readonly collections: ZongoCollections<T>;

    constructor(
        schemas: T,
        options: U,
    ) {
        this.schemas = schemas;
        this.options = options;
        this.client = new MongoClient(
            options.mongoUri ?? DEFAULT_MONGO_URI,
            options.clientOptions,
        );
        this.db = this.client.db(
            options.name,
            options.dbOptions,
        );
        this.collections = this.createCollections(schemas);
        this.applyMongoValidators(schemas).catch((error) => {
            console.error("Failed to apply MongoDB validators:", error);
        });
        if (options.indexes) {
            this.applyIndexes(options.indexes);
        }

        this.client.connect().catch((error) => {
            console.error("Failed to connect to MongoDB:", error);
        });
    }

    private createCollections(schemas: T): ZongoCollections<T> {
        return typedObjectEntries(schemas).reduce((prev, [key, schema]) => {
            prev[key] = this.db.collection<z.infer<typeof schema>>(key as string);
            return prev;
        }, {} as ZongoCollections<T>);
    }

    private async applyMongoValidators(schemas: T) {
        const collectionsArr = await this.db.listCollections().toArray();
        const collections = new Set(collectionsArr.map(c => c.name));
        for (const [key, schema] of Object.entries(schemas)) {
            try {
                if (collections.has(String(key))) {
                    await this.db.command({
                        collMod: String(key),
                        validator: zodToMongoValidator(schema, this.options.customJsonToBsonTypes),
                    });
                } else {
                    await this.db.createCollection(String(key), {
                        validator: zodToMongoValidator(schema, this.options.customJsonToBsonTypes),
                    });
                }
            } catch (error) {
                console.error(`Failed to apply validator for collection "${String(key)}":`, error);
            }
        }
    }

    private async applyIndexes(initIndexes: NonNullable<U["indexes"]>) {
        const existingIndexes = await this.db.listCollections().toArray();
        for (const index of existingIndexes) {
            if (index.name.startsWith("idx_")) {
                this.db.collection(index.name).dropIndex(index.name);
            }
        }

        for (const [collection, indexes] of Object.entries(initIndexes)) {
            if (!indexes) continue;
            for (const index of indexes) {
                this.collections[collection as string].createIndex(
                    index.index as any,
                    index.options,
                ).catch((error) => {
                    console.error(`Failed to create index for collection "${String(collection)}":`, error);
                });
            }
        }
    }
}

export type ZongoSchemas = Record<string, z.ZodObject<{ _id?: never } & Record<string, z.ZodTypeAny>>>;

export type ZongoCollections<T extends ZongoSchemas = ZongoSchemas> = {
    [K in keyof T]: Collection<z.infer<T[K]>>;
};

export type ZongoOptions<T extends ZongoSchemas> = {
    name: string;
    mongoUri?: string;
    clientOptions?: MongoClientOptions;
    dbOptions?: DbOptions;
    indexes?: ZongoIndexes<T>;
    customJsonToBsonTypes?: Partial<JsonToBsonTypes>;
};

type StrictZongoIndex<T extends ZongoSchemas, K extends keyof T> = {
    index: { [P in Paths<z.infer<T[K]>>]?: IndexDirection };
    options?: CreateIndexesOptions;
};

export type ZongoIndexes<T extends ZongoSchemas> = {
    [K in keyof T & string]?: Array<StrictZongoIndex<T, K>>;
};

export const zJobTimestamp = z.object({
	name: z.string(),
	timestamp: z.number().int(),
});
export type JobTimestamp = z.infer<typeof zJobTimestamp>;