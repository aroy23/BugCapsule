#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { encodingForModel, getEncoding, getEncodingNameForModel } from "js-tiktoken";

type CliOptions = {
  repoPath: string;
  capsuleId: string;
  model?: string;
  encoding?: string;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  outputDir?: string;
  baselineUsagePath?: string;
  bugcapsuleUsagePath?: string;
  includeLockfiles: boolean;
};

type CapsuleManifest = {
  capsuleId: string;
  name: string;
  originalRepro: {
    command: string;
    failureSummary: string;
  };
  capsule: {
    path: string;
    runCommand: string;
  };
  metrics?: {
    originalFileCount?: number;
    capsuleFileCount?: number;
    contextReductionPercent?: number;
  };
};

type FileMetric = {
  path: string;
  bytes: number;
  sourceTokens: number;
  sha256: string;
};

type ContextMetric = {
  label: string;
  rootPath: string;
  fileCount: number;
  byteCount: number;
  sourceTokens: number;
  contextTokens: number;
  contextInputCostUsd: number | null;
  payloadSha256: string;
  largestFiles: FileMetric[];
};

type UsageSummary = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
  listedCostUsd: number | null;
};

type EvaluationReport = {
  schemaVersion: "0.1";
  generatedAt: string;
  repoPath: string;
  capsuleId: string;
  capsulePath: string;
  model: string;
  tokenizer: {
    kind: "openai-tiktoken";
    encoding: string;
    exactForConfiguredModel: boolean;
  };
  pricing: {
    currency: "USD";
    inputPerMillion: number | null;
    outputPerMillion: number | null;
  };
  methodology: {
    deterministicContextComparison: true;
    contextBaseline: string;
    actualFixCost: string;
    excludedByDefault: string[];
  };
  originalRepro: {
    command: string;
    failureSummary: string;
  };
  contexts: {
    fullRepo: ContextMetric;
    bugCapsule: ContextMetric;
    savings: {
      filesPercent: number;
      bytesPercent: number;
      sourceTokensPercent: number;
      contextTokensPercent: number;
      contextInputCostPercent: number | null;
    };
  };
  measuredUsage?: {
    withoutBugCapsule?: UsageSummary;
    withBugCapsule?: UsageSummary;
    savings?: {
      inputTokensPercent: number | null;
      outputTokensPercent: number | null;
      totalTokensPercent: number | null;
      listedCostPercent: number | null;
    };
  };
  outputs: {
    jsonPath: string;
    markdownPath: string;
    htmlPath: string;
    svgPath: string;
  };
};

