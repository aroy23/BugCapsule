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

After configuring the local MCP server, the user prompt can be short:

```text
Use BugCapsule to fix this.
repoPath: /Users/arnav/Desktop/Demo
command: npm test -- checkout-missing-shipping-address
```

The MCP tool returns an `agentWorkflow` with the capsule path, repro command, editable files, and the exact apply-back call.

If the user only knows the app behavior, use the suggestion tool first:

```text
Use BugCapsule to figure out how to reproduce this checkout bug.
repoPath: /Users/arnav/Desktop/Demo
url: http://localhost:4177
bug: clicking Complete Checkout shows a missing shipping address error
```

`bugcapsule_suggest_repro` ranks existing tests, repro scripts, dev-server commands, and related files so the agent can confirm a failing command before capsule creation.
