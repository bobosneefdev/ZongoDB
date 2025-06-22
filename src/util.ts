import { ZodUtil } from "@bobosneefdev/zodutil";
import { z } from "zod";

export class ZongoUtil {
    static getValueAtPath(obj: any, path: string) {
        let current = obj;
        const keys = path.split(".");
        const pathStr = (i: number) => `"${keys.slice(0, i).join(" > ")}"`;
        for (let i = 0; i < keys.length; i++) {
            if (
                current === null ||
                (typeof current !== "object") ||
                current instanceof Date
            ) {
                throw new Error(`Invalid object at path: ${pathStr(i)}`);
            }
            // Handle array access by index
            if (Array.isArray(current) && !isNaN(Number(keys[i]))) {
                current = current[Number(keys[i])];
            } else if (Array.isArray(current)) {
                // If we're trying to access a property on an array (not by index), 
                // this is likely the final step where we want to return the array itself
                // for operations like push/pop
                if (i === keys.length - 1) {
                    return current;
                }
                throw new Error(`Cannot access property "${keys[i]}" on array at path: ${pathStr(i)}`);
            } else {
                current = current[keys[i]];
            }
        }
        return current;
    }

    /**
     * Ensures schema is compatible with Zongo + Determine whether the schema will need undefined values to be cleaned.
     * @param schema - The schema to check.
     * @returns Whether the schema will need undefined values to be cleaned.
     * */
    static verifySchemaAndCheckIfUndefinedCanExist(schema: z.ZodTypeAny): boolean {
        if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodUndefined)) {
            return true;
        }
        else if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodSet)) {
            throw new Error("ZodSet is not currently supported in Zongo schemas, consider using arrays instead.")
        }
        else if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodMap)) {
            throw new Error("ZodMap is not currently supported in Zongo schemas, consider using objects/records instead.");
        }
        else if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodIntersection)) {
            throw new Error("ZodIntersection is not currently supported in Zongo schemas, consider using the merge method instead.");
        }
        else if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodLiteral)) {
            if (typeof schema._def.value === "bigint") {
                throw new Error(`BigInt is not supported in Zongo schemas.`);
            }
            return false;
        }
        else if (
            ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodBoolean) ||
            ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodDate) ||
            ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodEnum) ||
            ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodNativeEnum) ||
            ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodNaN) ||
            ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodNumber) ||
            ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodString) ||
            ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodAny)
        ) {
            return false;
        }
        else if (
            ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodOptional) ||
            ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodDefault)
        ) {
            this.verifySchemaAndCheckIfUndefinedCanExist(schema._def.innerType);
            return true;
        }
        else if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodArray)) {
            return this.verifySchemaAndCheckIfUndefinedCanExist(schema.element);
        }
        else if (
            ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodUnion) ||
            ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion)
        ) {
            const results: Array<boolean> = schema.options.map((schema: any) => this.verifySchemaAndCheckIfUndefinedCanExist(schema));
            return results.some(r => r === true);
        }
        else if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodNullable)) {
            return this.verifySchemaAndCheckIfUndefinedCanExist(schema._def.innerType);
        }
        else if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodEffects)) {
            return this.verifySchemaAndCheckIfUndefinedCanExist(schema._def.schema);
        }
        else if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodObject)) {
            return Object.values(schema.shape)
                .map((schema: any) => this.verifySchemaAndCheckIfUndefinedCanExist(schema))
                .some(r => r === true);
        }
        else if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodRecord)) {
            return this.verifySchemaAndCheckIfUndefinedCanExist(schema.valueSchema);
        }
        else if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodTuple)) {
            const results: Array<boolean> = schema._def.items.map((schema: any) => this.verifySchemaAndCheckIfUndefinedCanExist(schema));
            return results.some(r => r === true);
        }
        else if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodLiteral)) {
            if (typeof schema._def.value === "bigint") {
                throw new Error(`BigInt is not supported in Zongo schemas.`);
            }
            return schema._def.value === undefined;
        }
        else {
            throw new Error(`${schema._def.typeName} is not supported in Zongo schemas.`);
        }
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
}