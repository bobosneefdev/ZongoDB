import { isDeepStrictEqual } from "node:util";
import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import type { Db, IndexDescriptionInfo, IndexDirection, IndexSpecification } from "mongodb";
import { compileSchema } from "./schema";
import type {
	CollectionDefinition,
	CollectionDefinitions,
	DocumentSchema,
	MongoValidator,
	NativeCollectionDefinitions,
	ZongoCollections,
} from "./types";

export type InitializationStep = {
	collection: string;
	operation: "createCollection" | "collMod" | "createIndex";
};

export class ZongoInitializationError extends Error {
	readonly collection: string;
	readonly operation: "compile" | InitializationStep["operation"];
	readonly completed: readonly InitializationStep[];
	constructor(
		collection: string,
		operation: ZongoInitializationError["operation"],
		cause: unknown,
		completed: readonly InitializationStep[] = [],
	) {
		super(`ZongoDB: ${operation} failed for collection "${collection}"`, { cause });
		this.name = "ZongoInitializationError";
		this.collection = collection;
		this.operation = operation;
		this.completed = [...completed];
	}
}

const indexKeys = (specification: IndexSpecification): [string, IndexDirection][] => {
	const isTuple =
		Array.isArray(specification) &&
		specification.length === 2 &&
		typeof specification[0] === "string" &&
		(typeof specification[1] === "number" ||
			["2d", "2dsphere", "text", "geoHaystack"].includes(specification[1] as string));
	const parts = !Array.isArray(specification) || isTuple ? [specification] : specification;
	const keys = new Map<string, IndexDirection>();
	for (const part of parts) {
		if (typeof part === "string") keys.set(part, 1);
		else if (Array.isArray(part)) keys.set(part[0], part[1] ?? 1);
		else
			for (const [field, direction] of part instanceof Map ? part : Object.entries(part))
				keys.set(field, direction as IndexDirection);
	}
	return [...keys];
};

/** Generate every validator before performing any database operations. */
export function compileCollections<T extends Record<string, StandardJSONSchemaV1<unknown, object>>>(
	definitions: NativeCollectionDefinitions<T>,
): Promise<{ [K in keyof T]: MongoValidator }>;
export function compileCollections<T extends Record<string, DocumentSchema>>(
	definitions: CollectionDefinitions<T>,
): Promise<{ [K in keyof T]: MongoValidator }>;
export async function compileCollections<T extends Record<string, DocumentSchema>>(
	definitions: CollectionDefinitions<T>,
): Promise<{ [K in keyof T]: MongoValidator }> {
	const validators: Record<string, MongoValidator> = Object.create(null);
	for (const [name, definition] of Object.entries(definitions)) {
		try {
			if (!name || name.includes("\0") || name.includes("$") || name.startsWith("system."))
				throw new Error("Invalid collection name");
			const { schema, toMongoSchema, toJSONSchema } =
				definition as CollectionDefinition<DocumentSchema>;
			if (toMongoSchema && toJSONSchema)
				throw new Error("Use either toMongoSchema or toJSONSchema, not both");
			if (schema?.["~standard"]?.version !== 1)
				throw new Error("Expected a version 1 standard schema");
			const json = toMongoSchema
				? await toMongoSchema(schema)
				: toJSONSchema
					? await toJSONSchema(schema, { target: "draft-07", io: "output" })
					: (schema as StandardJSONSchemaV1)["~standard"].jsonSchema?.output({
							target: "draft-07",
						});
			if (!json)
				throw new Error(
					"Schema has no native JSON Schema output converter; supply toMongoSchema",
				);
			validators[name] = compileSchema(json);
		} catch (cause) {
			throw new ZongoInitializationError(name, "compile", cause);
		}
	}
	return validators as { [K in keyof T]: MongoValidator };
}

/** The caller owns the Db/client. Resolves only after validators and indexes are installed. */
export function createZongo<
	T extends Record<string, StandardJSONSchemaV1<unknown, object>>,
>(options: { db: Db; collections: NativeCollectionDefinitions<T> }): Promise<ZongoDatabase<T>>;
export function createZongo<T extends Record<string, DocumentSchema>>(options: {
	db: Db;
	collections: CollectionDefinitions<T>;
}): Promise<ZongoDatabase<T>>;
export async function createZongo<T extends Record<string, DocumentSchema>>(options: {
	db: Db;
	collections: CollectionDefinitions<T>;
}): Promise<ZongoDatabase<T>> {
	const validators = await compileCollections(options.collections);
	const completed: InitializationStep[] = [];
	const collections: Record<string, unknown> = Object.create(null);
	for (const [name, definition] of Object.entries(options.collections)) {
		let operation: InitializationStep["operation"] = "createCollection";
		try {
			const validation = {
				validator: validators[name],
				validationLevel: "strict" as const,
				validationAction: "error" as const,
			};
			try {
				await options.db.createCollection(name, validation);
			} catch (error) {
				if (!error || typeof error !== "object" || !("code" in error) || error.code !== 48)
					throw error;
				operation = "collMod";
				await options.db.command({ collMod: name, ...validation });
			}
			completed.push({ collection: name, operation });
			const collection = options.db.collection(name);
			collections[name] = collection;
			let existingIndexes: IndexDescriptionInfo[] | undefined;
			for (const index of definition.indexes ?? []) {
				operation = "createIndex";
				const { key, rawKey, ...indexOptions } = index;
				const specification = (rawKey ?? key) as IndexSpecification;
				const keys = indexKeys(specification);
				existingIndexes ??= await collection.listIndexes().toArray();
				const candidates = existingIndexes.filter((existing) =>
					keys.some(([, direction]) => direction === "text")
						? existing.key._fts === "text"
						: isDeepStrictEqual(Object.entries(existing.key), keys),
				);
				if (candidates.length === 0) {
					await collection.createIndex(specification, indexOptions);
					// Refresh lazily: MongoDB normalizes stored index keys and options.
					existingIndexes = undefined;
				} else {
					let conflict: unknown;
					for (const existing of candidates) {
						if (Boolean(existing.hidden) !== Boolean(indexOptions.hidden)) {
							conflict = new Error(
								`Index "${existing.name}" has an incompatible hidden setting`,
							);
							continue;
						}
						try {
							// Reuse the name; let MongoDB compare effective options, including locale defaults.
							await collection.createIndex(specification, {
								...indexOptions,
								name: existing.name,
							});
							conflict = undefined;
							break;
						} catch (error) {
							if (
								!error ||
								typeof error !== "object" ||
								!("code" in error) ||
								(error.code !== 85 && error.code !== 86)
							)
								throw error;
							conflict = error;
						}
					}
					if (conflict) throw conflict;
				}
				completed.push({ collection: name, operation });
			}
		} catch (cause) {
			throw new ZongoInitializationError(name, operation, cause, completed);
		}
	}
	return { db: options.db, collections: collections as ZongoCollections<T>, validators };
}

export type ZongoDatabase<T extends Record<string, DocumentSchema>> = {
	db: Db;
	collections: ZongoCollections<T>;
	validators: { [K in keyof T]: MongoValidator };
};
