import path from "node:path";

import { writeJsonFile, writeTextFile } from "./fileUtils.js";
import { normalizePath } from "./pathUtils.js";
import type { BugCapsuleManifest, BugCapsuleReport, CreateCapsuleResult } from "./types.js";

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

  await writeTextFile(path.join(capsulePath, "README.md"), `# BugCapsule: ${manifest.name}\n\n## Bug\n\n${manifest.originalRepro.failureSummary}\n\n## Original repro\n\n\`\`\`bash\n${manifest.originalRepro.command}\n\`\`\`\n\n## Capsule repro\n\n\`\`\`bash\nnpm install\n${manifest.capsule.runCommand}\n\`\`\`\n\n## Expected behavior\n\nThe repro command should pass after the bug is fixed.\n\n## Current behavior\n\nThe repro command currently fails with:\n\n\`\`\`text\n${manifest.originalRepro.failureSummary}\n\`\`\`\n\n## Files copied from original repo\n\n| Capsule file | Original file |\n|---|---|\n${rows}\n\n## Instructions for coding agents\n\n1. Run \`${manifest.capsule.runCommand}\`.\n2. Fix the failing behavior.\n3. Keep the fix minimal.\n4. Do not remove the repro.\n5. After the repro passes, return to the original repo and run:\n   \`bugcapsule apply ${manifest.capsuleId} --verify\`.\n`);
}

export async function writeReport(repoPath: string, result: CreateCapsuleResult): Promise<void> {
  const reportPath = path.join(repoPath, ".bugcapsule", "reports", result.capsuleId);

  await writeJsonFile(path.join(reportPath, "report.json"), result.report);
  await writeTextFile(path.join(reportPath, "report.md"), renderReport(result.report, result.manifest));
}

export function renderReport(report: BugCapsuleReport, manifest: BugCapsuleManifest): string {
  const includedRows = report.includedFiles.map((file) => `| ${file.path} | ${file.reason} |`).join("\n");
  const mockRows = report.mocks.map((mock) => `| ${mock.moduleName} | ${mock.reason} |`).join("\n") || "| None | None |";

  return `# BugCapsule Report: ${report.capsuleId}\n\n## Summary\n\n- Original files: ${report.originalFileCount}\n- Capsule files: ${report.capsuleFileCount}\n- Context reduction: ${report.contextReductionPercent}%\n- Original command: \`${manifest.originalRepro.command}\`\n- Capsule command: \`${manifest.capsule.runCommand}\`\n- Status: ${report.status}\n\n## Failure\n\n\`\`\`text\n${report.failureMessage}\n\`\`\`\n\n## Included files\n\n| File | Reason |\n|---|---|\n${includedRows}\n\n## Excluded files/modules\n\n| File/module | Reason |\n|---|---|\n${mockRows}\n\n## Agent instructions\n\nOpen the capsule and run:\n\n\`\`\`bash\n${manifest.capsule.runCommand}\n\`\`\`\n\nFix the failure. Then apply:\n\n\`\`\`bash\nbugcapsule apply ${report.capsuleId} --verify\n\`\`\`\n`;
}

export function capsulePathFor(repoPath: string, capsuleId: string): string {
  return path.join(repoPath, ".bugcapsule", "capsules", capsuleId);
}

export function manifestRelativeLogPath(capsuleId: string, fileName: string): string {
  return normalizePath(path.join(".bugcapsule", "reports", capsuleId, fileName));
}
