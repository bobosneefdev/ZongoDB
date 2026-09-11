# Migrating to v5

This is a hard-cut release from the published Zod-based v4 (and earlier v3). There are no compatibility exports.

| v3 / v4 | v5 |
| --- | --- |
| `new Zongo(schemas, options)` | `await createZongo({ db, collections })` |
| Library-created connection, implicit localhost | Caller creates and closes `MongoClient` |
| `{ users: userSchema }` | `{ users: { schema: userSchema, indexes: [...] } }` |
| Global `indexes` option with `index` keys | Collection-local indexes with `key` (or `rawKey`) |
| Required Zod peer | Native Standard JSON Schema, or typed schema plus `toMongoSchema` |
| `customJsonToBsonTypes` | Per-collection `toMongoSchema`, with explicit `bsonType` fields |
| `describe("##uniqueItems")` | Actual `uniqueItems: true` in the converted JSON Schema |
| `zJobTimestamp` / `JobTimestamp` | Define your application's schemas locally |
| `zObjectId()`, `zBinary()`, `zDate()` and automatic `z.date()` conversion | Use your schema library's types and a per-collection BSON converter |
| `ready` / `init()` | Await `createZongo` |
| Automatically reconciled `zongo_` indexes | Additive indexes, with explicit migrations for changes |
| Advertised CommonJS entry | ESM only, Node 20.19+ |

## Validation changes

Zero bounds, literal values, integer constraints, exclusivity, and closed objects now affect database validation. Schemas that previously accepted invalid writes may reject them. `_id` is reserved at the document root so closed objects can use MongoDB-generated ObjectIds. Explicit custom `_id` schemas are preserved; declare custom IDs as required when the application must supply them.

Unsupported validation keywords now produce `SchemaConversionError` through the initialization error's `cause`. In particular, MongoDB does not enforce JSON Schema `format`, and v5 rejects it instead of dropping it. Convert such constraints explicitly to a suitable `pattern`, or intentionally remove them in your converter and perform application validation separately. Arbitrary refinements omitted by an upstream converter cannot be detected by ZongoDB.

Descriptions are preserved verbatim. Old `##` tags have no behavior.

## Deployment changes

Initialization now fails if a validator or index cannot be installed. It uses `validationLevel: "strict"` and `validationAction: "error"`. The caller needs permission to create collections, modify validators, and create declared indexes.

Initialization does not scan or repair existing documents. Existing invalid documents can remain until changed; updates must satisfy the new validator. Run your own data migration before enabling stricter validation where needed.

All schemas compile before database work starts, but applying validators and indexes across collections is not atomic. `ZongoInitializationError.completed` records successful operations before a failure. No automatic rollback is attempted. Indexes are never deleted; incompatible index changes need an explicit migration.

Existing v4 indexes keep their `zongo_` names and are adopted regardless of the declared name when their ordered keys and effective options match. New names are no longer prefixed automatically. Conflicting uniqueness, partial filter, TTL, sparse, or collation options reject initialization instead of dropping or rebuilding an index. Changed expiration settings require an explicit database migration.

The v4 converter used `unrepresentable: "any"` and BSON metadata tags. V5 deliberately removes this fallback: unsupported schema values fail conversion rather than silently becoming unconstrained. Use the packaged Zod or Effect adapter for supported native values, or return explicit `bsonType` properties from `toMongoSchema`. The former `toJSONSchema` key remains as a deprecated compatibility alias.

For deployments that manage schema installation separately, use `compileCollections` to obtain validators and apply them using your deployment tooling. Runtime code can then use the driver's typed collections directly.
