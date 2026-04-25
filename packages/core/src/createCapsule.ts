import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";

import { defaultConfig } from "./config.js";
import { captureFailure } from "./failureCapture.js";
import { copyTextFile, ensureDir, hashString, isSecretPath, listProjectFiles, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./fileUtils.js";
import { createMockPlan, rewriteExternalImports } from "./mockGenerator.js";
import { capsulePathFor, manifestRelativeLogPath, writeManifest, writeReadme, writeReport } from "./manifest.js";
import { detectProject } from "./projectDetector.js";
import { runShellCommand } from "./shell.js";
import { selectSlice } from "./slicer.js";
import { assertInsideRoot, normalizePath, slugify } from "./pathUtils.js";
import type { BugCapsuleManifest, BugCapsuleReport, CapsuleFileMapping, CreateCapsuleOptions, CreateCapsuleResult } from "./types.js";

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export async function createCapsule(options: CreateCapsuleOptions): Promise<CreateCapsuleResult> {
  const repoPath = path.resolve(options.repoPath);
  assertInsideRoot(repoPath, repoPath);

  const capsuleId = await resolveCapsuleId(repoPath, options);
  const project = await detectProject(repoPath);
  const failure = await captureFailure(repoPath, options.command, capsuleId);

  if (failure.exitCode === 0) {
    const emptyManifest = await buildEmptyManifest(repoPath, capsuleId, options, project.packageManager);
    const report = {
      capsuleId,
      status: "failed_original_passed" as const,
      originalFileCount: (await listProjectFiles(repoPath)).length,
      capsuleFileCount: 0,
      contextReductionPercent: 0,
      failureMessage: "Original command passed.",
      includedFiles: [],
      mocks: []
    };

    return {
      capsuleId,
      capsulePath: capsulePathFor(repoPath, capsuleId),
      status: "failed_original_passed",
      manifest: emptyManifest,
      report
    };
  }

  const maxFiles = options.maxFiles ?? defaultConfig.create.defaultMaxFiles;
  const maxDepth = options.maxDepth ?? defaultConfig.create.defaultMaxDepth;
  const slice = await selectSlice({
    repoPath,
    command: options.command,
    failure,
    maxFiles,
    maxDepth,
    ...(options.includeGlobs ? { includeGlobs: options.includeGlobs } : {}),
    ...(options.excludeGlobs ? { excludeGlobs: options.excludeGlobs } : {})
  });
  const mockPlan = createMockPlan(slice.externalImports.filter((binding) => shouldMockModule(binding.moduleName)));
  const capsulePath = capsulePathFor(repoPath, capsuleId);

  await fs.rm(capsulePath, { recursive: true, force: true });
  await ensureDir(capsulePath);

  const fileMappings: CapsuleFileMapping[] = [];

  for (const file of slice.files) {
    if (isSecretPath(file.path)) {
      continue;
    }

    const sourcePath = path.join(repoPath, file.path);
    const targetPath = path.join(capsulePath, file.path);
    assertInsideRoot(repoPath, sourcePath);
    const hashes = await copyTextFile(sourcePath, targetPath, (content) =>
      rewriteExternalImports(file.path, content, mockPlan.rewrites)
    );

    fileMappings.push({
      capsulePath: file.path,
      originalPath: file.path,
      kind: file.kind,
      hashAtCapture: hashes.writtenHash,
      originalHashAtCapture: hashes.sourceHash,
      editable: file.kind === "source" || file.kind === "test"
    });
  }

  for (const mock of mockPlan.files) {
    await writeTextFile(path.join(capsulePath, mock.relativePath), mock.content);
    fileMappings.push({
      capsulePath: mock.relativePath,
      originalPath: "",
      kind: "generated_mock",
      hashAtCapture: hashString(mock.content),
      editable: false
    });
  }

  const packageContent = await renderCapsulePackage(repoPath, project.testRunner, capsuleId);
  const packageHash = hashString(packageContent);
  await writeTextFile(path.join(capsulePath, "package.json"), packageContent);
  fileMappings.push({
    capsulePath: "package.json",
    originalPath: "package.json",
    kind: "package",
    hashAtCapture: packageHash,
    editable: false
  });

  const tsconfigContent = renderCapsuleTsconfig();
  await writeTextFile(path.join(capsulePath, "tsconfig.json"), tsconfigContent);
  fileMappings.push({
    capsulePath: "tsconfig.json",
    originalPath: "tsconfig.json",
    kind: "config",
    hashAtCapture: hashString(tsconfigContent),
    editable: false
  });

  const originalFiles = await listProjectFiles(repoPath);
  const manifest: BugCapsuleManifest = {
    schemaVersion: "0.1",
    capsuleId,
    name: options.capsuleName ?? capsuleId,
    createdAt: new Date().toISOString(),
    originalRepo: {
      rootPath: repoPath,
      packageManager: project.packageManager,
      language: "typescript"
    },
    originalRepro: {
      command: options.command,
      exitCode: failure.exitCode,
      stdoutPath: manifestRelativeLogPath(capsuleId, "original.stdout.log"),
      stderrPath: manifestRelativeLogPath(capsuleId, "original.stderr.log"),
      failureSummary: failure.failureSummary,
      stackTrace: failure.stackTrace
    },
    capsule: {
      path: capsulePath,
      installCommand: "npm install",
      runCommand: "npm test",
      expectedInitialStatus: "failing",
      testFramework: project.testRunner
    },
    files: fileMappings,
    mocks: mockPlan.mocks,
    fixtures: fileMappings
      .filter((file) => file.kind === "fixture")
      .map((file) => ({
        path: file.capsulePath,
        source: "copied" as const,
        description: "Fixture imported by the failing test slice."
      })),
    metrics: {
      originalFileCount: originalFiles.length,
      capsuleFileCount: fileMappings.length,
      contextReductionPercent: reductionPercent(originalFiles.length, fileMappings.length)
    },
    apply: {
      strategy: "file-map-patch",
      requireCleanGitWorktree: true,
      verifyOriginalCommand: true
    }
  };

  await writeManifest(capsulePath, manifest);
  await writeReadme(capsulePath, manifest);

  if (options.installDependencies ?? true) {
    await runShellCommand("npm install --ignore-scripts", capsulePath);
  }

  const runResult = options.verifyCapsule ?? true
    ? await runShellCommand(manifest.capsule.runCommand, capsulePath)
    : undefined;
  const status: CreateCapsuleResult["status"] = runResult && runResult.exitCode === 0 ? "created_not_reproduced" : "created_failing";
  const report: BugCapsuleReport = {
    capsuleId,
    status,
    originalFileCount: manifest.metrics.originalFileCount,
    capsuleFileCount: manifest.metrics.capsuleFileCount,
    contextReductionPercent: manifest.metrics.contextReductionPercent,
    failureMessage: failure.failureSummary,
    includedFiles: slice.files.map((file) => ({ path: file.path, reason: file.reason })),
    mocks: mockPlan.mocks
  };
  const result: CreateCapsuleResult = {
    capsuleId,
    capsulePath,
    status,
    manifest,
    report
  };

  await writeReport(repoPath, result);

  return result;
}

async function resolveCapsuleId(repoPath: string, options: CreateCapsuleOptions): Promise<string> {
  if (options.capsuleId) {
    return options.capsuleId;
  }

  const commandHint = options.command
    .split(/\s+/)
    .reverse()
    .find((token) => token.length >= 4 && !["test", "npm", "run"].includes(token.replace(/^--/, "")))
    ?.replace(/^--/, "");
  const base = `bc_${slugify(options.capsuleName ?? commandHint ?? "capsule")}`;
  let candidate = base;
  let index = 2;

  while (await pathExists(capsulePathFor(repoPath, candidate))) {
    candidate = `${base}_${index}`;
    index += 1;
  }

  return candidate;
}

async function renderCapsulePackage(repoPath: string, testRunner: string, capsuleId: string): Promise<string> {
  const sourcePackage = await readJsonFile<PackageJson>(path.join(repoPath, "package.json"));
  const devDependencies = {
    typescript: sourcePackage.devDependencies?.typescript ?? "^6.0.3",
    vitest: sourcePackage.devDependencies?.vitest ?? "^4.1.5",
    tsx: sourcePackage.devDependencies?.tsx ?? "^4.20.0"
  };
  const testCommand = testRunner === "jest" ? "jest" : "vitest run";
  const packageJson = {
    name: `bugcapsule-${capsuleId}`,
    private: true,
    type: "module",
    scripts: {
      test: testCommand
    },
    dependencies: {},
    devDependencies
  };

  return `${JSON.stringify(packageJson, null, 2)}\n`;
}

function renderCapsuleTsconfig(): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      types: ["node", "vitest/globals"]
    },
    include: ["**/*.ts"]
  }, null, 2)}\n`;
}

function reductionPercent(originalCount: number, capsuleCount: number): number {
  if (originalCount === 0) {
    return 0;
  }

  return Math.max(0, Math.round((1 - capsuleCount / originalCount) * 100));
}

async function buildEmptyManifest(
  repoPath: string,
  capsuleId: string,
  options: CreateCapsuleOptions,
  packageManager: BugCapsuleManifest["originalRepo"]["packageManager"]
): Promise<BugCapsuleManifest> {
  return {
    schemaVersion: "0.1",
    capsuleId,
    name: options.capsuleName ?? capsuleId,
    createdAt: new Date().toISOString(),
    originalRepo: {
      rootPath: repoPath,
      packageManager,
      language: "typescript"
    },
    originalRepro: {
      command: options.command,
      exitCode: 0,
      stdoutPath: manifestRelativeLogPath(capsuleId, "original.stdout.log"),
      stderrPath: manifestRelativeLogPath(capsuleId, "original.stderr.log"),
      failureSummary: "Original command passed.",
      stackTrace: []
    },
    capsule: {
      path: capsulePathFor(repoPath, capsuleId),
      installCommand: "npm install",
      runCommand: "npm test",
      expectedInitialStatus: "failing",
      testFramework: "unknown"
    },
    files: [],
    mocks: [],
    fixtures: [],
    metrics: {
      originalFileCount: 0,
      capsuleFileCount: 0,
      contextReductionPercent: 0
    },
    apply: {
      strategy: "file-map-patch",
      requireCleanGitWorktree: true,
      verifyOriginalCommand: true
    }
  };
}

export function shouldMockModule(moduleName: string, patterns: string[] = defaultConfig.slicing.preferMockFor): boolean {
  return patterns.some((pattern) => minimatch(moduleName, pattern));
}
