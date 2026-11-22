import { Agent, fetch as undiciFetch, type RequestInit as UndiciInit } from "undici";

function localChatUrl(input: RequestInfo | URL): boolean {
  if (typeof input !== "string" && !(input instanceof URL)) return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
    (url.pathname.endsWith("/v1/chat/completions") || url.pathname.endsWith("/v1/responses"));
}

/** Allow time for a queued loopback inference to send headers. Other requests keep pi's dispatcher. */
export function withLocalModelTimeout(original: typeof fetch, headersTimeout = 600_000): typeof fetch {
  const dispatcher = new Agent({ headersTimeout });
  return (input, init) => {
    if (!localChatUrl(input)) return original(input, init);
    // Node's fetch and undici implement the same web request and response APIs.
    return undiciFetch(input as string | URL, { ...(init as UndiciInit), dispatcher }) as unknown as Promise<Response>;
  };
}
