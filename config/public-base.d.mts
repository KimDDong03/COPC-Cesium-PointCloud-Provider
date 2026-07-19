export const DEFAULT_COPC_PUBLIC_BASE: "/";

export function normalizeCopcPublicBase(value: string | undefined): string;

export function readCopcPublicBase(
  environment?: Readonly<Record<string, string | undefined>>,
): string;
