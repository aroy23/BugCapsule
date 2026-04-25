import fs from "node:fs/promises";
import path from "node:path";

import { createCapsule } from "./createCapsule.js";
import { ensureDir, pathExists, writeTextFile } from "./fileUtils.js";
import { capsulePathFor } from "./manifest.js";
import { assertInsideRoot, normalizePath, slugify } from "./pathUtils.js";
import { runShellCommand } from "./shell.js";
import { extractFailureSummary, parseStackTrace } from "./stackTraceParser.js";
import type {
  CreateCapsuleFromRuntimeOptions,
  CreateCapsuleFromRuntimeResult,
  RuntimeFailure,
  RuntimeGeneratedRepro,
  RuntimeInteraction,
  RuntimeProbeOptions,
  RuntimeProbeResult,
  StackFrame
} from "./types.js";

type JsonRecord = Record<string, unknown>;

type TargetExport = {
  file: string;
  name: string;
  score: number;
  stackIndex: number;
};

type GeneratedRuntimeRepro = RuntimeGeneratedRepro & {
  content: string;
};

export async function createCapsuleFromRuntime(options: CreateCapsuleFromRuntimeOptions): Promise<CreateCapsuleFromRuntimeResult> {
  const repoPath = path.resolve(options.repoPath);
  assertInsideRoot(repoPath, repoPath);

  const probe = await probeRuntime({
    repoPath,
    url: options.url,
    ...(options.bugDescription ? { bugDescription: options.bugDescription } : {}),
    ...(options.interactionHint ? { interactionHint: options.interactionHint } : {})
  });

  if (probe.status === "probe_failed") {
    return {
      status: "runtime_probe_failed",
      repoPath,
      url: options.url,
      message: probe.message ?? "BugCapsule could not probe the runtime URL.",
      probe
    };
  }

  if (probe.status !== "failure_found" || !probe.failure) {
    return {
      status: "no_runtime_failure_found",
      repoPath,
      url: options.url,
      message: "BugCapsule did not find a failing interaction on the page.",
      probe
    };
  }

  const capsuleId = await resolveRuntimeCapsuleId(repoPath, options);
  const generatedRepro = await buildGeneratedRuntimeRepro(repoPath, capsuleId, probe.failure, options);

  if (!generatedRepro) {
    return {
      status: "runtime_repro_unavailable",
      repoPath,
      url: options.url,
      message: "BugCapsule found the runtime failure, but could not derive a self-contained source repro from the captured stack and page data.",
      probe
    };
  }

  const originalReproPath = path.join(repoPath, generatedRepro.path);
  assertInsideRoot(repoPath, originalReproPath);
  await ensureDir(path.dirname(originalReproPath));
  await writeTextFile(originalReproPath, generatedRepro.content);

  const result = await createCapsule({
    repoPath,
    command: generatedRepro.command,
    capsuleId,
    capsuleName: options.capsuleName ?? `Runtime bug: ${options.bugDescription ?? new URL(options.url).pathname}`,
    ...(options.maxFiles ? { maxFiles: options.maxFiles } : {}),
    ...(options.maxDepth ? { maxDepth: options.maxDepth } : {}),
    ...(options.includeGlobs ? { includeGlobs: options.includeGlobs } : {}),
    ...(options.excludeGlobs ? { excludeGlobs: options.excludeGlobs } : {}),
    ...(options.mockPolicy ? { mockPolicy: options.mockPolicy } : {}),
    ...(options.installDependencies === undefined ? {} : { installDependencies: options.installDependencies }),
    ...(options.verifyCapsule === undefined ? {} : { verifyCapsule: options.verifyCapsule }),
    capsuleRunScript: "repro",
    additionalFiles: [
      {
        capsulePath: generatedRepro.path,
        originalPath: generatedRepro.path,
        kind: "runtime_repro",
        content: generatedRepro.content,
        editable: false
      }
    ]
  });

  return {
    ...result,
    probe,
    generatedRepro: {
      path: generatedRepro.path,
      command: generatedRepro.command,
      targetExport: generatedRepro.targetExport,
      inputSource: generatedRepro.inputSource
    }
  };
}

