#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  applyCapsule,
  createCapsule,
  createCapsuleFromRuntime,
  inspectCapsule,
  listCapsules,
  runCapsule,
  runFixStep,
  suggestRepro,
  verifyCapsule,
  type BugCapsuleManifest,
  type CreateCapsuleResult
} from "@bugcapsule/core";

import { SessionTracker } from "./usage/sessionTracker.js";
import { loadPricing } from "./usage/pricing.js";
import { registerTrackedTool } from "./usage/wrapTool.js";

const server = new McpServer({
  name: "bugcapsule",
  version: "0.1.0"
});

const tracker = new SessionTracker();
const ANTI_SYMPTOM_PATCHING_INSTRUCTIONS = [
  "Important: A fix that makes the throw stop but produces fabricated output (empty strings, \"Unknown\", default values not derived from the input) is NOT an acceptable fix.",
  "Before patching the failing function:",
  "1. Inspect the value the function received at the failure site.",
  "2. If that value looks malformed (null, {}, undefined, NaN, etc.), trace it backwards through the call stack to find where it was constructed.",
  "3. Check the \"Upstream candidates\" section of the capsule README for files that transformed the input before it reached the failure site.",
  "4. Prefer fixing the upstream cause, validating-and-rejecting at the boundary, or returning a clear error to the user over defensive padding at the failure site."
].join("\n");

registerTools(server, tracker);
registerResources(server);
registerPrompts(server);
registerShutdownHooks(tracker);

await server.connect(new StdioServerTransport());

