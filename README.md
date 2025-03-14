# ZongoDB
Zod schemas + MongoDB = <3

# Config
- Create a zongo_config.json in the root of your directory.
- Your config file must be parsable by this Zod schema:
```ts
const zConfig = z.object({
    MONGO_URI: z.string()
        .default("mongodb://localhost:27017"),
    BACKUP_DIR: z.string()
        .default("./ZongoDB/backups"),
});
```

