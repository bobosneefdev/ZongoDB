import { z } from "zod";
import { ZongoDB } from "../src/database";
import { ZodUtil } from "@bobosneefdev/zodutil";

enum State {
    CA = "CA",
    NY = "NY",
    TX = "TX",
}

enum CarMake {
    HONDA = "Honda",
    TOYOTA = "Toyota",
    FORD = "Ford",
    VOLKSWAGEN = "Volkswagen",
}

const testDatabase = new ZongoDB(
    "ZongoTest",
    {
        people: z.object({
            created_at: z.date(),
            name: z.literal("John Doe"),
            property: z.object({
                cars: z.array(z.object({
                    state_registered: z.nativeEnum(State),
                    license_plate: z.string(),
                    make: z.nativeEnum(CarMake),
                    model: z.string(),
                    year: z.number()
                        .int()
                })).optional(),
                homes: z.array(z.object({
                    address_1: z.string(),
                    address_2: z.string()
                        .nullable(),
                    city: z.string(),
                    state: z.nativeEnum(State),
                    zip: z.number()
                        .int()
                        .min(10000)
                        .max(99999)
                })).optional(),
                cryptocurrency: z.object({
                    btc_address: z.string()
                        .regex(/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,39}$/),
                }).optional(),
            }),
            unionTest: z.union([
                z.object({
                    name: z.string(),
                    age: z.number()
                }),
                z.object({
                    name: z.string(),
                    age: z.number()
                }),
                z.object({
                    name: z.string(),
                    age: z.number()
                })
            ]).optional(),
            tupleTest: z.tuple([
                z.object({
                    name: z.string(),
                    age: z.number()
                }),
                z.string(),
                z.number()
            ]).optional(),
        }),
    },
    {
        initIndexes: {
            people: [
                {
                    index: {
                        "created_at": 1
                    },
                    options: {
                        unique: true
                    }
                }
            ]
        }
    }
);

for (const [collection, pathSchemas] of Object.entries(testDatabase.flattenedSchemas)) {
    for (const [path, schema] of Object.entries(pathSchemas)) {
        if (ZodUtil.isSchemaOfType(schema, z.ZodFirstPartyTypeKind.ZodUnion)) {
            console.log(`${collection}: ${path} - ${schema._def.options.map(o => o._def.typeName).join(", ")}`);
        }
        else {
            console.log(`${collection}: ${path} - ${schema._def.typeName}`);
        }
    }
}