function registerTools(mcp: McpServer, tracker: SessionTracker): void {
  registerTrackedTool(
    mcp,
    tracker,
    "bugcapsule_suggest_repro",
    {
      title: "Suggest BugCapsule Repro Command",
      description: [
        "Call this when the user gives a repo path plus a vague bug description, visible error, or URL, but no confirmed failing command.",
        "It inspects package scripts, test names, runtime repro scripts, and related source paths, then returns candidate commands or a workflow to create one.",
        "If a URL is present, prefer bugcapsule_create_from_runtime. If only a description is present, use this tool to disambiguate before asking for more context."
      ].join(" "),
      inputSchema: {
        repoPath: z.string(),
        bugDescription: z.string().optional(),
        url: z.string().optional(),
        errorText: z.string().optional()
      }
    },
    async (args) => jsonResult(await suggestRepro({
      repoPath: args.repoPath,
      ...(args.bugDescription ? { bugDescription: args.bugDescription } : {}),
      ...(args.url ? { url: args.url } : {}),
      ...(args.errorText ? { errorText: args.errorText } : {})
    }))
  );

  registerTrackedTool(
    mcp,
    tracker,
    "bugcapsule_create_from_runtime",
    {
      title: "Create BugCapsule From Runtime Symptom",
      description: [
        "Call this when the user reports a visual or runtime bug with broad context, such as 'this button does not work', and can provide the local page URL.",
        "It probes same-origin interactions from the page, captures the server-side stack, generates a hidden source repro under .bugcapsule/repros, then creates an executable capsule.",
        "After this tool succeeds, follow deterministicWorkflow.nextToolCall and use bugcapsule_fix_step for inspect, reproduction, verification, and apply-back."
      ].join(" "),
      inputSchema: {
        repoPath: z.string(),
        url: z.string(),
        bugDescription: z.string().optional(),
        interactionHint: z.string().optional(),
        capsuleName: z.string().optional(),
        maxFiles: z.number().positive().optional(),
        maxDepth: z.number().positive().optional(),
        includeGlobs: z.array(z.string()).optional(),
        excludeGlobs: z.array(z.string()).optional(),
        verifyCapsule: z.boolean().default(true),
        generateEvaluation: z.boolean().optional(),
        evaluationModel: z.string().optional(),
        evaluationEncoding: z.string().optional(),
        inputPricePerMillion: z.number().nonnegative().optional(),
        outputPricePerMillion: z.number().nonnegative().optional()
      }
    },
    async (args) => {
      const result = await createCapsuleFromRuntime({
        repoPath: args.repoPath,
        url: args.url,
        ...(args.bugDescription ? { bugDescription: args.bugDescription } : {}),
        ...(args.interactionHint ? { interactionHint: args.interactionHint } : {}),
        ...(args.capsuleName ? { capsuleName: args.capsuleName } : {}),
        ...(args.maxFiles ? { maxFiles: args.maxFiles } : {}),
        ...(args.maxDepth ? { maxDepth: args.maxDepth } : {}),
        ...(args.includeGlobs ? { includeGlobs: args.includeGlobs } : {}),
        ...(args.excludeGlobs ? { excludeGlobs: args.excludeGlobs } : {}),
        verifyCapsule: args.verifyCapsule
      });

      if (!("capsulePath" in result)) {
        return jsonResult(result);
      }

      return jsonResult({
        capsuleId: result.capsuleId,
        status: result.status,
        capsulePath: result.capsulePath,
        runCommand: result.manifest.capsule.runCommand,
        capsuleReadmePath: path.join(result.capsulePath, "README.md"),
        capsuleManifestPath: path.join(result.capsulePath, "capsule.json"),
        discoveredFailure: result.probe.failure,
        generatedRepro: result.generatedRepro,
        summary: {
          originalFileCount: result.manifest.metrics.originalFileCount,
          capsuleFileCount: result.manifest.metrics.capsuleFileCount,
          contextReductionPercent: result.manifest.metrics.contextReductionPercent,
          failureMessage: result.manifest.originalRepro.failureSummary,
          includedEditableFiles: editableFiles(result.manifest),
          suspectedUpstreamCauses: result.manifest.suspectedUpstreamCauses ?? [],
          generatedMocks: result.manifest.mocks.map((mock) => mock.moduleName)
        },
        deterministicWorkflow: workflowSummary(args.repoPath, result.manifest),
        agentWorkflow: buildAgentWorkflow(result),
        applyPatchToolCall: {
          tool: "bugcapsule_fix_step",
          arguments: fixStepArguments(args.repoPath, result.capsuleId, "apply_patch", args)
        },
        nextAgentInstruction: `Call bugcapsule_fix_step with repoPath='${args.repoPath}', capsuleId='${result.capsuleId}', action='inspect'. Follow the returned nextToolCall until action='apply_patch' succeeds.`
      });
    }
  );

  registerTrackedTool(
    mcp,
    tracker,
    "bugcapsule_create_from_command",
    {
      title: "Start BugCapsule Debugging From Failing Command",
      description: [
        "Call this first whenever the user asks BugCapsule to isolate, shrink, or fix a bug and provides a failing command. If the user does not know a failing command but has a local URL, call bugcapsule_create_from_runtime instead.",
        "This tool runs the failing command, creates a minimized executable capsule, and returns the exact next workflow for the agent.",
        "After this tool succeeds, follow deterministicWorkflow.nextToolCall and use bugcapsule_fix_step for inspect, reproduction, verification, and apply-back."
      ].join(" "),
      inputSchema: {
        repoPath: z.string(),
        command: z.string(),
        capsuleName: z.string().optional(),
        maxFiles: z.number().positive().optional(),
        maxDepth: z.number().positive().optional(),
        includeGlobs: z.array(z.string()).optional(),
        excludeGlobs: z.array(z.string()).optional(),
        verifyCapsule: z.boolean().default(true),
        generateEvaluation: z.boolean().optional(),
        evaluationModel: z.string().optional(),
        evaluationEncoding: z.string().optional(),
        inputPricePerMillion: z.number().nonnegative().optional(),
        outputPricePerMillion: z.number().nonnegative().optional()
      }
    },
    async (args) => {
      const result = await createCapsule({
        repoPath: args.repoPath,
        command: args.command,
        ...(args.capsuleName ? { capsuleName: args.capsuleName } : {}),
        ...(args.maxFiles ? { maxFiles: args.maxFiles } : {}),
        ...(args.maxDepth ? { maxDepth: args.maxDepth } : {}),
        ...(args.includeGlobs ? { includeGlobs: args.includeGlobs } : {}),
        ...(args.excludeGlobs ? { excludeGlobs: args.excludeGlobs } : {}),
        verifyCapsule: args.verifyCapsule
      });

      return jsonResult({
        capsuleId: result.capsuleId,
        status: result.status,
        capsulePath: result.capsulePath,
        runCommand: result.manifest.capsule.runCommand,
        capsuleReadmePath: path.join(result.capsulePath, "README.md"),
        capsuleManifestPath: path.join(result.capsulePath, "capsule.json"),
        summary: {
          originalFileCount: result.manifest.metrics.originalFileCount,
          capsuleFileCount: result.manifest.metrics.capsuleFileCount,
          contextReductionPercent: result.manifest.metrics.contextReductionPercent,
          failureMessage: result.manifest.originalRepro.failureSummary,
          includedEditableFiles: editableFiles(result.manifest),
          suspectedUpstreamCauses: result.manifest.suspectedUpstreamCauses ?? [],
          generatedMocks: result.manifest.mocks.map((mock) => mock.moduleName)
        },
        deterministicWorkflow: workflowSummary(args.repoPath, result.manifest),
        agentWorkflow: buildAgentWorkflow(result),
        applyPatchToolCall: {
          tool: "bugcapsule_fix_step",
          arguments: fixStepArguments(args.repoPath, result.capsuleId, "apply_patch", args)
        },
        nextAgentInstruction: `Call bugcapsule_fix_step with repoPath='${args.repoPath}', capsuleId='${result.capsuleId}', action='inspect'. Follow the returned nextToolCall until action='apply_patch' succeeds.`
      });
    }
  );

  registerTrackedTool(
    mcp,
    tracker,
    "bugcapsule_list",
    {
      title: "List BugCapsules",
      description: "List capsules in a repository.",
      inputSchema: {
        repoPath: z.string()
      }
    },
    async (args) => jsonResult(await listCapsules({ repoPath: args.repoPath }))
  );

  registerTrackedTool(
    mcp,
    tracker,
    "bugcapsule_run",
    {
      title: "Run BugCapsule",
      description: "Run a capsule repro command. Use this after creating a capsule if the agent wants MCP to execute the capsule repro instead of running a shell command directly.",
      inputSchema: {
        repoPath: z.string(),
        capsuleId: z.string(),
        command: z.string().optional()
      }
    },
    async (args) => jsonResult(await runCapsule({
      repoPath: args.repoPath,
      capsuleId: args.capsuleId,
      ...(args.command ? { command: args.command } : {})
    }))
  );

  registerTrackedTool(
    mcp,
    tracker,
    "bugcapsule_inspect",
    {
      title: "Inspect BugCapsule",
      description: "Read a capsule manifest and README. Use this after create when the agent needs file-map details or fix instructions.",
      inputSchema: {
        repoPath: z.string(),
        capsuleId: z.string()
      }
    },
    async (args) => {
      const manifest = await inspectCapsule({ repoPath: args.repoPath, capsuleId: args.capsuleId });
      const readmePath = path.join(manifest.capsule.path, "README.md");
      const readme = await fs.readFile(readmePath, "utf8");
      return jsonResult({
        manifest,
        readme,
        agentWorkflow: buildAgentWorkflowFromManifest(args.repoPath, manifest)
      });
    }
  );

  registerTrackedTool(
    mcp,
    tracker,
    "bugcapsule_fix_step",
    {
      title: "Run Deterministic BugCapsule Fix Step",
      description: [
        "Use this for strict BugCapsule capsules. It enforces the canonical workflow: inspect, reproduce_initial, verify_capsule, apply_patch.",
        "If called out of order, it returns the required next action and does not mutate source files.",
        "Apply-back succeeds only when the current editable capsule file set exactly matches a passing verify_capsule receipt."
      ].join(" "),
      inputSchema: {
        repoPath: z.string(),
        capsuleId: z.string(),
        action: z.enum(["next", "inspect", "reproduce_initial", "verify_capsule", "apply_patch"]),
        generateEvaluation: z.boolean().optional(),
        evaluationModel: z.string().optional(),
        evaluationEncoding: z.string().optional(),
        inputPricePerMillion: z.number().nonnegative().optional(),
        outputPricePerMillion: z.number().nonnegative().optional()
      }
    },
    async (args) => {
      const result = await runFixStep({
        repoPath: args.repoPath,
        capsuleId: args.capsuleId,
        action: args.action
      });

      if (args.action !== "apply_patch" || result.status !== "ok" || !result.applyResult?.status.startsWith("applied_")) {
        return jsonResult(result);
      }

      const evaluationConfig = await resolveEvaluationConfig(args);

      if (evaluationConfig.status === "disabled") {
        return jsonResult(result);
      }

      if (evaluationConfig.status === "invalid") {
        return jsonResult({
          ...result,
          evaluation: {
            status: "failed",
            message: evaluationConfig.message
          }
        });
      }

      const evaluation = await runEvaluation({
        repoPath: args.repoPath,
        capsuleId: args.capsuleId,
        evaluationModel: evaluationConfig.evaluationModel,
        ...(evaluationConfig.evaluationEncoding ? { evaluationEncoding: evaluationConfig.evaluationEncoding } : {}),
        inputPricePerMillion: evaluationConfig.inputPricePerMillion,
        outputPricePerMillion: evaluationConfig.outputPricePerMillion
      });

      return jsonResult({
        ...result,
        evaluation
      });
    }
  );

  registerTrackedTool(
    mcp,
    tracker,
    "bugcapsule_apply_patch",
    {
      title: "Apply BugCapsule Patch",
      description: "Apply changed capsule files back to their original source paths. Legacy-compatible tool; strict workflow capsules must apply through bugcapsule_fix_step with action='apply_patch'.",
      inputSchema: {
        repoPath: z.string(),
        capsuleId: z.string(),
        dryRun: z.boolean().default(false),
        verify: z.boolean().default(true),
        allowDirty: z.boolean().default(false),
        generateEvaluation: z.boolean().optional(),
        evaluationModel: z.string().optional(),
        evaluationEncoding: z.string().optional(),
        inputPricePerMillion: z.number().nonnegative().optional(),
        outputPricePerMillion: z.number().nonnegative().optional()
      }
    },
    async (args) => {
      const result = await applyCapsule({
        repoPath: args.repoPath,
        capsuleId: args.capsuleId,
        dryRun: args.dryRun,
        verify: args.verify,
        allowDirty: args.allowDirty
      });

      const evaluationConfig = await resolveEvaluationConfig(args);

      if (evaluationConfig.status === "disabled" || args.dryRun || !result.status.startsWith("applied_")) {
        return jsonResult(result);
      }

      if (evaluationConfig.status === "invalid") {
        return jsonResult({
          ...result,
          evaluation: {
            status: "failed",
            message: evaluationConfig.message
          }
        });
      }

      const evaluation = await runEvaluation({
        repoPath: args.repoPath,
        capsuleId: args.capsuleId,
        evaluationModel: evaluationConfig.evaluationModel,
        ...(evaluationConfig.evaluationEncoding ? { evaluationEncoding: evaluationConfig.evaluationEncoding } : {}),
        inputPricePerMillion: evaluationConfig.inputPricePerMillion,
        outputPricePerMillion: evaluationConfig.outputPricePerMillion
      });

      return jsonResult({
        ...result,
        evaluation
      });
    }
  );

  registerTrackedTool(
    mcp,
    tracker,
    "bugcapsule_verify",
    {
      title: "Verify BugCapsule",
      description: "Run capsule and original repro verification checks.",
      inputSchema: {
        repoPath: z.string(),
        capsuleId: z.string(),
        runFullProjectTests: z.boolean().default(false)
      }
    },
    async (args) => jsonResult(await verifyCapsule({
      repoPath: args.repoPath,
      capsuleId: args.capsuleId,
      runFullProjectTests: args.runFullProjectTests
    }))
  );
}