export async function probeRuntime(options: RuntimeProbeOptions): Promise<RuntimeProbeResult> {
  const repoPath = path.resolve(options.repoPath);
  assertInsideRoot(repoPath, repoPath);

  let pageUrl: URL;

  try {
    pageUrl = new URL(options.url);
  } catch {
    return failedProbe(repoPath, options.url, "Runtime URL must be an absolute URL.");
  }

  const attemptedInteractions: RuntimeProbeResult["attemptedInteractions"] = [];
  let pageResponse: Response;
  let pageText: string;

  try {
    pageResponse = await fetch(pageUrl, {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5"
      }
    });
    pageText = await pageResponse.text();
  } catch (error) {
    return failedProbe(repoPath, options.url, `Could not reach ${options.url}: ${errorMessage(error)}`);
  }

  const interactions = extractInteractions(pageText, pageUrl, options);

  for (const interaction of interactions) {
    try {
      const response = await fetch(interaction.url, {
        method: interaction.method,
        headers: {
          accept: "application/json,text/plain;q=0.8,*/*;q=0.5"
        }
      });
      const responseBody = await response.text();
      const failure = parseRuntimeFailure(repoPath, interaction, response.status, responseBody);

      attemptedInteractions.push({
        ...interaction,
        statusCode: response.status,
        outcome: failure ? "failure" : "passed",
        ...(failure ? { message: failure.errorMessage } : {})
      });

      if (failure) {
        return {
          status: "failure_found",
          repoPath,
          url: options.url,
          attemptedInteractions,
          failure,
          relatedFiles: relatedFilesFromStack(failure.stackTrace)
        };
      }
    } catch (error) {
      attemptedInteractions.push({
        ...interaction,
        outcome: "error",
        message: errorMessage(error)
      });
    }
  }

  return {
    status: "no_failure_found",
    repoPath,
    url: options.url,
    attemptedInteractions,
    relatedFiles: [],
    message: "No probed page interactions returned an error response."
  };
}

