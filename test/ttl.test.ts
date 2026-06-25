import { ObjectId } from "mongodb";
import z from "zod";
import { zObjectId } from "../src/bson";
import { Zongo } from "../src/database";

const DB = new Zongo(
	{
		session: z.object({
			ref: zObjectId(),
			createdAt: z.date(),
		}),
	},
	{
		name: "ZongoTtlTest",
		indexes: {
			session: [{ index: { createdAt: 1 }, options: { expireAfterSeconds: 3600 } }],
		},
	},
);

describe("ttl + native types", () => {
	beforeAll(async () => {
		await DB.collections.session.deleteMany({});
		await DB.ready;
	});

	afterAll(async () => {
		await DB.client.close();
	});

	it("creates a managed TTL index", async () => {
		const indexes = await DB.collections.session.indexes();
		const ttl = indexes.find((i) => i.name === "zongo_createdAt_1");
		expect(ttl).toBeDefined();
		expect((ttl as { expireAfterSeconds?: number }).expireAfterSeconds).toBe(3600);
	});

	it("accepts a native Date and ObjectId past the validator", async () => {
		const result = await DB.collections.session.insertOne({
			ref: new ObjectId(),
			createdAt: new Date(),
		});
		expect(result.acknowledged).toBe(true);
	});
});
