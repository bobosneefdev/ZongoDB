import { ZodEnv } from "@bobosneefdev/zodutil";
import { z } from "zod";
import { ZongoLogLevel } from "./types";

export const kZongoEnv = new ZodEnv({
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