function registerResources(mcp: McpServer): void {
  const template = new ResourceTemplate("bugcapsule://capsules/{capsuleId}/{resource}", { list: undefined });

  mcp.registerResource(
    "bugcapsule_capsule_resource",
    template,
    {
      title: "BugCapsule capsule resources",
      description: "Read manifest, readme, patch, or file-map for a capsule.",
      mimeType: "text/plain"
    },
    async (uri, variables) => {
      const capsuleId = String(variables.capsuleId);
      const resource = String(variables.resource);
      const manifest = await inspectCapsule({ repoPath: process.cwd(), capsuleId });
      const text = await readCapsuleResource(process.cwd(), manifest.capsule.path, capsuleId, resource);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: resource === "manifest" || resource === "file-map" ? "application/json" : "text/plain",
            text
          }
        ]
      };
    }
  );
}

function registerPrompts(mcp: McpServer): void {
  mcp.registerPrompt(
    "bugcapsule_fix_capsule",
    {
      title: "Fix BugCapsule",
      description: "Instructions for an agent fixing a minimized BugCapsule reproduction."
    },
    () => ({
      description: "Fix a minimized BugCapsule reproduction.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are fixing a minimized BugCapsule reproduction.\n\n${ANTI_SYMPTOM_PATCHING_INSTRUCTIONS}\n\nInstructions:\n1. Call bugcapsule_fix_step with action="inspect".\n2. Call bugcapsule_fix_step with action="reproduce_initial".\n3. Fix the failing behavior inside mapped editable capsule files only.\n4. Call bugcapsule_fix_step with action="verify_capsule" until it passes.\n5. Call bugcapsule_fix_step with action="apply_patch" to apply the exact verified file set.`
          }
        }
      ]
    })
  );

  mcp.registerPrompt(
    "bugcapsule_fix_from_command",
    {
      title: "Fix Bug With BugCapsule",
      description: "Short reusable workflow for using BugCapsule when the user provides only repoPath and a failing command.",
      argsSchema: {
        repoPath: z.string(),
        command: z.string()
      }
    },
    (args) => ({
      description: "Use BugCapsule to isolate and fix a failing command.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use BugCapsule to fix this bug.\n\nRepo path:\n${args.repoPath}\n\nFailing command:\n${args.command}\n\n${ANTI_SYMPTOM_PATCHING_INSTRUCTIONS}\n\nCall bugcapsule_create_from_command first. Follow deterministicWorkflow.nextToolCall from the tool result. Fix only mapped editable capsule files, then apply through bugcapsule_fix_step with action="apply_patch" and summarize the original files changed.`
          }
        }
      ]
    })
  );

  mcp.registerPrompt(
    "bugcapsule_fix_from_runtime",
    {
      title: "Fix Runtime Bug With BugCapsule",
      description: "Short workflow for using BugCapsule when the user only has a local URL and a broad visual symptom.",
      argsSchema: {
        repoPath: z.string(),
        url: z.string(),
        bugDescription: z.string()
      }
    },
    (args) => ({
      description: "Use BugCapsule to discover, isolate, and fix a runtime UI bug.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use BugCapsule to fix this runtime bug.\n\nRepo path:\n${args.repoPath}\n\nURL:\n${args.url}\n\nSymptom:\n${args.bugDescription}\n\n${ANTI_SYMPTOM_PATCHING_INSTRUCTIONS}\n\nCall bugcapsule_create_from_runtime first. Follow deterministicWorkflow.nextToolCall from the tool result. Fix only mapped editable capsule files, then apply through bugcapsule_fix_step with action="apply_patch" and summarize the original files changed.`
          }
        }
      ]
    })
  );
}

