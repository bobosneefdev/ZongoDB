import z from "zod";
import { zBinary, zDate, zObjectId } from "../src/bson";
import { zodToMongoValidator } from "../src/util/zod_to_mongo_validator";

describe("zodToMongoValidator native BSON types", () => {
	const schema = z.object({
		name: z.string(),
		createdAt: z.date(),
		expireAt: zDate(),
		ref: zObjectId(),
		blob: zBinary(),
	});

	const { $jsonSchema } = zodToMongoValidator(schema);
	const props = $jsonSchema.properties!;

	it("maps z.date() to bsonType date", () => {
		expect(props.createdAt.bsonType).toBe("date");
		expect(props.expireAt.bsonType).toBe("date");
	});

	it("maps zObjectId() to bsonType objectId", () => {
		expect(props.ref.bsonType).toBe("objectId");
	});

	it("maps zBinary() to bsonType binData", () => {
		expect(props.blob.bsonType).toBe("binData");
	});

	it("does not regress plain string fields", () => {
		expect(props.name.bsonType).toBe("string");
	});
});
