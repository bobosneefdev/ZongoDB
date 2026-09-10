import { toJsonSchema } from "@standard-community/standard-json";
import type { StandardJSONSchemaV1, StandardTypedV1 } from "@standard-schema/spec";
import type { Db, ObjectId, OptionalUnlessRequiredId, WithId } from "mongodb";
import { z } from "zod";
import {
	compileCollections,
	compileSchema,
	createZongo,
	type Paths,
	type SchemaOutput,
} from "../src";

// Generic application helpers must preserve schema types without explicit map arguments.
function compileNamed<S extends StandardJSONSchemaV1<unknown, { name: string }>>(schema: S) {
	return compileCollections({ documents: { schema } });
}
function createNamed<S extends StandardJSONSchemaV1<unknown, { name: string }>>(db: Db, schema: S) {
	return createZongo({ db, collections: { documents: { schema } } });
}

// Compile-only assertions; this function is never run.
async function typeChecks(db: Db) {
	const namedSchema = z.object({ name: z.string(), scores: z.object({ 0: z.string() }) });
	const named = await createNamed(db, namedSchema);
	await named.collections.documents.insertOne({ name: "Ada", scores: { 0: "A" } });
	// @ts-expect-error Generic helpers preserve concrete required fields.
	await named.collections.documents.insertOne({ name: "Ada" });
	const compiled = await compileNamed(namedSchema);
	compiled.documents.$jsonSchema;
	// @ts-expect-error Generic helpers preserve collection names.
	compiled.missing;
	const readonlyKey = [
		["name", 1],
		["scores.0", -1],
	] as const;
	await compileCollections({
		documents: {
			schema: namedSchema,
			indexes: [{ rawKey: readonlyKey }, { key: { "scores.0": 1 } }],
		},
	});
	await createZongo({
		db,
		collections: { documents: { schema: namedSchema, indexes: [{ rawKey: readonlyKey }] } },
	});
	await compileCollections({
		documents: {
			schema: namedSchema,
			toJSONSchema: (s) => toJsonSchema(s, { target: "draft-7", io: "output" }),
		},
	});
	await compileCollections({
		documents: {
			schema: namedSchema,
			toJSONSchema: async (s) => await toJsonSchema(s, { target: "draft-7", io: "output" }),
		},
	});
	compileSchema(await toJsonSchema(namedSchema, { target: "draft-7", io: "output" }));
	const numericPath: Paths<{ scores: { 0: string; 1: string } }> = "scores.0";
	void numericPath;
	const result = await createZongo({
		db,
		collections: {
			users: {
				schema: z.object({
					name: z.string(),
					address: z.object({ city: z.string() }).optional(),
				}),
				indexes: [{ key: { "address.city": 1 } }],
			},
			custom: { schema: z.object({ _id: z.string(), count: z.number() }) },
			transformed: {
				schema: z.object({ count: z.string().transform(Number).pipe(z.number()) }),
			},
		},
	});
	await result.collections.users.insertOne({ name: "Ada" });
	// @ts-expect-error Required document fields are checked.
	await result.collections.users.insertOne({ address: { city: "London" } });
	// @ts-expect-error Incorrect field types are checked.
	await result.collections.users.insertOne({ name: 12 });
	const user = await result.collections.users.findOne({});
	const id: ObjectId | undefined = user?._id;
	const custom = await result.collections.custom.findOne({});
	const customId: string | undefined = custom?._id;
	// @ts-expect-error Custom IDs are required when declared required.
	await result.collections.custom.insertOne({ count: 1 });
	await result.collections.custom.insertOne({ _id: "one", count: 1 });
	await result.collections.transformed.insertOne({ count: 1 });
	// @ts-expect-error Stored documents use output, not input types.
	await result.collections.transformed.insertOne({ count: "1" });
	await createZongo({
		db,
		collections: {
			// @ts-expect-error Unknown index fields are rejected.
			users: { schema: z.object({ name: z.string() }), indexes: [{ key: { typo: 1 } }] },
		},
	});
	await createZongo({
		db,
		collections: {
			users: { schema: z.object({ name: z.string() }), indexes: [{ rawKey: { "$**": 1 } }] },
		},
	});
	// @ts-expect-error Scalar schemas cannot describe documents.
	await createZongo({ db, collections: { value: { schema: z.string() } } });
	const typed = {} as StandardTypedV1<unknown, { created: Date }>;
	// @ts-expect-error Typed-only schemas need a converter.
	await createZongo({ db, collections: { users: { schema: typed } } });
	await createZongo({
		db,
		collections: {
			users: {
				schema: typed,
				toJSONSchema: () => ({
					type: "object",
					properties: { created: { bsonType: "date" } },
				}),
			},
		},
	});
	type Stored = SchemaOutput<typeof typed>;
	const insert: OptionalUnlessRequiredId<Stored> = { created: new Date() };
	const read = {} as WithId<Stored>;
	const path: Paths<{
		created: Date;
		id: ObjectId;
		nested?: { label: string };
		list: { name: string }[];
	}> = "list.0.name";
	// @ts-expect-error BSON internals are not document paths.
	const invalid: Paths<{ id: ObjectId }> = "id.toHexString";
	void [id, customId, insert, read, path, invalid];
}
void typeChecks;