function registerShutdownHooks(activeTracker: SessionTracker): void {
  let shuttingDown = false;
  const flush = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void activeTracker.finalizeAll("shutdown");
  };

  process.on("beforeExit", flush);
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);
}

async function readCapsuleResource(repoPath: string, capsulePath: string, capsuleId: string, resource: string): Promise<string> {
  switch (resource) {
    case "manifest":
      return fs.readFile(path.join(capsulePath, "capsule.json"), "utf8");
    case "readme":
      return fs.readFile(path.join(capsulePath, "README.md"), "utf8");
    case "patch":
      return fs.readFile(path.join(repoPath, ".bugcapsule", "patches", `${capsuleId}.patch`), "utf8");
    case "file-map": {
      const manifest = JSON.parse(await fs.readFile(path.join(capsulePath, "capsule.json"), "utf8")) as {
        files: unknown[];
      };
      return `${JSON.stringify(manifest.files, null, 2)}\n`;
    }
    default:
      throw new Error(`Unknown BugCapsule resource: ${resource}`);
  }
}

function jsonResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function buildAgentWorkflow(result: CreateCapsuleResult): Array<{
  step: number;
  action: string;
  detail: string;
}> {
  if (result.status === "failed_original_passed") {
    return [
      {
        step: 1,
        action: "stop",
        detail: "The original command passed, so BugCapsule did not create a useful failing capsule. Ask the user for a command that currently fails."
      }
    ];
  }

  return buildAgentWorkflowFromManifest(result.manifest.originalRepo.rootPath, result.manifest);
}

