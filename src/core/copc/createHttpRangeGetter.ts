import type { Getter } from "copc";

const MAX_RANGE_REQUEST_ATTEMPTS = 3;
const RANGE_REQUEST_RETRY_DELAY_MILLISECONDS = 75;

class RetriableCopcRangeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetriableCopcRangeRequestError";
  }
}

export function createHttpRangeGetter(url: string): Getter {
  const parsedUrl = createHttpUrl(url);

  return async (begin: number, end: number): Promise<Uint8Array> => {
    if (
      !Number.isSafeInteger(begin) ||
      !Number.isSafeInteger(end) ||
      begin < 0 ||
      end <= begin
    ) {
      throw new Error(`Invalid byte range: ${begin}-${end}`);
    }

    return fetchRangeWithRetries(parsedUrl, begin, end);
  };
}

async function fetchRangeWithRetries(
  parsedUrl: URL,
  begin: number,
  end: number,
): Promise<Uint8Array> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RANGE_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await fetchRange(parsedUrl, begin, end);
    } catch (error) {
      lastError = error;

      if (
        attempt === MAX_RANGE_REQUEST_ATTEMPTS ||
        !isRetriableRangeRequestError(error)
      ) {
        throw error;
      }

      await delayRangeRequestRetry(attempt);
    }
  }

  throw lastError;
}

async function fetchRange(
  parsedUrl: URL,
  begin: number,
  end: number,
): Promise<Uint8Array> {
    const response = await fetch(parsedUrl.toString(), {
      headers: {
        Range: `bytes=${begin}-${end - 1}`,
      },
    });

    if (!response.ok) {
      if (isRetriableHttpStatus(response.status)) {
        throw new RetriableCopcRangeRequestError(
          `COPC range request failed with HTTP ${response.status}.`,
        );
      }

      throw new Error(`COPC range request failed with HTTP ${response.status}.`);
    }

    if (response.status !== 206) {
      throw new Error("COPC source must support HTTP range requests.");
    }

    return new Uint8Array(await response.arrayBuffer());
}

function createHttpUrl(url: string): URL {
  const baseUrl =
    typeof globalThis.location?.href === "string"
      ? globalThis.location.href
      : undefined;
  const parsedUrl = baseUrl ? new URL(url, baseUrl) : new URL(url);

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(
      "Only HTTP and HTTPS COPC URLs are supported in this prototype.",
    );
  }

  return parsedUrl;
}

function isRetriableRangeRequestError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof RetriableCopcRangeRequestError
  );
}

function isRetriableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delayRangeRequestRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(
      resolve,
      RANGE_REQUEST_RETRY_DELAY_MILLISECONDS * attempt,
    );
  });
}
