import { describe, expect, it } from "vitest";
import {
  DEFAULT_COPC_SAMPLE_PROXY_ROOT,
  normalizeCopcSampleProxyRoot,
  readCopcSampleProxyRoot,
} from "./copc-sample-proxy-root.mjs";

describe("readCopcSampleProxyRoot", () => {
  it("returns the default root when the override is missing", () => {
    expect(readCopcSampleProxyRoot({})).toBe(DEFAULT_COPC_SAMPLE_PROXY_ROOT);
  });

  it("returns the default root when the override is empty", () => {
    expect(readCopcSampleProxyRoot({ COPC_SAMPLE_PROXY_ROOT: "   " })).toBe(
      DEFAULT_COPC_SAMPLE_PROXY_ROOT,
    );
  });

  it("accepts a local override and normalizes its pathname", () => {
    expect(
      readCopcSampleProxyRoot({
        COPC_SAMPLE_PROXY_ROOT: " http://127.0.0.1:8080/copc-samples/ ",
      }),
    ).toBe("http://127.0.0.1:8080/copc-samples");
  });
});

describe("normalizeCopcSampleProxyRoot", () => {
  it("accepts a root pathname", () => {
    expect(normalizeCopcSampleProxyRoot("https://example.com/", {
      allowUnsafeRemote: true,
    })).toBe(
      "https://example.com/",
    );
  });

  it("requires an explicit unsafe opt-in for remote proxy overrides", () => {
    expect(() =>
      readCopcSampleProxyRoot({
        COPC_SAMPLE_PROXY_ROOT: "https://metadata.example.internal/data",
      }),
    ).toThrow(/ALLOW_UNSAFE_REMOTE=true/);
    expect(
      readCopcSampleProxyRoot({
        COPC_SAMPLE_PROXY_ROOT: "https://cdn.example.com/data/",
        COPC_SAMPLE_PROXY_ALLOW_UNSAFE_REMOTE: "true",
      }),
    ).toBe("https://cdn.example.com/data");
  });

  it("rejects unsupported protocols", () => {
    expect(() => normalizeCopcSampleProxyRoot("ftp://example.com/data")).toThrow(
      /http or https protocol/i,
    );
  });

  it("rejects embedded credentials", () => {
    expect(() =>
      normalizeCopcSampleProxyRoot("https://user:pass@example.com/data"),
    ).toThrow(/must not include username or password/i);
  });

  it("rejects query strings", () => {
    expect(() =>
      normalizeCopcSampleProxyRoot("https://example.com/data?token=1"),
    ).toThrow(/must not include query strings or hash fragments/i);
  });

  it("rejects hash fragments", () => {
    expect(() => normalizeCopcSampleProxyRoot("https://example.com/data#v1")).toThrow(
      /must not include query strings or hash fragments/i,
    );
  });
});
