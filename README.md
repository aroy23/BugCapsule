# BugCapsule

BugCapsule is local-first MCP tooling that shrinks a failing behavior from a TypeScript repository into a small executable capsule an AI coding agent can fix.

This repository is MCP-first. There is no standalone BugCapsule CLI or installable agent skill package. Agents use the local MCP server and call BugCapsule tools directly.

## Repository Layout

- `@bugcapsule/core` contains capsule creation, verification, and apply-back logic.
- `@bugcapsule/mcp` exposes BugCapsule as a local MCP server.

## Local Development

```bash
npm install
npm run build
npm test
```

The local MCP server entry point is `packages/mcp/dist/server.js`. Use an absolute path in IDE config. From the BugCapsule repo root, print it with:

```bash
node -e 'console.log(require("node:path").resolve("packages/mcp/dist/server.js"))'
```

Run `npm run build` after changing the server or core package so your IDE uses the latest `dist` files.

## Add BugCapsule To An MCP IDE

BugCapsule runs as a stdio MCP server. The important configuration is always:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/BugCapsule/packages/mcp/dist/server.js"
  ]
}
```

### Windsurf

Open `Settings` -> `Tools` -> `Windsurf Settings` -> `Add Server`, then use the raw MCP config editor and add:

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

Refresh MCP servers after saving. Windsurf also supports editing its MCP config JSON directly; current Windsurf docs describe `~/.codeium/mcp_config.json` for this raw config.

Reference: [Windsurf Cascade MCP docs](https://docs.windsurf.com/plugins/cascade/mcp)

### Cursor

Add the same `mcpServers` entry to your Cursor MCP config. For a project-local config, create or edit `.cursor/mcp.json`:

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

Reference: [Cursor MCP docs](https://docs.cursor.com/advanced/model-context-protocol)

### VS Code

VS Code uses a `servers` object rather than `mcpServers`. Create or edit `.vscode/mcp.json`:

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

## Prompting BugCapsule

Use short prompts. The agent should choose the right BugCapsule MCP tool from the information you give it.

### Best case: local URL plus symptom

Use this when you can open the broken app locally but do not know a failing test command.

```text
Use BugCapsule to fix this.
repoPath: /Users/arnav/Desktop/Demo
url: http://localhost:4177
bug: The Complete Checkout button does not work.
```

Expected MCP flow:

1. Call `bugcapsule_create_from_runtime`.
2. Probe same-origin page interactions from the URL.
3. Capture the server-side stack and generated runtime repro.
4. Create a minimized capsule.
5. Follow `deterministicWorkflow.nextToolCall`.
6. Fix only mapped editable capsule files.
7. Call `bugcapsule_fix_step` with `action: "verify_capsule"` until the capsule passes.
8. Call `bugcapsule_fix_step` with `action: "apply_patch"`.

This path does not require you to provide an exact error-producing command.

### If you already have a failing command

```text
Use BugCapsule to fix this.
repoPath: /Users/arnav/Desktop/Demo
command: npm test -- checkout-missing-shipping-address
```

Expected MCP flow:

1. Call `bugcapsule_create_from_command`.
2. Follow `deterministicWorkflow.nextToolCall`.
3. Fix only mapped editable capsule files.
4. Call `bugcapsule_fix_step` with `action: "verify_capsule"` until the capsule passes.
5. Call `bugcapsule_fix_step` with `action: "apply_patch"`.

### If you only have a description

```text
Use BugCapsule to fix this.
repoPath: /Users/arnav/Desktop/Demo
bug: Checkout fails when the customer has no shipping address.
```

Expected MCP flow:

1. Call `bugcapsule_suggest_repro`.
2. Use returned candidate commands, related files, or dev-server hints to find a runnable reproduction.
3. If a local URL is available, call `bugcapsule_create_from_runtime`.
4. If a failing command is confirmed, call `bugcapsule_create_from_command`.

Description-only ambiguity handling exists, but it cannot always create a capsule by itself. BugCapsule can rank likely tests, scripts, dev-server commands, and related source files from the description. To create an executable capsule, it still needs either a local URL it can probe or a confirmed failing command it can run.

## MCP Tools

- `bugcapsule_suggest_repro`: use for ambiguous prompts with only a repo path, description, URL, or visible error text.
- `bugcapsule_create_from_runtime`: use when the user provides a local URL and broad runtime symptom.
- `bugcapsule_create_from_command`: use when the user provides or confirms a failing command.
- `bugcapsule_inspect`: read capsule manifest and README.
- `bugcapsule_run`: run a capsule repro through MCP.
- `bugcapsule_verify`: rerun capsule and original verification checks.
- `bugcapsule_fix_step`: deterministic strict workflow gate for inspect, initial reproduction, capsule verification, and apply-back.
- `bugcapsule_apply_patch`: legacy-compatible apply tool. Strict workflow capsules must apply through `bugcapsule_fix_step`.

## Evaluation Prompt Add-On

BugCapsule can generate `.bugcapsule/evaluations/<capsule-id>/evaluation.html` after deterministic apply-back through `bugcapsule_fix_step`. Evaluation is opt-in. Configure the model price once in `.bugcapsule/pricing.json`, then ask BugCapsule to generate evaluation.

```json
{
  "profile": "windsurf:swe-1.6-fast"
}
```

Profiles live in `packages/mcp/pricing-catalog.json`. Current bundled profile examples include:

- `windsurf:swe-1.6-fast` (`$0.30/M` input, `$0.03/M` cached input, `$1.50/M` output; source: user-provided Windsurf model selector screenshot)
- `anthropic:claude-sonnet-4.6`
- `anthropic:claude-opus-4.7`
- `openai:gpt-5.4`
- `openai:gpt-5.4-mini`
- `openai:gpt-5.3-codex`
- `google:gemini-2.5-pro`
- `google:gemini-2.5-flash`
- `google:gemini-3-flash-preview`

Manual overrides still work:

```json
{
  "profile": "windsurf:swe-1.6-fast",
  "input_per_million": 0.3,
  "output_per_million": 1.5,
  "evaluation_encoding": "o200k_base"
}
```

Use `generateEvaluation: true` on `bugcapsule_apply_patch` or the final `bugcapsule_fix_step` apply action. For non-OpenAI models, `evaluation_encoding` is a deterministic local tokenizer proxy, not provider-exact tokenization. Supported `js-tiktoken` encodings include `o200k_base`, `cl100k_base`, `p50k_base`, `r50k_base`, and `gpt2`.
