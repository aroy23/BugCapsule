import path from "node:path";
import fg from "fast-glob";
import { minimatch } from "minimatch";

import { defaultConfig } from "./config.js";
import { buildImportGraph, type ImportBinding } from "./importGraph.js";
import { isSecretPath, isTypeScriptLike } from "./fileUtils.js";
import { normalizePath } from "./pathUtils.js";
import { findUpstreamCandidates } from "./upstreamCandidates.js";
import type { CapturedFailure, SuspectedUpstreamCause } from "./types.js";

export type SliceFile = {
  path: string;
  kind: "source" | "test" | "fixture";
  reason: string;
};

export type SliceResult = {
  files: SliceFile[];
  externalImports: ImportBinding[];
  suspectedUpstreamCauses: SuspectedUpstreamCause[];
};

export async function selectSlice(options: {
  repoPath: string;
  command: string;
  failure: CapturedFailure;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  upstreamStackTrace?: CapturedFailure["stackTrace"];
  rootStackTrace?: CapturedFailure["stackTrace"];
  maxFiles: number;
  maxDepth: number;
}): Promise<SliceResult> {
  const roots = await findRootFiles(options);
  const graph = await buildImportGraph(options.repoPath, roots);
  const excluded = [
    ...defaultConfig.slicing.forceExclude,
    ...(options.excludeGlobs ?? [])
  ];
  const selected = new Map<string, SliceFile>();
  const externalImports: ImportBinding[] = [];
  const queue = roots.map((filePath) => ({ filePath, depth: 0, reason: rootReason(filePath, options.failure) }));

  for (let index = 0; index < queue.length && selected.size < options.maxFiles; index += 1) {
    const item = queue[index];

    if (!item || isExcluded(item.filePath, excluded) || isSecretPath(item.filePath)) {
      continue;
    }

    const kind = classifyFile(item.filePath);

    if (!selected.has(item.filePath)) {
      selected.set(item.filePath, {
        path: item.filePath,
        kind,
        reason: item.reason
      });
    }

    if (item.depth >= options.maxDepth) {
      continue;
    }

    const node = graph.nodes.get(item.filePath);

    if (!node) {
      continue;
    }

    externalImports.push(...node.externalImports);

    for (const imported of node.imports) {
      if (!selected.has(imported) && selected.size + queue.length < options.maxFiles * 4) {
        queue.push({
          filePath: imported,
          depth: item.depth + 1,
          reason: `Imported by ${item.filePath}`
        });
      }
    }
  }

  const suspectedUpstreamCauses = await findUpstreamCandidates({
    repoPath: options.repoPath,
    stackTrace: options.upstreamStackTrace ?? options.failure.stackTrace
  });

  for (const cause of suspectedUpstreamCauses) {
    if (isExcluded(cause.path, excluded) || isSecretPath(cause.path) || !isTypeScriptLike(cause.path)) {
      continue;
    }

    if (!selected.has(cause.path)) {
      selected.set(cause.path, {
        path: cause.path,
        kind: classifyFile(cause.path),
        reason: `Suspected upstream cause: ${cause.reason}`
      });
    }
  }

  return {
    files: [...selected.values()].sort((left, right) => left.path.localeCompare(right.path)),
    externalImports,
    suspectedUpstreamCauses
  };
}

async function findRootFiles(options: {
  repoPath: string;
  command: string;
  failure: CapturedFailure;
  rootStackTrace?: CapturedFailure["stackTrace"];
  includeGlobs?: string[];
}): Promise<string[]> {
  const stackTrace = options.rootStackTrace ?? options.failure.stackTrace;
  const stackFiles = stackTrace.map((frame) => frame.file).filter(isTypeScriptLike);
  const commandRoots = await findFilesFromCommand(options.repoPath, options.command);
  const includeRoots = options.includeGlobs && options.includeGlobs.length > 0
    ? await fg(options.includeGlobs, { cwd: options.repoPath, onlyFiles: true, dot: true })
    : [];

  return [...new Set([...stackFiles, ...commandRoots, ...includeRoots].map(normalizePath))].sort();
}

async function findFilesFromCommand(repoPath: string, command: string): Promise<string[]> {
  const tokens = command
    .split(/\s+/)
    .map((token) => token.replace(/^--/, ""))
    .filter((token) => token.length >= 3);
  const files = await fg(["tests/**/*.test.ts", "test/**/*.test.ts", "src/**/*.test.ts", "**/*.spec.ts"], {
    cwd: repoPath,
    onlyFiles: true,
    dot: true,
    ignore: defaultConfig.slicing.forceExclude
  });

  return files
    .filter((filePath) => tokens.some((token) => filePath.includes(token) || path.basename(filePath).includes(token)))
    .map(normalizePath)
    .sort();
}

function classifyFile(relativePath: string): SliceFile["kind"] {
  if (/(^|\/)(tests?|__tests__)\/|\.test\.|\.spec\./.test(relativePath)) {
    return "test";
  }

  if (/(^|\/)(fixtures?|__fixtures__)\/|\.json$/.test(relativePath)) {
    return "fixture";
  }

  return "source";
}

function rootReason(filePath: string, failure: CapturedFailure): string {
  if (failure.stackTrace.some((frame) => frame.file === filePath)) {
    return "Stack trace";
  }

  return classifyFile(filePath) === "test" ? "Failing test inferred from command" : "Included root";
}

function isExcluded(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(relativePath, pattern, { dot: true }));
}
