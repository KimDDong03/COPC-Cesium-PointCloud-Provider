export function createCopcPointSampleWorker(): Worker {
  if (typeof Worker === "undefined") {
    throw new Error("Web Workers are not available in this environment.");
  }

  return new Worker(new URL("./CopcPointSampleWorker.ts", import.meta.url), {
    name: "copc-point-sample-worker",
    type: "module",
  });
}
