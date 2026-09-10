import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { type } from "arktype";
import { type Db, MongoClient, ObjectId } from "mongodb";
import * as v from "valibot";
import { z } from "zod";
import { compileSchema, createZongo, ZongoInitializationError } from "../src";

const client = new MongoClient(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017", {
	serverSelectionTimeoutMS: 3000,
});
const databaseName = `zongo_v4_test_${crypto.randomUUID().replaceAll("-", "")}`;
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
					toJSONSchema: () => ({
						type: "object",
						required: ["created"],
						additionalProperties: false,
						properties: { created: { bsonType: "date" } },
					}),
				},
			},
		});
		await result.collections.dates.insertOne({ created: new Date() });
		await expect(
			db.collection("dates").insertOne({ created: "2026-01-01" }),
		).rejects.toMatchObject({ code: 121 });
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
