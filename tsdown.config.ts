import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/adapters/zod.ts", "src/adapters/effect.ts"],
	format: "esm",
	dts: true,
	clean: true,
	platform: "node",
	target: "node20.19",
});
