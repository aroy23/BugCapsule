import fs from "node:fs/promises";
import path from "node:path";

import { applyCapsule } from "./applyCapsule.js";
import { capsulePathFor, readManifest } from "./manifest.js";
import { runShellCommand, type CommandResult } from "./shell.js";
import {
  appendWorkflowReceipt,
  assertWorkflowCanApply,
  createWorkflowCommandReceipt,
  createWorkflowEventReceipt,
  ensureWorkflow,
  integrityFailureMessage,
  requiredNextActionFor,
  validateCapsuleIntegrity,
  writeWorkflow
} from "./workflow.js";
import type {
  ApplyCapsuleResult,
  BugCapsuleManifest,
  BugCapsuleWorkflow,
  FixStepOptions,
  FixStepResult,
  WorkflowAction,
  WorkflowNextAction,
  WorkflowReceipt,
  WorkflowState
} from "./types.js";

export async function runFixStep(options: FixStepOptions): Promise<FixStepResult> {
  const repoPath = path.resolve(options.repoPath);
  const capsulePath = capsulePathFor(repoPath, options.capsuleId);
  const manifest = await readManifest(capsulePath);
  const workflow = await ensureWorkflow(repoPath, manifest);

  if (!workflow) {
    return {
      status: "rejected",
      capsuleId: options.capsuleId,
      currentState: "created",
      requiredNextAction: "inspect",
      message: "This capsule does not have strict deterministic workflow metadata. Use the legacy BugCapsule tools for this capsule.",
      manifest
    };
  }

  if (options.action === "next") {
    return resultForWorkflow(repoPath, options.capsuleId, workflow, "Next deterministic action is available.", { manifest });
  }

  if (!isAllowedAction(workflow.state, options.action)) {
    return resultForWorkflow(
      repoPath,
      options.capsuleId,
      workflow,
      `Rejected action '${options.action}'. Required next action is '${workflow.requiredNextAction}'.`,
      { status: "rejected", manifest }
    );
  }

  switch (options.action) {
    case "inspect":
      return inspectStep(repoPath, manifest, workflow);
    case "reproduce_initial":
      return reproduceInitialStep(repoPath, manifest, workflow);
    case "verify_capsule":
      return verifyCapsuleStep(repoPath, manifest, workflow);
    case "apply_patch":
      return applyPatchStep(repoPath, manifest, workflow);
  }
}

async function inspectStep(
  repoPath: string,
  manifest: BugCapsuleManifest,
  workflow: BugCapsuleWorkflow
): Promise<FixStepResult> {
  const integrity = await validateCapsuleIntegrity(manifest);
  const receipt = await createWorkflowEventReceipt(manifest, "inspect", integrity.status);

  if (integrity.status !== "passed") {
    const updated = await appendWorkflowReceipt(repoPath, workflow, receipt, workflow.state);
    return resultForWorkflow(repoPath, manifest.capsuleId, updated, integrityFailureMessage(integrity), {
      status: "failed",
      manifest,
      receipt
    });
  }

  const readmePath = path.join(manifest.capsule.path, "README.md");
  const readme = await fs.readFile(readmePath, "utf8");
  const updated = await appendWorkflowReceipt(repoPath, workflow, receipt, "inspected");

  return resultForWorkflow(repoPath, manifest.capsuleId, updated, "Capsule inspected. Reproduce the initial failure next.", {
    manifest,
    readme,
    receipt
  });
}

async function reproduceInitialStep(
  repoPath: string,
  manifest: BugCapsuleManifest,
  workflow: BugCapsuleWorkflow
): Promise<FixStepResult> {
  const integrity = await validateCapsuleIntegrity(manifest);

  if (integrity.status !== "passed") {
    return resultForWorkflow(repoPath, manifest.capsuleId, workflow, integrityFailureMessage(integrity), {
      status: "failed",
      manifest
    });
  }

  const commandResult = await runShellCommand(manifest.capsule.runCommand, manifest.capsule.path);
  const stepPassed = commandResult.exitCode !== 0;
  const receipt = await createWorkflowCommandReceipt(
    repoPath,
    manifest,
    workflow,
    "reproduce_initial",
    commandResult,
    stepPassed ? "passed" : "failed"
  );
  const nextState: WorkflowState = stepPassed ? "initial_failure_confirmed" : "inspected";
  const updated = await appendWorkflowReceipt(repoPath, workflow, receipt, nextState);
  const message = stepPassed
    ? "Initial capsule repro failed as expected. Edit mapped capsule files, then verify the capsule."
    : "Initial capsule repro passed, so BugCapsule cannot prove the original failure in this capsule.";

  return resultForWorkflow(repoPath, manifest.capsuleId, updated, message, {
    status: stepPassed ? "ok" : "failed",
    manifest,
    receipt
  });
}

