import z from "zod";

export function zodToMongoValidator(zod: z.ZodObject) {
    const jsonSchema = z.toJSONSchema(zod);
    delete jsonSchema.$schema;
    return {
        $jsonSchema: {
            ...jsonSchema,
            properties: {
                ...jsonSchema.properties,
                _id: {
                    bsonType: "objectId",
                },
            },
        },
    }
}