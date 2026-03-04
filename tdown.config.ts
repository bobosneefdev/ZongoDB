import { defineConfig } from "tsdown";

export default defineConfig({
	format: "esm",
	dts: true,
	entry: {
		index: "src/index.ts",
	},
	deps: {
		skipNodeModulesBundle: true,
	},
	shims: true,
	clean: true,
	treeshake: true,
	target: false,
});
