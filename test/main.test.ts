import z from "zod";
import { Zongo } from "../src/database";

const TEST_DB = new Zongo(
    {
        user: z.object({
            id: z.string(),
            name: z.string(),
            email: z.email(),
            age: z.number().int(),
            cars: z.record(z.enum(["Toyota", "Honda", "Ford"]), z.array(z.string()).describe("##uniqueItems")),
        }),
    },
    {
        name: "ZongoTest",
    },
);

describe("main", () => {
    beforeAll(async () => {
        await TEST_DB.client.connect();
    });

    const uuid = crypto.randomUUID();
    it("Insert a user", async () => {
        try {
            const doc: z.infer<typeof TEST_DB.schemas.user> = {
                id: uuid,
                name: "John Doe",
                age: 20,
                email: "john.doe@example.com",
                cars: {
                    Ford: ["Flex", "Mustang"],
                    Toyota: [],
                    Honda: [],
                },
            }
            console.log(JSON.stringify(doc, null, 2));
            const result = await TEST_DB.collections.user.insertOne(doc);
            expect(result.acknowledged).toBe(true);
        } catch (error) {
            console.error(JSON.stringify(error, null, 2));
        }
    });
});