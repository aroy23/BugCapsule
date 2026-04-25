---
name: bugcapsule
description: >
  Use BugCapsule when debugging a failing test, vague bug report, flaky reproduction,
  production-like error, or large-codebase bug where the agent needs a smaller
  executable reproduction. This skill teaches the agent to create a minimized
  runnable capsule, fix it, and apply the patch back to the original repository.
---

# BugCapsule

## When to use this skill

Use this skill when:
- A bug is hard to understand in the full repo.
- A failing test involves too many files.
- The user asks to fix a bug but no small repro exists.
- The agent is about to search many unrelated files.
- The agent cannot reproduce a reported behavior.
- The agent needs to isolate a bug before editing the main codebase.

## Minimal user request

The user does not need to provide a long workflow. Treat short prompts that contain a repo path plus either a failing command or a local URL/symptom as enough context to start BugCapsule.

Command example:

```text
Use BugCapsule to fix this.
repoPath: /path/to/repo
command: npm test -- checkout-missing-shipping-address
```

Runtime example:

```text
Use BugCapsule to fix this.
/path/to/repo
http://localhost:4177
The checkout button does not work.
```

If the user only describes a website/runtime bug and gives a local URL, call `bugcapsule_create_from_runtime` with the repo path, URL, and broad symptom. It will probe the page, generate a hidden repro, and create a capsule without requiring a hand-written test command. If there is no URL, call `bugcapsule_suggest_repro` with the repo path, bug description, and any visible error text.

## Workflow

1. Check that the BugCapsule MCP server is available.
2. If there is a runtime URL but no failing command, call `bugcapsule_create_from_runtime`.
3. If there is a failing command, call `bugcapsule_create_from_command` immediately.
4. If there is a Playwright trace, call `bugcapsule_create_from_playwright_trace`.
5. Follow the `agentWorkflow` returned by the tool response.
6. Open the generated capsule path.
7. Read `README.md` and `capsule.json`.
8. Run the capsule repro command.
9. Fix the failing capsule test.
10. Run the capsule repro command again.
11. Call `bugcapsule_apply_patch` with `verify=true`.
12. Summarize which original files changed and which verification checks passed.

## Rules

- Do not edit unrelated original repo files before creating a capsule unless the user explicitly asks.
- If a failing command is available, do not ask the user to restate the workflow.
- If no failing command is available, use `bugcapsule_create_from_runtime` when a local URL exists; otherwise use `bugcapsule_suggest_repro` before normal broad code search.
- Do not delete capsule metadata.
- Prefer fixing the smallest root cause inside the capsule.
- After the capsule passes, always apply through BugCapsule rather than manually copying code back.
- If BugCapsule cannot reproduce the failure, report that clearly and fall back to normal debugging.

## Useful commands

```bash
npx bugcapsule create -- npm test -- <test-name>
npx bugcapsule create-runtime --url http://localhost:4177 --bug "the Complete Checkout button does not work"
npx bugcapsule list
npx bugcapsule inspect <capsule-id>
npx bugcapsule run <capsule-id>
npx bugcapsule apply <capsule-id> --verify
```