type TextFile = FileMetric & {
  content: string;
};

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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoPath = path.resolve(options.repoPath);
  const capsulePath = path.join(repoPath, ".bugcapsule", "capsules", options.capsuleId);
  const manifest = await readJson<CapsuleManifest>(path.join(capsulePath, "capsule.json"));
  const tokenizer = resolveTokenizer(options);
  const outputDir = path.resolve(options.outputDir ?? path.join(repoPath, ".bugcapsule", "evaluations", options.capsuleId));

  await fs.mkdir(outputDir, { recursive: true });

  const fullRepoFiles = await collectTextFiles(repoPath, {
    skipBugCapsule: true,
    includeLockfiles: options.includeLockfiles,
    countTokens: tokenizer.countTokens
  });
  const capsuleFiles = await collectTextFiles(capsulePath, {
    skipBugCapsule: false,
    includeLockfiles: options.includeLockfiles,
    countTokens: tokenizer.countTokens
  });

  const fullRepoPayload = renderContextPayload({
    label: "Without BugCapsule: full repository debug context",
    repoPath,
    capsuleId: manifest.capsuleId,
    reproCommand: manifest.originalRepro.command,
    failureSummary: manifest.originalRepro.failureSummary,
    files: fullRepoFiles
  });
  const capsulePayload = renderContextPayload({
    label: "With BugCapsule: generated capsule context",
    repoPath: capsulePath,
    capsuleId: manifest.capsuleId,
    reproCommand: manifest.capsule.runCommand,
    failureSummary: manifest.originalRepro.failureSummary,
    files: capsuleFiles
  });

  const fullRepo = buildContextMetric({
    label: "Without BugCapsule",
    rootPath: repoPath,
    files: fullRepoFiles,
    payload: fullRepoPayload,
    ...(options.inputPricePerMillion !== undefined ? { inputPricePerMillion: options.inputPricePerMillion } : {}),
    countTokens: tokenizer.countTokens
  });
  const bugCapsule = buildContextMetric({
    label: "With BugCapsule",
    rootPath: capsulePath,
    files: capsuleFiles,
    payload: capsulePayload,
    ...(options.inputPricePerMillion !== undefined ? { inputPricePerMillion: options.inputPricePerMillion } : {}),
    countTokens: tokenizer.countTokens
  });

  const measuredUsage = await buildMeasuredUsage(options);
  const baseName = "evaluation";
  const jsonPath = path.join(outputDir, `${baseName}.json`);
  const markdownPath = path.join(outputDir, `${baseName}.md`);
  const htmlPath = path.join(outputDir, `${baseName}.html`);
  const svgPath = path.join(outputDir, `${baseName}.svg`);

  const report: EvaluationReport = {
    schemaVersion: "0.1",
    generatedAt: new Date().toISOString(),
    repoPath,
    capsuleId: manifest.capsuleId,
    capsulePath,
    model: tokenizer.model,
    tokenizer: {
      kind: "openai-tiktoken",
      encoding: tokenizer.encodingName,
      exactForConfiguredModel: tokenizer.exactForConfiguredModel
    },
    pricing: {
      currency: "USD",
      inputPerMillion: options.inputPricePerMillion ?? null,
      outputPerMillion: options.outputPricePerMillion ?? null
    },
    methodology: {
      deterministicContextComparison: true,
      contextBaseline: "The before number is a deterministic, exact-token full-repo context payload built from text source/config/docs files. It is not a claim that an agent would always read every file.",
      actualFixCost: measuredUsage
        ? "Measured usage was loaded from supplied provider/harness logs."
        : "Not measured. Exact no-BugCapsule fix cost requires running the same instrumented agent on the same bug without BugCapsule and recording provider usage.",
      excludedByDefault: [
        "dependency directories",
        "build/cache/coverage directories",
        ".git",
        ".bugcapsule for the full-repo baseline",
        "lockfiles unless --include-lockfiles is passed",
        "files larger than 1 MiB"
      ]
    },
    originalRepro: {
      command: manifest.originalRepro.command,
      failureSummary: manifest.originalRepro.failureSummary
    },
    contexts: {
      fullRepo,
      bugCapsule,
      savings: {
        filesPercent: savingsPercent(fullRepo.fileCount, bugCapsule.fileCount),
        bytesPercent: savingsPercent(fullRepo.byteCount, bugCapsule.byteCount),
        sourceTokensPercent: savingsPercent(fullRepo.sourceTokens, bugCapsule.sourceTokens),
        contextTokensPercent: savingsPercent(fullRepo.contextTokens, bugCapsule.contextTokens),
        contextInputCostPercent: fullRepo.contextInputCostUsd === null || bugCapsule.contextInputCostUsd === null
          ? null
          : savingsPercent(fullRepo.contextInputCostUsd, bugCapsule.contextInputCostUsd)
      }
    },
    ...(measuredUsage ? { measuredUsage } : {}),
    outputs: {
      jsonPath,
      markdownPath,
      htmlPath,
      svgPath
    }
  };

  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, renderMarkdown(report), "utf8");
  await fs.writeFile(svgPath, renderSvg(report), "utf8");
  await fs.writeFile(htmlPath, renderHtml(report), "utf8");

  process.stdout.write(`${JSON.stringify(report.outputs, null, 2)}\n`);
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = normalizeArgName(rawKey ?? "");

    if (key === "includeLockfiles") {
      flags.add(key);
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    values.set(key, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  const repoPath = values.get("repo") ?? values.get("repoPath");
  const capsuleId = values.get("capsuleId");
  const model = values.get("model");
  const encoding = values.get("encoding");

  if (!repoPath || !capsuleId || (!model && !encoding)) {
    printUsageAndExit(1);
  }

  const inputPricePerMillion = parseOptionalNumber(values.get("inputPricePerMillion"));
  const outputPricePerMillion = parseOptionalNumber(values.get("outputPricePerMillion"));
  const outputDir = values.get("outDir");
  const baselineUsagePath = values.get("baselineUsage");
  const bugcapsuleUsagePath = values.get("bugcapsuleUsage");

  return {
    repoPath,
    capsuleId,
    ...(model ? { model } : {}),
    ...(encoding ? { encoding } : {}),
    ...(inputPricePerMillion !== undefined ? { inputPricePerMillion } : {}),
    ...(outputPricePerMillion !== undefined ? { outputPricePerMillion } : {}),
    ...(outputDir ? { outputDir } : {}),
    ...(baselineUsagePath ? { baselineUsagePath } : {}),
    ...(bugcapsuleUsagePath ? { bugcapsuleUsagePath } : {}),
    includeLockfiles: flags.has("includeLockfiles")
  };
}

function printUsageAndExit(code: number): never {
  const usage = `Usage:
  npm run eval:capsule -- --repo <repoPath> --capsule-id <id> --model <openai-model> --input-price-per-million <usd>

Options:
  --encoding <name>                    Use a tokenizer encoding directly, for example o200k_base.
  --output-price-per-million <usd>      Enables listed-cost totals for measured usage logs.
  --baseline-usage <path>               Optional exact provider/harness usage JSON for the no-BugCapsule run.
  --bugcapsule-usage <path>             Optional exact provider/harness usage JSON for the BugCapsule run.
  --out-dir <path>                      Output directory. Defaults to .bugcapsule/evaluations/<capsule-id>.
  --include-lockfiles                   Include package-lock.json, pnpm-lock.yaml, yarn.lock, and bun.lockb.

Notes:
  The context comparison is exact for OpenAI-compatible tiktoken models/encodings.
  Exact fix cost without BugCapsule cannot be inferred; supply a measured baseline usage log.
`;
  process.stderr.write(usage);
  process.exit(code);
}

function normalizeArgName(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, received: ${value}`);
  }
  return parsed;
}

function resolveTokenizer(options: CliOptions): {
  model: string;
  encodingName: string;
  exactForConfiguredModel: boolean;
  countTokens: (text: string) => number;
} {
  try {
    if (options.encoding) {
      const encoder = getEncoding(options.encoding as Parameters<typeof getEncoding>[0]);
      return {
        model: options.model ?? `encoding:${options.encoding}`,
        encodingName: options.encoding,
        exactForConfiguredModel: false,
        countTokens: (text) => encoder.encode(text).length
      };
    }

    const model = options.model;
    if (!model) {
      throw new Error("Missing model.");
    }

    const encoder = encodingForModel(model as Parameters<typeof encodingForModel>[0]);
    const encodingName = getEncodingNameForModel(model as Parameters<typeof getEncodingNameForModel>[0]);
    return {
      model,
      encodingName,
      exactForConfiguredModel: true,
      countTokens: (text) => encoder.encode(text).length
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`No local exact tokenizer is available for the configured model/encoding. Use --model with a supported OpenAI model or --encoding. Details: ${detail}`);
  }
}

async function collectTextFiles(
  rootPath: string,
  options: {
    skipBugCapsule: boolean;
    includeLockfiles: boolean;
    countTokens: (text: string) => number;
  }
): Promise<TextFile[]> {
  const files: TextFile[] = [];
  await walk(rootPath, "", files, options);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(
  rootPath: string,
  relativeDir: string,
  files: TextFile[],
  options: {
    skipBugCapsule: boolean;
    includeLockfiles: boolean;
    countTokens: (text: string) => number;
  }
): Promise<void> {
  const absoluteDir = path.join(rootPath, relativeDir);
  let entries: import("node:fs").Dirent[];

  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = normalizePath(path.join(relativeDir, entry.name));
    const absolutePath = path.join(rootPath, relativePath);

    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      if (options.skipBugCapsule && entry.name === ".bugcapsule") {
        continue;
      }
      await walk(rootPath, relativePath, files, options);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }
    if (!shouldIncludeFile(entry.name, options.includeLockfiles)) {
      continue;
    }

    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_FILE_BYTES) {
      continue;
    }

    const content = await fs.readFile(absolutePath, "utf8");
    files.push({
      path: relativePath,
      bytes: Buffer.byteLength(content, "utf8"),
      sourceTokens: options.countTokens(content),
      sha256: sha256(content),
      content
    });
  }
}

function shouldIncludeFile(fileName: string, includeLockfiles: boolean): boolean {
  if (!includeLockfiles && LOCKFILES.has(fileName)) {
    return false;
  }
  return TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function renderContextPayload(options: {
  label: string;
  repoPath: string;
  capsuleId: string;
  reproCommand: string;
  failureSummary: string;
  files: TextFile[];
}): string {
  const lines = [
    "# BugCapsule Evaluation Context",
    "",
    `Mode: ${options.label}`,
    `Root: ${options.repoPath}`,
    `Capsule ID: ${options.capsuleId}`,
    `Repro command: ${options.reproCommand}`,
    `Failure summary: ${options.failureSummary}`,
    "",
    "Files are sorted by repo-relative path. Each file is delimited for deterministic token counting.",
    ""
  ];

  for (const file of options.files) {
    lines.push(`--- BEGIN FILE ${file.path} ---`);
    lines.push(file.content);
    lines.push(`--- END FILE ${file.path} ---`);
    lines.push("");
  }

  return lines.join("\n");
}

function buildContextMetric(options: {
  label: string;
  rootPath: string;
  files: TextFile[];
  payload: string;
  inputPricePerMillion?: number;
  countTokens: (text: string) => number;
}): ContextMetric {
  const fileMetrics = options.files.map(({ content: _content, ...metric }) => metric);
  const contextTokens = options.countTokens(options.payload);
  const sourceTokens = fileMetrics.reduce((sum, file) => sum + file.sourceTokens, 0);
  const byteCount = fileMetrics.reduce((sum, file) => sum + file.bytes, 0);

  return {
    label: options.label,
    rootPath: options.rootPath,
    fileCount: fileMetrics.length,
    byteCount,
    sourceTokens,
    contextTokens,
    contextInputCostUsd: options.inputPricePerMillion === undefined
      ? null
      : costForTokens(contextTokens, options.inputPricePerMillion),
    payloadSha256: sha256(options.payload),
    largestFiles: [...fileMetrics]
      .sort((left, right) => right.sourceTokens - left.sourceTokens || left.path.localeCompare(right.path))
      .slice(0, 8)
  };
}

async function buildMeasuredUsage(options: CliOptions): Promise<EvaluationReport["measuredUsage"] | undefined> {
  const withoutBugCapsule = options.baselineUsagePath
    ? await readUsageSummary(options.baselineUsagePath, options)
    : undefined;
  const withBugCapsule = options.bugcapsuleUsagePath
    ? await readUsageSummary(options.bugcapsuleUsagePath, options)
    : undefined;

  if (!withoutBugCapsule && !withBugCapsule) {
    return undefined;
  }

  const result: NonNullable<EvaluationReport["measuredUsage"]> = {};
  if (withoutBugCapsule) {
    result.withoutBugCapsule = withoutBugCapsule;
  }
  if (withBugCapsule) {
    result.withBugCapsule = withBugCapsule;
  }
  if (withoutBugCapsule && withBugCapsule) {
    result.savings = {
      inputTokensPercent: savingsPercentOrNull(withoutBugCapsule.inputTokens, withBugCapsule.inputTokens),
      outputTokensPercent: savingsPercentOrNull(withoutBugCapsule.outputTokens, withBugCapsule.outputTokens),
      totalTokensPercent: savingsPercentOrNull(withoutBugCapsule.totalTokens, withBugCapsule.totalTokens),
      listedCostPercent: withoutBugCapsule.listedCostUsd === null || withBugCapsule.listedCostUsd === null
        ? null
        : savingsPercentOrNull(withoutBugCapsule.listedCostUsd, withBugCapsule.listedCostUsd)
    };
  }

  return result;
}

async function readUsageSummary(filePath: string, options: CliOptions): Promise<UsageSummary> {
  const raw = await fs.readFile(path.resolve(filePath), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const usages: Array<{ inputTokens: number; outputTokens: number }> = [];
  collectUsageObjects(parsed, usages);

  const inputTokens = usages.reduce((sum, usage) => sum + usage.inputTokens, 0);
  const outputTokens = usages.reduce((sum, usage) => sum + usage.outputTokens, 0);
  const listedCostUsd = options.inputPricePerMillion === undefined || options.outputPricePerMillion === undefined
    ? null
    : costForInputOutput(inputTokens, outputTokens, options.inputPricePerMillion, options.outputPricePerMillion);

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    callCount: usages.length,
    listedCostUsd
  };
}

function collectUsageObjects(value: unknown, output: Array<{ inputTokens: number; outputTokens: number }>): void {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUsageObjects(item, output);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  const direct = normalizeUsageRecord(record);
  if (direct) {
    output.push(direct);
    return;
  }

  for (const key of ["usage", "calls", "responses", "items", "data"]) {
    if (key in record) {
      collectUsageObjects(record[key], output);
    }
  }
}

function normalizeUsageRecord(record: Record<string, unknown>): { inputTokens: number; outputTokens: number } | undefined {
  const inputTokens = numberValue(record.inputTokens) ??
    numberValue(record.input_tokens) ??
    numberValue(record.promptTokens) ??
    numberValue(record.prompt_tokens);
  const outputTokens = numberValue(record.outputTokens) ??
    numberValue(record.output_tokens) ??
    numberValue(record.completionTokens) ??
    numberValue(record.completion_tokens);

  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function renderMarkdown(report: EvaluationReport): string {
  const measured = report.measuredUsage;
  const lines = [
    `# BugCapsule Evaluation: ${report.capsuleId}`,
    "",
    `- Repo: \`${report.repoPath}\``,
    `- Capsule: \`${report.capsulePath}\``,
    `- Model/tokenizer: ${report.model} (${report.tokenizer.encoding})`,
    `- Original repro: \`${report.originalRepro.command}\``,
    `- Failure: ${report.originalRepro.failureSummary}`,
    "",
    "## Deterministic Context Comparison",
    "",
    "| Metric | Without BugCapsule | With BugCapsule | Savings |",
    "| --- | ---: | ---: | ---: |",
    `| Files | ${formatNumber(report.contexts.fullRepo.fileCount)} | ${formatNumber(report.contexts.bugCapsule.fileCount)} | ${formatPercent(report.contexts.savings.filesPercent)} |`,
    `| Bytes | ${formatNumber(report.contexts.fullRepo.byteCount)} | ${formatNumber(report.contexts.bugCapsule.byteCount)} | ${formatPercent(report.contexts.savings.bytesPercent)} |`,
    `| Source tokens | ${formatNumber(report.contexts.fullRepo.sourceTokens)} | ${formatNumber(report.contexts.bugCapsule.sourceTokens)} | ${formatPercent(report.contexts.savings.sourceTokensPercent)} |`,
    `| Context payload tokens | ${formatNumber(report.contexts.fullRepo.contextTokens)} | ${formatNumber(report.contexts.bugCapsule.contextTokens)} | ${formatPercent(report.contexts.savings.contextTokensPercent)} |`,
    `| Input-context cost | ${formatCost(report.contexts.fullRepo.contextInputCostUsd)} | ${formatCost(report.contexts.bugCapsule.contextInputCostUsd)} | ${formatNullablePercent(report.contexts.savings.contextInputCostPercent)} |`,
    "",
    "## Measurement Boundary",
    "",
    report.methodology.contextBaseline,
    "",
    report.methodology.actualFixCost,
    ""
  ];

  if (measured) {
    lines.push("## Measured Agent Usage");
    lines.push("");
    lines.push("| Metric | Without BugCapsule | With BugCapsule | Savings |");
    lines.push("| --- | ---: | ---: | ---: |");
    lines.push(`| Input tokens | ${formatNumber(measured.withoutBugCapsule?.inputTokens)} | ${formatNumber(measured.withBugCapsule?.inputTokens)} | ${formatNullablePercent(measured.savings?.inputTokensPercent)} |`);
    lines.push(`| Output tokens | ${formatNumber(measured.withoutBugCapsule?.outputTokens)} | ${formatNumber(measured.withBugCapsule?.outputTokens)} | ${formatNullablePercent(measured.savings?.outputTokensPercent)} |`);
    lines.push(`| Total tokens | ${formatNumber(measured.withoutBugCapsule?.totalTokens)} | ${formatNumber(measured.withBugCapsule?.totalTokens)} | ${formatNullablePercent(measured.savings?.totalTokensPercent)} |`);
    lines.push(`| Listed-price cost | ${formatCost(measured.withoutBugCapsule?.listedCostUsd ?? null)} | ${formatCost(measured.withBugCapsule?.listedCostUsd ?? null)} | ${formatNullablePercent(measured.savings?.listedCostPercent)} |`);
    lines.push("");
  }

  lines.push("## Visualization Files");
  lines.push("");
  lines.push(`- HTML: \`${report.outputs.htmlPath}\``);
  lines.push(`- SVG: \`${report.outputs.svgPath}\``);
  lines.push(`- JSON: \`${report.outputs.jsonPath}\``);
  lines.push("");

  return lines.join("\n");
}

