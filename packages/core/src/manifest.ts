import path from "node:path";

import { writeJsonFile, writeTextFile } from "./fileUtils.js";
import { normalizePath } from "./pathUtils.js";
import type { BugCapsuleManifest } from "./types.js";

export async function writeManifest(capsulePath: string, manifest: BugCapsuleManifest): Promise<void> {
  await writeJsonFile(path.join(capsulePath, "capsule.json"), manifest);
}

export async function readManifest(capsulePath: string): Promise<BugCapsuleManifest> {
  const { readJsonFile } = await import("./fileUtils.js");
  return readJsonFile<BugCapsuleManifest>(path.join(capsulePath, "capsule.json"));
}

export async function writeReadme(capsulePath: string, manifest: BugCapsuleManifest): Promise<void> {
  const rows = manifest.files
    .filter((file) => file.originalPath)
    .map((file) => `| ${file.capsulePath} | ${file.originalPath} |`)
    .join("\n");

  await writeTextFile(path.join(capsulePath, "README.md"), `# BugCapsule: ${manifest.name}\n\n## Bug\n\n${manifest.originalRepro.failureSummary}\n\n## Original repro\n\n\`\`\`bash\n${manifest.originalRepro.command}\n\`\`\`\n\n## Capsule repro\n\n\`\`\`bash\nnpm install\n${manifest.capsule.runCommand}\n\`\`\`\n\n## Expected behavior\n\nThe repro command should pass after the bug is fixed.\n\n## Current behavior\n\nThe repro command currently fails with:\n\n\`\`\`text\n${manifest.originalRepro.failureSummary}\n\`\`\`\n\n## Files copied from original repo\n\n| Capsule file | Original file |\n|---|---|\n${rows}\n\n## Instructions for coding agents\n\n1. Run \`${manifest.capsule.runCommand}\`.\n2. Fix the failing behavior.\n3. Keep the fix minimal.\n4. Do not remove the repro.\n5. After the repro passes, call the MCP tool \`bugcapsule_apply_patch\` with \`repoPath\`, \`capsuleId: "${manifest.capsuleId}"\`, and \`verify: true\`.\n`);
}

export function capsulePathFor(repoPath: string, capsuleId: string): string {
  return path.join(repoPath, ".bugcapsule", "capsules", capsuleId);
}

export function manifestRelativeLogPath(capsuleId: string, fileName: string): string {
  return normalizePath(path.join(".bugcapsule", "captures", capsuleId, fileName));
}
