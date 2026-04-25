#!/usr/bin/env node

import path from "node:path";
import { Command } from "commander";
import {
  applyCapsule,
  createCapsule,
  initBugCapsule,
  inspectCapsule,
  listCapsules,
  runCapsule,
  suggestRepro,
  verifyCapsule,
  type CreateCapsuleResult
} from "@bugcapsule/core";
import { installSkill, type SkillTarget } from "@bugcapsule/skill";

const program = new Command();

program
  .name("bugcapsule")
  .description("Shrink real bugs into tiny executable repos AI coding agents can fix.")
  .version("0.1.0");

program
  .command("init")
  .description("Create BugCapsule config and local directories.")
  .action(async () => {
    await runCli(async () => {
      const result = await initBugCapsule(process.cwd());
      console.log(`BugCapsule initialized\n\nCreated:\n${result.created.map((item) => `- ${item}`).join("\n")}`);
    });
  });

program
  .command("create")
  .description("Create a capsule from a failing command.")
  .allowUnknownOption(true)
  .argument("[command...]", "Failing command after --")
  .option("--id <id>", "Optional capsule id")
  .option("--name <name>", "Human-readable capsule name")
  .option("--max-files <n>", "Maximum files to include", parsePositiveInteger)
  .option("--max-depth <n>", "Maximum import depth", parsePositiveInteger)
  .option("--include <glob>", "Force include glob", collect, [])
  .option("--exclude <glob>", "Force exclude glob", collect, [])
  .option("--mock <module=mode>", "Mock policy entry", collect, [])
  .option("--no-install", "Do not install capsule dependencies")
  .option("--no-run", "Do not verify capsule after creation")
  .option("--json", "Print machine-readable JSON")
  .option("--yes", "Do not prompt before executing commands")
  .action(async (commandParts: string[], options: {
    id?: string;
    name?: string;
    maxFiles?: number;
    maxDepth?: number;
    include: string[];
    exclude: string[];
    install: boolean;
    run: boolean;
    json?: boolean;
    yes?: boolean;
  }) => {
    await runCli(async () => {
      const command = extractCommand("create", commandParts);

      if (!command) {
        throw new Error("Missing command. Use: bugcapsule create -- npm test -- <test-name>");
      }

      const result = await createCapsule({
        repoPath: process.cwd(),
        command,
        ...(options.id ? { capsuleId: options.id } : {}),
        ...(options.name ? { capsuleName: options.name } : {}),
        ...(options.maxFiles ? { maxFiles: options.maxFiles } : {}),
        ...(options.maxDepth ? { maxDepth: options.maxDepth } : {}),
        includeGlobs: options.include,
        excludeGlobs: options.exclude,
        installDependencies: options.install,
        verifyCapsule: options.run
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printCreateResult(result);
    });
  });

program
  .command("suggest")
  .description("Suggest repro commands from a bug description before creating a capsule.")
  .option("--bug <description>", "User-visible bug description")
  .option("--url <url>", "Affected app URL")
  .option("--error <text>", "Observed error text or stack")
  .option("--json", "Print machine-readable JSON")
  .action(async (options: {
    bug?: string;
    url?: string;
    error?: string;
    json?: boolean;
  }) => {
    await runCli(async () => {
      const result = await suggestRepro({
        repoPath: process.cwd(),
        ...(options.bug ? { bugDescription: options.bug } : {}),
        ...(options.url ? { url: options.url } : {}),
        ...(options.error ? { errorText: options.error } : {})
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`BugCapsule repro suggestion: ${result.status}\n`);
      if (result.candidates.length > 0) {
        console.log("Candidate commands:");
        for (const candidate of result.candidates) {
          console.log(`- ${candidate.command} (${Math.round(candidate.confidence * 100)}%)`);
          console.log(`  ${candidate.reason}`);
        }
      } else {
        console.log("No existing failing command candidates found.");
      }
      if (result.relatedFiles.length > 0) {
        console.log("\nRelated files:");
        for (const file of result.relatedFiles) {
          console.log(`- ${file.path}`);
        }
      }
      console.log("\nNext:");
      for (const step of result.agentWorkflow) {
        console.log(`${step.step}. ${step.detail}`);
      }
    });
  });

program
  .command("list")
  .description("List existing capsules.")
  .action(async () => {
    await runCli(async () => {
      const result = await listCapsules({ repoPath: process.cwd() });

      if (result.capsules.length === 0) {
        console.log("No BugCapsules found.");
        return;
      }

      console.log("ID                         STATUS                FILES  CREATED");
      for (const capsule of result.capsules) {
        console.log(`${capsule.capsuleId.padEnd(26)} ${capsule.status.padEnd(21)} ${String(capsule.fileCount).padEnd(5)} ${capsule.createdAt}`);
      }
    });
  });

program
  .command("inspect")
  .description("Inspect a capsule manifest.")
  .argument("<id>", "Capsule id")
  .option("--json", "Print machine-readable JSON")
  .action(async (capsuleId: string, options: { json?: boolean }) => {
    await runCli(async () => {
      const manifest = await inspectCapsule({ repoPath: process.cwd(), capsuleId });

      if (options.json) {
        console.log(JSON.stringify(manifest, null, 2));
        return;
      }

      console.log(`BugCapsule ${manifest.capsuleId}\n`);
      console.log(`Bug:\n${manifest.originalRepro.failureSummary}\n`);
      console.log(`Original command:\n${manifest.originalRepro.command}\n`);
      console.log(`Capsule command:\n${manifest.capsule.runCommand}\n`);
      console.log("Files:");
      for (const file of manifest.files.filter((item) => item.originalPath)) {
        console.log(`- ${file.originalPath}`);
      }
      console.log(`\nStatus:\n${manifest.capsule.expectedInitialStatus}`);
    });
  });

program
  .command("run")
  .description("Run a capsule command inside the capsule directory.")
  .argument("<id>", "Capsule id")
  .option("--command <command>", "Override capsule run command")
  .option("--json", "Print machine-readable JSON")
  .action(async (capsuleId: string, options: { command?: string; json?: boolean }) => {
    await runCli(async () => {
      const result = await runCapsule({
        repoPath: process.cwd(),
        capsuleId,
        ...(options.command ? { command: options.command } : {})
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      console.log(`\nCapsule ${result.status.toUpperCase()} (${result.exitCode})`);
      process.exitCode = result.exitCode === 0 ? 0 : 1;
    });
  });

program
  .command("apply")
  .description("Apply modified capsule source files back to the original repo.")
  .argument("<id>", "Capsule id")
  .option("--dry-run", "Write patch without applying changes")
  .option("--verify", "Run capsule and original repro after applying")
  .option("--no-verify", "Skip verification")
  .option("--allow-dirty", "Allow applying when target repo path is dirty")
  .option("--json", "Print machine-readable JSON")
  .action(async (capsuleId: string, options: {
    dryRun?: boolean;
    verify?: boolean;
    allowDirty?: boolean;
    json?: boolean;
  }) => {
    await runCli(async () => {
      const result = await applyCapsule({
        repoPath: process.cwd(),
        capsuleId,
        verify: options.verify ?? false,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.allowDirty === undefined ? {} : { allowDirty: options.allowDirty })
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Status: ${result.status}`);
      if (result.patchPath) {
        console.log(`Patch: ${path.relative(process.cwd(), result.patchPath)}`);
      }
      if (result.modifiedOriginalFiles.length > 0) {
        console.log("Modified original files:");
        for (const file of result.modifiedOriginalFiles) {
          console.log(`- ${file}`);
        }
      }
      if (result.verification) {
        for (const check of result.verification.checks) {
          console.log(`${check.name}: ${check.status.toUpperCase()}`);
        }
      }
      if (result.status === "failed" || result.status === "conflict") {
        process.exitCode = 1;
      }
    });
  });

program
  .command("verify")
  .description("Run capsule and original repro verification.")
  .argument("<id>", "Capsule id")
  .option("--full", "Also run npm test in the original project")
  .option("--json", "Print machine-readable JSON")
  .action(async (capsuleId: string, options: { full?: boolean; json?: boolean }) => {
    await runCli(async () => {
      const result = await verifyCapsule({
        repoPath: process.cwd(),
        capsuleId,
        ...(options.full === undefined ? {} : { runFullProjectTests: options.full })
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const check of result.checks) {
        console.log(`${check.name}: ${check.status.toUpperCase()}`);
      }
      process.exitCode = result.status === "passed" ? 0 : 1;
    });
  });

program
  .command("install-skill")
  .description("Install the BugCapsule agent skill into this repo.")
  .requiredOption("--target <target>", "agents or windsurf")
  .action(async (options: { target: string }) => {
    await runCli(async () => {
      if (options.target !== "agents" && options.target !== "windsurf") {
        throw new Error("--target must be either agents or windsurf");
      }

      const result = await installSkill({
        repoPath: process.cwd(),
        target: options.target as SkillTarget
      });
      console.log(`Installed BugCapsule skill: ${path.relative(process.cwd(), result.targetPath)}`);
    });
  });

await program.parseAsync(process.argv);

function printCreateResult(result: CreateCapsuleResult): void {
  const metrics = result.manifest.metrics;

  console.log(`BugCapsule created ${result.capsuleId}\n`);
  console.log(`${metrics.originalFileCount} files → ${metrics.capsuleFileCount} files`);
  console.log(`Context reduction: ${metrics.contextReductionPercent}%`);
  if (result.manifest.mocks.length > 0) {
    console.log(`External services replaced: ${result.manifest.mocks.map((mock) => mock.moduleName).join(", ")}`);
  }
  console.log(`Original command: ${result.manifest.originalRepro.command}`);
  console.log(`Repro command: ${result.manifest.capsule.runCommand}`);
  console.log(`Status: ${result.status === "created_failing" ? "failing as expected" : result.status}`);
  console.log("\nNext:");
  console.log(`cd ${path.relative(process.cwd(), result.capsulePath)}`);
  console.log("npm test");
}

async function runCli(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got ${value}`);
  }

  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function extractCommand(commandName: string, commandParts: string[]): string {
  const commandIndex = process.argv.indexOf(commandName);
  const separatorIndex = process.argv.indexOf("--", commandIndex + 1);

  if (separatorIndex >= 0) {
    return process.argv.slice(separatorIndex + 1).join(" ").trim();
  }

  return commandParts.join(" ").trim();
}
