import {
	Collection,
	CreateIndexesOptions,
	Db,
	DbOptions,
	IndexDescription,
	IndexDirection,
	IndexSpecification,
	MongoClient,
	MongoClientOptions,
} from "mongodb";
import z from "zod";
import { DEFAULT_MONGO_URI } from "./constants";
import { JsonToBsonTypes, Paths } from "./types";
import { typedObjectEntries } from "./util";
import { zodToMongoValidator } from "./util/zod_to_mongo_validator";

export class Zongo<T extends ZongoSchemas, U extends ZongoOptions<T>> {
	readonly schemas: T;
	readonly options: U;
	readonly client: MongoClient;
	readonly db: Db;
	readonly collections: ZongoCollections<T>;
	/**
	 * Resolves once the client is connected and validators/indexes have been
	 * applied. Await this before relying on schema validation or indexes; it
	 * rejects if setup failed instead of silently logging.
	 */
	readonly ready: Promise<this>;

	constructor(schemas: T, options: U) {
		this.schemas = schemas;
		this.options = options;
		this.client = new MongoClient(options.mongoUri ?? DEFAULT_MONGO_URI, options.clientOptions);
		this.db = this.client.db(options.name, options.dbOptions);
		this.collections = this.createCollections(schemas);
		this.ready = this.init();
		// Prevent an unhandled rejection if the caller never awaits `ready`;
		// callers that do await still observe the real error.
		this.ready.catch(() => {});
	}

	/**
	 * Connect and apply validators and indexes. Called automatically by the
	 * constructor (exposed via {@link ready}); also safe to await directly.
	 */
	async init(): Promise<this> {
		await this.client.connect();
		await this.applyMongoValidators(this.schemas);
		await this.applyIndexes(this.options.indexes ?? {});
		return this;
	}

	private createCollections(schemas: T): ZongoCollections<T> {
		return typedObjectEntries(schemas).reduce(
			(prev, [key, schema]) => {
				prev[key] = this.db.collection<z.infer<typeof schema>>(key as string);
				return prev;
			},
			{} as ZongoCollections<T>,
		);
	}

	private async applyMongoValidators(schemas: T) {
		const collectionsArr = await this.db.listCollections().toArray();
		const collections = new Set(collectionsArr.map((c) => c.name));
		const errors: Error[] = [];
		for (const [key, schema] of Object.entries(schemas)) {
			try {
				const validator = zodToMongoValidator(schema, this.options.customJsonToBsonTypes);
				if (collections.has(String(key))) {
					await this.db.command({ collMod: String(key), validator });
				} else {
					await this.db.createCollection(String(key), { validator });
				}
			} catch (error) {
				errors.push(
					new Error(`Failed to apply validator for collection "${String(key)}"`, {
						cause: error,
					}),
				);
			}
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, "Failed to apply one or more MongoDB validators");
		}
	}

	private async applyIndexes(initIndexes: NonNullable<U["indexes"]>) {
		const errors: Error[] = [];
		for (const [collection, indexes] of Object.entries(initIndexes)) {
			if (!indexes) continue;
			const coll = this.collections[collection as string];

			const desired = indexes.map((index) => {
				const name = managedIndexName(index.index, index.options?.name);
				return { key: index.index, name, options: { ...index.options, name } };
			});
			const desiredByName = new Map(desired.map((d) => [d.name, d]));

			let existing: IndexDescription[] = [];
			try {
				existing = (await coll.indexes()) as IndexDescription[];
			} catch {
				// Collection may not exist yet; createIndex will create it.
			}

			try {
				// Drop only Zongo-managed indexes that are stale or whose
				// reconcilable options (e.g. expireAfterSeconds) changed.
				for (const ex of existing) {
					if (!ex.name?.startsWith(MANAGED_INDEX_PREFIX)) continue;
					const want = desiredByName.get(ex.name);
					if (!want || indexOptionsDiffer(ex, want.options)) {
						await coll.dropIndex(ex.name);
					}
				}

				const present = new Set(
					existing
						.filter((ex) => ex.name && desiredByName.has(ex.name))
						.filter(
							(ex) => !indexOptionsDiffer(ex, desiredByName.get(ex.name!)!.options),
						)
						.map((ex) => ex.name),
				);
				for (const d of desired) {
					if (present.has(d.name)) continue;
					await coll.createIndex(d.key as IndexSpecification, d.options);
				}
			} catch (error) {
				errors.push(
					new Error(`Failed to apply indexes for collection "${String(collection)}"`, {
						cause: error,
					}),
				);
			}
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, "Failed to apply one or more MongoDB indexes");
		}
	}
}

/** Prefix marking indexes managed by Zongo, so reconciliation never touches
 * `_id_` or indexes a user created by hand. */
const MANAGED_INDEX_PREFIX = "zongo_";

/** Build a deterministic, managed index name from its key spec. */
function managedIndexName(
	key: Record<string, IndexDirection | undefined>,
	override?: string,
): string {
	if (override) return `${MANAGED_INDEX_PREFIX}${override}`;
	const suffix = Object.entries(key)
		.map(([field, dir]) => `${field}_${dir}`)
		.join("_");
	return `${MANAGED_INDEX_PREFIX}${suffix}`;
}

/** Whether an existing index differs from the desired options in a way that
 * requires dropping and recreating it (MongoDB rejects in-place option changes). */
function indexOptionsDiffer(existing: IndexDescription, options: CreateIndexesOptions): boolean {
	const ex = existing as IndexDescription & { expireAfterSeconds?: number; unique?: boolean };
	if ((ex.expireAfterSeconds ?? undefined) !== (options.expireAfterSeconds ?? undefined)) {
		return true;
	}
	if (Boolean(ex.unique) !== Boolean(options.unique)) return true;
	return false;
}

export type ZongoSchemas = Record<
	string,
	z.ZodObject<{ _id?: never } & Record<string, z.ZodTypeAny>>
>;

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
