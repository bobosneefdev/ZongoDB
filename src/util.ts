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
            current = current[keys[i]];
        }
        return current;
    }

    /**
     * Ensures schema is compatible with Zongo + Determine whether the schema will need undefined values to be cleaned.
     * @param schema - The schema to check.
     * @returns Whether the schema will need undefined values to be cleaned.
     * */
    static verifySchemaAndCheckIfUndefinedCanExist(schema: z.ZodTypeAny): boolean {
        if (this.isZodUndefined(schema)) {
            return true;
        }
        else if (this.isZodSet(schema)) {
            throw new Error("ZodSet is not currently supported in Zongo schemas, consider using arrays instead.")
        }
        else if (this.isZodMap(schema)) {
            throw new Error("ZodMap is not currently supported in Zongo schemas, consider using objects/records instead.");
        }
        else if (this.isZodIntersection(schema)) {
            throw new Error("ZodIntersection is not currently supported in Zongo schemas, consider using the merge method instead.");
        }
        else if (this.isZodLiteral(schema)) {
            if (typeof schema._def.value === "bigint") {
                throw new Error(`BigInt is not supported in Zongo schemas.`);
            }
            return false;
        }
        else if (
            this.isZodBoolean(schema) ||
            this.isZodDate(schema) ||
            this.isZodEnum(schema) ||
            this.isZodNativeEnum(schema) ||
            this.isZodNaN(schema) ||
            this.isZodNumber(schema) ||
            this.isZodString(schema)
        ) {
            return false;
        }
        else if (this.isZodOptional(schema) || this.isZodDefault(schema)) {
            this.verifySchemaAndCheckIfUndefinedCanExist(schema._def.innerType);
            return true;
        }
        else if (this.isZodArray(schema)) {
            return this.verifySchemaAndCheckIfUndefinedCanExist(schema.element);
        }
        else if (this.isZodUnion(schema) || this.isZodDiscriminatedUnion(schema)) {
            const results: Array<boolean> = schema.options.map((schema: any) => this.verifySchemaAndCheckIfUndefinedCanExist(schema));
            return results.some(r => r === true);
        }
        else if (this.isZodNullable(schema)) {
            return this.verifySchemaAndCheckIfUndefinedCanExist(schema._def.innerType);
        }
        else if (this.isZodEffects(schema)) {
            return this.verifySchemaAndCheckIfUndefinedCanExist(schema._def.schema);
        }
        else if (this.isZodObject(schema)) {
            return Object.values(schema.shape)
                .map((schema: any) => this.verifySchemaAndCheckIfUndefinedCanExist(schema))
                .some(r => r === true);
        }
        else if (this.isZodRecord(schema)) {
            return this.verifySchemaAndCheckIfUndefinedCanExist(schema.valueSchema);
        }
        else if (this.isZodTuple(schema)) {
            const results: Array<boolean> = schema._def.items.map((schema: any) => this.verifySchemaAndCheckIfUndefinedCanExist(schema));
            return results.some(r => r === true);
        }
        else if (this.isZodLiteral(schema)) {
            if (typeof schema._def.value === "bigint") {
                throw new Error(`BigInt is not supported in Zongo schemas.`);
            }
            return schema._def.value === undefined;
        }
        else {
            throw new Error(`${schema._def.typeName} is not supported in Zongo schemas.`);
        }
    }

    // return true
    static isZodUndefined(schema: z.ZodTypeAny): schema is z.ZodUndefined {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodUndefined;
    }

    // throw, use plain array instead
    static isZodSet(schema: z.ZodTypeAny): schema is z.ZodSet<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodSet;
    }

    // throw, use plain objects/records instead
    static isZodMap(schema: z.ZodTypeAny): schema is z.ZodMap<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodMap;
    }

    // throw, use merge method instead
    static isZodIntersection(schema: z.ZodTypeAny): schema is z.ZodIntersection<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodIntersection;
    }

    // throw if bigint, return false otherwise
    static isZodLiteral(schema: z.ZodTypeAny): schema is z.ZodLiteral<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodLiteral;
    }

    // return false
    static isZodBoolean(schema: z.ZodTypeAny): schema is z.ZodBoolean {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodBoolean;
    }

    static isZodDate(schema: z.ZodTypeAny): schema is z.ZodDate {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodDate;
    }

    static isZodEnum(schema: z.ZodTypeAny): schema is z.ZodEnum<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodEnum;
    }

    static isZodNaN(schema: z.ZodTypeAny): schema is z.ZodNaN {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodNaN;
    }

    static isZodNativeEnum(schema: z.ZodTypeAny): schema is z.ZodNativeEnum<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodNativeEnum;
    }

    static isZodNull(schema: z.ZodTypeAny): schema is z.ZodNull {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodNull;
    }

    static isZodNumber(schema: z.ZodTypeAny): schema is z.ZodNumber {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodNumber;
    }

    static isZodString(schema: z.ZodTypeAny): schema is z.ZodString {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodString;
    }

    // recursive call, but return true
    static isZodOptional(schema: z.ZodTypeAny): schema is z.ZodOptional<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodOptional;
    }

    static isZodDefault(schema: z.ZodTypeAny): schema is z.ZodDefault<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodDefault;
    }

    // recursive return
    static isZodArray(schema: z.ZodTypeAny): schema is z.ZodArray<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodArray;
    }

    static isZodUnion(schema: z.ZodTypeAny): schema is z.ZodUnion<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodUnion;
    }

    static isZodDiscriminatedUnion(schema: z.ZodTypeAny): schema is z.ZodDiscriminatedUnion<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion;
    }

    static isZodNullable(schema: z.ZodTypeAny): schema is z.ZodNullable<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodNullable;
    }

    static isZodEffects(schema: z.ZodTypeAny): schema is z.ZodEffects<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodEffects;
    }

    static isZodObject(schema: z.ZodTypeAny): schema is z.ZodObject<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodObject;
    }

    static isZodRecord(schema: z.ZodTypeAny): schema is z.ZodRecord<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodRecord;
    }

    static isZodTuple(schema: z.ZodTypeAny): schema is z.ZodTuple<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodTuple;
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