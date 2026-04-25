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

## Workflow

1. Check that the BugCapsule MCP server is available.
2. If there is a failing command, call `bugcapsule_create_from_command`.
3. If there is a Playwright trace, call `bugcapsule_create_from_playwright_trace`.
4. Open the generated capsule path.
5. Read `README.md` and `capsule.json`.
6. Run the capsule repro command.
7. Fix the failing capsule test.
8. Run the capsule repro command again.
9. Call `bugcapsule_apply_patch` with `verify=true`.
10. Summarize which original files changed and which verification checks passed.

## Rules

- Do not edit unrelated original repo files before creating a capsule unless the user explicitly asks.
- Do not delete capsule metadata.
- Prefer fixing the smallest root cause inside the capsule.
- After the capsule passes, always apply through BugCapsule rather than manually copying code back.
- If BugCapsule cannot reproduce the failure, report that clearly and fall back to normal debugging.

## Useful commands

```bash
npx bugcapsule create -- npm test -- <test-name>
npx bugcapsule list
npx bugcapsule inspect <capsule-id>
npx bugcapsule run <capsule-id>
npx bugcapsule apply <capsule-id> --verify
```
