# BugCapsule

BugCapsule is local-first MCP tooling that shrinks a failing behavior from a TypeScript repository into a small executable capsule an AI coding agent can fix.

This repository is MCP-first. There is no standalone BugCapsule CLI or installable agent skill package. Agents use the local MCP server and call BugCapsule tools directly.

## Repository Layout

- `@bugcapsule/core` contains capsule creation, verification, and apply-back logic.
- `@bugcapsule/mcp` exposes BugCapsule as a local MCP server.
- `examples/acme-saas` contains the invoice export demo bug.

## Local Development

```bash
npm install
npm run build
npm test
```

The local MCP server entry point is:

```text
/Users/arnav/Desktop/BugCapsule/packages/mcp/dist/server.js
```

Run `npm run build` after changing the server or core package so your IDE uses the latest `dist` files.

## Add BugCapsule To An MCP IDE

BugCapsule runs as a stdio MCP server. The important configuration is always:

```json
{
  "command": "node",
  "args": [
    "/Users/arnav/Desktop/BugCapsule/packages/mcp/dist/server.js"
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
        "/Users/arnav/Desktop/BugCapsule/packages/mcp/dist/server.js"
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
        "/Users/arnav/Desktop/BugCapsule/packages/mcp/dist/server.js"
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
        "/Users/arnav/Desktop/BugCapsule/packages/mcp/dist/server.js"
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
5. Fix only the capsule.
6. Call `bugcapsule_apply_patch` with `verify: true`.

This path does not require you to provide an exact error-producing command.

### If you already have a failing command

```text
Use BugCapsule to fix this.
repoPath: /Users/arnav/Desktop/Demo
command: npm test -- checkout-missing-shipping-address
```

Expected MCP flow:

1. Call `bugcapsule_create_from_command`.
2. Fix the generated capsule until its repro passes.
3. Call `bugcapsule_apply_patch` with `verify: true`.

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
- `bugcapsule_apply_patch`: apply changed capsule files back to the original repo.
