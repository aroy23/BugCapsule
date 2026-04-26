import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCapsuleFromRuntime, probeRuntime } from "./runtimeDiscovery.js";
import { runShellCommand } from "./shell.js";

let server: http.Server | undefined;
const tempRoot = path.resolve(".tmp-tests/runtime-discovery");

describe("probeRuntime", () => {
  afterEach(async () => {
    if (!server) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
    server = undefined;
    await fs.rm(tempRoot, { recursive: true, force: true });
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

  it("creates the runtime repro from the narrowest stack export that reproduces the failure", async () => {
    const repoPath = path.join(tempRoot, "storefront");
    await writeRuntimeRepo(repoPath);

    const sampleInput = {
      cartId: "cart_123",
      customer: {
        id: "cus_123",
        shippingAddress: null
      },
      paymentToken: "tok_test"
    };
    const stack = [
      "TypeError: Cannot read properties of null (reading 'line1')",
      `    at normalizeShippingAddress (${path.join(repoPath, "src/checkout/normalizeAddress.ts")}:8:25)`,
      `    at buildFulfillmentRequest (${path.join(repoPath, "src/checkout/fulfillmentRequest.ts")}:5:19)`,
      `    at completeCheckout (${path.join(repoPath, "src/checkout/checkoutService.ts")}:8:10)`,
      `    at handleCheckout (${path.join(repoPath, "src/server.ts")}:6:10)`
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
          error: {
            message: "Cannot read properties of null (reading 'line1')",
            stack
          }
        }));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/sample-checkout") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(sampleInput));
        return;
      }

      response.writeHead(404);
      response.end();
    });

    const result = await createCapsuleFromRuntime({
      repoPath,
      url: baseUrl,
      bugDescription: "the Complete Checkout button does not work",
      capsuleId: "bc_runtime_checkout",
      installDependencies: false,
      verifyCapsule: false
    });

    if (!("capsulePath" in result)) {
      throw new Error(result.message);
    }

    expect(result.generatedRepro.targetExport).toEqual({
      file: "src/checkout/fulfillmentRequest.ts",
      name: "buildFulfillmentRequest"
    });

    const capsuleFiles = result.manifest.files.map((file) => file.capsulePath);
    expect(capsuleFiles).toEqual(expect.arrayContaining([
      ".bugcapsule/repros/bc_runtime_checkout.ts",
      "src/checkout/inputSanitizer.ts",
      "src/checkout/fulfillmentRequest.ts",
      "src/checkout/normalizeAddress.ts",
      "src/server.ts",
      "src/checkout/types.ts"
    ]));
    expect(capsuleFiles).not.toContain("src/analytics/checkoutAnalytics.ts");
    expect(capsuleFiles).not.toContain("src/payments/paymentGateway.ts");
    expect(result.manifest.suspectedUpstreamCauses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "src/checkout/inputSanitizer.ts"
      })
    ]));
    expect(result.manifest.inputLineage?.requestBoundary).toEqual(sampleInput);
    const readme = await fs.readFile(path.join(result.capsulePath, "README.md"), "utf8");
    expect(readme).toContain("## Upstream candidates");
    expect(readme).toContain("src/checkout/inputSanitizer.ts");
    expect(readme).toContain("## Symptom-patch warning");
    await expect(fs.readdir(path.join(repoPath, ".bugcapsule/repros"))).resolves.toEqual(["bc_runtime_checkout.ts"]);

    await writeFile(result.capsulePath, "src/checkout/normalizeAddress.ts", `import type { Address } from "./types.js";

export type NormalizedAddress = {
  line1: string;
};

export function normalizeShippingAddress(address: Address | null): NormalizedAddress {
  if (address === null) {
    return {
      line1: ""
    };
  }

  return {
    line1: address.line1.trim()
  };
}
`);
    await fs.symlink(path.resolve("node_modules"), path.join(result.capsulePath, "node_modules"), "dir");

    const weakFix = await runShellCommand(result.manifest.capsule.runCommand, result.capsulePath);

    expect(weakFix.exitCode).not.toBe(0);
    expect(weakFix.stderr).toContain("Runtime repro produced a placeholder value");
    expect(weakFix.stderr).toContain("Inspect the upstream candidates");
    expect(weakFix.stderr).toContain("Input lineage:");
    expect(weakFix.stderr).toContain("Boundary-vs-failure diff:");
    expect(weakFix.stderr).toContain("normalizeShippingAddress");

    const lineagePath = path.join(result.capsulePath, ".bugcapsule/repros/bc_runtime_checkout.lineage.json");
    const lineage = JSON.parse(await fs.readFile(lineagePath, "utf8")) as {
      requestBoundary: unknown;
      tape: Array<{ file: string; functionName: string; firstArg: unknown }>;
    };
    expect(lineage.requestBoundary).toEqual(sampleInput);
    expect(lineage.tape).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: "src/checkout/normalizeAddress.ts",
        functionName: "normalizeShippingAddress",
        firstArg: null
      })
    ]));
  });

  it("falls back to a server interaction repro when the runtime response has no stack or sample payload", async () => {
    const repoPath = path.join(tempRoot, "server-fallback");
    await writeRuntimeServerFallbackRepo(repoPath);
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
          error: "Cannot read properties of null (reading 'line1')"
        }));
        return;
      }

      response.writeHead(404);
      response.end();
    });

    const result = await createCapsuleFromRuntime({
      repoPath,
      url: baseUrl,
      bugDescription: "the Complete Checkout button does not work",
      capsuleId: "bc_runtime_server_fallback",
      installDependencies: false,
      verifyCapsule: false
    });

    if (!("capsulePath" in result)) {
      throw new Error(result.message);
    }

    expect(result.status).toBe("created_failing");
    expect(result.generatedRepro).toEqual(expect.objectContaining({
      targetExport: {
        file: "src/server.ts",
        name: "runtimeInteraction"
      },
      inputSource: "runtime interaction POST /api/checkout"
    }));
    expect(result.manifest.originalRepro.stackTrace).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: "src/checkout/normalizeAddress.ts"
      })
    ]));
    expect(result.manifest.files.map((file) => file.capsulePath)).toEqual(expect.arrayContaining([
      ".bugcapsule/repros/bc_runtime_server_fallback.ts",
      "src/server.ts",
      "src/checkout/checkoutService.ts",
      "src/checkout/normalizeAddress.ts"
    ]));
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

