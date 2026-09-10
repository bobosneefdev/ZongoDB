# ZongoDB

Standard schemas → typed MongoDB collections with database-enforced validation.

ZongoDB compiles document schemas to MongoDB validators, installs them and declared indexes, then returns native `Collection<T>` instances. It does not wrap writes, execute schema transformations, or own your connection.

## Install

```sh
bun add @bobosneefdev/zongodb mongodb
# Choose your schema library; for example:
bun add zod
```

ESM only. Requires Node 20.19+, MongoDB driver 7, and TypeScript 5.4+ for type declarations. Schema-library adapters use optional peer dependencies and do not affect the core import.

## Usage

```ts
import { createZongo } from "@bobosneefdev/zongodb";
import { MongoClient } from "mongodb";
import { z } from "zod";

const client = new MongoClient(process.env.MONGODB_URI!);
await client.connect();

try {
  const database = await createZongo({
    db: client.db("app"),
    collections: {
      users: {
        schema: z.strictObject({
          name: z.string().min(1),
          age: z.number().int().min(0),
        }),
        indexes: [{ key: { name: 1 }, unique: true }],
      },
    },
  });

  await database.collections.users.insertOne({ name: "Ada", age: 36 });
  const user = await database.collections.users.findOne({ name: "Ada" });
  // user: { _id: ObjectId; name: string; age: number } | null
} finally {
  await client.close();
}
```

The factory resolves after validators and indexes are installed. Failures reject with `ZongoInitializationError`, which includes `collection`, `operation`, `cause`, and `completed` operations. Successful results expose `db`, `collections`, and the compiled `validators`.

Sessions, transactions, aggregation, update pipelines, bulk writes, and driver options remain native MongoDB APIs. Driver validation bypass options and database privileges retain their normal meaning.

## Schema libraries

