import { ZongoLog } from "./logger";

export class ZongoUtil {
    static timeout(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    static updateValueInObject(
        obj: any,
        path: string,
        func: (value: any) => any
    ) {
        let current = obj;

        const keys = path.split(".");
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (!(key in current)) {
                throw new Error(`Key ${key} (Path: ${keys.join(" > ")}) does not exist in object!`);
            }
            if (i === keys.length - 1) {
                current[key] = func(current[key]);
            }
            else {
                current = current[key];
            }
        }
    }

    static removeUndefinedValues<T>(obj: T): T {
        if (
            obj === null ||
            typeof obj !== 'object' ||
            Array.isArray(obj)
        ) {
            return obj;
        }
        
        const result = {} as T;
        for (const [key, value] of Object.entries(obj)) {
            if (value !== undefined) {
                if (typeof value === 'object' && value !== null) {
                    (result as any)[key] = this.removeUndefinedValues(value);
                } else {
                    (result as any)[key] = value;
                }
            }
        }
        return result;
    }

    static separateSetAndUnset<T>(obj: T) {
        const set: Record<string, any> = {};
        const unset: Record<string, any> = {};

        if (
            obj === null ||
            typeof obj !== "object" ||
            Array.isArray(obj)
        ) {
            throw new Error("Cannot update an array. Please update an object instead.");
        }
        
        for (const [key, value] of Object.entries(obj)) {
            if (key === "_id") {
                ZongoLog.warn("_id field is immutable, therefore your change to it was ignored. Please use a different field.");
                continue;
            }
            else if (value === undefined) {
                unset[key] = "";
            } else if (
                value !== null &&
                typeof value === "object" &&
                !Array.isArray(value) && 
                Object.keys(value).length > 0
            ) {
                const nestedResult = this.separateSetAndUnset(value);
                if (
                    Object.keys(nestedResult.set).length > 0 ||
                    Object.keys(nestedResult.unset).length > 0
                ) {
                    for (const nestedKey in nestedResult.set) {
                        set[`${key}.${nestedKey}`] = nestedResult.set[nestedKey];
                    }
                    for (const nestedKey in nestedResult.unset) {
                        unset[`${key}.${nestedKey}`] = 1;
                    }
                } else {
                    set[key] = value;
                }
            } else {
                set[key] = value;
            }
        }
        
        return {
            set,
            unset
        };
    }
}