function renderHtml(report: EvaluationReport): string {
  const svg = renderSvg(report);
  const measured = report.measuredUsage;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BugCapsule Evaluation ${escapeHtml(report.capsuleId)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --ink: #18202a;
      --muted: #657286;
      --line: #d9dee7;
      --before: #d54b4b;
      --after: #257b63;
      --panel: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
    }
    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: end;
      border-bottom: 1px solid var(--line);
      padding-bottom: 20px;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0;
      font-size: 32px;
      line-height: 1.05;
      letter-spacing: 0;
    }
    .sub {
      margin-top: 8px;
      color: var(--muted);
      max-width: 780px;
      line-height: 1.45;
    }
    .badge {
      white-space: nowrap;
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 10px 12px;
      border-radius: 8px;
      font-weight: 700;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 24px 0;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      min-height: 116px;
    }
    .label {
      color: var(--muted);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0;
      font-weight: 700;
    }
    .value {
      margin-top: 10px;
      font-size: 28px;
      font-weight: 800;
    }
    .pair {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-top: 18px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      text-align: right;
    }
    th:first-child, td:first-child { text-align: left; }
    tr:last-child td { border-bottom: 0; }
    th {
      color: var(--muted);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .chart {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      margin-top: 16px;
    }
    .note {
      color: var(--muted);
      line-height: 1.5;
      margin-top: 18px;
    }
    svg { width: 100%; height: auto; display: block; }
    @media (max-width: 860px) {
      main { padding: 18px; }
      header, .pair { grid-template-columns: 1fr; display: grid; align-items: start; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>BugCapsule Evaluation</h1>
        <div class="sub">Exact-token context comparison for <strong>${escapeHtml(report.capsuleId)}</strong>. The before view is a deterministic full-repo context payload; the after view is the generated capsule context.</div>
      </div>
      <div class="badge">${escapeHtml(formatReductionLabel(report.contexts.savings.contextTokensPercent, "context tokens"))}</div>
    </header>

    <section class="grid" aria-label="summary metrics">
      <div class="card"><div class="label">Before tokens</div><div class="value">${formatNumber(report.contexts.fullRepo.contextTokens)}</div></div>
      <div class="card"><div class="label">After tokens</div><div class="value">${formatNumber(report.contexts.bugCapsule.contextTokens)}</div></div>
      <div class="card"><div class="label">Before files</div><div class="value">${formatNumber(report.contexts.fullRepo.fileCount)}</div></div>
      <div class="card"><div class="label">After files</div><div class="value">${formatNumber(report.contexts.bugCapsule.fileCount)}</div></div>
    </section>

    <section class="chart">
      ${svg}
    </section>

    <section class="pair">
      <div>
        <h2>Deterministic Context Metrics</h2>
        ${renderContextTable(report)}
      </div>
      <div>
        <h2>Measured Fix Usage</h2>
        ${measured ? renderMeasuredUsageTable(measured) : `<p class="note">${escapeHtml(report.methodology.actualFixCost)}</p>`}
      </div>
    </section>

    <p class="note">${escapeHtml(report.methodology.contextBaseline)}</p>
    <p class="note">Payload hashes: before <code>${report.contexts.fullRepo.payloadSha256}</code>, after <code>${report.contexts.bugCapsule.payloadSha256}</code>.</p>
  </main>
</body>
</html>
`;
}

function renderContextTable(report: EvaluationReport): string {
  return `<table>
    <thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Savings</th></tr></thead>
    <tbody>
      <tr><td>Files</td><td>${formatNumber(report.contexts.fullRepo.fileCount)}</td><td>${formatNumber(report.contexts.bugCapsule.fileCount)}</td><td>${formatPercent(report.contexts.savings.filesPercent)}</td></tr>
      <tr><td>Bytes</td><td>${formatNumber(report.contexts.fullRepo.byteCount)}</td><td>${formatNumber(report.contexts.bugCapsule.byteCount)}</td><td>${formatPercent(report.contexts.savings.bytesPercent)}</td></tr>
      <tr><td>Source tokens</td><td>${formatNumber(report.contexts.fullRepo.sourceTokens)}</td><td>${formatNumber(report.contexts.bugCapsule.sourceTokens)}</td><td>${formatPercent(report.contexts.savings.sourceTokensPercent)}</td></tr>
      <tr><td>Context payload tokens</td><td>${formatNumber(report.contexts.fullRepo.contextTokens)}</td><td>${formatNumber(report.contexts.bugCapsule.contextTokens)}</td><td>${formatPercent(report.contexts.savings.contextTokensPercent)}</td></tr>
      <tr><td>Input-context cost</td><td>${formatCost(report.contexts.fullRepo.contextInputCostUsd)}</td><td>${formatCost(report.contexts.bugCapsule.contextInputCostUsd)}</td><td>${formatNullablePercent(report.contexts.savings.contextInputCostPercent)}</td></tr>
    </tbody>
  </table>`;
}

function renderMeasuredUsageTable(measured: NonNullable<EvaluationReport["measuredUsage"]>): string {
  return `<table>
    <thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Savings</th></tr></thead>
    <tbody>
      <tr><td>Input tokens</td><td>${formatNumber(measured.withoutBugCapsule?.inputTokens)}</td><td>${formatNumber(measured.withBugCapsule?.inputTokens)}</td><td>${formatNullablePercent(measured.savings?.inputTokensPercent)}</td></tr>
      <tr><td>Output tokens</td><td>${formatNumber(measured.withoutBugCapsule?.outputTokens)}</td><td>${formatNumber(measured.withBugCapsule?.outputTokens)}</td><td>${formatNullablePercent(measured.savings?.outputTokensPercent)}</td></tr>
      <tr><td>Total tokens</td><td>${formatNumber(measured.withoutBugCapsule?.totalTokens)}</td><td>${formatNumber(measured.withBugCapsule?.totalTokens)}</td><td>${formatNullablePercent(measured.savings?.totalTokensPercent)}</td></tr>
      <tr><td>Listed-price cost</td><td>${formatCost(measured.withoutBugCapsule?.listedCostUsd ?? null)}</td><td>${formatCost(measured.withBugCapsule?.listedCostUsd ?? null)}</td><td>${formatNullablePercent(measured.savings?.listedCostPercent)}</td></tr>
    </tbody>
  </table>`;
}

function renderSvg(report: EvaluationReport): string {
  const width = 1320;
  const height = 820;
  const chartLeft = 110;
  const chartTop = 260;
  const rowHeight = 135;
  const maxBarWidth = 860;
  const metrics = [
    {
      label: "Context tokens",
      before: report.contexts.fullRepo.contextTokens,
      after: report.contexts.bugCapsule.contextTokens,
      savings: report.contexts.savings.contextTokensPercent,
      valueFormat: formatNumber
    },
    {
      label: "Source tokens",
      before: report.contexts.fullRepo.sourceTokens,
      after: report.contexts.bugCapsule.sourceTokens,
      savings: report.contexts.savings.sourceTokensPercent,
      valueFormat: formatNumber
    },
    {
      label: "Files",
      before: report.contexts.fullRepo.fileCount,
      after: report.contexts.bugCapsule.fileCount,
      savings: report.contexts.savings.filesPercent,
      valueFormat: formatNumber
    },
    {
      label: "Input-context cost",
      before: report.contexts.fullRepo.contextInputCostUsd ?? 0,
      after: report.contexts.bugCapsule.contextInputCostUsd ?? 0,
      savings: report.contexts.savings.contextInputCostPercent ?? 0,
      valueFormat: (value: number | undefined) => formatCost(value ?? null)
    }
  ].filter((metric) => metric.label !== "Input-context cost" || report.contexts.fullRepo.contextInputCostUsd !== null);
  const maxValue = Math.max(...metrics.flatMap((metric) => [metric.before, metric.after]), 1);

  const rows = metrics.map((metric, index) => {
    const y = chartTop + index * rowHeight;
    const beforeWidth = Math.max(2, metric.before / maxValue * maxBarWidth);
    const afterWidth = Math.max(2, metric.after / maxValue * maxBarWidth);
    return `
    <text x="${chartLeft}" y="${y}" class="row-label">${escapeXml(metric.label)}</text>
    <rect x="${chartLeft}" y="${y + 18}" width="${beforeWidth}" height="32" rx="5" fill="#d54b4b"/>
    <rect x="${chartLeft}" y="${y + 58}" width="${afterWidth}" height="32" rx="5" fill="#257b63"/>
    <text x="${chartLeft + beforeWidth + 14}" y="${y + 41}" class="bar-value">${escapeXml(metric.valueFormat(metric.before))}</text>
    <text x="${chartLeft + afterWidth + 14}" y="${y + 81}" class="bar-value">${escapeXml(metric.valueFormat(metric.after))}</text>
    <text x="${chartLeft + maxBarWidth + 120}" y="${y + 62}" class="saving" style="fill: ${metric.savings >= 0 ? "#257b63" : "#d54b4b"}">${escapeXml(formatPercent(metric.savings))}</text>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="BugCapsule before and after evaluation">
  <style>
    .title { font: 800 44px Inter, Arial, sans-serif; fill: #18202a; }
    .subtitle { font: 500 19px Inter, Arial, sans-serif; fill: #657286; }
    .metric-label { font: 700 16px Inter, Arial, sans-serif; fill: #657286; text-transform: uppercase; }
    .metric-value { font: 800 34px Inter, Arial, sans-serif; fill: #18202a; }
    .legend { font: 700 17px Inter, Arial, sans-serif; fill: #18202a; }
    .row-label { font: 800 22px Inter, Arial, sans-serif; fill: #18202a; }
    .bar-value { font: 700 18px Inter, Arial, sans-serif; fill: #18202a; }
    .saving { font: 800 25px Inter, Arial, sans-serif; fill: #257b63; text-anchor: middle; }
    .note { font: 500 16px Inter, Arial, sans-serif; fill: #657286; }
  </style>
  <rect width="${width}" height="${height}" fill="#f6f7f9"/>
  <text x="72" y="78" class="title">BugCapsule Evaluation</text>
  <text x="74" y="116" class="subtitle">Before: full repository debug context. After: generated executable capsule.</text>
  <text x="74" y="148" class="subtitle">Capsule ${escapeXml(report.capsuleId)} using ${escapeXml(report.model)} / ${escapeXml(report.tokenizer.encoding)}</text>

  <rect x="72" y="178" width="265" height="62" rx="8" fill="#ffffff" stroke="#d9dee7"/>
  <text x="92" y="203" class="metric-label">Before tokens</text>
  <text x="92" y="231" class="metric-value">${escapeXml(formatNumber(report.contexts.fullRepo.contextTokens))}</text>
  <rect x="357" y="178" width="265" height="62" rx="8" fill="#ffffff" stroke="#d9dee7"/>
  <text x="377" y="203" class="metric-label">After tokens</text>
  <text x="377" y="231" class="metric-value">${escapeXml(formatNumber(report.contexts.bugCapsule.contextTokens))}</text>
  <rect x="642" y="178" width="310" height="62" rx="8" fill="#ffffff" stroke="#d9dee7"/>
  <text x="662" y="203" class="metric-label">Context savings</text>
  <text x="662" y="231" class="metric-value">${escapeXml(formatPercent(report.contexts.savings.contextTokensPercent))}</text>

  <circle cx="114" cy="252" r="7" fill="#d54b4b"/><text x="130" y="258" class="legend">Without BugCapsule</text>
  <circle cx="342" cy="252" r="7" fill="#257b63"/><text x="358" y="258" class="legend">With BugCapsule</text>
  <text x="${chartLeft + maxBarWidth + 120}" y="258" class="legend" text-anchor="middle">Savings</text>

  ${rows}

  <text x="74" y="780" class="note">Exact tokenizer count for the deterministic context payload. Actual no-BugCapsule fix cost requires a measured baseline agent run.</text>
</svg>
`;
}

function savingsPercent(before: number, after: number): number {
  if (!Number.isFinite(before) || before <= 0) {
    return 0;
  }
  return Number((((before - after) / before) * 100).toFixed(1));
}

function savingsPercentOrNull(before: number, after: number): number | null {
  if (!Number.isFinite(before) || before <= 0) {
    return null;
  }
  return savingsPercent(before, after);
}

function costForTokens(tokens: number, pricePerMillion: number): number {
  return tokens / 1_000_000 * pricePerMillion;
}

function costForInputOutput(inputTokens: number, outputTokens: number, inputPricePerMillion: number, outputPricePerMillion: number): number {
  return costForTokens(inputTokens, inputPricePerMillion) + costForTokens(outputTokens, outputPricePerMillion);
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) {
    return "not measured";
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatReductionLabel(value: number, noun: string): string {
  return value >= 0
    ? `${formatPercent(value)} fewer ${noun}`
    : `${formatPercent(Math.abs(value))} more ${noun}`;
}

function formatNullablePercent(value: number | null | undefined): string {
  return value === null || value === undefined ? "not measured" : formatPercent(value);
}

function formatCost(value: number | null): string {
  if (value === null) {
    return "not configured";
  }
  if (!Number.isFinite(value) || value === 0) {
    return "$0.00";
  }
  const decimals = Math.abs(value) >= 1 ? 2 : Math.abs(value) >= 0.01 ? 4 : 6;
  return `$${value.toFixed(decimals)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeXml(value: string): string {
  return escapeHtml(value).replaceAll("'", "&apos;");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`BugCapsule evaluation failed: ${message}\n`);
  process.exit(1);
});
