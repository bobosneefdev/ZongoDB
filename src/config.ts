import fs from "fs";
import { z } from "zod";

const kConfigFilePath = "./zongo_config.json";

const zConfig = z.object({
    MONGO_URI: z.string()
        .default("mongodb://localhost:27017"),
    BACKUP_DIR: z.string()
        .default("./ZongoDB/backups"),
});

if (!fs.existsSync(kConfigFilePath)) {
    throw new Error(`${kConfigFilePath} not found in cwd. Please create a config.json file in the root directory.`);
}

export const kConfig = zConfig.parse(JSON.parse(fs.readFileSync(kConfigFilePath, "utf-8")));