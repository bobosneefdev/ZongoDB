import { defineConfig } from "tsup";

export default defineConfig({
    format: ["esm", "cjs"],
    entry: {
        index: "src/index.ts"
    },
    dts: true,
    shims: true,
    skipNodeModulesBundle: true,
    clean: true,
});