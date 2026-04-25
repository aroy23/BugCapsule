#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  applyCapsule,
  createCapsule,
  inspectCapsule,
  listCapsules,
  runCapsule,
  verifyCapsule
} from "@bugcapsule/core";

const server = new McpServer({
  name: "bugcapsule",
  version: "0.1.0"
});

registerTools(server);
registerResources(server);
registerPrompts(server);

await server.connect(new StdioServerTransport());

function registerTools(mcp: McpServer): void {
  mcp.registerTool(
    "bugcapsule_create_from_command",
    {
      title: "Create BugCapsule From Command",
      description: "Create a minimized runnable capsule from a failing shell command.",
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
        summary: {
          originalFileCount: result.manifest.metrics.originalFileCount,
          capsuleFileCount: result.manifest.metrics.capsuleFileCount,
          contextReductionPercent: result.manifest.metrics.contextReductionPercent,
          failureMessage: result.manifest.originalRepro.failureSummary
        },
        nextAgentInstruction: "Open the capsule path, run npm test, fix the failing test, then call bugcapsule_apply_patch."
      });
    }
  );

  mcp.registerTool(
    "bugcapsule_create_from_playwright_trace",
    {
      title: "Create BugCapsule From Playwright Trace",
      description: "MVP placeholder for creating capsules from Playwright trace metadata.",
      inputSchema: {
        repoPath: z.string(),
        tracePath: z.string(),
        bugDescription: z.string().optional(),
        routeHint: z.string().optional(),
        maxFiles: z.number().positive().optional()
      }
    },
    async (args) => {
      const tracePath = path.isAbsolute(args.tracePath) ? args.tracePath : path.join(args.repoPath, args.tracePath);
      const stat = await fs.stat(tracePath);

      return jsonResult({
        status: "unsupported_mvp",
        tracePath,
        traceBytes: stat.size,
        bugDescription: args.bugDescription ?? "",
        routeHint: args.routeHint ?? "",
        message: "Playwright trace input is registered for MCP compatibility, but the demo MVP creates capsules from failing commands."
      });
    }
  );

  mcp.registerTool(
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

  mcp.registerTool(
    "bugcapsule_run",
    {
      title: "Run BugCapsule",
      description: "Run a capsule repro command.",
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

  mcp.registerTool(
    "bugcapsule_inspect",
    {
      title: "Inspect BugCapsule",
      description: "Read a capsule manifest and README.",
      inputSchema: {
        repoPath: z.string(),
        capsuleId: z.string()
      }
    },
    async (args) => {
      const manifest = await inspectCapsule({ repoPath: args.repoPath, capsuleId: args.capsuleId });
      const readmePath = path.join(manifest.capsule.path, "README.md");
      const readme = await fs.readFile(readmePath, "utf8");
      return jsonResult({ manifest, readme });
    }
  );

  mcp.registerTool(
    "bugcapsule_apply_patch",
    {
      title: "Apply BugCapsule Patch",
      description: "Apply changed capsule files back to their original source paths.",
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

  mcp.registerTool(
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