async function verifyCapsuleStep(
  repoPath: string,
  manifest: BugCapsuleManifest,
  workflow: BugCapsuleWorkflow
): Promise<FixStepResult> {
  const integrity = await validateCapsuleIntegrity(manifest);

  if (integrity.status !== "passed") {
    return resultForWorkflow(repoPath, manifest.capsuleId, workflow, integrityFailureMessage(integrity), {
      status: "failed",
      manifest
    });
  }

  const commandResult = await runShellCommand(manifest.capsule.runCommand, manifest.capsule.path);
  const stepPassed = commandResult.exitCode === 0;
  const receipt = await createWorkflowCommandReceipt(
    repoPath,
    manifest,
    workflow,
    "verify_capsule",
    commandResult,
    stepPassed ? "passed" : "failed"
  );
  const nextState: WorkflowState = stepPassed ? "capsule_passed" : "awaiting_fix";
  const updated = await appendWorkflowReceipt(repoPath, workflow, receipt, nextState);
  const message = stepPassed
    ? "Capsule repro passed. Apply the exact verified capsule file set next."
    : "Capsule repro is still failing. Continue editing mapped capsule files, then verify again.";

  return resultForWorkflow(repoPath, manifest.capsuleId, updated, message, {
    manifest,
    receipt
  });
}

async function applyPatchStep(
  repoPath: string,
  manifest: BugCapsuleManifest,
  workflow: BugCapsuleWorkflow
): Promise<FixStepResult> {
  const gate = await assertWorkflowCanApply(repoPath, manifest);

  if (!gate.ok) {
    const resetWorkflow = gate.workflow && gate.editableFileSetHash &&
      gate.workflow.passingEditableFileSetHash &&
      gate.editableFileSetHash !== gate.workflow.passingEditableFileSetHash
      ? await resetWorkflowToAwaitingFix(repoPath, gate.workflow)
      : workflow;

    return resultForWorkflow(repoPath, manifest.capsuleId, resetWorkflow, gate.message, {
      status: "rejected",
      manifest
    });
  }

  const startedAt = Date.now();
  const applyResult = await applyCapsule({
    repoPath,
    capsuleId: manifest.capsuleId,
    verify: true,
    workflowValidated: true
  });
  const applied = applyResult.status.startsWith("applied_");
  const commandResult = syntheticApplyCommandResult(repoPath, applyResult, Date.now() - startedAt);
  const receipt = await createWorkflowCommandReceipt(
    repoPath,
    manifest,
    workflow,
    "apply_patch",
    commandResult,
    applied ? "passed" : "failed"
  );
  const updated = await appendWorkflowReceipt(repoPath, workflow, receipt, applied ? "applied" : "capsule_passed");
  const message = applied
    ? "Patch applied and verified through the deterministic workflow."
    : applyResult.message ?? "Patch application failed.";

  return resultForWorkflow(repoPath, manifest.capsuleId, updated, message, {
    status: applied ? "ok" : "failed",
    manifest,
    receipt,
    applyResult
  });
}

function isAllowedAction(state: WorkflowState, action: WorkflowAction): boolean {
  if (action === "verify_capsule" && state === "capsule_passed") {
    return true;
  }

  return requiredNextActionFor(state) === action;
}

async function resetWorkflowToAwaitingFix(repoPath: string, workflow: BugCapsuleWorkflow): Promise<BugCapsuleWorkflow> {
  const reset: BugCapsuleWorkflow = {
    ...workflow,
    state: "awaiting_fix",
    requiredNextAction: "verify_capsule"
  };

  delete reset.passingReceiptId;
  delete reset.passingEditableFileSetHash;
  await writeWorkflow(repoPath, reset);

  return {
    ...reset,
    updatedAt: new Date().toISOString()
  };
}

function resultForWorkflow(
  repoPath: string,
  capsuleId: string,
  workflow: BugCapsuleWorkflow,
  message: string,
  options: {
    status?: FixStepResult["status"];
    manifest?: FixStepResult["manifest"];
    readme?: string;
    receipt?: WorkflowReceipt;
    applyResult?: ApplyCapsuleResult;
  } = {}
): FixStepResult {
  const requiredNextAction = workflow.requiredNextAction;
  const base: FixStepResult = {
    status: options.status ?? "ok",
    capsuleId,
    workflow,
    currentState: workflow.state,
    requiredNextAction,
    message
  };

  if (options.manifest) {
    base.manifest = options.manifest;
  }
  if (options.readme) {
    base.readme = options.readme;
  }
  if (options.receipt) {
    base.receipt = options.receipt;
  }
  if (options.applyResult) {
    base.applyResult = options.applyResult;
  }

  const nextToolCall = nextToolCallFor(repoPath, capsuleId, requiredNextAction);

  if (nextToolCall) {
    base.nextToolCall = nextToolCall;
  }

  return base;
}

function nextToolCallFor(
  repoPath: string,
  capsuleId: string,
  action: WorkflowNextAction
): FixStepResult["nextToolCall"] {
  if (action === "done") {
    return undefined;
  }

  return {
    tool: "bugcapsule_fix_step",
    arguments: {
      repoPath,
      capsuleId,
      action
    }
  };
}

function syntheticApplyCommandResult(repoPath: string, applyResult: ApplyCapsuleResult, durationMs: number): CommandResult {
  const stdout = `${JSON.stringify(applyResult, null, 2)}\n`;
  const stderr = applyResult.status === "failed" || applyResult.status === "conflict"
    ? `${applyResult.message ?? "BugCapsule apply failed."}\n`
    : "";

  return {
    command: "bugcapsule_apply_patch --verify",
    cwd: repoPath,
    exitCode: applyResult.status.startsWith("applied_") ? 0 : 1,
    stdout,
    stderr,
    durationMs
  };
}