async function writeRuntimeRepo(repoPath: string): Promise<void> {
  await fs.rm(repoPath, { recursive: true, force: true });
  await writeFile(repoPath, "package.json", `${JSON.stringify({
    name: "runtime-target-selection",
    private: true,
    type: "module",
    devDependencies: {
      tsx: "^4.20.0",
      typescript: "^6.0.3"
    }
  }, null, 2)}\n`);
  await writeFile(repoPath, "tsconfig.json", `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true
    },
    include: ["src/**/*.ts", ".bugcapsule/**/*.ts"]
  }, null, 2)}\n`);

  try {
    await fs.symlink(path.resolve("node_modules"), path.join(repoPath, "node_modules"), "dir");
  } catch {
    // The test can still use npx's normal resolution path if the symlink cannot be created.
  }

  await writeFile(repoPath, "src/checkout/types.ts", `export type Address = {
  line1: string;
};

export type CheckoutInput = {
  cartId: string;
  customer: {
    id: string;
    shippingAddress: Address | null;
  };
  paymentToken: string;
};
`);
  await writeFile(repoPath, "src/checkout/normalizeAddress.ts", `import type { Address } from "./types.js";

export type NormalizedAddress = {
  line1: string;
};

export function normalizeShippingAddress(address: Address | null): NormalizedAddress {
  const presentAddress = address as Address;
  return {
    line1: presentAddress.line1.trim()
  };
}
`);
  await writeFile(repoPath, "src/checkout/fulfillmentRequest.ts", `import { normalizeShippingAddress } from "./normalizeAddress.js";
import type { CheckoutInput } from "./types.js";

export function buildFulfillmentRequest(input: CheckoutInput): { destination: string } {
  const address = normalizeShippingAddress(input.customer.shippingAddress);
  return {
    destination: address.line1
  };
}
`);
  await writeFile(repoPath, "src/checkout/checkoutService.ts", `import { publishCheckoutAnalytics } from "../analytics/checkoutAnalytics.js";
import { authorizePayment } from "../payments/paymentGateway.js";
import { buildFulfillmentRequest } from "./fulfillmentRequest.js";
import type { CheckoutInput } from "./types.js";

export function completeCheckout(input: CheckoutInput): { destination: string } {
  authorizePayment(input.paymentToken);
  publishCheckoutAnalytics(input.cartId);
  return buildFulfillmentRequest(input);
}
`);
  await writeFile(repoPath, "src/checkout/inputSanitizer.ts", `import type { Address, CheckoutInput } from "./types.js";

export function sanitizeCheckoutInput(raw: CheckoutInput): CheckoutInput {
  return {
    ...raw,
    customer: {
      ...raw.customer,
      shippingAddress: raw.customer.shippingAddress ?? ({} as Address)
    }
  };
}
`);
  await writeFile(repoPath, "src/server.ts", `import { sanitizeCheckoutInput } from "./checkout/inputSanitizer.js";
import { completeCheckout } from "./checkout/checkoutService.js";
import type { CheckoutInput } from "./checkout/types.js";

export function handleCheckout(raw: CheckoutInput): { destination: string } {
  return completeCheckout(sanitizeCheckoutInput(raw));
}
`);
  await writeFile(repoPath, "src/analytics/checkoutAnalytics.ts", `export function publishCheckoutAnalytics(cartId: string): void {
  void cartId;
}
`);
  await writeFile(repoPath, "src/payments/paymentGateway.ts", `export function authorizePayment(paymentToken: string): void {
  void paymentToken;
}
`);
}

