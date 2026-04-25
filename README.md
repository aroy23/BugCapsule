# BugCapsule

BugCapsule is local-first developer tooling that shrinks a failing behavior from a TypeScript repository into a small executable capsule an AI coding agent can fix.

This repository contains the demo MVP:

- `@bugcapsule/core` for capsule creation, verification, and apply-back.
- `@bugcapsule/cli` for the `bugcapsule` command.
- `@bugcapsule/mcp` for agent tool integration.
- `@bugcapsule/skill` for installable agent skill instructions.
- `examples/acme-saas` for the invoice export demo bug.

## Local Development

```bash
npm install
npm run build
npm test
```

## Using BugCapsule From An MCP Agent

After configuring the local MCP server, the user prompt can be short. If the user has a failing command:

```text
Use BugCapsule to fix this.
repoPath: /Users/arnav/Desktop/Demo
command: npm test -- checkout-missing-shipping-address
```

The MCP tool returns an `agentWorkflow` with the capsule path, repro command, editable files, and the exact apply-back call.

If the user only knows the app behavior, provide the local URL and a broad symptom:

```text
Use BugCapsule to fix this.
/Users/arnav/Desktop/Demo
http://localhost:4177
The Complete Checkout button does not work.
```

`bugcapsule_create_from_runtime` probes same-origin page interactions, captures the server stack, writes a hidden `.bugcapsule/repros/*` repro, and creates the capsule from that generated repro. `bugcapsule_suggest_repro` remains useful when the user does not know whether a command or runtime URL is available.