describe(
    "Database",
    () => {
        const date = new Date();

        // TESTS THAT MUST BE RUN IN ORDER
        let deleteManyResolve: (v?: any) => void;
        const deleteManyPromise = new Promise(resolve => deleteManyResolve = resolve);
        it(
            "deleteMany",
            async () => {
                const result = await testDatabase.deleteMany(
                    "people",
                    {}
                );
                expect(result.acknowledged).toBe(true);
                deleteManyResolve();
            }
        )

        let insertOneResolve: (v?: any) => void;
        const insertOnePromise = new Promise(resolve => insertOneResolve = resolve);
        it(
            "insertOne",
            async () => {
                await deleteManyPromise;
                const result = await testDatabase.insertOne(
                    "people",
                    {
                        created_at: date,
                        name: "John Doe",
                        property: {
                            cars: [{
                                state_registered: State.CA,
                                license_plate: "7TJF456",
                                make: CarMake.VOLKSWAGEN,
                                model: "Passat",
                                year: 2001
                            }],
                        }
                    },
                );
                expect(result?.insertedId).toBeDefined();
                insertOneResolve();
            }
        );

        let transformManyResolve: (v?: any) => void;
        const transformManyPromise = new Promise(resolve => transformManyResolve = resolve);
        it(
            "transformMany",
            async () => {
                await insertOnePromise;
                const result = await testDatabase.transformMany(
                    "people",
                    {
                        "created_at": date,
                    },
                    (doc) => {
                        doc.property.cars?.push({
                            state_registered: State.CA,
                            license_plate: "8RJK860",
                            make: CarMake.TOYOTA,
                            model: "Land Cruiser",
                            year: 2025
                        });
                        return doc;
                    },
                    {
                        detailed: true
                    }
                );
                console.log(result);
                expect(result.modifiedCount).toBeGreaterThan(0);
                transformManyResolve();
            }
        );

        let transformOneResolve: (v?: any) => void;
        const transformOnePromise = new Promise(resolve => transformOneResolve = resolve);
        it(
            "transformOne",
            async () => {
                await transformManyPromise;
                const result = await testDatabase.transformOne(
                    "people",
                    {
                        "created_at": date,
                    },
                    (doc) => {
                        doc.property.cars?.push({
                            state_registered: State.CA,
                            license_plate: "3EBK823",
                            make: CarMake.HONDA,
                            model: "Accord CrossTour",
                            year: 2014,
                        });
                        return doc;
                    }
                );
                expect(result?.result.modifiedCount ?? 0).toBeGreaterThan(0);
                transformOneResolve();
            }
        );

        let findOneResolve: (v?: any) => void;
        const findOnePromise = new Promise(resolve => findOneResolve = resolve);
        it(
            "findOne",
            async () => {
                await transformOnePromise;
                const result = await testDatabase.findOne(
                    "people",
                    {
                        created_at: date,
                    },
                );
                if (result !== null) {
                    expect(result.property.cars?.length).toBe(3);
                    expect(result.property.cars?.some(car => car.model === "Land Cruiser")).toBe(true);
                    expect(result.property.cars?.some(car => car.model === "Accord CrossTour")).toBe(true);
                }
                else {
                    expect(typeof result).toBe("object");
                }
                findOneResolve();
            }
        );

        let updateManyResolve: (v?: any) => void;
        const updateManyPromise = new Promise(resolve => updateManyResolve = resolve);
        it(
            "updateMany",
            async () => {
                await findOnePromise;
                const result = await testDatabase.updateMany(
                    "people",
                    {
                        created_at: date,
                    },
                    {
                        property: {
                            homes: [{
                                "address_1": "123 Main St",
                                "address_2": null,
                                "city": "Los Angeles",
                                "state": State.CA,
                                "zip": 90001
                            }],
                            cars: undefined,
                        }
                    }
                );
                expect(result.modifiedCount).toBe(1);
                updateManyResolve();
            }
        );

        let findManyResolve: (v?: any) => void;
        const findManyPromise = new Promise(resolve => findManyResolve = resolve);
        it(
            "findMany with query",
            async () => {
                await updateManyPromise;

                for (let i = 0; i < 3; i++) {
                    await testDatabase.insertOne(
                        "people",
                        {
                            created_at: new Date(),
                            name: "John Doe",
                            property: {}
                        }
                    );
                    await new Promise(r => setTimeout(r, 10));
                }
                const result = await testDatabase.findMany(
                    "people",
                    {},
                    {
                        maxResults: 2
                    }
                );
                expect(result?.length).toBe(2);
                expect(Array.isArray(result)).toBe(true);
                if (result !== null) {
                    expect(result[0].property.cars).toBe(undefined);
                    expect(result[0].property.homes?.length).toBe(1);
                }
                findManyResolve();
            }
        );

        // TESTS THAT JUST REQUIRE A DOCUMENT TO BE PRESENT
        it(
            "findMany with blank query",
            async () => {
                await insertOnePromise;
                const result = await testDatabase.findMany(
                    "people",
                    {},
                );
                expect(Array.isArray(result)).toBe(true);
                if (result !== null) {
                    expect(result.length).toBeGreaterThan(0);
                }
            }
        );

        it(
            "backup database",
            async () => {
                await insertOnePromise;
                const backup = await testDatabase.backupDatabase();
                expect(backup.failures).toBe(0);
                expect(backup.successes).toBeGreaterThan(0);
            }
        );
    }
)