import path from "node:path";

import { ensureDir, hashFile, hashString, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./fileUtils.js";
import { capsulePathFor, readManifest, writeManifest } from "./manifest.js";
import { assertInsideRoot, normalizePath } from "./pathUtils.js";
import type {
  BugCapsuleManifest,
  BugCapsuleWorkflow,
  BugCapsuleWorkflowMetadata,
  CapsuleIntegrityStatus,
  WorkflowCommandReceipt,
  WorkflowEventReceipt,
  WorkflowNextAction,
  WorkflowReceipt,
  WorkflowState
} from "./types.js";
import type { CommandResult } from "./shell.js";

export type WorkflowApplyGateResult =
  | {
    ok: true;
    workflow?: BugCapsuleWorkflow;
    editableFileSetHash?: string;
    lockedFileIntegrity: CapsuleIntegrityStatus;
  }
  | {
    ok: false;
    message: string;
    workflow?: BugCapsuleWorkflow;
    editableFileSetHash?: string;
    lockedFileIntegrity?: CapsuleIntegrityStatus;
  };

export function isStrictWorkflowManifest(manifest: BugCapsuleManifest): boolean {
  return manifest.schemaVersion === "0.2" && manifest.workflow?.strict === true;
}

export function workflowRelativePathFor(capsuleId: string): string {
  return normalizePath(path.join(".bugcapsule", "workflows", `${capsuleId}.json`));
}

export function workflowPathFor(repoPath: string, capsuleId: string): string {
  return path.join(repoPath, workflowRelativePathFor(capsuleId));
}

export function workflowLogRelativePath(capsuleId: string, fileName: string): string {
  return normalizePath(path.join(".bugcapsule", "workflows", capsuleId, fileName));
}

export function requiredNextActionFor(state: WorkflowState): WorkflowNextAction {
  switch (state) {
    case "created":
      return "inspect";
    case "inspected":
      return "reproduce_initial";
    case "initial_failure_confirmed":
    case "awaiting_fix":
      return "verify_capsule";
    case "capsule_passed":
      return "apply_patch";
    case "applied":
      return "done";
  }
}

export function workflowMetadataFor(capsuleId: string, state: WorkflowState = "created"): BugCapsuleWorkflowMetadata {
  return {
    id: capsuleId,
    strict: true,
    state,
    workflowPath: workflowRelativePathFor(capsuleId),
    requiredNextAction: requiredNextActionFor(state)
  };
}

export async function initializeWorkflow(repoPath: string, manifest: BugCapsuleManifest): Promise<BugCapsuleWorkflow> {
  const now = new Date().toISOString();
  const state = manifest.workflow?.state ?? "created";
  const workflow: BugCapsuleWorkflow = {
    schemaVersion: "0.1",
    workflowId: manifest.workflow?.id ?? manifest.capsuleId,
    capsuleId: manifest.capsuleId,
    repoPath,
    capsulePath: manifest.capsule.path,
    strict: manifest.workflow?.strict ?? true,
    state,
    requiredNextAction: requiredNextActionFor(state),
    createdAt: now,
    updatedAt: now,
    receipts: []
  };

  await writeWorkflow(repoPath, workflow);
  return workflow;
}

export async function readWorkflow(repoPath: string, capsuleId: string): Promise<BugCapsuleWorkflow | undefined> {
  const filePath = workflowPathFor(repoPath, capsuleId);

  if (!(await pathExists(filePath))) {
    return undefined;
  }

  return readJsonFile<BugCapsuleWorkflow>(filePath);
}

export async function ensureWorkflow(repoPath: string, manifest: BugCapsuleManifest): Promise<BugCapsuleWorkflow | undefined> {
  if (!isStrictWorkflowManifest(manifest)) {
    return undefined;
  }

  const existing = await readWorkflow(repoPath, manifest.capsuleId);

  if (existing) {
    return existing;
  }

  return initializeWorkflow(repoPath, manifest);
}

export async function writeWorkflow(repoPath: string, workflow: BugCapsuleWorkflow): Promise<void> {
  const updated: BugCapsuleWorkflow = {
    ...workflow,
    requiredNextAction: requiredNextActionFor(workflow.state),
    updatedAt: new Date().toISOString()
  };

  await writeJsonFile(workflowPathFor(repoPath, workflow.capsuleId), updated);
  await syncManifestWorkflowMetadata(repoPath, updated);
}

export async function hashEditableFileSet(manifest: BugCapsuleManifest): Promise<string> {
  const files = manifest.files
    .filter((file) => file.editable)
    .sort((left, right) => left.capsulePath.localeCompare(right.capsulePath));
  const entries = [];

  for (const file of files) {
    const absolutePath = path.join(manifest.capsule.path, file.capsulePath);
    assertInsideRoot(manifest.capsule.path, absolutePath);
    const hash = await pathExists(absolutePath) ? await hashFile(absolutePath) : "<missing>";

    entries.push({
      path: file.capsulePath,
      kind: file.kind,
      hash
    });
  }

  return hashString(`${JSON.stringify(entries)}\n`);
}

export async function validateCapsuleIntegrity(manifest: BugCapsuleManifest): Promise<CapsuleIntegrityStatus> {
  const lockedFiles = manifest.files
    .filter((file) => !file.editable)
    .sort((left, right) => left.capsulePath.localeCompare(right.capsulePath));
  const modifiedLockedFiles: string[] = [];
  const missingLockedFiles: string[] = [];

  for (const file of lockedFiles) {
    const absolutePath = path.join(manifest.capsule.path, file.capsulePath);
    assertInsideRoot(manifest.capsule.path, absolutePath);

    if (!(await pathExists(absolutePath))) {
      missingLockedFiles.push(file.capsulePath);
      continue;
    }

    const currentHash = await hashFile(absolutePath);

    if (currentHash !== file.hashAtCapture) {
      modifiedLockedFiles.push(file.capsulePath);
    }
  }

  return {
    status: modifiedLockedFiles.length === 0 && missingLockedFiles.length === 0 ? "passed" : "failed",
    checkedFiles: lockedFiles.length,
    modifiedLockedFiles,
    missingLockedFiles
  };
}

export async function assertWorkflowCanApply(
  repoPath: string,
  manifest: BugCapsuleManifest
): Promise<WorkflowApplyGateResult> {
  const lockedFileIntegrity = await validateCapsuleIntegrity(manifest);

  if (lockedFileIntegrity.status !== "passed") {
    return {
      ok: false,
      message: integrityFailureMessage(lockedFileIntegrity),
      lockedFileIntegrity
    };
  }

  if (!isStrictWorkflowManifest(manifest)) {
    return {
      ok: true,
      lockedFileIntegrity
    };
  }

  const workflow = await readWorkflow(repoPath, manifest.capsuleId);
  const editableFileSetHash = await hashEditableFileSet(manifest);

  if (!workflow) {
    return {
      ok: false,
      message: "Strict BugCapsule workflow is enabled, but the workflow receipt file is missing. Use bugcapsule_fix_step to verify and apply this capsule.",
      editableFileSetHash,
      lockedFileIntegrity
    };
  }

  if (workflow.state !== "capsule_passed") {
    return {
      ok: false,
      message: `Strict BugCapsule workflow requires state 'capsule_passed' before apply. Current state is '${workflow.state}'. Required next action: ${workflow.requiredNextAction}.`,
      workflow,
      editableFileSetHash,
      lockedFileIntegrity
    };
  }

  if (!workflow.passingReceiptId || !workflow.passingEditableFileSetHash) {
    return {
      ok: false,
      message: "Strict BugCapsule workflow has no passing capsule verification receipt. Call bugcapsule_fix_step with action='verify_capsule' after the capsule repro passes.",
      workflow,
      editableFileSetHash,
      lockedFileIntegrity
    };
  }

  if (editableFileSetHash !== workflow.passingEditableFileSetHash) {
    return {
      ok: false,
      message: "Editable capsule files changed after the passing verification receipt. Re-run bugcapsule_fix_step with action='verify_capsule' before applying.",
      workflow,
      editableFileSetHash,
      lockedFileIntegrity
    };
  }

  return {
    ok: true,
    workflow,
    editableFileSetHash,
    lockedFileIntegrity
  };
}

export async function createWorkflowEventReceipt(
  manifest: BugCapsuleManifest,
  action: WorkflowEventReceipt["action"],
  result: WorkflowEventReceipt["result"]
): Promise<WorkflowEventReceipt> {
  return {
    id: action,
    action,
    timestamp: new Date().toISOString(),
    editableFileSetHash: await hashEditableFileSet(manifest),
    lockedFileIntegrity: await validateCapsuleIntegrity(manifest),
    result
  };
}

export async function createWorkflowCommandReceipt(
  repoPath: string,
  manifest: BugCapsuleManifest,
  workflow: BugCapsuleWorkflow,
  action: WorkflowCommandReceipt["action"],
  commandResult: CommandResult,
  result: WorkflowCommandReceipt["result"]
): Promise<WorkflowCommandReceipt> {
  const sequence = String(workflow.receipts.length + 1).padStart(3, "0");
  const baseName = `${sequence}-${action}`;
  const stdoutPath = workflowLogRelativePath(manifest.capsuleId, `${baseName}.stdout.log`);
  const stderrPath = workflowLogRelativePath(manifest.capsuleId, `${baseName}.stderr.log`);

  await ensureDir(path.join(repoPath, ".bugcapsule", "workflows", manifest.capsuleId));
  await writeTextFile(path.join(repoPath, stdoutPath), commandResult.stdout);
  await writeTextFile(path.join(repoPath, stderrPath), commandResult.stderr);

  return {
    id: baseName,
    action,
    timestamp: new Date().toISOString(),
    command: commandResult.command,
    cwd: commandResult.cwd,
    exitCode: commandResult.exitCode,
    durationMs: commandResult.durationMs,
    stdoutPath,
    stderrPath,
    stdoutHash: hashString(commandResult.stdout),
    stderrHash: hashString(commandResult.stderr),
    editableFileSetHash: await hashEditableFileSet(manifest),
    lockedFileIntegrity: await validateCapsuleIntegrity(manifest),
    result
  };
}

export async function appendWorkflowReceipt(
  repoPath: string,
  workflow: BugCapsuleWorkflow,
  receipt: WorkflowReceipt,
  state: WorkflowState
): Promise<BugCapsuleWorkflow> {
  const nextWorkflow: BugCapsuleWorkflow = {
    ...workflow,
    state,
    requiredNextAction: requiredNextActionFor(state),
    receipts: [...workflow.receipts, receipt]
  };

  if (receipt.action === "verify_capsule" && receipt.result === "passed") {
    nextWorkflow.passingReceiptId = receipt.id;
    nextWorkflow.passingEditableFileSetHash = receipt.editableFileSetHash;
  } else if (state === "awaiting_fix" || state === "initial_failure_confirmed") {
    delete nextWorkflow.passingReceiptId;
    delete nextWorkflow.passingEditableFileSetHash;
  }

  await writeWorkflow(repoPath, nextWorkflow);
  const written = await readWorkflow(repoPath, workflow.capsuleId);
  return written ?? nextWorkflow;
}

export function integrityFailureMessage(integrity: CapsuleIntegrityStatus): string {
  const modified = integrity.modifiedLockedFiles.length > 0
    ? `modified locked files: ${integrity.modifiedLockedFiles.join(", ")}`
    : "";
  const missing = integrity.missingLockedFiles.length > 0
    ? `missing locked files: ${integrity.missingLockedFiles.join(", ")}`
    : "";
  const details = [modified, missing].filter(Boolean).join("; ");
  return `Capsule integrity check failed${details ? ` (${details})` : ""}. Non-editable capsule files must not change.`;
}

async function syncManifestWorkflowMetadata(repoPath: string, workflow: BugCapsuleWorkflow): Promise<void> {
  const capsulePath = capsulePathFor(repoPath, workflow.capsuleId);
  const manifestPath = path.join(capsulePath, "capsule.json");

  if (!(await pathExists(manifestPath))) {
    return;
  }

  const manifest = await readManifest(capsulePath);

  if (!manifest.workflow) {
    return;
  }

  manifest.workflow = {
    id: workflow.workflowId,
    strict: workflow.strict,
    state: workflow.state,
    workflowPath: workflowRelativePathFor(workflow.capsuleId),
    requiredNextAction: workflow.requiredNextAction
  };
  await writeManifest(capsulePath, manifest);
}