function fixStepArguments(
  repoPath: string,
  capsuleId: string,
  action: "next" | "inspect" | "reproduce_initial" | "verify_capsule" | "apply_patch",
  evaluationArgs?: {
    generateEvaluation?: boolean;
    evaluationModel?: string;
    evaluationEncoding?: string;
    inputPricePerMillion?: number;
    outputPricePerMillion?: number;
  }
): Record<string, unknown> {
  return {
    repoPath,
    capsuleId,
    action,
    ...(evaluationArgs?.generateEvaluation !== undefined ? { generateEvaluation: evaluationArgs.generateEvaluation } : {}),
    ...(evaluationArgs?.evaluationModel ? { evaluationModel: evaluationArgs.evaluationModel } : {}),
    ...(evaluationArgs?.evaluationEncoding ? { evaluationEncoding: evaluationArgs.evaluationEncoding } : {}),
    ...(evaluationArgs?.inputPricePerMillion !== undefined ? { inputPricePerMillion: evaluationArgs.inputPricePerMillion } : {}),
    ...(evaluationArgs?.outputPricePerMillion !== undefined ? { outputPricePerMillion: evaluationArgs.outputPricePerMillion } : {})
  };
}

function workflowSummary(repoPath: string, manifest: BugCapsuleManifest): Record<string, unknown> | undefined {
  if (!manifest.workflow) {
    return undefined;
  }

  return {
    workflowId: manifest.workflow.id,
    strict: manifest.workflow.strict,
    currentState: manifest.workflow.state,
    workflowPath: path.join(repoPath, manifest.workflow.workflowPath),
    requiredNextAction: manifest.workflow.requiredNextAction,
    nextToolCall: {
      tool: "bugcapsule_fix_step",
      arguments: fixStepArguments(repoPath, manifest.capsuleId, manifest.workflow.requiredNextAction === "done" ? "next" : manifest.workflow.requiredNextAction)
    }
  };
}