async function writeRuntimeServerFallbackRepo(repoPath: string): Promise<void> {
  await fs.rm(repoPath, { recursive: true, force: true });
  await writeFile(repoPath, "package.json", `${JSON.stringify({
    name: "runtime-server-fallback",
    private: true,
    type: "module",
    devDependencies: {
      tsx: "^4.20.0",
      typescript: "^6.0.3"
    }
  }, null, 2)}\n`);
  await writeFile(repoPath, "tsconfig.json", `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      types: ["node"]
    },
    include: ["src/**/*.ts", ".bugcapsule/**/*.ts"]
  }, null, 2)}\n`);

  try {
    await fs.symlink(path.resolve("node_modules"), path.join(repoPath, "node_modules"), "dir");
  } catch {
    // The test can still use npx's normal resolution path if the symlink cannot be created.
  }

  await writeFile(repoPath, "src/checkout/types.ts", `export type Address = {
  line1: string;
};

export type CheckoutInput = {
  cartId: string;
  shippingAddress: Address | null;
};
`);
  await writeFile(repoPath, "src/checkout/normalizeAddress.ts", `import type { Address } from "./types.js";

export function normalizeShippingAddress(address: Address | null): { line1: string } {
  return {
    line1: address!.line1.trim()
  };
}
`);
  await writeFile(repoPath, "src/checkout/checkoutService.ts", `import { normalizeShippingAddress } from "./normalizeAddress.js";
import type { CheckoutInput } from "./types.js";

export function completeCheckout(input: CheckoutInput): { destination: string } {
  const address = normalizeShippingAddress(input.shippingAddress);
  return {
    destination: address.line1
  };
}
`);
  await writeFile(repoPath, "src/server.ts", `import { createServer } from "node:http";

import { completeCheckout } from "./checkout/checkoutService.js";

const port = Number(process.env.PORT ?? "4177");

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && requestUrl.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<button>Complete Checkout</button><script>fetch('/api/checkout', { method: 'POST' })</script>");
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/checkout") {
    try {
      const result = completeCheckout({
        cartId: "cart_123",
        shippingAddress: null
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      console.error(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      }));
    }
    return;
  }

  response.writeHead(404);
  response.end();
});

server.listen(port);
`);
}

async function writeFile(repoPath: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(repoPath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}
