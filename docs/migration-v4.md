# Migrating to v4

This is a hard-cut release. There are no v3 compatibility exports.

| v3 | v4 |
| --- | --- |
| `new Zongo(schemas, options)` | `await createZongo({ db, collections })` |
| Library-created connection, implicit localhost | Caller creates and closes `MongoClient` |
| `{ users: userSchema }` | `{ users: { schema: userSchema, indexes: [...] } }` |
| Global `indexes` option with `index` keys | Collection-local indexes with `key` (or `rawKey`) |
| Required Zod peer | Native Standard JSON Schema, or typed schema plus `toJSONSchema` |
| `customJsonToBsonTypes` | Per-collection `toJSONSchema`, with explicit `bsonType` fields |
| `describe("##uniqueItems")` | Actual `uniqueItems: true` in the converted JSON Schema |
| `zJobTimestamp` / `JobTimestamp` | Define your application's schemas locally |
| Advertised CommonJS entry | ESM only, Node 20.19+ |

## Validation changes

Zero bounds, literal values, integer constraints, exclusivity, and closed objects now affect database validation. Schemas that previously accepted invalid writes may reject them. `_id` is reserved at the document root so closed objects can use MongoDB-generated ObjectIds. Explicit custom `_id` schemas are preserved; declare custom IDs as required when the application must supply them.

Unsupported validation keywords now produce `SchemaConversionError` through the initialization error's `cause`. In particular, MongoDB does not enforce JSON Schema `format`, and v4 rejects it instead of dropping it. Convert such constraints explicitly to a suitable `pattern`, or intentionally remove them in your converter and perform application validation separately. Arbitrary refinements omitted by an upstream converter cannot be detected by ZongoDB.

Descriptions are preserved verbatim. Old `##` tags have no behavior.

## Deployment changes

Initialization now fails if a validator or index cannot be installed. It uses `validationLevel: "strict"` and `validationAction: "error"`. The caller needs permission to create collections, modify validators, and create declared indexes.

Initialization does not scan or repair existing documents. Existing invalid documents can remain until changed; updates must satisfy the new validator. Run your own data migration before enabling stricter validation where needed.

All schemas compile before database work starts, but applying validators and indexes across collections is not atomic. `ZongoInitializationError.completed` records successful operations before a failure. No automatic rollback is attempted. Indexes are never deleted; incompatible index changes need an explicit migration.

For deployments that manage schema installation separately, use `compileCollections` to obtain validators and apply them using your deployment tooling. Runtime code can then use the driver's typed collections directly.
