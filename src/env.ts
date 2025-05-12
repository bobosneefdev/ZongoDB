import { ZodEnv } from "@bobosneefdev/zodutil";
import fs from "fs";
import { z } from "zod";
import { ZongoLogLevel } from "./types";

export const kZongoEnv = new ZodEnv({
    ZONGO_MONGO_URI: z.string()
        .default("mongodb://localhost:27017"),
    ZONGO_BACKUP_DIR: z.string()
        .default("./ZongoDB/backups"),
    ZONGO_LOG_LEVEL: z.nativeEnum(ZongoLogLevel)
        .default(ZongoLogLevel.INFO),
});