import { HOBU_LIDAR_SAMPLE_ROOT } from "./live-copc-sources.mjs";

export const DEFAULT_COPC_SAMPLE_PROXY_ROOT = HOBU_LIDAR_SAMPLE_ROOT;

export function normalizeCopcSampleProxyRoot(
  value,
  { allowUnsafeRemote = false } = {},
) {
  if (value === undefined || value.trim().length === 0) {
    return DEFAULT_COPC_SAMPLE_PROXY_ROOT;
  }

  let url;

  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      "COPC_SAMPLE_PROXY_ROOT must be a valid absolute http or https URL.",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "COPC_SAMPLE_PROXY_ROOT must use the http or https protocol.",
    );
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(
      "COPC_SAMPLE_PROXY_ROOT must not include username or password credentials.",
    );
  }

  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error(
      "COPC_SAMPLE_PROXY_ROOT must not include query strings or hash fragments.",
    );
  }

  if (!isLoopbackHostname(url.hostname) && !allowUnsafeRemote) {
    throw new Error(
      "COPC_SAMPLE_PROXY_ROOT remote overrides require COPC_SAMPLE_PROXY_ALLOW_UNSAFE_REMOTE=true.",
    );
  }

  url.pathname = normalizeCopcSampleProxyPathname(url.pathname);

  return url.toString();
}

export function readCopcSampleProxyRoot(environment = process.env) {
  return normalizeCopcSampleProxyRoot(environment.COPC_SAMPLE_PROXY_ROOT, {
    allowUnsafeRemote:
      environment.COPC_SAMPLE_PROXY_ALLOW_UNSAFE_REMOTE === "true",
  });
}

function normalizeCopcSampleProxyPathname(pathname) {
  const normalized = pathname.length === 0 ? "/" : pathname;

  return normalized.endsWith("/") ? normalized.slice(0, -1) || "/" : normalized;
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
