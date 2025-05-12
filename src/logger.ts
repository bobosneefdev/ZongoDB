import { kZongoEnv } from "./env";
import { ZongoLogLevel } from "./types";

const kLogLevelHeirarchy: Record<ZongoLogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

export class ZongoLog {
    static longestLogLevel = Object.values(ZongoLogLevel).reduce((p, c) => Math.max(p, c.length), 0);

    private static getLogTag(logLevel: ZongoLogLevel) {
        const simpleDateStr = new Date().toLocaleTimeString(
            "en-US",
            {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            }
        );
        return `[zongo ${logLevel.padEnd(ZongoLog.longestLogLevel)} | ${simpleDateStr}]`;
    }

    private static convertInput(...messages: unknown[]): string[] {
        return messages.map(msg => typeof msg === "object" ? JSON.stringify(msg, null, 4) : String(msg));
    }

    static error(...messages: unknown[]): void {
        if (kLogLevelHeirarchy.error > kLogLevelHeirarchy[kZongoEnv.get("ZONGO_LOG_LEVEL")]) {
            return;
        }
        console.error(this.getLogTag(ZongoLogLevel.ERROR), this.convertInput(...messages));
    }

    static warn(...messages: unknown[]): void {
        if (kLogLevelHeirarchy.warn > kLogLevelHeirarchy[kZongoEnv.get("ZONGO_LOG_LEVEL")]) {
            return;
        }
        console.warn(this.getLogTag(ZongoLogLevel.WARN), this.convertInput(...messages));
    }

    static info(...messages: unknown[]): void {
        if (kLogLevelHeirarchy.info > kLogLevelHeirarchy[kZongoEnv.get("ZONGO_LOG_LEVEL")]) {
            return;
        }
        console.info(this.getLogTag(ZongoLogLevel.INFO), this.convertInput(...messages));
    }

    static debug(...messages: unknown[]): void {
        if (kLogLevelHeirarchy.debug > kLogLevelHeirarchy[kZongoEnv.get("ZONGO_LOG_LEVEL")]) {
            return;
        }
        console.debug(this.getLogTag(ZongoLogLevel.DEBUG), this.convertInput(...messages));
    }
}