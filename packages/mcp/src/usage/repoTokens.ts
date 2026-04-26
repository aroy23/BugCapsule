import fs from "node:fs/promises";
import path from "node:path";

import { estimateTokens } from "./tokenizer.js";

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".vue",
  ".svelte",
  ".astro",
  ".yml",
  ".yaml",
  ".toml",
  ".graphql",
  ".gql",
  ".sql"
]);

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".git",
  ".turbo",
  ".cache",
  ".vercel",
  ".svelte-kit"
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb"
]);

const MAX_FILE_BYTES = 1 * 1024 * 1024;

export async function estimateRepoTokens(repoPath: string): Promise<number> {
  return walkAndCount(repoPath, { skipBugCapsule: true });
}

export async function estimateCapsuleTokens(repoPath: string, capsuleId: string | undefined): Promise<number> {
  if (!capsuleId) {
    return 0;
  }
  const capsulePath = path.join(repoPath, ".bugcapsule", "capsules", capsuleId);
  return walkAndCount(capsulePath, { skipBugCapsule: false });
}

async function walkAndCount(rootPath: string, options: { skipBugCapsule: boolean }): Promise<number> {
  let total = 0;
  await walk(rootPath, async (filePath) => {
    total += await tokensForFile(filePath);
  }, options);
  return total;
}

async function walk(
  dir: string,
  onFile: (filePath: string) => Promise<void>,
  options: { skipBugCapsule: boolean }
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      if (isGeneratedRuntimeLineagePath(entryPath)) {
        continue;
      }
      if (options.skipBugCapsule && entry.name === ".bugcapsule") {
        continue;
      }
      await walk(entryPath, onFile, options);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!shouldIncludeFile(entryPath, entry.name)) {
      continue;
    }

    await onFile(entryPath);
  }
}

function shouldIncludeFile(filePath: string, fileName: string): boolean {
  if (isGeneratedRuntimeLineagePath(filePath)) {
    return false;
  }
  if (LOCKFILES.has(fileName)) {
    return false;
  }
  return TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function isGeneratedRuntimeLineagePath(filePath: string): boolean {
  return /(?:^|[/\\])\.bugcapsule[/\\]repros[/\\][^/\\]+\.lineage(?:[/\\]|$|\.json$)/.test(filePath);
}

async function tokensForFile(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return 0;
    }
    if (stat.size > MAX_FILE_BYTES) {
      return 0;
    }
    const content = await fs.readFile(filePath, "utf8");
    return estimateTokens(content);
  } catch {
    return 0;
  }
}
