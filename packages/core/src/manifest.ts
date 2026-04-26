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
  const suspectedUpstreamCauses = manifest.suspectedUpstreamCauses ?? [];
  const upstreamPaths = new Set(suspectedUpstreamCauses.map((cause) => cause.path));
  const rows = [...manifest.files]
    .filter((file) => file.originalPath)
    .sort((left, right) => Number(upstreamPaths.has(right.originalPath)) - Number(upstreamPaths.has(left.originalPath)) || left.capsulePath.localeCompare(right.capsulePath))
    .map((file) => `| ${file.capsulePath} | ${file.originalPath} | ${upstreamPaths.has(file.originalPath) ? "Suspected upstream cause" : ""} |`)
    .join("\n");
  const upstreamSection = renderUpstreamCandidates(manifest);
  const inputLineageSection = renderInputLineage(manifest);
  const workflowSection = renderWorkflowSection(manifest);

  await writeTextFile(path.join(capsulePath, "README.md"), `# BugCapsule: ${manifest.name}\n\n## Bug\n\n${manifest.originalRepro.failureSummary}\n\n## Original repro\n\n\`\`\`bash\n${manifest.originalRepro.command}\n\`\`\`\n\n## Capsule repro\n\n\`\`\`bash\nnpm install\n${manifest.capsule.runCommand}\n\`\`\`\n\n## Expected behavior\n\nThe repro command should pass after the bug is fixed.\n\n## Current behavior\n\nThe repro command currently fails with:\n\n\`\`\`text\n${manifest.originalRepro.failureSummary}\n\`\`\`\n\n${upstreamSection}${inputLineageSection}## Files copied from original repo\n\n| Capsule file | Original file | Signal |\n|---|---|---|\n${rows}\n\n${workflowSection}## Symptom-patch warning\n\n${antiSymptomPatchingInstructions()}\n\n## Instructions for coding agents\n\n1. Call the MCP tool \`bugcapsule_fix_step\` with \`action: "inspect"\`.\n2. Call \`bugcapsule_fix_step\` with \`action: "reproduce_initial"\` to record the failing capsule receipt.\n3. Fix the failing behavior in mapped editable capsule files only.\n4. Call \`bugcapsule_fix_step\` with \`action: "verify_capsule"\` until the capsule passes.\n5. Call \`bugcapsule_fix_step\` with \`action: "apply_patch"\` to apply the exact verified file set.\n`);
}

function renderWorkflowSection(manifest: BugCapsuleManifest): string {
  if (!manifest.workflow?.strict) {
    return "";
  }

  return `## Deterministic workflow\n\nThis capsule uses a strict BugCapsule workflow. Apply-back is gated by \`${manifest.workflow.workflowPath}\`, and the source repo will only be patched from the exact editable capsule file set that passed \`bugcapsule_fix_step\` verification.\n\n`;
}

function renderUpstreamCandidates(manifest: BugCapsuleManifest): string {
  const suspectedUpstreamCauses = manifest.suspectedUpstreamCauses ?? [];

  if (suspectedUpstreamCauses.length === 0) {
    return "";
  }

  const rows = suspectedUpstreamCauses
    .map((cause) => `- \`${cause.path}\` - ${cause.reason}`)
    .join("\n");

  return `## Upstream candidates\n\nThese files appear in the static call graph above the failure site and construct or transform the value passed to the failing function. If the failing function received malformed input, the cause is likely here:\n\n${rows}\n\n`;
}

function renderInputLineage(manifest: BugCapsuleManifest): string {
  if (!manifest.inputLineage || !("requestBoundary" in manifest.inputLineage)) {
    return "";
  }

  const source = manifest.inputLineage.requestBoundarySource
    ? `\nSource: ${manifest.inputLineage.requestBoundarySource}\n`
    : "\n";
  const payload = JSON.stringify(manifest.inputLineage.requestBoundary, null, 2);

  return `## Request boundary input\n${source}\n\`\`\`json\n${payload}\n\`\`\`\n\n`;
}

function antiSymptomPatchingInstructions(): string {
  return `Important: A fix that makes the throw stop but produces fabricated output (empty strings, "Unknown", default values not derived from the input) is NOT an acceptable fix. Before patching the failing function:\n\n1. Inspect the value the function received at the failure site.\n2. If that value looks malformed (null, {}, undefined, NaN, etc.), trace it backwards through the call stack to find where it was constructed.\n3. Check the "Upstream candidates" section of this README for files that transformed the input before it reached the failure site.\n4. Prefer fixing the upstream cause, validating-and-rejecting at the boundary, or returning a clear error to the user over defensive padding at the failure site.`;
}

export function capsulePathFor(repoPath: string, capsuleId: string): string {
  return path.join(repoPath, ".bugcapsule", "capsules", capsuleId);
}

export function manifestRelativeLogPath(capsuleId: string, fileName: string): string {
  return normalizePath(path.join(".bugcapsule", "captures", capsuleId, fileName));
}
