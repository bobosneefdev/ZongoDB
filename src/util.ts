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

    /**
     * Ensures schema is compatible with Zongo + Determine whether it has any optional fields.
     * @param schema - The schema to check.
     * @returns Whether the schema has any optional fields.
     * */
    static doesValidSchemaHaveOptionalFields(schema: z.ZodType<any>): boolean {
        if (this.isZodOptional(schema) || this.isZodDefault(schema)) {
            this.doesValidSchemaHaveOptionalFields(schema._def.innerType);
            return true;
        }
        else if (this.isZodNullable(schema)) {
            return this.doesValidSchemaHaveOptionalFields(schema._def.innerType);
        }
        else if (this.isZodEffects(schema)) {
            return this.doesValidSchemaHaveOptionalFields(schema._def.schema);
        }
        else if (this.isZodObject(schema)) {
            const results: Array<boolean> = Object.values(schema.shape).map((schema: any) => this.doesValidSchemaHaveOptionalFields(schema));
            return results.some(r => r === true);
        }
        else if (
            this.isZodRecord(schema) ||
            this.isZodMap(schema)
        ) {
            return this.doesValidSchemaHaveOptionalFields(schema.valueSchema);
        }
        else if (this.isZodArray(schema)) {
            return this.doesValidSchemaHaveOptionalFields(schema.element);
        }
        else if (
            this.isZodUnion(schema) ||
            this.isZodDiscriminatedUnion(schema)
        ) {
            const results: Array<boolean> = schema.options.map((schema: any) => this.doesValidSchemaHaveOptionalFields(schema));
            return results.some(r => r === true);
        }
        else if (this.isZodTuple(schema)) {
            const results: Array<boolean> = schema._def.items.map((schema: any) => this.doesValidSchemaHaveOptionalFields(schema));
            return results.some(r => r === true);
        }
        else if (
            this.isZodIntersection(schema) ||
            this.isZodLazy(schema) ||
            this.isZodSet(schema) ||
            this.isZodPromise(schema) ||
            this.isZodNaN(schema) ||
            this.isZodBigInt(schema) ||
            this.isZodVoid(schema) ||
            this.isZodFunction(schema)
        ) {
            throw new Error(`${schema._def.typeName} is not supported in Zongo schemas.`);
        }
        else if (this.isZodLiteral(schema)) {
            if (typeof schema._def.value === "bigint") {
                throw new Error(`BigInt is not supported in Zongo schemas.`);
            }
            return schema._def.value === undefined;
        }
        return false;
    }

    static isZodFunction(schema: z.ZodTypeAny): schema is z.ZodFunction<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodFunction;
    }

    static isZodVoid(schema: z.ZodTypeAny): schema is z.ZodVoid {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodVoid;
    }

    static isZodLiteral(schema: z.ZodTypeAny): schema is z.ZodLiteral<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodLiteral;
    }

    static isZodBigInt(schema: z.ZodTypeAny): schema is z.ZodBigInt {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodBigInt;
    }

    static isZodNaN(schema: z.ZodTypeAny): schema is z.ZodNaN {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodNaN;
    }

    static isZodPromise(schema: z.ZodTypeAny): schema is z.ZodPromise<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodPromise;
    }

    static isZodIntersection(schema: z.ZodTypeAny): schema is z.ZodIntersection<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodIntersection;
    }

    static isZodLazy(schema: z.ZodTypeAny): schema is z.ZodLazy<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodLazy;
    }

    static isZodDefault(schema: z.ZodTypeAny): schema is z.ZodDefault<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodDefault;
    }

    static isZodTuple(schema: z.ZodTypeAny): schema is z.ZodTuple<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodTuple;
    }

    static isZodNullable(schema: z.ZodTypeAny): schema is z.ZodNullable<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodNullable;
    }

    static isZodEffects(schema: z.ZodTypeAny): schema is z.ZodEffects<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodEffects;
    }

    static isZodOptional(schema: z.ZodTypeAny): schema is z.ZodOptional<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodOptional;
    }

    static isZodObject(schema: z.ZodTypeAny): schema is z.ZodObject<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodObject;
    }

    static isZodRecord(schema: z.ZodTypeAny): schema is z.ZodRecord<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodRecord;
    }

    static isZodArray(schema: z.ZodTypeAny): schema is z.ZodArray<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodArray;
    }
    
    static isZodUnion(schema: z.ZodTypeAny): schema is z.ZodUnion<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodUnion;
    }
    
    static isZodDiscriminatedUnion(schema: z.ZodTypeAny): schema is z.ZodDiscriminatedUnion<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion;
    }

    static isZodMap(schema: z.ZodTypeAny): schema is z.ZodMap<any, any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodMap;
    }

    static isZodSet(schema: z.ZodTypeAny): schema is z.ZodSet<any> {
        return schema._def.typeName === z.ZodFirstPartyTypeKind.ZodSet;
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

    static isDate(value: any): value is Date {
        if (Object.prototype.toString.call(value) === "[object Date]") {
            return true;
        }
        return false;
    }
}