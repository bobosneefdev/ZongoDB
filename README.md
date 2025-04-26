# ZongoDB
Zod schemas + MongoDB = <3

# About
## Important notes:
- I am always trying to improve/tweak things, breaking changes occur often.
- I have no background in security.
- Zod V3 is slow, this wrapper will hurt performance.

## Paths
- Collection schemas are traversed and flattened into a map used for accessing nested schemas.
- Here's how the traverser creates the map:
  - Unwrap schema (get main schema within ZodOptional, ZodNullable, and ZodEffects)
  - If the schema is a ZodObject or ZodTuple, all nested schemas will be traversed.
  - If the schema is a ZodUnion, all possible schemas will be traversed.
  - If a path for some reason has duplicate schemas, a ZodUnion will be created.
- Curious about what paths are available in your instance? Just log the "flattenedSchemas" property.
- Zongo uses this map to verify:
  - Queried values (when using operators only existence is verified)
  - Update values
  - Transform function return data
- When trying to query, update, or transform, provided paths MUST exist in the map.
  - If it doesn't Zongo will throw an error.

# Setup
## Install
```cmd
npm install @bobosneefdev/zongodb
```

## Config
Create and configure zongo_config.json in the root of your project according to this Zod schema:
```ts
// Your config file must be parsable by this Zod schema.
z.object({
    MONGO_URI: z.string()
        .default("mongodb://localhost:27017"),
    BACKUP_DIR: z.string()
        .default("./ZongoDB/backups"),
    LOG_LEVEL: z.enum([
        "error",
        "warn",
        "info",
        "debug"
    ]),
});
```

# Examples
```ts
enum State {
    CA = "CA"
}

enum CarMake {
    VOLKSWAGEN = "Volkswagen",
    FORD = "Ford"
}

const testDatabase = new ZongoDB(
    "ZongoTest",
    {
        people: z.object({
            created_at: z.date(),
            name: z.literal("John Doe"),
            property: z.object({
                cars: z.array(z.object({
                    state_registered: z.nativeEnum(State),
                    license_plate: z.string(),
                    make: z.nativeEnum(CarMake),
                    model: z.string(),
                    year: z.number()
                        .int()
                })).optional(),
                homes: z.array(z.object({
                    address_1: z.string(),
                    address_2: z.string()
                        .nullable(),
                    city: z.string(),
                    state: z.nativeEnum(State),
                    zip: z.number()
                        .int()
                        .min(10000)
                        .max(99999)
                })).optional(),
                cryptocurrency: z.object({
                    btc_address: z.string()
                        .regex(/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,39}$/),
                }).optional(),
            })
        }),
    },
    {
        initIndexes: {
            people: {
                "created_at": 1,
            }
        }
    }
);

// ✔️ VALID
await testDatabase.insertOne(
    "people",
    { // complete, parsable document :)
        created_at: new Date(),
        name: "John Doe",
        property: {
            cars: [{
                state_registered: State.CA,
                license_plate: "7TJF456",
                make: CarMake.VOLKSWAGEN,
                model: "Passat",
                year: 2001
            }],
        }
    },
);

// ❌ INVALID DATA
await testDatabase.updateOne(
    "people",
    {
        created_at: new Date(),
        name: "John Doe",
    },
    {
        // upsert requires fully parsable document ("created_at" and "name" are missing)
        property: {
            cars: [{
                state_registered: State.CA,
                license_plate: "7TJF456",
                make: CarMake.VOLKSWAGEN,
                model: "Passat",
                year: 2001
            }],
        }
    },
    {
        upsert: true
    }
);

// ❌ INVALID QUERY
await database.findMany(
    "people",
    {
        // fails regex
        "property.crypto.btc_address": "totally-not-a-real-wallet",
    }
);

// ❌ INVALID QUERY
await database.deleteOne(
    "people",
    {
        // invalid literal
        name: "John Deer"
    }
);

// ✔️ VALID
await database.transformOne(
    "people",
    {
        name: "John Doe",
    },
    {
        "property.cars": function (cars) {
            if (!cars) {
                cars = [];
            }
            cars.push({
                state_registered: State.CA,
                license_plate: "3LTO552",
                make: CarMake.FORD,
                model: "Focus RS",
                year: 2016
            });
            // returned value in transform must be parsable by path at schema
            return cars;
        }
    }
)
```