import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { type } from "arktype";
import { Schema } from "effect";
import {
	Binary,
	type CreateIndexesOptions,
	type Db,
	type IndexSpecification,
	MongoClient,
	ObjectId,
} from "mongodb";
import * as v from "valibot";
import { z } from "zod";
import { compileSchema, createZongo, ZongoInitializationError } from "../src";
import { BinarySchema, effectToMongoSchema, ObjectIdSchema } from "../src/adapters/effect";
import { zodToMongoSchema } from "../src/adapters/zod";

const client = new MongoClient(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017", {
	serverSelectionTimeoutMS: 3000,
});
const databaseName = `zongo_v5_test_${crypto.randomUUID().replaceAll("-", "")}`;
const db = client.db(databaseName);

beforeAll(async () => {
	await client.connect();
});
afterAll(async () => {
	try {
		await db.dropDatabase();
	} finally {
		await client.close();
	}
});

describe("MongoDB validation", () => {
	test("awaits indexes and enforces inserts, updates, bulk writes, and custom IDs", async () => {
		const result = await createZongo({
			db,
			collections: {
				users: {
					schema: z.strictObject({
						name: z.string().min(1),
						age: z.number().int().min(0),
						kind: z.literal("user"),
						score: z.number().gt(5).lt(10),
					}),
					indexes: [{ key: { name: 1 }, unique: true }],
				},
				custom: { schema: z.strictObject({ _id: z.string(), count: z.number() }) },
			},
		});
		const valid = { name: "Ada", age: 0, kind: "user" as const, score: 6 };
		const inserted = await result.collections.users.insertOne(valid);
		expect(inserted.insertedId).toBeInstanceOf(ObjectId);
		await expect(
			result.collections.users.insertOne({ ...valid, name: "Ada" }),
		).rejects.toMatchObject({ code: 11000 });
		for (const bad of [
			{ age: -1 },
			{ age: 0.5 },
			{ score: 5 },
			{ score: 10 },
			{ kind: "admin" },
			{ extra: true },
		]) {
			await expect(
				db.collection("users").insertOne({ ...valid, name: crypto.randomUUID(), ...bad }),
			).rejects.toMatchObject({ code: 121 });
			await expect(
				db.collection("users").updateOne({ _id: inserted.insertedId }, { $set: bad }),
			).rejects.toMatchObject({ code: 121 });
		}
		await expect(
			result.collections.users.bulkWrite([
				{ insertOne: { document: { ...valid, name: "Bulk", age: -1 } } },
			]),
		).rejects.toThrow();
		await result.collections.custom.insertOne({ _id: "custom", count: 1 });
		await expect(db.collection("custom").insertOne({ count: 1 })).rejects.toMatchObject({
			code: 121,
		});
		expect((await result.collections.custom.findOne({}))?._id).toBe("custom");
	});

	test("enforces the same contract from Zod, Valibot, and ArkType", async () => {
		const result = await createZongo({
			db,
			collections: {
				zod: { schema: z.strictObject({ name: z.string(), age: z.number().min(0) }) },
				valibot: {
					schema: toStandardJsonSchema(
						v.strictObject({
							name: v.string(),
							age: v.pipe(v.number(), v.minValue(0)),
						}),
					),
				},
				arktype: { schema: type({ name: "string", age: "number >= 0", "+": "reject" }) },
			},
		});
		for (const collection of Object.values(result.collections)) {
			await collection.insertOne({ name: "Grace", age: 0 });
			await expect(collection.insertOne({ name: "Grace", age: -1 })).rejects.toMatchObject({
				code: 121,
			});
			await expect(collection.updateOne({}, { $set: { age: -1 } })).rejects.toMatchObject({
				code: 121,
			});
		}
	});

	test("closed root unions allow generated IDs but reject extra fields", async () => {
		const schema = z.union([
			z.strictObject({ kind: z.literal("a"), name: z.string() }),
			z.strictObject({ kind: z.literal("b"), count: z.number() }),
		]);
		const result = await createZongo({ db, collections: { unions: { schema } } });
		await result.collections.unions.insertOne({ kind: "a", name: "A" });
		await result.collections.unions.insertOne({ kind: "b", count: 1 });
		await expect(
			db.collection("unions").insertOne({ kind: "a", name: "A", count: 1 }),
		).rejects.toMatchObject({ code: 121 });
	});

	test("handles refs, tuples, booleans, nulls, uniqueness, and zero limits", async () => {
		const validator = compileSchema({
			type: "object",
			additionalProperties: false,
			definitions: { label: { type: "string", pattern: "^[A-Z]+$" } },
			properties: {
				label: { $ref: "#/definitions/label" },
				empty: { type: "string", maxLength: 0 },
				tuple: {
					type: "array",
					items: [{ type: "integer" }, { type: "string" }],
					additionalItems: false,
				},
				unique: { type: "array", items: true, uniqueItems: true },
				forbidden: false,
				maybe: { type: ["integer", "null"] },
			},
		});
		const collection = await db.createCollection("features", { validator });
		await collection.insertOne({
			label: "YES",
			empty: "",
			tuple: [1, "a"],
			unique: [1, 2],
			maybe: null,
		});
		await collection.insertOne({ maybe: 1 });
		for (const bad of [
			{ label: "no" },
			{ empty: "x" },
			{ tuple: [1, "a", true] },
			{ unique: [1, 1] },
			{ forbidden: 1 },
			{ maybe: 0.5 },
		]) {
			await expect(collection.insertOne(bad)).rejects.toMatchObject({ code: 121 });
		}
	});

	test("custom converters support BSON values without executing transforms", async () => {
		const result = await createZongo({
			db,
			collections: {
				dates: {
					schema: z.strictObject({ created: z.date() }),
					toMongoSchema: zodToMongoSchema,
				},
			},
		});
		await result.collections.dates.insertOne({ created: new Date() });
		await expect(
			db.collection("dates").insertOne({ created: "2026-01-01" }),
		).rejects.toMatchObject({ code: 121 });
	});

	test("Effect declarations validate and round-trip BSON values", async () => {
		const result = await createZongo({
			db,
			collections: {
				effectValues: {
					schema: Schema.toStandardSchemaV1(
						Schema.Struct({
							created: Schema.Date,
							id: ObjectIdSchema,
							data: BinarySchema,
						}),
					),
					toMongoSchema: effectToMongoSchema,
				},
			},
		});
		const value = { created: new Date(), id: new ObjectId(), data: new Binary([1, 2]) };
		await result.collections.effectValues.insertOne(value);
		const row = await result.collections.effectValues.findOne({});
		expect(row?.created).toBeInstanceOf(Date);
		expect(row?.id).toBeInstanceOf(ObjectId);
		expect(row?.data).toBeInstanceOf(Binary);
	});

	test("adopts v4 TTL indexes and validates native BSON fields", async () => {
		const schema = z.strictObject({
			ref: z.instanceof(ObjectId),
			createdAt: z.date(),
			blob: z.union([z.instanceof(Binary), z.instanceof(Uint8Array)]),
		});
		const definition = {
			schema,
			toMongoSchema: zodToMongoSchema,
			indexes: [
				{
					key: { createdAt: 1 as const },
					name: "zongo_createdAt_1",
					expireAfterSeconds: 3600,
				},
			],
		};
		await db
			.collection("sessions")
			.createIndex({ createdAt: 1 }, { name: "zongo_createdAt_1", expireAfterSeconds: 3600 });
		const result = await createZongo({ db, collections: { sessions: definition } });
		const indexes = await result.collections.sessions.listIndexes().toArray();
		expect(indexes.filter((index) => index.name !== "_id_")).toHaveLength(1);
		expect(
			indexes.find((index) => index.name === "zongo_createdAt_1")?.expireAfterSeconds,
		).toBe(3600);
		for (const blob of [
			new Binary(new Uint8Array([1, 2])),
			new Uint8Array([1, 2]),
			Buffer.from([1, 2]),
		]) {
			await result.collections.sessions.insertOne({
				ref: new ObjectId(),
				createdAt: new Date(),
				blob,
			});
		}
		const row = await result.collections.sessions.findOne({});
		expect(row?.ref).toBeInstanceOf(ObjectId);
		expect(row?.createdAt).toBeInstanceOf(Date);
		expect(row?.blob).toBeInstanceOf(Binary);
		for (const bad of [
			{ ref: "not-an-object-id" },
			{ createdAt: "not-a-date" },
			{ blob: "not-binary" },
		]) {
			await expect(
				db.collection("sessions").insertOne({
					ref: new ObjectId(),
					createdAt: new Date(),
					blob: new Binary(),
					...bad,
				}),
			).rejects.toMatchObject({ code: 121 });
		}
		await expect(
			createZongo({
				db,
				collections: {
					sessions: {
						...definition,
						indexes: [{ ...definition.indexes[0], expireAfterSeconds: 7200 }],
					},
				},
			}),
		).rejects.toMatchObject({ collection: "sessions", operation: "createIndex" });
		expect(
			(await result.collections.sessions.listIndexes().toArray()).find(
				(index) => index.name === "zongo_createdAt_1",
			)?.expireAfterSeconds,
		).toBe(3600);
	});

	test("preserves schema dependencies and nested closed objects", async () => {
		const validator = compileSchema({
			type: "object",
			additionalProperties: false,
			properties: {
				trigger: { type: "boolean" },
				reason: { type: "string" },
				nested: {
					type: "object",
					additionalProperties: false,
					properties: { count: { type: "number", maximum: 0, exclusiveMinimum: -2 } },
				},
			},
			dependencies: { trigger: ["reason"] },
		});
		const collection = await db.createCollection("dependencies", { validator });
		await collection.insertOne({ trigger: true, reason: "yes", nested: { count: 0 } });
		for (const bad of [
			{ trigger: true },
			{ nested: { count: 1 } },
			{ nested: { count: -2 } },
			{ nested: { _id: new ObjectId() } },
		]) {
			await expect(collection.insertOne(bad)).rejects.toMatchObject({ code: 121 });
		}
	});

	test("reinitialization updates validators and keeps existing indexes", async () => {
		await db.createCollection("existing");
		await db.collection("existing").createIndex({ untouched: 1 }, { name: "keep_me" });
		const definition = {
			schema: z.object({ name: z.string() }),
			indexes: [{ key: { name: 1 as const } }],
		};
		await createZongo({ db, collections: { existing: definition } });
		await createZongo({ db, collections: { existing: definition } });
		const names = (await db.collection("existing").listIndexes().toArray()).map(
			(index) => index.name,
		);
		expect(names).toContain("keep_me");
		expect(names).toContain("name_1");
		await expect(db.collection("existing").insertOne({})).rejects.toMatchObject({ code: 121 });
	});

	test("reuses equivalent differently named indexes across repeated initialization", async () => {
		const collection = db.collection("equivalent_indexes");
		await collection.createIndex(
			{ name: 1, active: 1 },
			{
				name: "legacy_partial",
				unique: true,
				partialFilterExpression: { active: true },
				collation: { locale: "en", strength: 2 },
			},
		);
		await collection.createIndex(
			{ expiresAt: 1 },
			{ name: "legacy_ttl", sparse: true, expireAfterSeconds: 60 },
		);
		const definition = {
			schema: z.object({
				name: z.string(),
				active: z.boolean(),
				expiresAt: z.string().optional(),
			}),
			indexes: [
				{
					key: { name: 1 as const, active: 1 as const },
					name: "current_partial",
					unique: true,
					partialFilterExpression: { active: true },
					collation: { locale: "en", strength: 2 },
				},
				{
					key: { expiresAt: 1 as const },
					name: "current_ttl",
					sparse: true,
					expireAfterSeconds: 60,
				},
			],
		};
		await createZongo({ db, collections: { equivalent_indexes: definition } });
		await createZongo({ db, collections: { equivalent_indexes: definition } });
		expect(
			(await collection.listIndexes().toArray())
				.filter(({ name }) => name !== "_id_")
				.map(({ name }) => name),
		).toEqual(["legacy_partial", "legacy_ttl"]);
	});

	test("rejects same-key indexes with incompatible effective options", async () => {
		const cases = [
			[{ unique: true }, {}],
			[
				{ partialFilterExpression: { active: true } },
				{ partialFilterExpression: { active: false } },
			],
			[{ expireAfterSeconds: 60 }, { expireAfterSeconds: 120 }],
			[{ sparse: true }, {}],
			[
				{ collation: { locale: "en", strength: 2 } },
				{ collation: { locale: "en", strength: 1 } },
			],
		] as const;
		for (const [position, [existingOptions, requestedOptions]] of cases.entries()) {
			const name = `option_conflict_${position}`;
			const collection = db.collection(name);
			await collection.createIndex({ value: 1 }, { name: "existing", ...existingOptions });
			await expect(
				createZongo({
					db,
					collections: {
						[name]: {
							schema: z.object({
								value: z.string(),
								active: z.boolean(),
							}),
							indexes: [
								{ key: { value: 1 }, name: "requested", ...requestedOptions },
							],
						},
					},
				}),
			).rejects.toMatchObject({ collection: name, operation: "createIndex" });
			expect(
				(await collection.listIndexes().toArray()).filter(({ name }) => name !== "_id_"),
			).toHaveLength(1);
		}
	});

	test("delegates specialized index equivalence to MongoDB", async () => {
		const cases: {
			name: string;
			key: IndexSpecification;
			existing: CreateIndexesOptions;
			requested: CreateIndexesOptions;
			accepted: boolean;
		}[] = [
			{
				name: "danish",
				key: { value: 1 },
				existing: { collation: { locale: "da" } },
				requested: { collation: { locale: "da" } },
				accepted: true,
			},
			{ name: "text", key: { value: "text" }, existing: {}, requested: {}, accepted: true },
			{
				name: "text_weights",
				key: { value: "text" },
				existing: { weights: { value: 2 } },
				requested: { weights: { value: 3 } },
				accepted: false,
			},
			{
				name: "wildcard",
				key: { "$**": 1 },
				existing: { wildcardProjection: { a: 1 } },
				requested: { wildcardProjection: { b: 1 } },
				accepted: false,
			},
			{
				name: "geo",
				key: { value: "2d" },
				existing: { bits: 20 },
				requested: { bits: 22 },
				accepted: false,
			},
			{
				name: "hidden",
				key: { value: 1 },
				existing: { hidden: true },
				requested: {},
				accepted: false,
			},
			{
				name: "embedded_filter",
				key: { value: 1 },
				existing: { partialFilterExpression: { obj: { $eq: { a: 1, b: 2 } } } },
				requested: { partialFilterExpression: { obj: { $eq: { b: 2, a: 1 } } } },
				accepted: false,
			},
		];
		for (const { name, key, existing, requested, accepted } of cases) {
			const collectionName = `specialized_${name}`;
			const collection = db.collection(collectionName);
			await collection.createIndex(key, { ...existing, name: "legacy" });
			const before = await collection.listIndexes().toArray();
			const initialize = () =>
				createZongo({
					db,
					collections: {
						[collectionName]: {
							schema: z.object({ value: z.string() }),
							indexes: [{ rawKey: key, ...requested, name: "current" }],
						},
					},
				});
			if (accepted) {
				await initialize();
				await initialize();
			} else {
				await expect(initialize()).rejects.toMatchObject({
					collection: collectionName,
					operation: "createIndex",
				});
			}
			expect(await collection.listIndexes().toArray()).toEqual(before);
		}
	});

	test("checks all same-key candidates and refreshes after creating an index", async () => {
		const collection = await db.createCollection("index_candidates", {
			collation: { locale: "da" },
		});
		await collection.createIndex({ value: 1 }, { name: "ordinary" });
		await collection.createIndex({ value: 1 }, { name: "unique", unique: true });
		const result = await createZongo({
			db,
			collections: {
				index_candidates: {
					schema: z.object({ value: z.string(), other: z.string() }),
					indexes: [
						{ key: { value: 1 }, unique: true, name: "adopt_unique" },
						{ key: { other: 1 }, name: "new_index" },
						{ key: { other: 1 }, name: "adopt_new_index" },
					],
				},
			},
		});
		expect(
			(await result.collections.index_candidates.listIndexes().toArray()).map(
				({ name }) => name,
			),
		).toEqual(["_id_", "ordinary", "unique", "new_index"]);
	});

	test("readonly compound index tuples preserve order without mutation", async () => {
		const keys = Object.freeze([
			Object.freeze(["name", 1] as const),
			Object.freeze(["rank", -1] as const),
		] as const);
		const result = await createZongo({
			db,
			collections: {
				ordered: {
					schema: z.object({
						name: z.string(),
						rank: z.number(),
						scores: z.object({ 0: z.string() }),
					}),
					indexes: [
						{ rawKey: keys, name: "ordered_fields" },
						{ key: { "scores.0": 1 }, name: "numeric_path" },
					],
				},
			},
		});
		const indexes = await result.collections.ordered.listIndexes().toArray();
		expect(
			Object.entries(indexes.find((index) => index.name === "ordered_fields")!.key),
		).toEqual([
			["name", 1],
			["rank", -1],
		]);
		expect(indexes.find((index) => index.name === "numeric_path")!.key).toEqual({
			"scores.0": 1,
		});
		expect(keys).toEqual([
			["name", 1],
			["rank", -1],
		]);
	});

	test("compile failure happens before any collection is created", async () => {
		await expect(
			createZongo({
				db,
				collections: {
					must_not_exist: { schema: z.object({ name: z.string() }) },
					bad: { schema: z.object({ email: z.email() }) },
				},
			}),
		).rejects.toMatchObject({ collection: "bad", operation: "compile", completed: [] });
		expect(await db.listCollections({ name: "must_not_exist" }).toArray()).toHaveLength(0);
	});

	test("index conflicts reject with partial progress and preserve the index", async () => {
		await db.collection("conflict").createIndex({ name: 1 }, { name: "named" });
		try {
			await createZongo({
				db,
				collections: {
					conflict: {
						schema: z.object({ name: z.string() }),
						indexes: [{ key: { name: 1 }, name: "named", unique: true }],
					},
				},
			});
			throw new Error("Expected index conflict");
		} catch (error) {
			expect(error).toBeInstanceOf(ZongoInitializationError);
			expect(error).toMatchObject({
				collection: "conflict",
				operation: "createIndex",
				completed: [{ collection: "conflict", operation: "collMod" }],
			});
			expect((error as Error).cause).toBeDefined();
		}
		expect(
			(await db.collection("conflict").listIndexes().toArray()).find(
				(index) => index.name === "named",
			)?.unique,
		).toBeUndefined();
	});

	test("connection and validator failures preserve their cause", async () => {
		const cause = new Error("permission denied");
		const fakeDb = {
			createCollection: async () => {
				throw cause;
			},
		} as unknown as Db;
		await expect(
			createZongo({
				db: fakeDb,
				collections: { denied: { schema: z.object({ name: z.string() }) } },
			}),
		).rejects.toMatchObject({
			collection: "denied",
			operation: "createCollection",
			cause,
			completed: [],
		});
		const existing = {
			createCollection: async () => {
				throw { code: 48 };
			},
			command: async () => {
				throw cause;
			},
		} as unknown as Db;
		await expect(
			createZongo({
				db: existing,
				collections: { denied: { schema: z.object({ name: z.string() }) } },
			}),
		).rejects.toMatchObject({ operation: "collMod", cause, completed: [] });
	});
});