The default input implements [Standard JSON Schema](https://standardschema.dev/json-schema). ZongoDB requests `jsonSchema.output({ target: "draft-07" })` and infers the stored **output** type. A validation-only Standard Schema needs a converter.

```ts
// Zod: native support
const users = { schema: z.object({ name: z.string() }) };

// Valibot: use its official wrapper
import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
const usersV = { schema: toStandardJsonSchema(v.object({ name: v.string() })) };

// ArkType: native support
import { type } from "arktype";
const usersA = { schema: type({ name: "string" }) };
```

Tests exercise Zod 4.6, Valibot 1.5 with its JSON Schema package 1.7, and ArkType 2.2. Other conforming implementations can work when they emit the supported dialect. No vendor detection occurs in core.

Schemas describe **stored documents**. Parse/transform/default your input before inserting it. ZongoDB cannot reproduce arbitrary refinements, nor discover constraints an upstream converter has omitted. An output schema that cannot be represented in JSON Schema needs an explicit converter.

## Optional standard-json bridge

Install [standard-json](https://github.com/standard-community/standard-json) and any converter dependencies required by your schema library. Its options are vendor-specific; the example below is for Zod.

```ts
import { toJsonSchema } from "@standard-community/standard-json";
import { compileCollections } from "@bobosneefdev/zongodb";

const validators = await compileCollections({
  users: {
    schema: z.object({ name: z.string() }),
    toMongoSchema: (schema) => toJsonSchema(schema, { target: "draft-7", io: "output" }),
  },
});
```

The `toMongoSchema(schema)` hook accepts schema objects, promises, and promise-like results. Its result must describe the stored output type using JSON Schema plus MongoDB's `bsonType` extension. The compiler validates the result at runtime. The old `toJSONSchema` name remains as a deprecated compatibility alias.

## BSON and custom IDs

Omit `_id` for the driver's default ObjectId behavior. Declare `_id: z.string()` for an application-supplied string ID. MongoDB's restrictions on ID values still apply. If a custom ID schema rejects ObjectIds, supply an ID on every insert, including when the schema marks it optional.

For BSON-specific values, use a packaged adapter instead of duplicating the schema. The Zod adapter maps `z.date()`, `z.instanceof(ObjectId)`, and `Binary`/`Uint8Array`/`Buffer` instance schemas. The Effect v4 adapter maps the output side of `Schema.Date`, date codecs, `Schema.Uint8Array`, and its exported `ObjectIdSchema` and `BinarySchema` declarations.

```ts
import { zodToMongoSchema } from "@bobosneefdev/zongodb/zod";

const events = {
  schema: z.strictObject({ created: z.date() }),
  toMongoSchema: zodToMongoSchema,
};
```

Effect schemas need their Standard Schema wrapper for collection typing:

```ts
import { Schema } from "effect";
import {
  BinarySchema,
  effectToMongoSchema,
  ObjectIdSchema,
} from "@bobosneefdev/zongodb/effect";

const events = {
  schema: Schema.toStandardSchemaV1(
    Schema.Struct({
      created: Schema.Date,
      owner: ObjectIdSchema,
      data: BinarySchema,
    }),
  ),
  toMongoSchema: effectToMongoSchema,
};
```

For other BSON values or schema libraries, return an explicit Mongo-compatible schema from `toMongoSchema`. Do not specify both `type` and `bsonType` on the same node.

## Compiler contract

`compileSchema(jsonSchema)` is a pure, synchronous function returning `{ $jsonSchema }`. `compileCollections(definitions)` runs native/custom converters and returns a map of these validators without touching a database.

```ts
import { compileCollections, compileSchema } from "@bobosneefdev/zongodb";

const validators = await compileCollections({ users });
const validator = compileSchema({
  type: "object",
  properties: { tags: { type: "array", items: { type: "string" }, uniqueItems: true } },
});
```

Supported source dialect: JSON Schema Draft 7, with optional `bsonType` and local `$defs` references. Conversion targets [MongoDB's modified Draft 4 dialect](https://www.mongodb.com/docs/manual/reference/operator/query/jsonSchema/).

| Feature | Behavior |
| --- | --- |
| Objects, properties, required, additional/pattern properties | Preserved; `_id` reserved in root branches |
| Arrays, tuples, additional items, uniqueness | Preserved; empty tuple lists rejected (use `maxItems: 0`) |
| Strings, patterns, lengths | Preserved; patterns must be compatible with MongoDB's regex engine |
| Numbers, bounds, multiples | Zero bounds preserved; exclusive bounds translated |
| Integers, including nullable integer unions | Numeric BSON value constrained to a multiple of 1 |
| `enum`, `const`, `allOf`, `anyOf`, `oneOf`, `not`, dependencies | Translated without dropping constraints |
| Boolean subschemas | Supported |
| Local JSON Pointer `$ref` | Expanded; recursive/external refs rejected |
| `title`, `description` | Preserved verbatim |
| `default`, `examples`, `$comment`, read/write/deprecated annotations | Ignored; never executed |
| `format`, `propertyNames`, conditionals, newer/unknown keywords | Rejected with the schema path |

Collection roots must establish an object type, directly or through supported compositions. `_id` is not added to nested objects. Root property-count and whole-object equality constraints apply to the stored document, including `_id`. Compilation is bounded to 10,000 expanded nodes and 100 nesting levels. No remote schemas are fetched.

## Indexes and initialization

Indexes live next to their schema and accept MongoDB `CreateIndexesOptions`. `key` suggests inferred document paths, including numeric object keys (up to eight levels, excluding Date/BSON internals). Use `rawKey` for dynamic or advanced specifications, including ordered tuples or maps. Readonly tuples declared with `as const` are supported:

```ts
indexes: [
  { key: { name: 1 }, unique: true, name: "unique_name" },
  { rawKey: new Map([["name", 1], ["age", -1]]), name: "ordered_compound" },
]
```

Initialization is additive for indexes: no deletion or automatic replacement. Existing collections receive `collMod` with strict/error validation. Existing data is not scanned, repaired, or migrated. All schemas compile first, but database changes across collections are not atomic; inspect `completed` after a failure. Manage destructive changes through your own migrations.

## Development

```sh
bun install --frozen-lockfile
bun run lint
bun run check
bun run test
```

Tests require MongoDB at `mongodb://127.0.0.1:27017`, or `MONGODB_URI`. They create and drop a uniquely named `zongo_v5_test_*` database and do not touch application databases. The package smoke test installs a temporary packed consumer, requiring registry access, and checks Node ESM imports and TypeScript inference without Zod.

`bun run format` applies formatting/lint fixes; `lint` and `check` do not write files. `bun run test:integration` runs database checks; `bun run test:package` builds and verifies the packed package.

See [the v5 migration guide](docs/migration-v5.md) for the intentional breaking changes.
