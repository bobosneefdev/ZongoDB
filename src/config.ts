import fs from "fs";
import { z } from "zod";

const kZongoConfigFilePath = "./zongo_config.json";

const zZongoConfig = z.object({
    ZONGO_MONGO_URI: z.string()
        .default("mongodb://localhost:27017"),
    ZONGO_BACKUP_DIR: z.string()
        .default("./ZongoDB/backups"),
    ZONGO_LOG_LEVEL: z.enum([
        "error",
        "warn",
        "info",
        "debug"
    ]),
});
export type ZongoConfig = z.infer<typeof zZongoConfig>;

export const kZongoConfig = getConfig();

function getConfig() {
    if (fs.existsSync(kZongoConfigFilePath)) {
        return zZongoConfig.parse(JSON.parse(fs.readFileSync(kZongoConfigFilePath, "utf-8")));
    }
    else {
        const configFromEnv = Object.keys(zZongoConfig.shape).reduce(
            (p, c) => {
                p[c] = process.env[c];
                return p;
            },
            {} as Record<string, string | undefined>
        );
        return zZongoConfig.parse(configFromEnv);
    }
}