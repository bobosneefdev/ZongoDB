import { Binary, ObjectId } from "mongodb";
import { z } from "zod";

function bsonType(schema: z.core.$ZodType): string | undefined {
	if (schema._zod.def.type === "date") return "date";
	const Class = schema._zod.bag.Class;
	if (Class === ObjectId) return "objectId";
	if (Class === Binary || Class === Uint8Array || Class === Buffer) return "binData";
}

/** Convert a Zod output schema to MongoDB's JSON Schema dialect. */
export function zodToMongoSchema(schema: z.core.$ZodType): object {
	return z.toJSONSchema(schema, {
		target: "draft-07",
		io: "output",
		unrepresentable: ({ zodSchema }) => {
			const type = bsonType(zodSchema);
			return type ? { bsonType: type } : undefined;
		},
	});
}
