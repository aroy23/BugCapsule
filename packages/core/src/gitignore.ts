import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, writeTextFile } from "./fileUtils.js";
import { assertInsideRoot } from "./pathUtils.js";

const bugCapsuleGitignoreEntry = ".bugcapsule/";

export type GitignoreUpdateResult = {
  path: string;
  created: boolean;
  updated: boolean;
};

export async function ensureBugCapsuleGitignoreEntry(repoPath: string): Promise<GitignoreUpdateResult> {
  const gitignorePath = path.join(repoPath, ".gitignore");
  assertInsideRoot(repoPath, gitignorePath);

  const existing = await readExistingGitignore(gitignorePath);

  if (hasBugCapsuleEntry(existing.content)) {
    return {
      path: gitignorePath,
      created: false,
      updated: false
    };
  }

  const separator = existing.content.length === 0 || existing.content.endsWith("\n") ? "" : "\n";
  await ensureDir(path.dirname(gitignorePath));
  await writeTextFile(gitignorePath, `${existing.content}${separator}${bugCapsuleGitignoreEntry}\n`);

  return {
    path: gitignorePath,
    created: existing.created,
    updated: true
  };
}

async function readExistingGitignore(gitignorePath: string): Promise<{ content: string; created: boolean }> {
  try {
    return {
      content: await fs.readFile(gitignorePath, "utf8"),
      created: false
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        content: "",
        created: true
      };
    }

    throw error;
  }
}

function hasBugCapsuleEntry(content: string): boolean {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .some((line) => [
      ".bugcapsule",
      ".bugcapsule/",
      ".bugcapsule/**",
      "/.bugcapsule",
      "/.bugcapsule/",
      "/.bugcapsule/**"
    ].includes(line));
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
