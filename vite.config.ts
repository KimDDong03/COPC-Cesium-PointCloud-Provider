import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

export default defineConfig({
  plugins: [cesium()],
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

function filePathFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
}
