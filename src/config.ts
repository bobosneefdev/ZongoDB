import fs from "fs";
import { z } from "zod";

const kZongoConfigFilePath = "./zongo_config.json";

const zZongoConfig = z.object({
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
export type ZongoConfig = z.infer<typeof zZongoConfig>;

if (!fs.existsSync(kZongoConfigFilePath)) {
    throw new Error(`${kZongoConfigFilePath} not found in cwd. Please create a config.json file in the root directory.`);
}

export const kZongoConfig = zZongoConfig.parse(JSON.parse(fs.readFileSync(kZongoConfigFilePath, "utf-8")));