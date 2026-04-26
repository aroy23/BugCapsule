#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { encodingForModel, getEncoding, getEncodingNameForModel } from "js-tiktoken";

import { loadPricing } from "../packages/mcp/src/usage/pricing.js";

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
    htmlPath: string;
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
  const options = await resolveCliOptions(parseArgs(process.argv.slice(2)));
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
  const htmlPath = path.join(outputDir, `${baseName}.html`);

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
        "generated runtime lineage artifacts",
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
      htmlPath
    }
  };

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

  if (!repoPath || !capsuleId) {
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

async function resolveCliOptions(options: CliOptions): Promise<CliOptions> {
  const needsTokenizerDefault = !options.model && !options.encoding;
  const needsPricingDefaults = needsTokenizerDefault ||
    options.inputPricePerMillion === undefined ||
    options.outputPricePerMillion === undefined;

  if (!needsPricingDefaults) {
    return options;
  }

  const pricing = await loadPricing(path.resolve(options.repoPath));
  const resolved: CliOptions = {
    ...options,
    ...(!options.model ? { model: pricing.model } : {}),
    ...(needsTokenizerDefault && pricing.evaluation_encoding ? { encoding: pricing.evaluation_encoding } : {}),
    ...(options.inputPricePerMillion === undefined ? { inputPricePerMillion: pricing.input_per_million } : {}),
    ...(options.outputPricePerMillion === undefined ? { outputPricePerMillion: pricing.output_per_million } : {})
  };

  if (!resolved.model && !resolved.encoding) {
    printUsageAndExit(1);
  }

  return resolved;
}

function printUsageAndExit(code: number): never {
  const usage = `Usage:
  npm run eval:capsule -- --repo <repoPath> --capsule-id <id>

Options:
  --model <name>                       Override the configured pricing profile model.
  --encoding <name>                    Use a tokenizer encoding directly, for example o200k_base.
  --input-price-per-million <usd>       Override configured input pricing.
  --output-price-per-million <usd>      Enables listed-cost totals for measured usage logs.
  --baseline-usage <path>               Optional exact provider/harness usage JSON for the no-BugCapsule run.
  --bugcapsule-usage <path>             Optional exact provider/harness usage JSON for the BugCapsule run.
  --out-dir <path>                      Output directory. Defaults to .bugcapsule/evaluations/<capsule-id>.
  --include-lockfiles                   Include package-lock.json, pnpm-lock.yaml, yarn.lock, and bun.lockb.

Notes:
  Model, tokenizer encoding, and prices default to .bugcapsule/pricing.json, then BugCapsule's bundled pricing profile.
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
      if (isGeneratedRuntimeLineagePath(relativePath)) {
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
    if (!shouldIncludeFile(relativePath, options.includeLockfiles)) {
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

function shouldIncludeFile(relativePath: string, includeLockfiles: boolean): boolean {
  if (isGeneratedRuntimeLineagePath(relativePath)) {
    return false;
  }

  const fileName = path.basename(relativePath);
  if (!includeLockfiles && LOCKFILES.has(fileName)) {
    return false;
  }
  return TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function isGeneratedRuntimeLineagePath(relativePath: string): boolean {
  return /(?:^|\/)\.bugcapsule\/repros\/[^/]+\.lineage(?:\/|$|\.json$)/.test(relativePath);
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
  lines.push("");

  return lines.join("\n");
}

type CardData = {
  key: string;
  eyebrow: string;
  label: string;
  before: string;
  after: string;
  saved: string;
  pct: number;
  pctOfBefore: number;
  explainer: string;
};

function renderHtml(report: EvaluationReport): string {
  const c = report.contexts;
  const measured = report.measuredUsage;

  const beforeTokens = c.fullRepo.contextTokens;
  const afterTokens = c.bugCapsule.contextTokens;
  const tokensSaved = Math.max(0, beforeTokens - afterTokens);
  const beforeFiles = c.fullRepo.fileCount;
  const afterFiles = c.bugCapsule.fileCount;
  const filesSaved = Math.max(0, beforeFiles - afterFiles);
  const beforeBytes = c.fullRepo.byteCount;
  const afterBytes = c.bugCapsule.byteCount;
  const bytesSaved = Math.max(0, beforeBytes - afterBytes);
  const beforeCost = c.fullRepo.contextInputCostUsd;
  const afterCost = c.bugCapsule.contextInputCostUsd;
  const costAvailable = beforeCost !== null && afterCost !== null;
  const costSaved = costAvailable ? Math.max(0, (beforeCost ?? 0) - (afterCost ?? 0)) : null;
  const capsuleRepoRatio = beforeTokens > 0 ? afterTokens / beforeTokens : null;
  const capsuleRepoRatioLabel = capsuleRepoRatio === null ? "n/a" : `${formatRatio(capsuleRepoRatio)} : 1`;
  const generatedFormatted = report.generatedAt.replace("T", " ").slice(0, 19) + " UTC";

  const cards: CardData[] = [
    {
      key: "tokens",
      eyebrow: "tokens",
      label: "Context tokens",
      before: formatNumber(beforeTokens),
      after: formatNumber(afterTokens),
      saved: formatNumber(tokensSaved),
      pct: c.savings.contextTokensPercent,
      pctOfBefore: beforeTokens > 0 ? (afterTokens / beforeTokens) * 100 : 0,
      explainer: "Tokens are how language models charge for inputs. The full-repo payload is the entire deterministic context an unscoped agent might ingest. The capsule keeps only what reproduces the failure."
    },
    {
      key: "files",
      eyebrow: "files",
      label: "Files",
      before: formatNumber(beforeFiles),
      after: formatNumber(afterFiles),
      saved: formatNumber(filesSaved),
      pct: c.savings.filesPercent,
      pctOfBefore: beforeFiles > 0 ? (afterFiles / beforeFiles) * 100 : 0,
      explainer: "Source files included in the context payload. node_modules, build artifacts, lockfiles, and binaries are excluded by default for both views, so this is an apples-to-apples count."
    },
    {
      key: "bytes",
      eyebrow: "storage",
      label: "Storage size",
      before: formatBytes(beforeBytes),
      after: formatBytes(afterBytes),
      saved: formatBytes(bytesSaved),
      pct: c.savings.bytesPercent,
      pctOfBefore: beforeBytes > 0 ? (afterBytes / beforeBytes) * 100 : 0,
      explainer: "Raw byte size of every included source file. A small capsule ships faster, caches better, and is dramatically easier to inspect when triaging an incident."
    }
  ];

  if (costAvailable) {
    cards.push({
      key: "cost",
      eyebrow: "USD",
      label: "Input-context cost",
      before: formatCost(beforeCost),
      after: formatCost(afterCost),
      saved: formatCost(costSaved),
      pct: c.savings.contextInputCostPercent ?? 0,
      pctOfBefore: beforeCost && beforeCost > 0 ? ((afterCost ?? 0) / beforeCost) * 100 : 0,
      explainer: "Listed-price cost of feeding the context payload to the model once, at the configured input rate. Multiply by the number of fix attempts to see compounded impact."
    });
  }

  const cardsHtml = cards.map((m) => `
        <button class="metric-card" type="button" data-metric="${escapeHtml(m.key)}" aria-expanded="false">
          <div class="card-eyebrow">${escapeHtml(m.eyebrow)}</div>
          <div class="card-label">${escapeHtml(m.label)}</div>
          <div class="card-savings ${m.pct >= 0 ? "is-pos" : "is-neg"}">
            <span class="card-pct" data-target="${m.pct}">${escapeHtml(formatPercent(Math.abs(m.pct)))}</span>
            <span class="card-pct-word">${m.pct >= 0 ? "saved" : "more"}</span>
          </div>
          <div class="card-numbers">
            <div class="num-side"><span class="num-tag">before</span><span class="num-val">${escapeHtml(m.before)}</span></div>
            <svg class="num-arrow" viewBox="0 0 28 12" width="38" height="14" aria-hidden="true"><path d="M1 6h25M21 1l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <div class="num-side after"><span class="num-tag">after</span><span class="num-val">${escapeHtml(m.after)}</span></div>
          </div>
          <div class="card-bar">
            <div class="card-bar-track"><div class="card-bar-fill" style="--target-w: ${m.pctOfBefore.toFixed(2)}%"></div></div>
            <span class="card-bar-caption">capsule keeps ${m.pctOfBefore.toFixed(1)}% of original</span>
          </div>
          <div class="card-detail">
            <p>${escapeHtml(m.explainer)}</p>
            <div class="card-detail-grid">
              <div class="card-detail-item"><span>Saved</span><strong>${escapeHtml(m.saved)}</strong></div>
              <div class="card-detail-item"><span>Reduction</span><strong>${escapeHtml(formatPercent(m.pct))}</strong></div>
              <div class="card-detail-item"><span>Capsule keeps</span><strong>${m.pctOfBefore.toFixed(1)}%</strong></div>
            </div>
          </div>
          <div class="card-cta">
            <span>Tap for context</span>
            <span class="card-cta-icon" aria-hidden="true">＋</span>
          </div>
        </button>`).join("");

  const chartRowsHtml = cards.map((m) => `
          <div class="bar-row" data-row="${escapeHtml(m.key)}">
            <div class="bar-row-head">
              <div class="bar-row-label">${escapeHtml(m.label)}</div>
              <div class="bar-row-pct ${m.pct >= 0 ? "is-pos" : "is-neg"}">${escapeHtml(formatPercent(Math.abs(m.pct)))} ${m.pct >= 0 ? "saved" : "more"}</div>
            </div>
            <div class="bar-row-tracks">
              <div class="bar-track">
                <span class="bar-track-tag">without</span>
                <div class="bar-track-bar"><div class="bar-track-fill is-before" style="--target-w: 100%"></div></div>
                <span class="bar-track-value">${escapeHtml(m.before)}</span>
              </div>
              <div class="bar-track">
                <span class="bar-track-tag">with</span>
                <div class="bar-track-bar"><div class="bar-track-fill is-after" style="--target-w: ${m.pctOfBefore.toFixed(2)}%"></div></div>
                <span class="bar-track-value">${escapeHtml(m.after)}</span>
              </div>
            </div>
          </div>`).join("");

  const repoTop = c.fullRepo.largestFiles;
  const capsuleTop = c.bugCapsule.largestFiles;
  const allLarge = [...repoTop, ...capsuleTop];
  const largeMaxTokens = allLarge.length > 0 ? Math.max(...allLarge.map((f) => f.sourceTokens), 1) : 1;

  const renderLargeList = (files: FileMetric[], emptyText: string): string => files.length === 0
    ? `<div class="lf-empty">${escapeHtml(emptyText)}</div>`
    : files.map((f) => `
            <div class="lf-row">
              <div class="lf-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
              <div class="lf-bar"><div class="lf-fill" style="--target-w: ${(f.sourceTokens / largeMaxTokens * 100).toFixed(2)}%"></div></div>
              <div class="lf-tokens"><span class="lf-tokens-num">${escapeHtml(formatNumber(f.sourceTokens))}</span><span class="lf-tokens-unit">tok</span></div>
            </div>`).join("");

  const projectionMultipliers = [1, 10, 100, 1000, 10000];
  const projectionHtml = costAvailable && costSaved !== null && costSaved > 0 ? `
      <section class="block cost-block" id="cost-projection">
        <header class="block-head">
          <div class="block-eyebrow">— compounded savings</div>
          <h2 class="block-title">Cost <em>over time</em></h2>
          <p class="block-sub">Per-run savings compound across every fix attempt. Pick a scale to project the dollar impact.</p>
        </header>
        <div class="proj-card">
          <div class="proj-display">
            <div class="proj-label">total saved</div>
            <div class="proj-amount">
              <span class="proj-symbol">$</span><span class="proj-num" data-base="${costSaved}" data-multiplier="1">${escapeHtml(formatCost(costSaved).replace("$", ""))}</span>
            </div>
            <div class="proj-runs-line">across <strong class="proj-runs">1</strong> <span class="proj-runs-noun">run</span></div>
          </div>
          <div class="proj-controls" role="tablist" aria-label="Projection scale">
            ${projectionMultipliers.map((mul, i) => `
            <button class="proj-btn${i === 0 ? " is-active" : ""}" data-multiplier="${mul}" type="button" role="tab" aria-selected="${i === 0 ? "true" : "false"}">
              <span class="proj-btn-num">${mul.toLocaleString("en-US")}×</span>
              <span class="proj-btn-label">${mul === 1 ? "single" : mul < 100 ? "small team" : mul < 1000 ? "growing" : mul < 10000 ? "org-wide" : "fleet"}</span>
            </button>`).join("")}
          </div>
          <div class="proj-foot">
            Per run: <strong>${escapeHtml(formatCost(costSaved))}</strong> saved${report.pricing.inputPerMillion !== null ? ` · Input rate: <strong>${escapeHtml(formatCost(report.pricing.inputPerMillion))}/M tokens</strong>` : ""}
          </div>
        </div>
      </section>` : "";

  const measuredHtml = measured ? `
      <section class="block measured-block" id="measured">
        <header class="block-head">
          <div class="block-eyebrow">— measured agent usage</div>
          <h2 class="block-title">Real <em>fix runs</em></h2>
          <p class="block-sub">Provider usage logs from instrumented agent runs. Captures the agent's actual behavior, not just the deterministic baseline.</p>
        </header>
        <div class="measured-grid">
          ${renderMeasuredCard("Input tokens", formatNumber(measured.withoutBugCapsule?.inputTokens), formatNumber(measured.withBugCapsule?.inputTokens), measured.savings?.inputTokensPercent)}
          ${renderMeasuredCard("Output tokens", formatNumber(measured.withoutBugCapsule?.outputTokens), formatNumber(measured.withBugCapsule?.outputTokens), measured.savings?.outputTokensPercent)}
          ${renderMeasuredCard("Total tokens", formatNumber(measured.withoutBugCapsule?.totalTokens), formatNumber(measured.withBugCapsule?.totalTokens), measured.savings?.totalTokensPercent)}
          ${renderMeasuredCard("Listed cost", formatCost(measured.withoutBugCapsule?.listedCostUsd ?? null), formatCost(measured.withBugCapsule?.listedCostUsd ?? null), measured.savings?.listedCostPercent)}
        </div>
      </section>` : `
      <section class="block measured-block measured-empty">
        <header class="block-head">
          <div class="block-eyebrow">— measured agent usage</div>
          <h2 class="block-title">Awaiting <em>real runs</em></h2>
          <p class="block-sub">${escapeHtml(report.methodology.actualFixCost)}</p>
        </header>
      </section>`;

  const exclusionsHtml = report.methodology.excludedByDefault.map((e) => `<li>${escapeHtml(e)}</li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BugCapsule · ${escapeHtml(report.capsuleId)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: light;
      --bg: #fafaf7;
      --bg-2: #f4f2ec;
      --surface: #ffffff;
      --surface-2: #f8f6f0;
      --border: #e6e2d8;
      --border-strong: #d4cebd;
      --ink: #1c1a17;
      --ink-2: #38342e;
      --muted: #767168;
      --muted-2: #a39e92;
      --before: #b96a4a;
      --before-soft: #f4e6dc;
      --before-line: #d6b39d;
      --after: #1f5d49;
      --after-soft: #e3eee8;
      --after-line: #97b9a8;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      background: var(--bg);
      color: var(--ink);
      font-family: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      font-weight: 400;
      font-size: 16px;
      line-height: 1.55;
      letter-spacing: -0.005em;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    body { min-height: 100vh; }

    .grain { display: none; }

    main { position: relative; z-index: 2; max-width: 1180px; margin: 0 auto; padding: 28px clamp(20px, 4vw, 48px) 96px; }

    .topbar {
      display: flex; flex-wrap: wrap; gap: 18px;
      align-items: center; justify-content: space-between;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--border);
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--muted);
    }
    .brand { display: flex; align-items: center; gap: 10px; color: var(--ink); }
    .brand-mark {
      display: inline-block;
      width: 10px; height: 10px; border-radius: 50%;
      background: var(--after);
    }
    .brand-mark::after { content: none; }
    .brand-name { font-weight: 600; letter-spacing: 0.08em; color: var(--ink); }
    .brand-divider { color: var(--muted-2); }
    .brand-section { color: var(--muted); }
    .topbar-meta { display: flex; flex-wrap: wrap; gap: 6px; }
    .meta-pill { padding: 6px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--ink-2); }
    .meta-pill .k { color: var(--muted-2); margin-right: 6px; }

    .hero { padding: 64px 0 28px; }
    .hero-eyebrow { display: inline-flex; align-items: center; gap: 10px; color: var(--muted); font-family: "JetBrains Mono", monospace; font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 22px; }
    .hero-eyebrow::before { content: ""; width: 22px; height: 1px; background: var(--muted); }

    .hero-headline {
      font-family: "Instrument Serif", "Times New Roman", serif;
      font-weight: 400; font-style: normal;
      font-size: clamp(40px, 6.4vw, 76px);
      line-height: 1.08;
      letter-spacing: -0.02em;
      color: var(--ink);
      max-width: 1080px;
    }
    .hero-headline .seg { display: inline; }
    .big-percent {
      font-style: italic;
      color: var(--after);
      padding-right: 0.06em;
      white-space: nowrap;
    }

    .hero-lede { margin-top: 24px; max-width: 700px; color: var(--ink-2); font-size: 16.5px; line-height: 1.6; }

    .hero-stats {
      display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; overflow: hidden;
      margin-top: 36px;
    }
    .hero-stats > div { padding: 22px 24px 20px; border-right: 1px solid var(--border); min-width: 0; }
    .hero-stats > div:last-child { border-right: 0; }
    .hero-stat-label { font-family: "JetBrains Mono", monospace; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .hero-stat-value {
      margin-top: 14px;
      font-family: "JetBrains Mono", monospace;
      font-size: 26px;
      font-weight: 500;
      line-height: 1.15;
      color: var(--ink);
      word-break: break-word;
    }
    .hero-stat-sub { margin-top: 8px; color: var(--muted); font-size: 12px; font-family: "JetBrains Mono", monospace; line-height: 1.5; word-break: break-word; }

    .block { margin-top: 72px; }
    .block-head { display: grid; gap: 8px; margin-bottom: 28px; max-width: 720px; }
    .block-eyebrow { font-family: "JetBrains Mono", monospace; font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .block-title { font-family: "Instrument Serif", serif; font-weight: 400; font-size: clamp(28px, 3.4vw, 38px); line-height: 1.15; letter-spacing: -0.015em; color: var(--ink); }
    .block-title em { font-style: italic; color: var(--after); padding-right: 0.04em; }
    .block-sub { color: var(--muted); font-size: 14.5px; max-width: 600px; }

    .bento-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }

    .metric-card {
      position: relative;
      text-align: left; cursor: pointer;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px 22px 18px;
      color: inherit;
      font: inherit;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .metric-card:hover { border-color: var(--border-strong); box-shadow: 0 4px 18px rgba(28, 26, 23, 0.06); }
    .metric-card:focus-visible { outline: 2px solid var(--after); outline-offset: 2px; }

    .card-eyebrow { font-family: "JetBrains Mono", monospace; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .card-label { margin-top: 6px; font-family: "Instrument Serif", serif; font-size: 22px; line-height: 1.2; color: var(--ink); letter-spacing: -0.01em; }

    .card-savings { display: flex; align-items: baseline; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
    .card-pct {
      font-family: "JetBrains Mono", monospace;
      font-weight: 500;
      font-size: 38px;
      line-height: 1.05;
      letter-spacing: -0.015em;
      white-space: nowrap;
    }
    .card-savings.is-pos .card-pct { color: var(--after); }
    .card-savings.is-neg .card-pct { color: var(--before); }
    .card-pct-word { font-family: "JetBrains Mono", monospace; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }

    .card-numbers { margin-top: 18px; display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
    .num-side { flex: 1; display: grid; gap: 4px; min-width: 0; }
    .num-tag { font-family: "JetBrains Mono", monospace; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted-2); }
    .num-val { font-family: "JetBrains Mono", monospace; font-size: 13.5px; font-weight: 500; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .num-side.after .num-val { color: var(--after); }
    .num-arrow { color: var(--muted-2); flex-shrink: 0; }

    .card-bar { margin-top: 16px; }
    .card-bar-track { height: 5px; background: var(--bg-2); border-radius: 999px; overflow: hidden; position: relative; }
    .card-bar-fill { height: 100%; width: 0%; background: var(--after); border-radius: 999px; animation: barGrow 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) 0.2s forwards; }
    .card-bar-caption { display: block; margin-top: 8px; font-family: "JetBrains Mono", monospace; font-size: 10.5px; color: var(--muted); }

    .card-detail { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.32s ease, margin-top 0.28s ease, opacity 0.28s ease; opacity: 0; margin-top: 0; }
    .card-detail > * { overflow: hidden; }
    .metric-card.is-open .card-detail { grid-template-rows: 1fr; opacity: 1; margin-top: 16px; }
    .card-detail p { color: var(--ink-2); font-size: 13.5px; line-height: 1.6; padding-top: 14px; border-top: 1px solid var(--border); }
    .card-detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; margin-top: 14px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .card-detail-item { background: var(--surface-2); padding: 10px 12px; display: grid; gap: 4px; border-right: 1px solid var(--border); }
    .card-detail-item:last-child { border-right: 0; }
    .card-detail-item span { font-family: "JetBrains Mono", monospace; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .card-detail-item strong { font-family: "JetBrains Mono", monospace; font-size: 13px; color: var(--ink); font-weight: 500; }

    .card-cta { margin-top: 14px; display: flex; align-items: center; justify-content: space-between; font-family: "JetBrains Mono", monospace; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .card-cta-icon { width: 22px; height: 22px; border-radius: 50%; background: var(--surface-2); border: 1px solid var(--border); display: inline-grid; place-items: center; transition: transform 0.25s ease, background 0.25s ease, color 0.25s ease, border-color 0.25s ease; color: var(--ink-2); font-size: 13px; }
    .metric-card.is-open .card-cta-icon { transform: rotate(45deg); background: var(--after-soft); color: var(--after); border-color: var(--after-line); }

    .chart-block .legend { display: flex; gap: 18px; flex-wrap: wrap; font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--muted); margin-top: 6px; }
    .legend-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: 1px; }
    .legend-dot.before { background: var(--before); }
    .legend-dot.after { background: var(--after); }

    .chart-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px 28px 20px; }
    .bar-row { padding: 20px 0; border-bottom: 1px solid var(--border); cursor: pointer; transition: opacity 0.2s ease; }
    .bar-row:last-child { border-bottom: 0; }
    .chart-card.has-focus .bar-row { opacity: 0.4; }
    .chart-card.has-focus .bar-row.is-focused { opacity: 1; }
    .bar-row-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; gap: 12px; }
    .bar-row-label { font-family: "Instrument Serif", serif; font-size: 20px; line-height: 1.2; color: var(--ink); }
    .bar-row-pct { font-family: "JetBrains Mono", monospace; font-size: 11.5px; letter-spacing: 0.04em; padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
    .bar-row-pct.is-pos { background: var(--after-soft); color: var(--after); border: 1px solid var(--after-line); }
    .bar-row-pct.is-neg { background: var(--before-soft); color: var(--before); border: 1px solid var(--before-line); }

    .bar-row-tracks { display: grid; gap: 8px; }
    .bar-track { display: grid; grid-template-columns: 64px 1fr 110px; align-items: center; gap: 14px; }
    .bar-track-tag { font-family: "JetBrains Mono", monospace; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .bar-track-bar { height: 24px; background: var(--bg-2); border-radius: 4px; overflow: hidden; position: relative; }
    .bar-track-fill { height: 100%; width: 0%; border-radius: 4px; animation: barGrow 1.1s cubic-bezier(0.2, 0.7, 0.2, 1) 0.15s forwards; }
    .bar-track-fill.is-before { background: var(--before); }
    .bar-track-fill.is-after { background: var(--after); }
    .bar-track-value { font-family: "JetBrains Mono", monospace; font-size: 12.5px; color: var(--ink); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .files-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .files-col { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 22px; }
    .files-col-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; gap: 10px; }
    .files-col-title { font-family: "Instrument Serif", serif; font-size: 20px; line-height: 1.2; color: var(--ink); }
    .files-col-tag { font-family: "JetBrains Mono", monospace; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
    .files-col-tag.before { color: var(--before); }
    .files-col-tag.after { color: var(--after); }
    .lf-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(60px, 1.6fr) auto; gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .lf-row:last-child { border-bottom: 0; }
    .lf-path { font-family: "JetBrains Mono", monospace; font-size: 11.5px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lf-bar { height: 5px; background: var(--bg-2); border-radius: 999px; overflow: hidden; }
    .lf-fill { height: 100%; width: 0%; border-radius: 999px; animation: barGrow 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) 0.3s forwards; }
    .files-col.before .lf-fill { background: var(--before); }
    .files-col.after .lf-fill { background: var(--after); }
    .lf-tokens { font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--ink); white-space: nowrap; }
    .lf-tokens-unit { color: var(--muted-2); margin-left: 4px; font-size: 10px; }
    .lf-empty { color: var(--muted); font-size: 13px; padding: 12px 0; }

    .proj-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 28px; display: grid; gap: 24px; }
    .proj-display { display: grid; gap: 8px; padding-bottom: 22px; border-bottom: 1px solid var(--border); }
    .proj-label { font-family: "JetBrains Mono", monospace; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .proj-amount { display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap; }
    .proj-symbol { font-family: "JetBrains Mono", monospace; font-size: 28px; font-weight: 500; color: var(--muted); line-height: 1.1; }
    .proj-num {
      font-family: "JetBrains Mono", monospace;
      font-weight: 500;
      font-size: clamp(40px, 5.5vw, 64px);
      line-height: 1.15;
      letter-spacing: -0.015em;
      color: var(--after);
      transition: opacity 0.25s ease;
      word-break: break-word;
    }
    .proj-runs-line { font-family: "JetBrains Mono", monospace; font-size: 12.5px; color: var(--muted); }
    .proj-runs-line strong { color: var(--ink); font-weight: 500; }

    .proj-controls { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
    .proj-btn { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 12px; cursor: pointer; display: grid; gap: 4px; transition: border-color 0.2s ease, background 0.2s ease; color: inherit; font: inherit; text-align: left; }
    .proj-btn:hover { border-color: var(--border-strong); background: var(--surface-2); }
    .proj-btn.is-active { background: var(--after-soft); border-color: var(--after-line); }
    .proj-btn-num { font-family: "JetBrains Mono", monospace; font-weight: 500; font-size: 18px; line-height: 1.15; color: var(--ink); }
    .proj-btn.is-active .proj-btn-num { color: var(--after); }
    .proj-btn-label { font-family: "JetBrains Mono", monospace; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .proj-foot { font-family: "JetBrains Mono", monospace; font-size: 11.5px; color: var(--muted); }
    .proj-foot strong { color: var(--ink); font-weight: 500; }

    .measured-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
    .measured-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; display: grid; gap: 12px; }
    .measured-card-label { font-family: "JetBrains Mono", monospace; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .measured-card-row { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: baseline; padding-top: 10px; border-top: 1px solid var(--border); }
    .measured-card-row .v { font-family: "JetBrains Mono", monospace; font-size: 13.5px; }
    .measured-card-row .v.before { color: var(--before); }
    .measured-card-row .v.after { color: var(--after); }
    .measured-card-row .arrow { color: var(--muted-2); }
    .measured-card-pct {
      font-family: "JetBrains Mono", monospace;
      font-weight: 500;
      font-size: 28px;
      line-height: 1.15;
      letter-spacing: -0.01em;
    }
    .measured-card-pct.is-pos { color: var(--after); }
    .measured-card-pct.is-neg { color: var(--before); }
    .measured-card-pct.is-na { color: var(--muted); font-size: 12.5px; letter-spacing: 0.06em; text-transform: uppercase; line-height: 1.4; }
    .measured-empty .block-sub { font-style: italic; }

    .method-grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 14px; }
    .method-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 22px; }
    .method-card h3 { font-family: "Instrument Serif", serif; font-size: 20px; line-height: 1.2; color: var(--ink); margin-bottom: 14px; font-weight: 400; }
    .method-card p { color: var(--ink-2); font-size: 13.5px; line-height: 1.6; }
    .method-card p + p { margin-top: 10px; }
    .method-list { display: grid; gap: 6px; margin-top: 12px; }
    .method-list li { list-style: none; padding-left: 18px; position: relative; color: var(--ink-2); font-size: 13px; line-height: 1.55; }
    .method-list li::before { content: "—"; position: absolute; left: 0; color: var(--muted-2); }
    .method-row { display: grid; gap: 6px; padding: 12px 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; margin-top: 12px; }
    .method-row .k { font-family: "JetBrains Mono", monospace; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .method-row .v { font-family: "JetBrains Mono", monospace; font-size: 12.5px; color: var(--ink); word-break: break-all; line-height: 1.5; }

    .footer { margin-top: 64px; padding-top: 22px; border-top: 1px solid var(--border); display: grid; grid-template-columns: 1fr auto; gap: 18px; align-items: center; }
    .footer-info { font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--muted); display: grid; gap: 4px; line-height: 1.5; }
    .footer-info code { font-family: "JetBrains Mono", monospace; color: var(--ink-2); }
    .footer-mark { font-family: "Instrument Serif", serif; font-size: 20px; color: var(--ink); letter-spacing: -0.01em; }

    @keyframes barGrow {
      from { width: 0%; }
      to { width: var(--target-w, 0%); }
    }

    @media (max-width: 920px) {
      .hero-stats { grid-template-columns: repeat(2, 1fr); }
      .hero-stats > div:nth-child(2) { border-right: 0; }
      .hero-stats > div:nth-child(1), .hero-stats > div:nth-child(2) { border-bottom: 1px solid var(--border); }
      .files-grid, .method-grid { grid-template-columns: 1fr; }
      .proj-controls { grid-template-columns: repeat(3, 1fr); }
    }
    @media (max-width: 560px) {
      .topbar { font-size: 10.5px; }
      .hero { padding: 40px 0 20px; }
      .hero-stats { grid-template-columns: 1fr; }
      .hero-stats > div { border-right: 0; border-bottom: 1px solid var(--border); }
      .hero-stats > div:last-child { border-bottom: 0; }
      .bar-track { grid-template-columns: 56px 1fr; row-gap: 4px; }
      .bar-track-value { grid-column: 2 / 3; text-align: left; }
      .proj-controls { grid-template-columns: repeat(2, 1fr); }
      .footer { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <div class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-name">bugcapsule</span>
        <span class="brand-divider">/</span>
        <span class="brand-section">evaluation</span>
      </div>
      <div class="topbar-meta">
        <span class="meta-pill"><span class="k">capsule</span>${escapeHtml(report.capsuleId)}</span>
        <span class="meta-pill"><span class="k">model</span>${escapeHtml(report.model)}</span>
        <span class="meta-pill"><span class="k">tokenizer</span>${escapeHtml(report.tokenizer.encoding)}${report.tokenizer.exactForConfiguredModel ? " · exact" : ""}</span>
        <span class="meta-pill"><span class="k">generated</span>${escapeHtml(generatedFormatted)}</span>
      </div>
    </div>

    <section class="hero">
      <div class="hero-eyebrow">Deterministic context reduction</div>
      <h1 class="hero-headline">
        <span class="seg seg-1">A&nbsp;</span><em class="big-percent seg seg-2">${escapeHtml(formatPercent(Math.abs(c.savings.contextTokensPercent)))}</em><span class="seg seg-3">&nbsp;${c.savings.contextTokensPercent >= 0 ? "smaller debugging context." : "larger debugging context."}</span>
      </h1>
      <p class="hero-lede">The capsule replaces the full-repository context an unscoped agent would otherwise ingest with a deterministic, executable reproduction of the exact failure — keeping only the files needed to surface the bug.</p>

      <div class="hero-stats">
        <div>
          <div class="hero-stat-label">tokens removed</div>
          <div class="hero-stat-value">${escapeHtml(formatNumber(tokensSaved))}</div>
          <div class="hero-stat-sub">${escapeHtml(formatNumber(beforeTokens))} → ${escapeHtml(formatNumber(afterTokens))}</div>
        </div>
        <div>
          <div class="hero-stat-label">files dropped</div>
          <div class="hero-stat-value">${escapeHtml(formatNumber(filesSaved))}</div>
          <div class="hero-stat-sub">${escapeHtml(formatNumber(beforeFiles))} → ${escapeHtml(formatNumber(afterFiles))}</div>
        </div>
        <div>
          <div class="hero-stat-label">storage pruned</div>
          <div class="hero-stat-value">${escapeHtml(formatBytes(bytesSaved))}</div>
          <div class="hero-stat-sub">${escapeHtml(formatBytes(beforeBytes))} → ${escapeHtml(formatBytes(afterBytes))}</div>
        </div>
        <div>
          <div class="hero-stat-label">size ratio</div>
          <div class="hero-stat-value">${escapeHtml(capsuleRepoRatioLabel)}</div>
          <div class="hero-stat-sub">capsule tokens : repo tokens</div>
        </div>
      </div>
    </section>

    <section class="block" id="metrics">
      <header class="block-head">
        <div class="block-eyebrow">— side-by-side metrics</div>
        <h2 class="block-title">Click any card to <em>learn what it measures</em></h2>
        <p class="block-sub">Each card compares the unscoped baseline to the generated capsule and reveals the underlying definition on tap.</p>
      </header>
      <div class="bento-grid">${cardsHtml}
      </div>
    </section>

    <section class="block chart-block" id="comparison">
      <header class="block-head">
        <div class="block-eyebrow">— comparison breakdown</div>
        <h2 class="block-title">Before <em>vs</em> after</h2>
        <p class="block-sub">Hover or tap a row to isolate it. Bars are scaled to the unscoped baseline within each metric.</p>
        <div class="legend"><span><span class="legend-dot before"></span>Without capsule</span><span><span class="legend-dot after"></span>With capsule</span></div>
      </header>
      <div class="chart-card">${chartRowsHtml}
      </div>
    </section>

    <section class="block files-block" id="files">
      <header class="block-head">
        <div class="block-eyebrow">— largest files in context</div>
        <h2 class="block-title">What's in the <em>payload</em>?</h2>
        <p class="block-sub">The biggest token contributors on each side. Bars are scaled to the global maximum so the visual size difference is meaningful.</p>
      </header>
      <div class="files-grid">
        <div class="files-col before">
          <div class="files-col-head">
            <div class="files-col-title">Without capsule</div>
            <div class="files-col-tag before">full repo · top ${repoTop.length}</div>
          </div>
          ${renderLargeList(repoTop, "No files indexed for this side.")}
        </div>
        <div class="files-col after">
          <div class="files-col-head">
            <div class="files-col-title">With capsule</div>
            <div class="files-col-tag after">capsule · top ${capsuleTop.length}</div>
          </div>
          ${renderLargeList(capsuleTop, "No files indexed for this side.")}
        </div>
      </div>
    </section>

    ${projectionHtml}

    ${measuredHtml}

    <section class="block method-block" id="method">
      <header class="block-head">
        <div class="block-eyebrow">— methodology &amp; provenance</div>
        <h2 class="block-title">How we <em>measured</em> this</h2>
      </header>
      <div class="method-grid">
        <div class="method-card">
          <h3>Context baseline</h3>
          <p>${escapeHtml(report.methodology.contextBaseline)}</p>
          <p>${escapeHtml(report.methodology.actualFixCost)}</p>
        </div>
        <div class="method-card">
          <h3>Original failure</h3>
          <div class="method-row"><span class="k">repro command</span><span class="v">${escapeHtml(report.originalRepro.command)}</span></div>
          <div class="method-row"><span class="k">failure summary</span><span class="v">${escapeHtml(report.originalRepro.failureSummary)}</span></div>
        </div>
        <div class="method-card">
          <h3>Excluded by default</h3>
          <ul class="method-list">${exclusionsHtml}</ul>
        </div>
        <div class="method-card">
          <h3>Payload provenance</h3>
          <div class="method-row"><span class="k">before · sha256</span><span class="v">${escapeHtml(c.fullRepo.payloadSha256)}</span></div>
          <div class="method-row"><span class="k">after · sha256</span><span class="v">${escapeHtml(c.bugCapsule.payloadSha256)}</span></div>
          <div class="method-row"><span class="k">repo path</span><span class="v">${escapeHtml(report.repoPath)}</span></div>
          <div class="method-row"><span class="k">capsule path</span><span class="v">${escapeHtml(report.capsulePath)}</span></div>
        </div>
      </div>
    </section>

    <footer class="footer">
      <div class="footer-info">
        <span>Schema v${escapeHtml(report.schemaVersion)} · generated ${escapeHtml(generatedFormatted)}</span>
        <span>Tokenizer: ${escapeHtml(report.tokenizer.kind)} · ${escapeHtml(report.tokenizer.encoding)}${report.tokenizer.exactForConfiguredModel ? " (exact for configured model)" : ""}</span>
      </div>
      <div class="footer-mark">bugcapsule</div>
    </footer>
  </main>

  <script>
    (function () {
      var cards = document.querySelectorAll(".metric-card");
      for (var i = 0; i < cards.length; i++) {
        cards[i].addEventListener("click", function (e) {
          var open = this.classList.toggle("is-open");
          this.setAttribute("aria-expanded", open ? "true" : "false");
        });
      }

      var chartCard = document.querySelector(".chart-card");
      var rows = document.querySelectorAll(".bar-row");
      for (var j = 0; j < rows.length; j++) {
        rows[j].addEventListener("click", function (e) {
          var alreadyFocused = this.classList.contains("is-focused");
          for (var k = 0; k < rows.length; k++) rows[k].classList.remove("is-focused");
          if (alreadyFocused) {
            chartCard && chartCard.classList.remove("has-focus");
          } else {
            this.classList.add("is-focused");
            chartCard && chartCard.classList.add("has-focus");
          }
        });
      }

      var projButtons = document.querySelectorAll(".proj-btn");
      var projNum = document.querySelector(".proj-num");
      var projRuns = document.querySelector(".proj-runs");
      var projRunsNoun = document.querySelector(".proj-runs-noun");
      function formatProjCost(value) {
        var abs = Math.abs(value);
        var decimals = abs >= 100 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
        var formatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        return formatter.format(value);
      }
      for (var p = 0; p < projButtons.length; p++) {
        projButtons[p].addEventListener("click", function () {
          for (var q = 0; q < projButtons.length; q++) {
            projButtons[q].classList.remove("is-active");
            projButtons[q].setAttribute("aria-selected", "false");
          }
          this.classList.add("is-active");
          this.setAttribute("aria-selected", "true");
          if (!projNum) return;
          var mul = parseFloat(this.getAttribute("data-multiplier")) || 1;
          var base = parseFloat(projNum.getAttribute("data-base")) || 0;
          var total = base * mul;
          projNum.style.opacity = "0.4";
          window.setTimeout(function () {
            projNum.textContent = formatProjCost(total);
            projNum.setAttribute("data-multiplier", String(mul));
            projNum.style.opacity = "1";
            if (projRuns) projRuns.textContent = mul.toLocaleString("en-US");
            if (projRunsNoun) projRunsNoun.textContent = mul === 1 ? "run" : "runs";
          }, 140);
        });
      }

    })();
  </script>
</body>
</html>
`;
}

function renderMeasuredCard(label: string, before: string, after: string, pct: number | null | undefined): string {
  const pctClass = pct === null || pct === undefined ? "is-na" : pct >= 0 ? "is-pos" : "is-neg";
  const pctText = pct === null || pct === undefined ? "not measured" : formatPercent(Math.abs(pct));
  return `
          <div class="measured-card">
            <div class="measured-card-label">${escapeHtml(label)}</div>
            <div class="measured-card-pct ${pctClass}">${escapeHtml(pctText)}</div>
            <div class="measured-card-row">
              <span class="v before">${escapeHtml(before)}</span>
              <span class="arrow">→</span>
              <span class="v after">${escapeHtml(after)}</span>
            </div>
          </div>`;
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

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
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

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "0 B";
  }
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
