import z from "zod";
import { typedObjectEntries } from "../util";

type JsonType = "object" | "array" | "number" | "boolean" | "string" | "null";

type BsonType =
	| "double"
	| "string"
	| "object"
	| "array"
	| "binData"
	| "objectId"
	| "bool"
	| "date"
	| "null"
	| "regex"
	| "javascript"
	| "int"
	| "timestamp"
	| "long"
	| "decimal"
	| "minKey"
	| "maxKey"
	| "number";

// https://www.mongodb.com/docs/manual/reference/operator/query/jsonSchema/#available-keywords

const JSON_TO_BSON_TYPES: Record<NonNullable<z.core.JSONSchema.JSONSchema["type"]>, BsonType> = {
	array: "array",
	boolean: "bool",
	integer: "int",
	null: "null",
	number: "number",
	object: "object",
	string: "string",
};

export type MongoSchema = {
	additionalItems?: boolean | MongoSchema;
	additionalProperties?: boolean | MongoSchema;
	allOf?: MongoSchema[];
	anyOf?: MongoSchema[];
	bsonType?: BsonType | BsonType[];
	dependencies?: {
		[k: string]: string[] | MongoSchema;
	};
	description?: string;
	enum?: Array<
		| string
		| number
		| boolean
		| z.core.JSONSchema.ObjectSchema
		| z.core.JSONSchema.ArraySchema
		| null
	>;
	exclusiveMaximum?: boolean;
	exclusiveMinimum?: boolean;
	items?: MongoSchema | MongoSchema[];
	maximum?: number;
	maxItems?: number;
	maxLength?: number;
	maxProperties?: number;
	minimum?: number;
	minItems?: number;
	minLength?: number;
	minProperties?: number;
	multipleOf?: number;
	not?: MongoSchema;
	oneOf?: MongoSchema[];
	pattern?: string;
	patternProperties?: {
		[reg: string]: MongoSchema;
	};
	properties?: {
		[key: string]: MongoSchema;
	};
	required?: string[];
	title?: string;
	type?: JsonType | JsonType[];
	uniqueItems?: boolean;
};

export function zodToMongoValidator(zod: z.ZodObject) {
	const jsonSchema = z.toJSONSchema(zod);
	const bsonSchema = toMongoSchema(jsonSchema);
	return { $jsonSchema: bsonSchema };
}

function toMongoSchema(jsonSchema: z.core.JSONSchema.JSONSchema): MongoSchema {
	if (!jsonSchema.type) throw new Error("Type is required");

	const cleanedSchema: MongoSchema = {};

	cleanedSchema.bsonType = Array.isArray(jsonSchema.type)
		? jsonSchema.type.map(
				(type: NonNullable<z.core.JSONSchema.JSONSchema["type"]>) =>
					JSON_TO_BSON_TYPES[type],
			)
		: JSON_TO_BSON_TYPES[jsonSchema.type];

	if (jsonSchema.description) {
		const [description, rawTags] = jsonSchema.description.split("##");
		const tags = rawTags.split(":");
		for (const tag of tags) {
			if (tag === "uniqueItems") {
				cleanedSchema.uniqueItems = true;
			}
		}
		if (description) {
			cleanedSchema.description = description;
		}
	}

	const allOf = jsonSchema.allOf?.map(toMongoSchema);
	if (allOf) {
		cleanedSchema.allOf = allOf;
	}

	const additionalItems =
		typeof jsonSchema.additionalItems === "object"
			? toMongoSchema(jsonSchema.additionalItems)
			: undefined;
	if (additionalItems) {
		cleanedSchema.additionalItems = additionalItems;
	}

	const additionalProperties =
		typeof jsonSchema.additionalProperties === "object"
			? toMongoSchema(jsonSchema.additionalProperties)
			: undefined;
	if (additionalProperties) {
		cleanedSchema.additionalProperties = additionalProperties;
	}

	const anyOf = jsonSchema.anyOf?.map(toMongoSchema);
	if (anyOf) {
		cleanedSchema.anyOf = anyOf;
	}

	if (jsonSchema.enum) {
		cleanedSchema.enum = jsonSchema.enum;
	}

	if (jsonSchema.oneOf) {
		cleanedSchema.oneOf = jsonSchema.oneOf.map(toMongoSchema);
	}

	if (jsonSchema.required) {
		cleanedSchema.required = jsonSchema.required;
	}

	if (jsonSchema.items) {
		cleanedSchema.items =
			typeof jsonSchema.items === "object"
				? Array.isArray(jsonSchema.items)
					? jsonSchema.items
							.filter((schema) => typeof schema === "object")
							.map(toMongoSchema)
					: toMongoSchema(jsonSchema.items)
				: undefined;
	}

	if (jsonSchema.exclusiveMaximum) {
		cleanedSchema.exclusiveMaximum = formatExclusive(jsonSchema.exclusiveMaximum);
	}

	if (jsonSchema.exclusiveMinimum) {
		cleanedSchema.exclusiveMinimum = formatExclusive(jsonSchema.exclusiveMinimum);
	}

	if (jsonSchema.maximum) {
		cleanedSchema.maximum = jsonSchema.maximum;
	}

	if (jsonSchema.minimum) {
		cleanedSchema.minimum = jsonSchema.minimum;
	}

	if (jsonSchema.maxItems) {
		cleanedSchema.maxItems = jsonSchema.maxItems;
	}

	if (jsonSchema.maxLength) {
		cleanedSchema.maxLength = jsonSchema.maxLength;
	}

	if (jsonSchema.maxProperties) {
		cleanedSchema.maxProperties = jsonSchema.maxProperties;
	}

	if (jsonSchema.minItems) {
		cleanedSchema.minItems = jsonSchema.minItems;
	}

	if (jsonSchema.minLength) {
		cleanedSchema.minLength = jsonSchema.minLength;
	}

	if (jsonSchema.minProperties) {
		cleanedSchema.minProperties = jsonSchema.minProperties;
	}

	if (jsonSchema.multipleOf) {
		cleanedSchema.multipleOf = jsonSchema.multipleOf;
	}

	if (jsonSchema.not && typeof jsonSchema.not === "object") {
		cleanedSchema.not = toMongoSchema(jsonSchema.not);
	}

	if (jsonSchema.pattern) {
		cleanedSchema.pattern = jsonSchema.pattern;
	}

	if (jsonSchema.patternProperties) {
		cleanedSchema.patternProperties = formatRecord(jsonSchema.patternProperties);
	}

	if (jsonSchema.properties) {
		cleanedSchema.properties = formatRecord(jsonSchema.properties);
	}

	if (jsonSchema.title) {
		cleanedSchema.title = jsonSchema.title;
	}

	if (jsonSchema.uniqueItems) {
		cleanedSchema.uniqueItems = jsonSchema.uniqueItems;
	}

	return cleanedSchema;
}

function formatExclusive(exclusive: boolean | number | undefined): boolean | undefined {
	if (typeof exclusive === "number") return true;
	return exclusive;
}

function formatRecord(
	record?: Record<string, z.core.JSONSchema._JSONSchema>,
): Record<string, MongoSchema> | undefined {
	return record
		? typedObjectEntries(record).reduce(
				(prev, [key, value]) => {
					if (typeof value !== "object") return prev;
					prev[key] = toMongoSchema(value);
					return prev;
				},
				{} as Record<string, MongoSchema>,
			)
		: undefined;
}
