import type { MongoSchema, MongoValidator } from "./types";

const annotations = new Set([
	"title",
	"description",
	"$comment",
	"default",
	"examples",
	"readOnly",
	"writeOnly",
	"deprecated",
]);
const bsonTypes = new Set([
	"double",
	"string",
	"object",
	"array",
	"binData",
	"objectId",
	"bool",
	"date",
	"null",
	"regex",
	"javascript",
	"int",
	"timestamp",
	"long",
	"decimal",
	"minKey",
	"maxKey",
	"number",
]);
const jsonTypes: Record<string, string> = {
	object: "object",
	array: "array",
	string: "string",
	boolean: "bool",
	null: "null",
	number: "number",
	integer: "number",
};
const counts = new Set([
	"minItems",
	"maxItems",
	"minLength",
	"maxLength",
	"minProperties",
	"maxProperties",
]);

export class SchemaConversionError extends Error {
	readonly path: string;
	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "SchemaConversionError";
		this.path = path;
	}
}

function fail(path: string, message: string): never {
	throw new SchemaConversionError(path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	) {
		fail(path, "Expected a schema object");
	}
	return value as Record<string, unknown>;
}

function child(path: string, key: string | number): string {
	return `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function strings(value: unknown, path: string): string[] {
	if (
		!Array.isArray(value) ||
		!value.every((item) => typeof item === "string") ||
		new Set(value).size !== value.length
	)
		fail(path, "Expected an array of unique strings");
	return value;
}

function jsonValue(value: unknown, path: string, parents = new Set<object>()): void {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	)
		return;
	if (!value || typeof value !== "object") fail(path, "Expected a JSON value");
	if (parents.has(value) || parents.size > 100)
		fail(path, "Cyclic or excessively deep JSON value");
	parents.add(value);
	for (const [key, item] of Object.entries(Array.isArray(value) ? value : record(value, path)))
		jsonValue(item, child(path, key), parents);
	parents.delete(value);
}

/** Compile a Draft 7 document schema without connecting to MongoDB or mutating the input. */
export function compileSchema(input: object): MongoValidator {
	const root = record(input, "#");
	const active = new Set<object>();
	let expandedNodes = 0;
	let customId = false;
	function convert(
		value: unknown,
		path: string,
		documentRoot = false,
		declareId = true,
	): MongoSchema {
		// ponytail: bound reference expansion; reject pathological schemas instead of exhausting memory.
		if (++expandedNodes > 10000 || active.size > 100)
			fail(path, "Schema expansion exceeds 10,000 nodes or 100 levels");
		if (value === true) return {};
		if (value === false) return { not: {} };
		const source = record(value, path);
		if (active.has(source)) fail(path, "Recursive schemas are not supported");
		active.add(source);
		try {
			if (
				source.$schema !== undefined &&
				source.$schema !== "http://json-schema.org/draft-07/schema#" &&
				source.$schema !== "https://json-schema.org/draft-07/schema#"
			)
				fail(child(path, "$schema"), "Expected JSON Schema Draft 7");
			if (source.$ref !== undefined) {
				if (typeof source.$ref !== "string" || !source.$ref.startsWith("#"))
					fail(child(path, "$ref"), "Only local JSON Pointer references are supported");
				if (
					Object.keys(source).some(
						(key) =>
							!["$ref", "$schema", "definitions", "$defs"].includes(key) &&
							!annotations.has(key),
					)
				)
					fail(path, "Draft 7 $ref siblings are not supported; use allOf");
				let pointer: string;
				try {
					pointer = decodeURIComponent(source.$ref.slice(1));
				} catch {
					return fail(path, "Invalid reference encoding");
				}
				if (pointer !== "" && !pointer.startsWith("/"))
					fail(path, "Only JSON Pointer references are supported");
				let target: unknown = root;
				for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
					if (/~(?:[^01]|$)/.test(token)) fail(path, "Invalid JSON Pointer escape");
					const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
					if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
						fail(path, `Unresolved reference ${source.$ref}`);
					target = (target as Record<string, unknown>)[key];
				}
				return convert(target, `${path}/$ref(${source.$ref})`, documentRoot, declareId);
			}
			const result: MongoSchema = {};
			const extra: MongoSchema[] = [];
			for (const [key, item] of Object.entries(source)) {
				const at = child(path, key);
				if (annotations.has(key)) {
					if (key === "description" || key === "title") {
						if (typeof item !== "string") fail(at, "Expected a string");
						result[key] = item;
					}
					continue;
				}
				if (key === "$schema") continue;
				if (key === "definitions" || key === "$defs") {
					record(item, at);
					continue;
				}
				if (key === "type" || key === "bsonType") {
					if (source.type !== undefined && source.bsonType !== undefined)
						fail(at, "Use either type or bsonType, not both");
					const types = Array.isArray(item) ? strings(item, at) : [item];
					if (
						!types.length ||
						!types.every(
							(type) =>
								typeof type === "string" &&
								(key === "type"
									? Object.hasOwn(jsonTypes, type)
									: bsonTypes.has(type)),
						)
					)
						fail(at, "Unknown or invalid type");
					const alternatives = types.map((type) =>
						type === "integer"
							? { bsonType: "number", multipleOf: 1 }
							: { bsonType: key === "type" ? jsonTypes[type as string] : type },
					);
					if (alternatives.length === 1) {
						result.bsonType = alternatives[0].bsonType;
						if (types[0] === "integer") extra.push({ multipleOf: 1 });
					} else extra.push({ anyOf: alternatives });
					continue;
				}
				if (key === "properties" || key === "patternProperties") {
					const fields = record(item, at);
					if (
						documentRoot &&
						declareId &&
						key === "properties" &&
						Object.hasOwn(fields, "_id")
					)
						customId = true;
					result[key] = Object.fromEntries(
						Object.entries(fields).map(([name, schema]) => [
							name,
							convert(schema, child(at, name)),
						]),
					);
					continue;
				}
				if (key === "allOf" || key === "anyOf" || key === "oneOf") {
					if (!Array.isArray(item) || !item.length)
						fail(at, "Expected a nonempty array of schemas");
					result[key] = item.map((schema, i) =>
						convert(schema, child(at, i), documentRoot, declareId),
					);
					continue;
				}
				if (key === "not") {
					result.not = convert(item, at, documentRoot, false);
					continue;
				}
				if (key === "additionalProperties" || key === "additionalItems") {
					result[key] = typeof item === "boolean" ? item : convert(item, at);
					continue;
				}
				if (key === "items") {
					result.items = Array.isArray(item)
						? item.map((schema, i) => convert(schema, child(at, i)))
						: convert(item, at);
					if (Array.isArray(item) && !item.length)
						fail(at, "Empty tuple schemas are not supported; use maxItems: 0");
					continue;
				}
				if (key === "dependencies") {
					result.dependencies = Object.fromEntries(
						Object.entries(record(item, at)).map(([name, dependency]) => [
							name,
							Array.isArray(dependency)
								? strings(dependency, child(at, name))
								: convert(dependency, child(at, name), documentRoot, false),
						]),
					);
					continue;
				}
				if (key === "required") {
					const names = strings(item, at);
					if (names.length) result.required = names;
					continue;
				}
				if (key === "enum" || key === "const") {
					const values = key === "const" ? [item] : item;
					if (!Array.isArray(values) || !values.length)
						fail(at, "Expected a nonempty enum");
					jsonValue(values, at);
					extra.push({ enum: structuredClone(values) });
					continue;
				}
				if (
					key === "minimum" ||
					key === "maximum" ||
					key === "exclusiveMinimum" ||
					key === "exclusiveMaximum" ||
					key === "multipleOf" ||
					counts.has(key)
				) {
					if (typeof item !== "number" || !Number.isFinite(item))
						fail(at, "Expected a finite number");
					if (counts.has(key) && (!Number.isInteger(item) || item < 0))
						fail(at, "Expected a nonnegative integer");
					if (key === "multipleOf" && item <= 0) fail(at, "Expected a positive divisor");
					if (key === "exclusiveMinimum")
						extra.push({ minimum: item, exclusiveMinimum: true });
					else if (key === "exclusiveMaximum")
						extra.push({ maximum: item, exclusiveMaximum: true });
					else result[key] = item;
					continue;
				}
				if (key === "pattern") {
					if (typeof item !== "string") fail(at, "Expected a pattern string");
					result.pattern = item;
					continue;
				}
				if (key === "uniqueItems") {
					if (typeof item !== "boolean") fail(at, "Expected a boolean");
					result.uniqueItems = item;
					continue;
				}
				fail(
					at,
					`Unsupported keyword "${key}"; provide an explicit toMongoSchema converter`,
				);
			}
			if (
				documentRoot &&
				(result.additionalProperties !== undefined || result.properties !== undefined)
			) {
				const properties = (result.properties ?? {}) as Record<string, unknown>;
				// Reserve the driver's _id field in each root branch, but never overwrite a custom ID.
				result.properties = { _id: {}, ...properties };
			}
			if (extra.length) result.allOf = [...((result.allOf as MongoSchema[]) ?? []), ...extra];
			return result;
		} finally {
			active.delete(source);
		}
	}

	const converted = convert(root, "#", true);
	function objectOnly(schema: MongoSchema): boolean {
		return (
			schema.bsonType === "object" ||
			(schema.allOf as MongoSchema[] | undefined)?.some(objectOnly) === true ||
			[schema.anyOf, schema.oneOf].some(
				(branches) =>
					Array.isArray(branches) && branches.length && branches.every(objectOnly),
			)
		);
	}
	if (!objectOnly(converted)) fail("#", "Collection schemas must describe object documents");
	if (!customId)
		converted.properties = {
			...((converted.properties as object) ?? {}),
			_id: { bsonType: "objectId" },
		};
	return { $jsonSchema: converted };
}
