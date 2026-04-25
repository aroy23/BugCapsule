import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { probeRuntime } from "./runtimeDiscovery.js";

let server: http.Server | undefined;

describe("probeRuntime", () => {
  afterEach(async () => {
    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
    server = undefined;
  });

  it("discovers a failing same-origin page interaction and parses source frames", async () => {
    const repoPath = path.resolve(".tmp-tests/runtime-probe");
    const stackFile = path.join(repoPath, "src/checkout/normalizeAddress.ts");
    const stack = [
      "TypeError: Cannot read properties of null (reading 'line1')",
      `    at normalizeShippingAddress (${stackFile}:12:27)`
    ].join("\n");
    const baseUrl = await startServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && requestUrl.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<button>Complete Checkout</button><script>fetch('/api/checkout', { method: 'POST' })</script>");
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/checkout") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: false,
          error: {
            message: "Cannot read properties of null (reading 'line1')",
            stack
          }
        }));
        return;
      }

      response.writeHead(404);
      response.end();
    });

    const result = await probeRuntime({
      repoPath,
      url: baseUrl,
      bugDescription: "the Complete Checkout button does not work"
    });

    expect(result.status).toBe("failure_found");
    expect(result.failure?.method).toBe("POST");
    expect(result.failure?.errorMessage).toContain("TypeError");
    expect(result.relatedFiles).toEqual([
      {
        path: "src/checkout/normalizeAddress.ts",
        reason: "Captured from runtime stack trace."
      }
    ]);
  });
});

async function startServer(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);

  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port.");
  }

  return `http://127.0.0.1:${address.port}/`;
}
