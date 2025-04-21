import { z } from "zod";
import { ZongoLog } from "./logger";

export class ZongoUtil {
    static timeout(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    static getValueAtPath(
        obj: any,
        path: string,
    ) {
        let current = obj;
        const keys = path.split(".");
        for (const key of keys) {
            if (
                typeof current !== "object" ||
                !(key in current)
            ) {
                throw new Error(`Value at path: "${keys.join(" > ")}" does not exist in object!`);
            }
            current = current[key];
        }
        return current;
    }

    static removeUndefinedValues<T>(obj: T): T {
        if (
            obj === null ||
            typeof obj !== 'object' ||
            Array.isArray(obj) ||
            obj instanceof Date
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

    // static getSetAndUnset<T>(obj: T) {
    //     const $set: Record<string, any> = {};
    //     const $unset: Record<string, string> = {};
    //     if (
    //         obj === null ||
    //         typeof obj !== "object" ||
    //         Array.isArray(obj)
    //     ) {
    //         throw new Error("Please update an object instead.");
    //     }
        
    //     for (const key in obj) {
    //         if (key === "_id") {
    //             ZongoLog.warn("_id field is immutable, therefore your change to it was ignored. Please use a different field.");
    //             continue;
    //         }
    //         else if (obj[key] === undefined) {
    //             $unset[key] = "";
    //         } else if (
    //             obj[key] !== null &&
    //             typeof obj[key] === "object" &&
    //             !Array.isArray(obj[key]) && 
    //             Object.keys(obj[key]).length > 0
    //         ) {
    //             const nestedResult = this.getSetAndUnset(obj[key]);
    //             if (
    //                 Object.keys(nestedResult.$set).length > 0 ||
    //                 Object.keys(nestedResult.$unset).length > 0
    //             ) {
    //                 for (const nestedKey in nestedResult.$set) {
    //                     $set[`${key}.${nestedKey}`] = nestedResult.$set[nestedKey];
    //                 }
    //                 for (const nestedKey in nestedResult.$unset) {
    //                     $unset[`${key}.${nestedKey}`] = "";
    //                 }
    //             } else {
    //                 $set[key] = obj[key];
    //             }
    //         } else {
    //             $set[key] = obj[key];
    //         }
    //     }
        
    //     return {
    //         $set,
    //         $unset
    //     };
    // }

    static getSetAndUnset<T>(obj: T, currentPath: string[] = []) {
        const unset: Record<string, ""> = {};
        for (const key in obj) {
            for (const key in obj) {
                if (obj[key] === undefined) {
                    unset[[...currentPath, key].join(".")] = "";
                    delete obj[key];
                }
            }
            if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
                this.getSetAndUnset(obj[key], [...currentPath, key]);
            }
        }
        return {
            $set: obj,
            $unset: unset
        }
    }

    static unwrapSchema(schema: z.ZodTypeAny) {
        let result = schema;
        while (true) {
            if (
                result._def.typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
                result._def.typeName === z.ZodFirstPartyTypeKind.ZodNullable
            ) {
                result = result._def.innerType;
            }
            else if (result._def.typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
                result = result._def.schema;
            }
            else {
                break;
            }
        }
        return result;
    }

    static doesSchemaHaveOptionalFields(schema: z.ZodObject<any>) {
        for (const value of Object.values(schema.shape)) {
            if (
                value instanceof z.ZodOptional ||
                (
                    value instanceof z.ZodObject &&
                    this.doesSchemaHaveOptionalFields(value)
                ) ||
                (
                    value instanceof z.ZodArray &&
                    value.element instanceof z.ZodObject &&
                    this.doesSchemaHaveOptionalFields(value.element)
                )
            ) {
                return true;
            }
        }
        return false;
    }
}