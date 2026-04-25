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
bash scripts/e2e-demo.sh
```
