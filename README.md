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