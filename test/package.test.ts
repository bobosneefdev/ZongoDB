import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

test("packed ESM package imports and infers types without Zod", () => {
	const temporaryRoot = resolve(tmpdir());
	const fixture = mkdtempSync(join(temporaryRoot, "zongo-package-"));
	function cleanup() {
		if (dirname(resolve(fixture)) !== temporaryRoot)
			throw new Error("Unexpected fixture cleanup path");
		rmSync(fixture, { recursive: true, force: true });
	}
	function run(command: string, args: string[], cwd = fixture) {
		const result = spawnSync(command, args, {
			cwd,
			encoding: "utf8",
			timeout: 45000,
			windowsHide: true,
		});
		if (result.status !== 0)
			throw new Error(`${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`, {
				cause: result.error,
			});
		return result.stdout;
	}
	try {
		run(
			process.execPath,
			["pm", "pack", "--ignore-scripts", "--destination", fixture],
			process.cwd(),
		);
		const tarball = readdirSync(fixture).find((name) => name.endsWith(".tgz"));
		expect(tarball).toBeDefined();
		writeFileSync(
			join(fixture, "package.json"),
			JSON.stringify({
				private: true,
				type: "module",
				dependencies: { "@bobosneefdev/zongodb": `file:./${tarball}`, mongodb: "^7.0.0" },
			}),
		);
		run(process.execPath, ["install", "--ignore-scripts"]);
		expect(existsSync(join(fixture, "node_modules", "zod"))).toBe(false);
		expect(
			existsSync(
				join(
					fixture,
					"node_modules",
					"@bobosneefdev",
					"zongodb",
					"docs",
					"migration-v4.md",
				),
			),
		).toBe(true);
		expect(
			run("node", [
				"--input-type=module",
				"-e",
				'import { compileSchema, createZongo } from "@bobosneefdev/zongodb"; if (typeof createZongo !== "function" || compileSchema({type:"object"}).$jsonSchema.bsonType !== "object") throw new Error("Invalid exports"); console.log("esm-ok");',
			]),
		).toContain("esm-ok");
		writeFileSync(
			join(fixture, "index.ts"),
			`
import { createZongo } from "@bobosneefdev/zongodb";
import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import type { Db, ObjectId } from "mongodb";
declare const db: Db;
declare const schema: StandardJSONSchemaV1<unknown, { name: string }>;
const result = await createZongo({ db, collections: { users: { schema } } });
await result.collections.users.insertOne({ name: "Ada" });
// @ts-expect-error The published declaration must preserve required fields.
await result.collections.users.insertOne({});
const row = await result.collections.users.findOne({});
const id: ObjectId | undefined = row?._id;
`,
		);
		writeFileSync(
			join(fixture, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					skipLibCheck: true,
					noEmit: true,
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
				},
				include: ["index.ts"],
			}),
		);
		run("node", [
			resolve("node_modules/typescript/bin/tsc"),
			"--project",
			join(fixture, "tsconfig.json"),
		]);
	} finally {
		cleanup();
	}
}, 60000);
