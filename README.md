# ZongoDB
Zod schemas + MongoDB = <3

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

# Notes
- This package isn't meant to be bullet-proof by any means.
- I have tried to keep a bit of balance of overhead/type safety.
- I am still relatively new to coding, so brace yourself if you look at the source code 😭

# Examples
```ts
const database = new ZongoDB(
    "MyDatabase",
    {
        users: z.object({
            internalId: z.number(),
            joined: z.date(),
            balance: z.object({
                currentCents: z.number().int(),
                history: z.array(z.object({
                    changeCents: z.number().int(),
                    reason: z.string(),
                    timestamp: z.date(),
                })),
            })
        })
    }
);

// Zongo verifies that balance.currentCents could be zero ✔️
const theRightWay = await database.findMany(
    "users",
    {
        "balance.currentCents": 0,
    }
);

// Zongo will fail to parse balance.currentCents since it must be an integer ❌
const theWrongWay = await database.findMany(
    "users",
    {
        "balance.currentCents": 0.92
    }
);

// Zongo does not verify conditionals in queries yet, but it will still work 🟡
const theWrongWay = await database.findMany(
    "users",
    {
        "balance.currentCents": {
            $gt: 0
        }
    }
);

// I'll add more examples soon, in the meantime just play around with it :)
```