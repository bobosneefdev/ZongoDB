import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Binary, ObjectId } from "mongodb";
import { z } from "zod";
import { BinarySchema, effectToMongoSchema, ObjectIdSchema } from "../src/adapters/effect";
import { zodToMongoSchema } from "../src/adapters/zod";
import { compileSchema } from "../src/schema";

describe("Mongo schema adapters", () => {
	test("Zod maps Date, ObjectId, and binary values", () => {
		const output = compileSchema(
			zodToMongoSchema(
				z.object({
					created: z.date(),
					id: z.instanceof(ObjectId),
					data: z.union([z.instanceof(Binary), z.instanceof(Uint8Array)]),
				}),
			),
		).$jsonSchema.properties as Record<string, unknown>;
		expect(output.created).toEqual({ bsonType: "date" });
		expect(output.id).toEqual({ bsonType: "objectId" });
		expect(output.data).toEqual({
			anyOf: [{ bsonType: "binData" }, { bsonType: "binData" }],
		});
	});

	test("Effect maps Date, ObjectId, and binary outputs", () => {
		const output = compileSchema(
			effectToMongoSchema(
				Schema.Struct({
					created: Schema.DateFromString,
					id: ObjectIdSchema,
					binary: BinarySchema,
					data: Schema.Uint8Array,
				}),
			),
		).$jsonSchema;
		const properties = output.properties as Record<string, unknown>;
		expect(output.additionalProperties).toBe(false);
		expect(properties.created).toEqual({ bsonType: "date" });
		expect(properties.id).toEqual({ bsonType: "objectId" });
		expect(properties.binary).toEqual({ bsonType: "binData" });
		expect(properties.data).toEqual({ bsonType: "binData" });
	});
});
