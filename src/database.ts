import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import type { Db, IndexSpecification } from "mongodb";
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
			const { schema, toJSONSchema } = definition as CollectionDefinition<DocumentSchema>;
			if (schema?.["~standard"]?.version !== 1)
				throw new Error("Expected a version 1 standard schema");
			const json = toJSONSchema
				? await toJSONSchema(schema, { target: "draft-07", io: "output" })
				: (schema as StandardJSONSchemaV1)["~standard"].jsonSchema?.output({
						target: "draft-07",
					});
			if (!json)
				throw new Error(
					"Schema has no native JSON Schema output converter; supply toJSONSchema",
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
			for (const index of definition.indexes ?? []) {
				operation = "createIndex";
				const { key, rawKey, ...indexOptions } = index;
				// The driver copies index entries into its own Map, including readonly tuples.
				await collection.createIndex((rawKey ?? key) as IndexSpecification, indexOptions);
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
