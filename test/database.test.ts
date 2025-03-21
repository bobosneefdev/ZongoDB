import { z } from "zod";
import { ZongoDB } from "../src/database";

describe(
    "Database",
    () => {
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

        const database = new ZongoDB(
            "ZongoTest",
            {
                people: z.object({
                    created_at: z.date(),
                    name: z.string(),
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
                    })
                })
            }
        );

        const date = new Date();

        beforeAll(
            async () => {
                const indexesCreated = await database.createIndexes(
                    "people",
                    {
                        "created_at": 1,
                    }
                );
                expect(indexesCreated).toBe(true);
            }
        )

        it(
            "Get all collection names.",
            async () => {
                const collections = await database.getCollectionInfos();
                const expectedCollections = new Set(collections.map(c => c.name));
                for (const collection of Object.keys(database.schemas)) {
                    expect(expectedCollections.has(collection)).toBe(true);
                }
            }
        )

        let insertResolve: (v?: any) => void;
        const insertPromise = new Promise(resolve => insertResolve = resolve);
        it(
            "Insert John Doe into the database, he only has a car.",
            async () => {
                const result = await database.insertOne(
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
                insertResolve();
            }
        );

        let newCarResolve: (v?: any) => void;
        const newCarPromise = new Promise(resolve => newCarResolve = resolve);
        it(
            "John Doe got a new car, add that to the DB.",
            async () => {
                await insertPromise;
                const result = await database.transformOne(
                    "people",
                    {
                        "created_at": date,
                    },
                    [
                        {
                            path: "property.cars",
                            transform: (d: NonNullable<z.infer<typeof database.schemas.people>["property"]["cars"]>) => {
                                d.push({
                                    state_registered: State.CA,
                                    license_plate: "8RJK860",
                                    make: CarMake.TOYOTA,
                                    model: "Land Cruiser",
                                    year: 2025
                                });
                                return d;
                            }
                        },
                    ]
                );
                if (typeof result === "boolean") {
                    expect(typeof result).toBe("object");
                }
                else {
                    expect(result.previous).toBeDefined();
                    expect(result.updated).toBeDefined();
                }
                newCarResolve();
            }
        );

        let findNewCarResolve: (v?: any) => void;
        const findNewCarPromise = new Promise(resolve => findNewCarResolve = resolve);
        it(
            "Find John Doe's new car in the database.",
            async () => {
                await newCarPromise;
                const result = await database.findOne(
                    "people",
                    {
                        created_at: date,
                    },
                );
                if (typeof result === "object") {
                    expect(result.property.cars?.length).toBe(2);
                    expect(result.property.cars?.some(car => car.model === "Land Cruiser")).toBe(true);
                }
                else {
                    expect(typeof result).toBe("object");
                }
                findNewCarResolve();
            }
        );

        let newHouseResolve: (v?: any) => void;
        const newHousePromise = new Promise(resolve => newHouseResolve = resolve);
        it(
            "John Doe got a new house, but he had to sell both of his cars for the down payment.",
            async () => {
                await findNewCarPromise;
                const result = await database.updateOne(
                    "people",
                    {
                        created_at: date,
                    },
                    {
                        "property.homes": [{
                            "address_1": "123 Main St",
                            "address_2": null,
                            "city": "Los Angeles",
                            "state": State.CA,
                            "zip": 90001
                        }],
                        "property.cars": undefined,
                    }
                );
                expect(result.modifiedCount).toBe(1);
                newHouseResolve();
            }
        );

        let houseVerifyResolve: (v?: any) => void;
        const houseVerifyPromise = new Promise(resolve => houseVerifyResolve = resolve);
        it(
            "Verify that he actually got his new house and lost his cars.",
            async () => {
                await newHousePromise;
                const result = await database.findOne(
                    "people",
                    {
                        created_at: date,
                    },
                );
                expect(typeof result).toBe("object");
                if (typeof result !== "boolean") {
                    expect(result.property.cars).toBe(undefined);
                    expect(result.property.homes?.length).toBe(1);
                }
                houseVerifyResolve();
            }
        );

        // it(
        //     "Find one or more John Does in the database with a blank query.",
        //     async () => {
        //         await houseVerifyPromise;
        //         const result = await database.findMany(
        //             "people",
        //             {},
        //         );
        //         expect(Array.isArray(result)).toBe(true);
        //         if (typeof result !== "boolean") {
        //             expect(result.length).toBeGreaterThan(0);
        //         }
        //     }
        // );
    }
)