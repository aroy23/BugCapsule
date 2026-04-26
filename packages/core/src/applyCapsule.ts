import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";

import { ensureDir, hashFile, pathExists, writeTextFile } from "./fileUtils.js";
import { capsulePathFor, readManifest } from "./manifest.js";
import { runShellCommand } from "./shell.js";
import { verifyCapsule } from "./verifyCapsule.js";
import { assertWorkflowCanApply, isStrictWorkflowManifest } from "./workflow.js";
import type { ApplyCapsuleOptions, ApplyCapsuleResult } from "./types.js";

export async function applyCapsule(options: ApplyCapsuleOptions): Promise<ApplyCapsuleResult> {
  const repoPath = path.resolve(options.repoPath);
  const capsulePath = capsulePathFor(repoPath, options.capsuleId);
  const manifest = await readManifest(capsulePath);
  const applyGate = await assertWorkflowCanApply(repoPath, manifest);

  if (!applyGate.ok) {
    return {
      status: "failed",
      modifiedOriginalFiles: [],
      message: applyGate.message
    };
  }

  if (isStrictWorkflowManifest(manifest) && !options.workflowValidated) {
    return {
      status: "failed",
      modifiedOriginalFiles: [],
      message: "Strict deterministic workflow requires applying through bugcapsule_fix_step with action='apply_patch'."
    };
  }

  if (!options.allowDirty && manifest.apply.requireCleanGitWorktree) {
    const dirty = await scopedGitDirty(repoPath);

    if (dirty) {
      return {
        status: "failed",
        modifiedOriginalFiles: [],
        message: "Original repo has uncommitted changes inside the target repo path. Re-run with allowDirty to override."
      };
    }
  }

  const modified = [];

  for (const file of manifest.files) {
    if (!file.editable || !file.originalPath || file.kind === "generated_mock") {
      continue;
    }

    const capsuleFilePath = path.join(capsulePath, file.capsulePath);

    if (!(await pathExists(capsuleFilePath))) {
      continue;
    }

    const currentHash = await hashFile(capsuleFilePath);

    if (currentHash !== file.hashAtCapture) {
      modified.push(file);
    }
  }

  if (modified.length === 0) {
    return {
      status: options.dryRun ? "dry_run" : "applied_unverified",
      modifiedOriginalFiles: [],
      message: "No editable capsule files changed."
    };
  }

  const patches = [];

  for (const file of modified) {
    const originalPath = path.join(repoPath, file.originalPath);
    const capsuleFilePath = path.join(capsulePath, file.capsulePath);

    const originalHashAtCapture = file.originalHashAtCapture ?? file.hashAtCapture;

    if ((await hashFile(originalPath)) !== originalHashAtCapture && !options.allowDirty) {
      return {
        status: "conflict",
        modifiedOriginalFiles: modified.map((item) => item.originalPath),
        message: `Original file changed since capture: ${file.originalPath}`
      };
    }

    const originalContent = await fs.readFile(originalPath, "utf8");
    const updatedContent = await fs.readFile(capsuleFilePath, "utf8");
    patches.push(createTwoFilesPatch(file.originalPath, file.originalPath, originalContent, updatedContent));
  }

  const patchPath = path.join(repoPath, ".bugcapsule", "patches", `${options.capsuleId}.patch`);
  await ensureDir(path.dirname(patchPath));
  await writeTextFile(patchPath, patches.join("\n"));

  if (options.dryRun) {
    return {
      status: "dry_run",
      modifiedOriginalFiles: modified.map((file) => file.originalPath),
      patchPath
    };
  }

  for (const file of modified) {
    const originalPath = path.join(repoPath, file.originalPath);
    const capsuleFilePath = path.join(capsulePath, file.capsulePath);
    await fs.copyFile(capsuleFilePath, originalPath);
  }

  if (options.verify ?? false) {
    const verification = await verifyCapsule({ repoPath, capsuleId: options.capsuleId });

    return {
      status: verification.status === "passed" ? "applied_verified" : "failed",
      modifiedOriginalFiles: modified.map((file) => file.originalPath),
      patchPath,
      verification
    };
  }

  return {
    status: "applied_unverified",
    modifiedOriginalFiles: modified.map((file) => file.originalPath),
    patchPath
  };
}

async function scopedGitDirty(repoPath: string): Promise<boolean> {
  const result = await runShellCommand("git status --porcelain -- .", repoPath);
  return result.stdout.trim().length > 0;
}
