import { kZongoConfig, ZongoConfig } from "./config";

type LogLevel = ZongoConfig["ZONGO_LOG_LEVEL"];

const kLogLevelHeirarchy: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

export class ZongoLog {
    private static getLogTag(logLevel: LogLevel) {
        const simpleDateStr = new Date().toLocaleTimeString(
            "en-US",
            {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            }
        );
        return `[zongo ${logLevel} | ${simpleDateStr}]`;
    }

    private static convertInput(...messages: unknown[]): string[] {
        return messages.map(msg => typeof msg === "object" ? JSON.stringify(msg, null, 4) : String(msg));
    }

    static error(...messages: unknown[]): void {
        if (kLogLevelHeirarchy.error > kLogLevelHeirarchy[kZongoConfig.ZONGO_LOG_LEVEL]) {
            return;
        }
        console.error(this.getLogTag("error"), this.convertInput(...messages));
    }

    static warn(...messages: unknown[]): void {
        if (kLogLevelHeirarchy.warn > kLogLevelHeirarchy[kZongoConfig.ZONGO_LOG_LEVEL]) {
            return;
        }
        console.warn(this.getLogTag("warn"), this.convertInput(...messages));
    }

    static info(...messages: unknown[]): void {
        if (kLogLevelHeirarchy.info > kLogLevelHeirarchy[kZongoConfig.ZONGO_LOG_LEVEL]) {
            return;
        }
        console.info(this.getLogTag("info"), this.convertInput(...messages));
    }

    static debug(...messages: unknown[]): void {
        if (kLogLevelHeirarchy.debug > kLogLevelHeirarchy[kZongoConfig.ZONGO_LOG_LEVEL]) {
            return;
        }
        console.debug(this.getLogTag("debug"), this.convertInput(...messages));
    }
}