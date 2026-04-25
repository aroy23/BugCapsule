import path from "node:path";

import { normalizePath, toAbsolutePath, toRepoRelative } from "./pathUtils.js";
import type { StackFrame } from "./types.js";

const FRAME_PATTERNS = [
  /^\s*at\s+(?<fn>.*?)\s+\((?<file>.*?):(?<line>\d+):(?<column>\d+)\)\s*$/,
  /^\s*at\s+(?<file>.*?):(?<line>\d+):(?<column>\d+)\s*$/,
  /^\s*(?<file>[^()\s].*?):(?<line>\d+):(?<column>\d+)\s*$/
];

export function parseStackTrace(output: string, repoPath: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const seen = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const frame = parseFrameLine(line, repoPath);

    if (!frame) {
      continue;
    }

    const key = `${frame.file}:${frame.line ?? ""}:${frame.column ?? ""}:${frame.functionName ?? ""}`;

    if (!seen.has(key)) {
      seen.add(key);
      frames.push(frame);
    }
  }

  return frames;
}

export function extractFailureSummary(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const typeError = lines.find((line) => /(?:TypeError|ReferenceError|SyntaxError|AssertionError|Error):/.test(line));

  if (typeError) {
    return typeError.replace(/^["']|["']$/g, "");
  }

  const failedLine = lines.find((line) => /FAIL|failed|Failed|Error/.test(line));
  return failedLine ?? "Command failed without a recognizable error summary.";
}

function parseFrameLine(line: string, repoPath: string): StackFrame | undefined {
  for (const pattern of FRAME_PATTERNS) {
    const match = line.match(pattern);

    if (!match?.groups) {
      continue;
    }

    const rawFile = stripFileProtocol(match.groups.file ?? "");

    if (!isRelevantFile(rawFile)) {
      return undefined;
    }

    const absolutePath = toAbsolutePath(repoPath, rawFile);
    const relative = normalizePath(path.isAbsolute(rawFile) ? toRepoRelative(repoPath, absolutePath) : rawFile);
    const isUserCode = isUserCodePath(relative);

    if (!isUserCode) {
      return undefined;
    }

    return {
      file: relative,
      line: Number(match.groups.line),
      column: Number(match.groups.column),
      ...(match.groups.fn ? { functionName: match.groups.fn.trim() } : {}),
      isUserCode
    };
  }

  return undefined;
}

function stripFileProtocol(value: string): string {
  return value
    .replace(/^file:\/\//, "")
    .replace(/^[^A-Za-z0-9./~_-]+\s*/, "");
}

function isRelevantFile(value: string): boolean {
  return /\.(?:c|m)?tsx?$/.test(value) && !value.includes("node_modules");
}

function isUserCodePath(relativePath: string): boolean {
  return ![
    "node_modules/",
    "dist/",
    ".next/",
    "coverage/",
    ".git/",
    ".bugcapsule/"
  ].some((prefix) => relativePath.startsWith(prefix));
}
