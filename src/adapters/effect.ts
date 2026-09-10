import { JsonSchema, Schema, SchemaAST, SchemaRepresentation } from "effect";
import { Binary, ObjectId } from "mongodb";

const objectIdRepresentation = "zongodb/ObjectId";
const binaryRepresentation = "zongodb/Binary";
const bsonTypes: Record<string, string> = {
	"effect/schema/Date": "date",
	"effect/schema/Uint8Array": "binData",
	[objectIdRepresentation]: "objectId",
	[binaryRepresentation]: "binData",
};

/** Effect schema for MongoDB ObjectId values. */
export const ObjectIdSchema = Schema.declare(
	(input): input is ObjectId => input instanceof ObjectId,
	{
		expected: "a MongoDB ObjectId",
		representation: { id: objectIdRepresentation, payload: null },
	},
);

/** Effect schema for MongoDB Binary values. */
export const BinarySchema = Schema.declare((input): input is Binary => input instanceof Binary, {
	expected: "MongoDB binary data",
	representation: { id: binaryRepresentation, payload: null },
});

function markBsonTypes(ast: SchemaAST.AST): SchemaAST.AST {
	const id = (ast.annotations?.representation as { id?: string } | undefined)?.id;
	if (id && bsonTypes[id]) return Schema.Unknown.annotate({ bsonType: bsonTypes[id] }).ast;
	const recursive = ast as SchemaAST.AST & {
		recur?: (f: (child: SchemaAST.AST) => SchemaAST.AST) => SchemaAST.AST;
	};
	return recursive.recur ? recursive.recur(markBsonTypes) : ast;
}

/** Convert an Effect v4 output schema to MongoDB's JSON Schema dialect. */
export function effectToMongoSchema(schema: Schema.Constraint): object {
	const source = Schema.toRepresentation(Schema.make(markBsonTypes(Schema.toType(schema).ast)));
	const document = SchemaRepresentation.toJsonSchemaDocument(source, {
		includeAnnotationKey: (key) => key === "bsonType",
	});
	const draft7 = JsonSchema.toDocumentDraft07(document);
	const output = draft7.schema;
	if (Object.keys(draft7.definitions).length) output.definitions = draft7.definitions;
	return output;
}
