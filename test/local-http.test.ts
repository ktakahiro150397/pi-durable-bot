import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { withLocalModelTimeout } from "../src/agent/local-http.ts";

it("uses the longer transport for loopback inference and leaves other requests to pi", async () => {
  const previous = vi.fn<typeof fetch>().mockResolvedValue(new Response("previous"));
  const fetchWithTimeout = withLocalModelTimeout(previous, 1_000);
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("local"), 25);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await (await fetchWithTimeout(`${origin}/v1/chat/completions`)).text()).toBe("local");
    expect(previous).not.toHaveBeenCalled();
    expect(await (await fetchWithTimeout(`${origin}/health`)).text()).toBe("previous");
    expect(previous).toHaveBeenCalledTimes(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
