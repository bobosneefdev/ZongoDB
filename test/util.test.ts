import { z } from "zod";
import { ZongoUtil } from "../src/util";

describe(
    "Util",
    () => {

        const testSchema = z.object({
            people: z.array(z.object({
                name: z.string(),
                homes: z.array(z.object({
                    address_1: z.string(),
                    address_2: z.string().optional(),
                })).refine(d => d.some(home => home.address_1.length > 0)),
            })),
        });

        it(
            "Detect optional fields on a complex schema",
            async () => {
                const result = ZongoUtil.verifySchemaAndCheckIfUndefinedCanExist(testSchema);
                expect(result).toBe(true);
            }
        );

        it(
            "Delete a deeply nested undefined value",
            async () => {
                const example: z.infer<typeof testSchema> = {
                    people: [
                        {
                            name: "John Doe",
                            homes: [
                                {
                                    address_1: "123 Main St",
                                    address_2: "Apt 1",
                                }
                            ]
                        },
                        {
                            name: "Bill Doe",
                            homes: [
                                {
                                    address_1: "123 Broadway St",
                                    address_2: undefined,
                                }
                            ]
                        }
                    ]
                }
                const result = ZongoUtil.removeExplicitUndefined(example);
                const billDoeAddress = result.people[1].homes?.[0];
                expect(typeof billDoeAddress === "object" && !("address_2" in billDoeAddress)).toBe(true);
            }
        );
    }
);