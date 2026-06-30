import { defineConfig } from "vite";

const externalDependencies = [
  /^cesium(\/.*)?$/,
  /^copc(\/.*)?$/,
  /^laz-perf(\/.*)?$/,
  /^proj4(\/.*)?$/,
];

export default defineConfig({
  base: "",
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        index: "src/index.ts",
        "core/index": "src/core/index.ts",
        "cesium/index": "src/cesium/index.ts",
      },
      formats: ["es"],
    },
    outDir: "dist/lib",
    rollupOptions: {
      external: externalDependencies,
      output: {
        entryFileNames: "[name].js",
        preserveModules: true,
        preserveModulesRoot: "src",
      },
    },
  },
});
