import z from "zod";

export type Paths<T> = T extends object
	? {
			[K in keyof T]: K extends string | number
				? T[K] extends object
					? T[K] extends any[]
						?
								| `${K}`
								| `${K}${"."}${number}`
								| `${K}${"."}${Paths<T[K][number]>}`
						: `${K}` | `${K}${"."}${Paths<T[K]>}`
					: `${K}`
				: never;
		}[keyof T]
	: never;

export type JsonType = NonNullable<z.core.JSONSchema.JSONSchema["type"]>;

export type BsonType =
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

export type JsonToBsonTypes = Record<NonNullable<z.core.JSONSchema.JSONSchema["type"]>, BsonType>;