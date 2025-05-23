import { ZodEnv } from "@bobosneefdev/zodutil";
import { z } from "zod";
import { ZongoLogLevel } from "./types";

export const kZongoEnv = new ZodEnv({
    ZONGO_MONGO_URI: {
        schema: z.string()
            .default("mongodb://localhost:27017"),
        type: "throwOnStartup",
    },
    ZONGO_BACKUP_DIR: {
        schema: z.string()
            .default("./ZongoDB/backups"),
        type: "throwOnStartup",
    },
    ZONGO_LOG_LEVEL: {
        schema: z.nativeEnum(ZongoLogLevel)
            .default(ZongoLogLevel.INFO),
        type: "throwOnStartup",
    },
});