type EvaluationConfig =
  | { status: "disabled" }
  | { status: "invalid"; message: string }
  | {
    status: "enabled";
    evaluationModel: string;
    evaluationEncoding?: string;
    inputPricePerMillion: number;
    outputPricePerMillion: number;
  };

async function resolveEvaluationConfig(args: {
  repoPath: string;
  generateEvaluation?: boolean;
  evaluationModel?: string;
  evaluationEncoding?: string;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}): Promise<EvaluationConfig> {
  const hasAnyEvaluationInput = args.generateEvaluation !== undefined ||
    Boolean(args.evaluationModel || args.evaluationEncoding) ||
    args.inputPricePerMillion !== undefined ||
    args.outputPricePerMillion !== undefined;

  if (!hasAnyEvaluationInput || args.generateEvaluation === false) {
    return { status: "disabled" };
  }

  let pricing;
  try {
    pricing = await loadPricing(args.repoPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "invalid",
      message: `Evaluation was requested, but pricing configuration is invalid: ${message}`
    };
  }

  const evaluationModel = args.evaluationModel ?? pricing.model;
  const inputPricePerMillion = args.inputPricePerMillion ?? pricing.input_per_million;
  const outputPricePerMillion = args.outputPricePerMillion ?? pricing.output_per_million;
  const evaluationEncoding = args.evaluationEncoding ?? (!args.evaluationModel ? pricing.evaluation_encoding : undefined);

  if (!evaluationModel) {
    return {
      status: "invalid",
      message: "Evaluation was requested, but evaluationModel is missing."
    };
  }

  if (inputPricePerMillion === undefined || outputPricePerMillion === undefined) {
    return {
      status: "invalid",
      message: "Evaluation was requested, but both inputPricePerMillion and outputPricePerMillion are required."
    };
  }

  return {
    status: "enabled",
    evaluationModel,
    ...(evaluationEncoding ? { evaluationEncoding } : {}),
    inputPricePerMillion,
    outputPricePerMillion
  };
}

