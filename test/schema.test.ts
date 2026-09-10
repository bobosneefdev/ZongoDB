import { describe, expect, test } from "bun:test";
import { toJsonSchema } from "@standard-community/standard-json";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { type } from "arktype";
import * as v from "valibot";
import { z } from "zod";
import { compileCollections, compileSchema, SchemaConversionError } from "../src";

describe("schema compilation", () => {
	test("preserves constraints and does not mutate schemas", () => {
		const input = {
			type: "object",
			additionalProperties: false,
			properties: {
				count: { type: "integer", minimum: 0, maximum: 0 },
				score: { type: "number", minimum: 10, exclusiveMinimum: 5, exclusiveMaximum: 20 },
				kind: { const: "user", enum: ["user", "admin"] },
				empty: { type: "string", maxLength: 0 },
				items: {
					type: "array",
					items: [{ type: "string" }],
					additionalItems: false,
					uniqueItems: true,
				},
			},
		};
		const original = structuredClone(input);
		const output = compileSchema(input).$jsonSchema;
		expect(input).toEqual(original);
		expect(output).toMatchObject({
			additionalProperties: false,
			properties: {
				_id: { bsonType: "objectId" },
				count: { minimum: 0, maximum: 0, allOf: [{ multipleOf: 1 }] },
				score: {
					minimum: 10,
					allOf: [
						{ minimum: 5, exclusiveMinimum: true },
						{ maximum: 20, exclusiveMaximum: true },
					],
				},
				kind: { allOf: [{ enum: ["user"] }, { enum: ["user", "admin"] }] },
				empty: { maxLength: 0 },
				items: { additionalItems: false, uniqueItems: true },
			},
		});
	});

	test("resolves shared local refs and reserves IDs in closed union branches", () => {
		const output = compileSchema({
			definitions: { label: { type: "string", minLength: 1 } },
			anyOf: ["a", "b"].map((kind) => ({
				type: "object",
				additionalProperties: false,
				properties: { kind: { const: kind }, label: { $ref: "#/definitions/label" } },
			})),
		}).$jsonSchema;
		expect(output.properties).toEqual({ _id: { bsonType: "objectId" } });
		for (const branch of output.anyOf as any[])
			expect(branch.properties).toMatchObject({
				_id: {},
				label: { bsonType: "string", minLength: 1 },
			});
	});

	test("keeps explicit IDs and BSON types", () => {
		const output = compileSchema({
			type: "object",
			properties: { _id: { type: "string" }, date: { bsonType: "date" } },
		});
		expect(output.$jsonSchema.properties).toEqual({
			_id: { bsonType: "string" },
			date: { bsonType: "date" },
		});
	});

	test("root refs preserve custom IDs and negative checks do not declare IDs", () => {
		const ref = compileSchema({
			$schema: "http://json-schema.org/draft-07/schema#",
			$ref: "#/$defs/document",
			$defs: {
				document: {
					type: "object",
					additionalProperties: false,
					properties: { _id: { type: "string" } },
				},
			},
		});
		expect(ref.$jsonSchema.properties).toEqual({ _id: { bsonType: "string" } });
		const negative = compileSchema({
			type: "object",
			not: { properties: { _id: { type: "string" } } },
		});
		expect(negative.$jsonSchema.properties).toEqual({ _id: { bsonType: "objectId" } });
	});

	test("rejects cyclic object graphs and non-JSON literal values", () => {
		const recursive: Record<string, unknown> = { type: "object" };
		recursive.properties = { node: recursive };
		expect(() => compileSchema(recursive)).toThrow("Recursive");
		expect(() =>
			compileSchema({ type: "object", properties: { value: { const: new Date() } } }),
		).toThrow(SchemaConversionError);
	});

	test.each([
		{ type: "object", properties: { email: { type: "string", format: "email" } } },
		{ type: "object", properties: { node: { $ref: "#" } } },
		{ type: "object", properties: { node: { $ref: "https://example.com/schema" } } },
		{ type: "object", properties: { node: { $ref: "#/missing" } } },
		{ type: "object", properties: { age: { minimum: Number.NaN } } },
		{ type: "object", properties: { age: { exclusiveMinimum: true } } },
		{ type: "object", properties: { age: { type: "mystery" } } },
		{ type: "object", properties: { age: { minimum: undefined } } },
		{ type: "array" },
		{ type: "object", unevaluatedProperties: false },
	])("rejects unsupported or malformed schemas: %j", (schema) => {
		expect(() => compileSchema(schema)).toThrow(SchemaConversionError);
	});

	test("reports precise keyword paths", () => {
		expect(() =>
			compileSchema({ type: "object", properties: { "a/b": { format: "email" } } }),
		).toThrow("#/properties/a~1b/format");
	});

	test("three native libraries compile equivalent document shapes", async () => {
		const validators = await compileCollections({
			zod: { schema: z.strictObject({ name: z.string(), age: z.number().min(0) }) },
			valibot: {
				schema: toStandardJsonSchema(
					v.strictObject({ name: v.string(), age: v.pipe(v.number(), v.minValue(0)) }),
				),
			},
			arktype: { schema: type({ name: "string", age: "number >= 0", "+": "reject" }) },
		});
		expect(validators.valibot).toEqual(validators.zod);
		expect(validators.arktype.$jsonSchema).toEqual({
			...validators.zod.$jsonSchema,
			required: ["age", "name"],
		});
	});

	test("standard-json is an optional per-collection bridge", async () => {
		const schema = z.object({ name: z.string() });
		const result = await compileCollections({
			users: {
				schema,
				toJSONSchema: async (s, options) => {
					expect(options).toEqual({ target: "draft-07", io: "output" });
					return (await toJsonSchema(s, { target: "draft-7", io: "output" })) as Record<
						string,
						unknown
					>;
				},
			},
		});
		expect(result.users).toEqual(
			compileSchema(schema["~standard"].jsonSchema.output({ target: "draft-07" })),
		);
	});
});
