import { Binary, ObjectId } from "mongodb";
import z from "zod";
import { BsonType } from "./types";

/**
 * Meta key used to tag a Zod schema with the MongoDB BSON type it should map to
 * in a generated `$jsonSchema` validator. Read by the `override` callback in
 * {@link zodToMongoValidator}.
 */
export const BSON_TYPE_META_KEY = "mongoBsonType";

/** Sentinel key embedded into the intermediate JSON Schema by the override. */
export const BSON_TYPE_SENTINEL = "x-bson";

function withBsonType<T extends z.ZodType>(schema: T, bsonType: BsonType): T {
	return schema.meta({ [BSON_TYPE_META_KEY]: bsonType }) as T;
}

/**
 * A field stored as a native BSON `ObjectId`. JSON Schema has no representation
 * for ObjectId, so this is tagged for the validator generator to emit
 * `bsonType: "objectId"`.
 */
export function zObjectId() {
	return withBsonType(z.instanceof(ObjectId), "objectId");
}

/**
 * A field stored as native BSON binary data (`Buffer` / `Uint8Array` / driver
 * `Binary`). Emits `bsonType: "binData"`.
 */
export function zBinary() {
	return withBsonType(z.union([z.instanceof(Binary), z.instanceof(Uint8Array)]), "binData");
}

/**
 * A field stored as a native BSON `date`. Plain `z.date()` is detected
 * automatically by the validator generator, but this helper is provided for a
 * single, explicit import surface alongside {@link zObjectId} / {@link zBinary}.
 */
export function zDate() {
	return z.date();
}
