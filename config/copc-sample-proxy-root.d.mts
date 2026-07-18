export const DEFAULT_COPC_SAMPLE_PROXY_ROOT: string;

export function normalizeCopcSampleProxyRoot(
  value: string | undefined,
  options?: Readonly<{ allowUnsafeRemote?: boolean }>,
): string;

export function readCopcSampleProxyRoot(
  environment?: Readonly<Record<string, string | undefined>>,
): string;
