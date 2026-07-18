import { defineConfig, type ProxyOptions } from "vite";
import cesium from "vite-plugin-cesium";
import { configureCesiumForPublicBase } from "./config/cesium-public-base.mjs";
import { readCopcSampleProxyRoot } from "./config/copc-sample-proxy-root.mjs";
import { readCopcViewerPublicBase } from "./config/public-base.mjs";

const copcSampleProxyRoot = new URL(readCopcSampleProxyRoot());
const publicBase = readCopcViewerPublicBase();

export default defineConfig({
  base: publicBase,
  plugins: [...configureCesiumForPublicBase(cesium(), publicBase)],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Projection definitions are stable vendor code and account for a
          // meaningful share of the example entry bundle. Keep them in their
          // own cacheable chunk instead of crossing Vite's 500 KB warning at
          // the exact camera-stream feature boundary.
          if (id.replaceAll("\\", "/").includes("/node_modules/proj4/")) {
            return "proj4";
          }

          return undefined;
        },
      },
    },
  },
  server: {
    proxy: createCopcSampleProxy(),
  },
  preview: {
    proxy: createCopcSampleProxy(),
  },
  resolve: {
    alias: [
      {
        find: "copc-cesium/cesium",
        replacement: filePathFromUrl(
          new URL("./src/cesium/index.ts", import.meta.url),
        ),
      },
      {
        find: "copc-cesium/core",
        replacement: filePathFromUrl(
          new URL("./src/core/index.ts", import.meta.url),
        ),
      },
      {
        find: "copc-cesium",
        replacement: filePathFromUrl(new URL("./src/index.ts", import.meta.url)),
      },
    ],
  },
});

function createCopcSampleProxy(): Record<string, string | ProxyOptions> {
  return {
    "/copc-samples": {
      target: copcSampleProxyRoot.origin,
      changeOrigin: true,
      rewrite: (path: string) =>
        path.replace(
          /^\/copc-samples/,
          copcSampleProxyRoot.pathname.replace(/\/$/, ""),
        ),
    },
  };
}

function filePathFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
}
