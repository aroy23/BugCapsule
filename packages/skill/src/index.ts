import fs from "node:fs/promises";
import path from "node:path";

export type SkillTarget = "agents" | "windsurf";

export const skillName = "bugcapsule";

export const skillMarkdown = `---
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

The user does not need to provide a long workflow. If they provide a repo path and failing command, proceed without asking for more BugCapsule instructions.

Example:

\`\`\`text
Use BugCapsule to fix this.
repoPath: /path/to/repo
command: npm test -- checkout-missing-shipping-address
\`\`\`

## Workflow

1. Check that the BugCapsule MCP server is available.
2. If there is a failing command, call \`bugcapsule_create_from_command\` immediately.
3. If there is a Playwright trace, call \`bugcapsule_create_from_playwright_trace\`.
4. Follow the \`agentWorkflow\` returned by the tool response.
5. Open the generated capsule path.
6. Read \`README.md\` and \`capsule.json\`.
7. Run the capsule repro command.
8. Fix the failing capsule test.
9. Run the capsule repro command again.
10. Call \`bugcapsule_apply_patch\` with \`verify=true\`.
11. Summarize which original files changed and which verification checks passed.

## Rules

- Do not edit unrelated original repo files before creating a capsule unless the user explicitly asks.
- If a failing command is available, do not ask the user to restate the workflow.
- Do not delete capsule metadata.
- Prefer fixing the smallest root cause inside the capsule.
- After the capsule passes, always apply through BugCapsule rather than manually copying code back.
- If BugCapsule cannot reproduce the failure, report that clearly and fall back to normal debugging.

## Useful commands

\`\`\`bash
npx bugcapsule create -- npm test -- <test-name>
npx bugcapsule list
npx bugcapsule inspect <capsule-id>
npx bugcapsule run <capsule-id>
npx bugcapsule apply <capsule-id> --verify
\`\`\`
`;

export async function installSkill(options: {
  repoPath: string;
  target: SkillTarget;
}): Promise<{ targetPath: string }> {
  const targetPath = path.join(options.repoPath, targetDirectory(options.target), "bugcapsule", "SKILL.md");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, skillMarkdown);
  return { targetPath };
}

export function targetDirectory(target: SkillTarget): ".agents/skills" | ".windsurf/skills" {
  return target === "agents" ? ".agents/skills" : ".windsurf/skills";
}
