import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

import { normalizePath } from "./pathUtils.js";

const secretFilePatterns = [
  /^\.env(?:\..*)?$/,
  /^\.npmrc$/,
  /id_rsa/,
  /id_ed25519/,
  /\.pem$/,
  /\.key$/
];

const secretValuePatterns = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/g,
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^"'\s]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /[a-z]+:\/\/[^:\s]+:[^@\s]+@[^/\s]+/gi
];

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextFile(filePath: string, value: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value);
}

export type CopyTextFileResult = {
  sourceHash: string;
  writtenHash: string;
};

export async function copyTextFile(sourcePath: string, targetPath: string, transform?: (content: string) => string): Promise<CopyTextFileResult> {
  const original = await fs.readFile(sourcePath, "utf8");
  const content = transform ? transform(original) : original;
  await writeTextFile(targetPath, content);

  return {
    sourceHash: hashString(original),
    writtenHash: hashString(content)
  };
}

export function hashString(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function hashFile(filePath: string): Promise<string> {
  return hashString(await fs.readFile(filePath, "utf8"));
}

export function redactSecrets(value: string): string {
  return secretValuePatterns.reduce((content, pattern) => content.replace(pattern, "[REDACTED]"), value);
}

export function isSecretPath(relativePath: string): boolean {
  const baseName = path.basename(relativePath);
  return secretFilePatterns.some((pattern) => pattern.test(baseName));
}

export async function listProjectFiles(rootPath: string): Promise<string[]> {
  const entries = await fg("**/*", {
    cwd: rootPath,
    dot: true,
    onlyFiles: true,
    ignore: [
      "node_modules/**",
      "dist/**",
      ".next/**",
      "coverage/**",
      ".git/**",
      ".bugcapsule/**"
    ]
  });

  return entries.map(normalizePath).sort();
}

export function isTypeScriptLike(relativePath: string): boolean {
  return /\.(?:c|m)?tsx?$/.test(relativePath);
}
