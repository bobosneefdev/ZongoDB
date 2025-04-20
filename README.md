# ZongoDB
Zod schemas + MongoDB = <3

# Important Notes
- This package isn't meant to be bullet-proof by any means, it's a project to help me learn.
- I have tried to keep a bit of balance of overhead/type safety.
- I am still relatively new to coding, so brace yourself if you look at the source code 😭

# Install
```cmd
npm install @bobosneefdev/zongodb
```

# Config
Create and configure zongo_config.json in the root of your project. It's contents must be parsable by this Zod schema:
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

// valid ✔️
await testDatabase.insertOne(
    "people",
    {
        created_at: date,
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

// fails to parse the document since "property" is required ❌
await testDatabase.insertOne(
    "people",
    {
        created_at: date,
        name: "John Doe",
    },
);

// valid ✔️
await database.findOne(
    "people",
    {
        "property.crypto.btc_address": "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
    }
);

// fails to parse since regex is not matched ❌
await database.findMany(
    "people",
    {
        "property.crypto.btc_address": "totally-not-a-real-wallet",
    }
);

// fails to parse since literal is invalid ❌
await database.deleteOne(
    "people",
    {
        "name": "John Deer"
    }
);
```