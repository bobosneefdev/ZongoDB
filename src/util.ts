import { z } from "zod";

export class ZongoUtil {
    static getValueAtPath(obj: any, path: string) {
        let current = obj;
        const keys = path.split(".");
        const pathStr = (i: number) => `"${keys.slice(0, i).join(" > ")}"`;
        for (let i = 0; i < keys.length; i++) {
            if (
                current === null ||
                typeof current !== "object" ||
                Array.isArray(current) ||
                current instanceof Date
            ) {
                throw new Error(`Invalid object at path: ${pathStr(i)}`);
            }
            else if (!(keys[i] in current)) {
                throw new Error(`Path does not exist in object: ${pathStr(i + 1)}`);
            }
            current = current[keys[i]];
        }
        return current;
    }

    static doesSchemaHaveOptionalFields(schema: z.ZodTypeAny): boolean {
        const unwrapped = this.unwrapSchema(schema);
        if (unwrapped instanceof z.ZodOptional) {
            return true;
        }
        else if (unwrapped instanceof z.ZodObject) {
            for (const key in unwrapped.shape) {
                if (unwrapped.shape[key] instanceof z.ZodOptional) {
                    return true;
                }
                else if (this.doesSchemaHaveOptionalFields(unwrapped.shape[key])) {
                    return true;
                }
            }
        }
        else if (unwrapped instanceof z.ZodRecord) {
            if (this.doesSchemaHaveOptionalFields(unwrapped.valueSchema)) {
                return true;
            }
        }
        else if (unwrapped instanceof z.ZodArray) {
            if (this.doesSchemaHaveOptionalFields(unwrapped.element)) {
                return true;
            }
        }
        else if (
            unwrapped instanceof z.ZodUnion ||
            unwrapped instanceof z.ZodDiscriminatedUnion
        ) {
            for (const option of unwrapped.options) {
                if (this.doesSchemaHaveOptionalFields(option)) {
                    return true;
                }
            }
        }
        return false;
    }

    static removeExplicitUndefined<T>(obj: T): T {
        if (obj === null || typeof obj !== "object") {
            return obj;
        }
        for (const key in obj) {
            if (obj[key] === undefined) {
                // this will "delete" on arrays too
                // but that's fine, as it does nothing
                delete obj[key];
            }
            else {
                obj[key] = this.removeExplicitUndefined(obj[key]);
            }
        }
        return obj;
    }

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
}