function extractInteractions(pageText: string, pageUrl: URL, options: RuntimeProbeOptions): RuntimeInteraction[] {
  const tokens = tokenize([options.bugDescription, options.interactionHint, options.url].filter(Boolean).join(" "));
  const interactions = new Map<string, RuntimeInteraction>();
  const fetchPattern = /fetch\(\s*(["'`])(?<url>[^"'`]+)\1\s*(?:,\s*(?<options>\{[\s\S]*?\})\s*)?\)/g;
  let match: RegExpExecArray | null;

  while ((match = fetchPattern.exec(pageText)) !== null) {
    const rawUrl = match.groups?.url;

    if (!rawUrl) {
      continue;
    }

    const absoluteUrl = toSameOriginUrl(rawUrl, pageUrl);

    if (!absoluteUrl) {
      continue;
    }

    const optionsText = match.groups?.options ?? "";
    const method = extractMethod(optionsText);
    const interaction = {
      method,
      url: absoluteUrl.href,
      source: "html_fetch" as const,
      reason: `Discovered fetch(${rawUrl}) in ${pageUrl.href}`
    };
    interactions.set(`${method} ${absoluteUrl.href}`, interaction);
  }

  if (interactions.size === 0) {
    interactions.set(`GET ${pageUrl.href}`, {
      method: "GET",
      url: pageUrl.href,
      source: "page_get",
      reason: "No fetch calls were found; probing the page URL itself."
    });
  }

  return [...interactions.values()]
    .sort((left, right) => scoreInteraction(right, tokens) - scoreInteraction(left, tokens));
}

function parseRuntimeFailure(
  repoPath: string,
  interaction: RuntimeInteraction,
  statusCode: number,
  responseBody: string
): RuntimeFailure | undefined {
  const structured = extractStructuredError(responseBody);

  if (statusCode < 400 && !structured) {
    return undefined;
  }

  const stack = structured?.stack ?? (looksLikeStack(responseBody) ? responseBody : undefined);
  const message = structured?.message ?? responseBody.trim();
  const combined = stack ?? message;
  const stackTrace = parseStackTrace(combined, repoPath);
  const errorMessage = extractFailureSummary(combined);

  return {
    method: interaction.method,
    url: interaction.url,
    statusCode,
    errorMessage,
    ...(stack ? { stack } : {}),
    responseBody: responseBody.slice(0, 12_000),
    stackTrace
  };
}

async function buildGeneratedRuntimeRepro(
  repoPath: string,
  capsuleId: string,
  failure: RuntimeFailure,
  options: CreateCapsuleFromRuntimeOptions
): Promise<GeneratedRuntimeRepro | undefined> {
  const payload = await discoverInputPayload(failure);

  if (payload === undefined) {
    return undefined;
  }

  const target = await selectTargetExport(repoPath, capsuleId, failure, payload.value, [
    options.bugDescription,
    options.interactionHint,
    failure.url
  ].filter(Boolean).join(" "));

  if (!target) {
    return undefined;
  }

  const reproPath = normalizePath(path.join(".bugcapsule", "repros", `${capsuleId}.ts`));
  const importSpecifier = importSpecifierFor(reproPath, target.file);
  const content = renderRuntimeRepro({
    targetName: target.name,
    importSpecifier,
    input: payload.value,
    failure
  });

  return {
    path: reproPath,
    command: `npx tsx ${reproPath}`,
    targetExport: {
      file: target.file,
      name: target.name
    },
    inputSource: payload.source,
    content
  };
}

async function discoverInputPayload(failure: RuntimeFailure): Promise<{ value: unknown; source: string } | undefined> {
  const failedUrl = new URL(failure.url);
  const pathParts = failedUrl.pathname.split("/").filter(Boolean);
  const leaf = pathParts.at(-1);
  const parent = `/${pathParts.slice(0, -1).join("/")}`;

  const candidates = [
    leaf ? `${failedUrl.origin}${parent}/sample-${leaf}` : undefined,
    leaf ? `${failedUrl.origin}${parent}/${leaf}-sample` : undefined,
    `${failedUrl.origin}${failedUrl.pathname.replace(/\/$/, "")}/sample`,
    `${failedUrl.origin}${failedUrl.pathname.replace(/\/$/, "")}/example`
  ].filter((item): item is string => Boolean(item));

  for (const candidate of [...new Set(candidates)]) {
    try {
      const response = await fetch(candidate, {
        method: "GET",
        headers: {
          accept: "application/json"
        }
      });

      if (!response.ok) {
        continue;
      }

      const parsed = parseJson(await response.text());

      if (parsed !== undefined) {
        return {
          value: parsed,
          source: candidate
        };
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

async function selectTargetExport(
  repoPath: string,
  capsuleId: string,
  failure: RuntimeFailure,
  input: unknown,
  hintText: string
): Promise<TargetExport | undefined> {
  const candidates = await findTargetExportCandidates(repoPath, failure.stackTrace, hintText);

  for (const [index, candidate] of candidates.entries()) {
    if (await validatesRuntimeTarget(repoPath, capsuleId, candidate, input, failure, index)) {
      return candidate;
    }
  }

  return candidates.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))[0];
}

async function findTargetExportCandidates(repoPath: string, stackTrace: StackFrame[], hintText: string): Promise<TargetExport[]> {
  const tokens = tokenize(hintText);
  const candidates: TargetExport[] = [];

  for (const [index, frame] of stackTrace.entries()) {
    const absolutePath = path.join(repoPath, frame.file);
    assertInsideRoot(repoPath, absolutePath);

    let content: string;

    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }

    const exportedFunctions = findExportedFunctions(content);
    const frameFunction = normalizeFunctionName(frame.functionName);

    for (const name of exportedFunctions) {
      const exactFrameMatch = frameFunction === name;
      const nearFrameMatch = frameFunction ? frameFunction.includes(name) || name.includes(frameFunction) : false;

      if (frameFunction && !exactFrameMatch && !nearFrameMatch && exportedFunctions.length > 1) {
        continue;
      }

      candidates.push({
        file: frame.file,
        name,
        score: scoreTarget(frame.file, name, tokens, index, exactFrameMatch),
        stackIndex: index
      });
    }
  }

  return candidates.sort((left, right) =>
    left.stackIndex - right.stackIndex ||
    right.score - left.score ||
    left.file.localeCompare(right.file)
  );
}

async function validatesRuntimeTarget(
  repoPath: string,
  capsuleId: string,
  target: TargetExport,
  input: unknown,
  failure: RuntimeFailure,
  index: number
): Promise<boolean> {
  const reproPath = normalizePath(path.join(".bugcapsule", "repros", `${capsuleId}.candidate-${index + 1}.ts`));
  const absolutePath = path.join(repoPath, reproPath);
  assertInsideRoot(repoPath, absolutePath);

  const content = renderRuntimeRepro({
    targetName: target.name,
    importSpecifier: importSpecifierFor(reproPath, target.file),
    input,
    failure
  });

  await ensureDir(path.dirname(absolutePath));
  await writeTextFile(absolutePath, content);

  try {
    const result = await runShellCommand(`npx tsx ${reproPath}`, repoPath);

    if (result.exitCode === 0) {
      return false;
    }

    const summary = extractFailureSummary(`${result.stderr}\n${result.stdout}`);
    return failureSummariesMatch(failure.errorMessage, summary);
  } finally {
    await fs.rm(absolutePath, { force: true });
  }
}

function failureSummariesMatch(expected: string, actual: string): boolean {
  const normalizedExpected = normalizeFailureText(expected);
  const normalizedActual = normalizeFailureText(actual);

  return normalizedExpected.length > 0 &&
    normalizedActual.length > 0 &&
    (normalizedActual.includes(normalizedExpected) || normalizedExpected.includes(normalizedActual));
}

function normalizeFailureText(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function renderRuntimeRepro(options: {
  targetName: string;
  importSpecifier: string;
  input: unknown;
  failure: RuntimeFailure;
}): string {
  return `import { ${options.targetName} } from "${options.importSpecifier}";

const input = ${JSON.stringify(options.input, null, 2)} as const;

try {
  const result = await Promise.resolve(${options.targetName}(input as never));
  console.log(JSON.stringify({ ok: true, result }, null, 2));
} catch (error) {
  if (error instanceof Error) {
    console.error(error.stack ?? \`\${error.name}: \${error.message}\`);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
}
`;
}

function findExportedFunctions(content: string): string[] {
  const names = new Set<string>();
  const pattern = /export\s+(?:async\s+)?function\s+(?<name>[A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const name = match.groups?.name;

    if (name) {
      names.add(name);
    }
  }

  return [...names];
}

function importSpecifierFor(reproPath: string, sourcePath: string): string {
  const reproDir = path.posix.dirname(normalizePath(reproPath));
  const sourceJsPath = normalizePath(sourcePath).replace(/\.[cm]?tsx?$/, ".js");
  const relative = path.posix.relative(reproDir, sourceJsPath);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function extractStructuredError(responseBody: string): { message?: string; stack?: string } | undefined {
  const parsed = parseJson(responseBody);
  const record = asRecord(parsed);
  const error = asRecord(record?.error);

  if (!record && !error) {
    return undefined;
  }

  const message = stringValue(error?.message) ?? stringValue(record?.message) ?? stringValue(record?.error);
  const stack = stringValue(error?.stack) ?? stringValue(record?.stack);

  if (!message && !stack) {
    return undefined;
  }

  return {
    ...(message ? { message } : {}),
    ...(stack ? { stack } : {})
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractMethod(optionsText: string): string {
  return optionsText.match(/method\s*:\s*(["'`])(?<method>[A-Za-z]+)\1/i)?.groups?.method?.toUpperCase() ?? "GET";
}

function toSameOriginUrl(rawUrl: string, pageUrl: URL): URL | undefined {
  try {
    const absoluteUrl = new URL(rawUrl, pageUrl);
    return absoluteUrl.origin === pageUrl.origin ? absoluteUrl : undefined;
  } catch {
    return undefined;
  }
}

function scoreInteraction(interaction: RuntimeInteraction, tokens: Set<string>): number {
  let score = interaction.method === "GET" ? 0 : 1;
  const normalized = `${interaction.url} ${interaction.reason}`.toLowerCase();

  for (const token of tokens) {
    if (normalized.includes(token)) {
      score += 2;
    }
  }

  return score;
}

function scoreTarget(filePath: string, functionName: string, tokens: Set<string>, stackIndex: number, exactFrameMatch: boolean): number {
  let score = exactFrameMatch ? 3 : 1;
  const normalized = `${filePath} ${functionName}`.toLowerCase();

  for (const token of tokens) {
    if (normalized.includes(token)) {
      score += 2;
    }
  }

  if (/(^|\/)(web|pages|routes|server)\//.test(filePath) || /^(handle|render|send)/i.test(functionName)) {
    score -= 4;
  }

  return score + stackIndex * 0.15;
}

function normalizeFunctionName(functionName: string | undefined): string | undefined {
  if (!functionName) {
    return undefined;
  }

  return functionName
    .replace(/^async\s+/, "")
    .split(".")
    .at(-1)
    ?.replace(/[^\w$].*$/, "");
}

function relatedFilesFromStack(stackTrace: StackFrame[]): RuntimeProbeResult["relatedFiles"] {
  const seen = new Set<string>();
  const related = [];

  for (const frame of stackTrace) {
    if (seen.has(frame.file)) {
      continue;
    }

    seen.add(frame.file);
    related.push({
      path: frame.file,
      reason: "Captured from runtime stack trace."
    });
  }

  return related;
}

function looksLikeStack(value: string): boolean {
  return /\n\s*at\s+.*\.(?:c|m)?tsx?:\d+:\d+/.test(value);
}

function tokenize(value: string): Set<string> {
  const ignored = new Set(["the", "and", "for", "with", "when", "that", "this", "from", "doesnt", "doesn", "work", "button", "http", "https", "localhost"]);

  return new Set(value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !ignored.has(token)));
}

async function resolveRuntimeCapsuleId(repoPath: string, options: CreateCapsuleFromRuntimeOptions): Promise<string> {
  if (options.capsuleId) {
    return options.capsuleId;
  }

  const url = new URL(options.url);
  const hint = options.capsuleName ?? options.bugDescription ?? url.pathname.split("/").filter(Boolean).join("-") ?? "runtime";
  const base = `bc_${slugify(hint)}`;
  let candidate = base;
  let index = 2;

  while (await pathExists(capsulePathFor(repoPath, candidate))) {
    candidate = `${base}_${index}`;
    index += 1;
  }

  return candidate;
}

function failedProbe(repoPath: string, url: string, message: string): RuntimeProbeResult {
  return {
    status: "probe_failed",
    repoPath,
    url,
    attemptedInteractions: [],
    relatedFiles: [],
    message
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
