import { ZongoConfig } from "./config";

type LogLevel = ZongoConfig["LOG_LEVEL"];

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
        console.error(this.getLogTag("error"), this.convertInput(...messages));
    }

    static warn(...messages: unknown[]): void {
        console.warn(this.getLogTag("warn"), this.convertInput(...messages));
    }

    static info(...messages: unknown[]): void {
        console.info(this.getLogTag("info"), this.convertInput(...messages));
    }

    static debug(...messages: unknown[]): void {
        console.debug(this.getLogTag("debug"), this.convertInput(...messages));
    }
}