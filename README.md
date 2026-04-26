# BugCapsule

BugCapsule is local-first MCP tooling that shrinks a failing TypeScript/Node bug into a small executable capsule an AI coding agent can inspect, fix, verify, and apply back to the original repo.

It is MCP-first: there is no standalone CLI or installable agent skill package. Agents use the local MCP server and call BugCapsule tools directly.

**Report:** [Read our comprehensive implementation and testing report](docs/bugcapsule_report.pdf)

## Packages

- `@bugcapsule/core`: capsule creation, slicing, verification, and apply-back logic.
- `@bugcapsule/mcp`: local stdio MCP server that exposes BugCapsule tools.

## Implementation

- Determinism: `bugcapsule_fix_step` enforces an ordered workflow: inspect, reproduce, verify, then apply. Capsules use manifests, file hashes, locked support files, and verification receipts so patches are applied back only after the focused repro passes.
- Technologies: BugCapsule is built with TypeScript, Node.js, MCP stdio, `ts-morph`/TypeScript compiler tooling, `tsx`, npm, Vitest, local browser/runtime probing, and `js-tiktoken` for evaluation token estimates.
- Capsule boundary: capsulation starts from a failing command or captured runtime stack trace, then follows stack frames, TypeScript imports, upstream candidates, and required support files. It excludes large or unsafe artifacts such as `node_modules`, build outputs, coverage, and secrets while preserving enough code to reproduce the same failure.

## Effectiveness

BugCapsule was tested on a demo checkout bug and a 10-project stress-testing suite with one distinct runtime bug per project. In the stress suite, capsules reduced debugging context by about 77% on average while preserving executable failures, and on the demo repo SWE-1.6 Fast failed alone but succeeded when guided through BugCapsule.

## Local Development

```bash
npm install
npm run build
npm test
```

After changing `packages/core` or `packages/mcp`, run `npm run build` so your IDE uses the latest `dist` files.

Print the absolute MCP server path:

```bash
node -e 'console.log(require("node:path").resolve("packages/mcp/dist/server.js"))'
```

## MCP IDE Setup

BugCapsule runs as a stdio MCP server. Use the absolute path to `packages/mcp/dist/server.js`.

### Windsurf / Cursor

Add this to the IDE MCP config:

```json
{
  "mcpServers": {
    "bugcapsule": {
      "command": "node",
      "args": [
        "/absolute/path/to/BugCapsule/packages/mcp/dist/server.js"
      ]
    }
  }
}
```

References:

- [Windsurf Cascade MCP docs](https://docs.windsurf.com/plugins/cascade/mcp)
- [Cursor MCP docs](https://docs.cursor.com/advanced/model-context-protocol)

### VS Code

VS Code uses `servers` instead of `mcpServers`:

```json
{
  "servers": {
    "bugcapsule": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/BugCapsule/packages/mcp/dist/server.js"
      ]
    }
  }
}
```

Reference: [VS Code MCP server docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)

## Prompting

For a local runtime bug:

```text
Use BugCapsule to fix this.
repoPath: /path/to/Demo
url: http://localhost:4177
bug: The checkout page looks normal, but clicking "Place the order" fails.
```

For a known failing command:

```text
Use BugCapsule to fix this.
repoPath: /path/to/Demo
command: npm test -- checkout-missing-shipping-address
```

For an ambiguous bug description:

```text
Use BugCapsule to fix this.
repoPath: /path/to/Demo
bug: Checkout fails when the customer has no shipping address.
```

If only a description is provided, BugCapsule can suggest likely commands, files, and dev-server hints. To create an executable capsule, it still needs either a local URL it can probe or a confirmed failing command it can run.

## MCP Tools

- `bugcapsule_suggest_repro`: finds likely repro commands, files, or runtime hints from partial bug context.
- `bugcapsule_create_from_runtime`: probes a local URL, captures the failure, derives a source repro, and creates a capsule.
- `bugcapsule_create_from_command`: creates a capsule from a confirmed failing command.
- `bugcapsule_inspect`: reads capsule manifest and guidance.
- `bugcapsule_run`: runs the capsule repro.
- `bugcapsule_verify`: reruns capsule and original verification checks.
- `bugcapsule_fix_step`: deterministic workflow gate for inspect, reproduce, verify, and apply-back.
- `bugcapsule_apply_patch`: legacy-compatible apply tool; strict workflow capsules should apply through `bugcapsule_fix_step`.

## Typical Agent Flow

1. Create a capsule from runtime or command.
2. Inspect the manifest and mapped editable files.
3. Reproduce the failure inside the capsule.
4. Fix only mapped editable files.
5. Verify the capsule passes.
6. Apply the verified patch back to the original repo.

## Evaluation Reports

After deterministic apply-back, BugCapsule can generate `.bugcapsule/evaluations/<capsule-id>/evaluation.html`. Configure pricing once per target repo:

```bash
npm run pricing -- --repo /path/to/repo --profile windsurf:swe-1.6-fast
```

List bundled pricing profiles:

```bash
npm run pricing -- --list
```

If `.bugcapsule/pricing.json` is missing, evaluation stays off unless pricing is passed directly with the apply request. For non-OpenAI models, `evaluation_encoding` is a deterministic local tokenizer proxy, not provider-exact tokenization.

## Current Scope

BugCapsule currently targets TypeScript/Node projects. The capsule idea is language-agnostic, but this implementation relies on TypeScript-aware stack parsing, import graphing, repro generation, and `tsx` execution.