function buildAgentWorkflowFromManifest(repoPath: string, manifest: BugCapsuleManifest): Array<{
  step: number;
  action: string;
  detail: string;
}> {
  return [
    {
      step: 1,
      action: "inspect",
      detail: `Call bugcapsule_fix_step with repoPath='${repoPath}', capsuleId='${manifest.capsuleId}', action='inspect'.`
    },
    {
      step: 2,
      action: "reproduce_initial",
      detail: "Call bugcapsule_fix_step with action='reproduce_initial' to record the initial failing capsule receipt."
    },
    {
      step: 3,
      action: "fix_capsule",
      detail: `Edit only mapped editable capsule files: ${editableFiles(manifest).join(", ") || "none detected"}`
    },
    {
      step: 4,
      action: "verify_capsule",
      detail: "Call bugcapsule_fix_step with action='verify_capsule'. Repeat edit and verify until the capsule passes."
    },
    {
      step: 5,
      action: "apply_back",
      detail: "Call bugcapsule_fix_step with action='apply_patch'. This applies only the exact editable file set that passed verification."
    },
    {
      step: 6,
      action: "summarize",
      detail: "Tell the user which original files changed and which verification checks passed."
    }
  ];
}

function editableFiles(manifest: BugCapsuleManifest): string[] {
  return manifest.files
    .filter((file) => file.editable && file.originalPath)
    .map((file) => file.capsulePath);
}

type EvaluationOptions = {
  repoPath: string;
  capsuleId: string;
  evaluationModel: string;
  evaluationEncoding?: string;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
};

type EvaluationResult = {
  status: "created" | "failed";
  htmlPath?: string;
  command: string;
  message?: string;
  stderr?: string;
};

async function runEvaluation(options: EvaluationOptions): Promise<EvaluationResult> {
  const bugCapsuleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const tsxBin = path.join(bugCapsuleRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const args = [
    path.join(bugCapsuleRoot, "scripts", "evaluateCapsule.ts"),
    "--repo",
    options.repoPath,
    "--capsule-id",
    options.capsuleId,
    "--model",
    options.evaluationModel
  ];

  if (options.evaluationEncoding) {
    args.push("--encoding", options.evaluationEncoding);
  }
  if (options.inputPricePerMillion !== undefined) {
    args.push("--input-price-per-million", String(options.inputPricePerMillion));
  }
  if (options.outputPricePerMillion !== undefined) {
    args.push("--output-price-per-million", String(options.outputPricePerMillion));
  }

  const command = `${tsxBin} ${args.map(shellQuote).join(" ")}`;
  const result = await runProcess(tsxBin, args, bugCapsuleRoot);

  if (result.exitCode !== 0) {
    return {
      status: "failed",
      command,
      message: "BugCapsule applied the patch, but automatic evaluation failed.",
      stderr: result.stderr.trim()
    };
  }

  const parsed = parseEvaluationOutput(result.stdout);

  if (!parsed?.htmlPath) {
    return {
      status: "failed",
      command,
      message: "BugCapsule applied the patch, but evaluation did not return an HTML path.",
      stderr: result.stderr.trim()
    };
  }

  return {
    status: "created",
    htmlPath: parsed.htmlPath,
    command
  };
}

function runProcess(command: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
    });
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function parseEvaluationOutput(stdout: string): { htmlPath?: string } | undefined {
  const match = stdout.match(/\{[\s\S]*\}\s*$/);

  if (!match) {
    return undefined;
  }

  try {
    return JSON.parse(match[0]) as { htmlPath?: string };
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
