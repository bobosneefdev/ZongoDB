import type { StandardJSONSchemaV1, StandardTypedV1 } from "@standard-schema/spec";
import type { Collection, CreateIndexesOptions, IndexDirection, IndexSpecification } from "mongodb";

export type DocumentSchema = StandardTypedV1<unknown, object>;
export type SchemaOutput<S extends DocumentSchema> = StandardTypedV1.InferOutput<S>;

type Atomic = Date | RegExp | Uint8Array | { readonly _bsontype: string };
// ponytail: cap suggestions at eight levels; rawKey covers deeper or dynamic indexes.
export type Paths<T, Depth extends unknown[] = []> = Depth["length"] extends 8
	? never
	: T extends Atomic
		? never
		: T extends readonly (infer Item)[]
			?
					| `${number}`
					| Paths<Item, [...Depth, unknown]>
					| `${number}.${Paths<Item, [...Depth, unknown]>}`
			: T extends object
				? {
						[K in keyof T & (string | number)]:
							| `${K}`
							| `${K}.${Paths<NonNullable<T[K]>, [...Depth, unknown]>}`;
					}[keyof T & (string | number)]
				: never;

/** The driver reads tuple keys without mutating them. */
export type ZongoIndexSpecification =
	| IndexSpecification
	| readonly [string, IndexDirection]
	| readonly (readonly [string, IndexDirection])[];

export type ZongoIndex<T extends object> = CreateIndexesOptions &
	(
		| { key: Partial<Record<Paths<T> | "_id", IndexDirection>>; rawKey?: never }
		| { rawKey: ZongoIndexSpecification; key?: never }
	);

/** Return a MongoDB-compatible schema for the stored output type. */
export type MongoSchemaConverter<S extends DocumentSchema> = (
	schema: S,
) => object | PromiseLike<object>;

/** @deprecated Use MongoSchemaConverter and toMongoSchema. */
export type SchemaConverter<S extends DocumentSchema> = (
	schema: S,
	options: { target: "draft-07"; io: "output" },
) => object | PromiseLike<object>;

type CollectionOptions<S extends DocumentSchema> = {
	schema: S;
	indexes?: readonly ZongoIndex<SchemaOutput<S>>[];
	toMongoSchema?: MongoSchemaConverter<NoInfer<S>>;
	/** @deprecated Use toMongoSchema. */
	toJSONSchema?: SchemaConverter<NoInfer<S>>;
};

export type CollectionDefinition<S extends DocumentSchema> = CollectionOptions<S> &
	(S extends StandardJSONSchemaV1
		? unknown
		:
				| { toMongoSchema: MongoSchemaConverter<NoInfer<S>> }
				| { toJSONSchema: SchemaConverter<NoInfer<S>> });

/** A direct inference path for native schemas, including generic application wrappers. */
export type NativeCollectionDefinitions<
	T extends Record<string, StandardJSONSchemaV1<unknown, object>>,
> = {
	[K in keyof T]: CollectionOptions<T[K]>;
};

export type CollectionDefinitions<T extends Record<string, DocumentSchema>> = {
	[K in keyof T]: CollectionDefinition<T[K]>;
};

export type ZongoCollections<T extends Record<string, DocumentSchema>> = {
	[K in keyof T]: Collection<SchemaOutput<T[K]>>;
};

/** MongoDB's JSON Schema dialect. Values are checked by compileSchema and MongoDB. */
export type MongoSchema = Record<string, unknown>;
export type MongoValidator = { $jsonSchema: MongoSchema };
