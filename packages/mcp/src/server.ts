#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
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
  suggestRepro,
  verifyCapsule,
  type BugCapsuleManifest,
  type CreateCapsuleResult
} from "@bugcapsule/core";

import { SessionTracker } from "./usage/sessionTracker.js";
import { registerTrackedTool } from "./usage/wrapTool.js";

const server = new McpServer({
  name: "bugcapsule",
  version: "0.1.0"
});

const tracker = new SessionTracker();

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
        "After this tool succeeds, open the capsulePath, fix only the capsule, rerun its runCommand, then call bugcapsule_apply_patch with verify=true."
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
        verifyCapsule: z.boolean().default(true)
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
          generatedMocks: result.manifest.mocks.map((mock) => mock.moduleName)
        },
        agentWorkflow: buildAgentWorkflow(result),
        applyPatchToolCall: {
          tool: "bugcapsule_apply_patch",
          arguments: {
            repoPath: args.repoPath,
            capsuleId: result.capsuleId,
            verify: true
          }
        },
        nextAgentInstruction: `Open ${result.capsulePath}, read README.md and capsule.json, run ${result.manifest.capsule.runCommand}, fix the failing behavior only inside the capsule, rerun ${result.manifest.capsule.runCommand}, then call bugcapsule_apply_patch with verify=true.`
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
        "After this tool succeeds, do not ask the user for more BugCapsule steps: open the capsulePath, fix only the capsule, rerun its runCommand, then call bugcapsule_apply_patch with verify=true."
      ].join(" "),
      inputSchema: {
        repoPath: z.string(),
        command: z.string(),
        capsuleName: z.string().optional(),
        maxFiles: z.number().positive().optional(),
        maxDepth: z.number().positive().optional(),
        includeGlobs: z.array(z.string()).optional(),
        excludeGlobs: z.array(z.string()).optional(),
        verifyCapsule: z.boolean().default(true)
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
          generatedMocks: result.manifest.mocks.map((mock) => mock.moduleName)
        },
        agentWorkflow: buildAgentWorkflow(result),
        applyPatchToolCall: {
          tool: "bugcapsule_apply_patch",
          arguments: {
            repoPath: args.repoPath,
            capsuleId: result.capsuleId,
            verify: true
          }
        },
        nextAgentInstruction: `Open ${result.capsulePath}, read README.md and capsule.json, run ${result.manifest.capsule.runCommand}, fix the failing behavior only inside the capsule, rerun ${result.manifest.capsule.runCommand}, then call bugcapsule_apply_patch with verify=true.`
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
    "bugcapsule_apply_patch",
    {
      title: "Apply BugCapsule Patch",
      description: "Apply changed capsule files back to their original source paths. Call this after the capsule repro passes; default verify=true reruns both capsule and original repro.",
      inputSchema: {
        repoPath: z.string(),
        capsuleId: z.string(),
        dryRun: z.boolean().default(false),
        verify: z.boolean().default(true),
        allowDirty: z.boolean().default(false)
      }
    },
    async (args) => jsonResult(await applyCapsule({
      repoPath: args.repoPath,
      capsuleId: args.capsuleId,
      dryRun: args.dryRun,
      verify: args.verify,
      allowDirty: args.allowDirty
    }))
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
      description: "Read manifest, readme, report, patch, or file-map for a capsule.",
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
            text: "You are fixing a minimized BugCapsule reproduction.\n\nInstructions:\n1. Open the capsule directory.\n2. Read README.md and capsule.json.\n3. Run the capsule repro command.\n4. Fix the failing behavior inside the capsule.\n5. Do not broaden the fix unnecessarily.\n6. Rerun the capsule repro command.\n7. Once passing, call bugcapsule_apply_patch with verify=true."
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
            text: `Use BugCapsule to fix this bug.\n\nRepo path:\n${args.repoPath}\n\nFailing command:\n${args.command}\n\nCall bugcapsule_create_from_command first. Follow the agentWorkflow returned by the tool. Fix only files inside the generated capsule until the capsule passes. Then call bugcapsule_apply_patch with verify=true and summarize the original files changed.`
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
            text: `Use BugCapsule to fix this runtime bug.\n\nRepo path:\n${args.repoPath}\n\nURL:\n${args.url}\n\nSymptom:\n${args.bugDescription}\n\nCall bugcapsule_create_from_runtime first. Follow the agentWorkflow returned by the tool. Fix only files inside the generated capsule until the capsule passes. Then call bugcapsule_apply_patch with verify=true and summarize the original files changed.`
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
    case "report":
      return fs.readFile(path.join(repoPath, ".bugcapsule", "reports", capsuleId, "report.md"), "utf8");
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

function buildAgentWorkflowFromManifest(repoPath: string, manifest: BugCapsuleManifest): Array<{
  step: number;
  action: string;
  detail: string;
}> {
  return [
    {
      step: 1,
      action: "open_capsule",
      detail: `Work in the generated capsule only: ${manifest.capsule.path}`
    },
    {
      step: 2,
      action: "read_context",
      detail: "Read README.md and capsule.json to understand the failure, file map, and editable files."
    },
    {
      step: 3,
      action: "reproduce",
      detail: `Run '${manifest.capsule.runCommand}' inside the capsule and confirm the failure: ${manifest.originalRepro.failureSummary}`
    },
    {
      step: 4,
      action: "fix_capsule",
      detail: `Edit only mapped editable capsule files: ${editableFiles(manifest).join(", ") || "none detected"}`
    },
    {
      step: 5,
      action: "verify_capsule",
      detail: `Rerun '${manifest.capsule.runCommand}' inside the capsule until it passes.`
    },
    {
      step: 6,
      action: "apply_back",
      detail: `Call bugcapsule_apply_patch with repoPath='${repoPath}', capsuleId='${manifest.capsuleId}', verify=true.`
    },
    {
      step: 7,
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
