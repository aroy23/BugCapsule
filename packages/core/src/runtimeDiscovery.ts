import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

import { createCapsule } from "./createCapsule.js";
import { ensureDir, pathExists, writeTextFile } from "./fileUtils.js";
import { buildImportGraph } from "./importGraph.js";
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
  input: unknown;
  sliceStackTrace: StackFrame[];
};

type RuntimeLineageFile = {
  path: string;
  exportedFunctions: string[];
};

export async function createCapsuleFromRuntime(options: CreateCapsuleFromRuntimeOptions): Promise<CreateCapsuleFromRuntimeResult> {
  const requestedRepoPath = path.resolve(options.repoPath);
  assertInsideRoot(requestedRepoPath, requestedRepoPath);

  const probe = await probeRuntime({
    repoPath: requestedRepoPath,
    url: options.url,
    ...(options.bugDescription ? { bugDescription: options.bugDescription } : {}),
    ...(options.interactionHint ? { interactionHint: options.interactionHint } : {})
  });

  if (probe.status === "probe_failed") {
    return {
      status: "runtime_probe_failed",
      repoPath: requestedRepoPath,
      url: options.url,
      message: probe.message ?? "BugCapsule could not probe the runtime URL.",
      probe
    };
  }

  if (probe.status !== "failure_found" || !probe.failure) {
    return {
      status: "no_runtime_failure_found",
      repoPath: requestedRepoPath,
      url: options.url,
      message: "BugCapsule did not find a failing interaction on the page.",
      probe
    };
  }

  const hintText = runtimeHintText(options, probe.failure);
  const runtimeRepoPath = await resolveRuntimeRepoPath(requestedRepoPath, probe.failure, hintText);
  const runtimeFailure = rebaseRuntimeFailure(probe.failure, requestedRepoPath, runtimeRepoPath);
  const capsuleId = await resolveRuntimeCapsuleId(runtimeRepoPath, options);
  const generatedRepro = await buildGeneratedRuntimeRepro(runtimeRepoPath, capsuleId, runtimeFailure, hintText);

  if (!generatedRepro) {
    return {
      status: "runtime_repro_unavailable",
      repoPath: runtimeRepoPath,
      url: options.url,
      message: "BugCapsule found the runtime failure, but could not derive a self-contained source repro from the captured stack and page data.",
      probe
    };
  }

  const originalReproPath = path.join(runtimeRepoPath, generatedRepro.path);
  assertInsideRoot(runtimeRepoPath, originalReproPath);
  await ensureDir(path.dirname(originalReproPath));
  await writeTextFile(originalReproPath, generatedRepro.content);

  const result = await createCapsule({
    repoPath: runtimeRepoPath,
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
    inputLineage: {
      requestBoundary: generatedRepro.input,
      requestBoundarySource: generatedRepro.inputSource
    },
    ...(runtimeFailure.stackTrace.length > 0 ? { upstreamStackTrace: runtimeFailure.stackTrace } : {}),
    ...(generatedRepro.sliceStackTrace.length > 0 ? { sliceStackTrace: generatedRepro.sliceStackTrace } : {}),
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
  await cleanupRuntimeReproArtifacts(runtimeRepoPath, generatedRepro.path);

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
  const extractedSummary = extractFailureSummary(combined);
  const errorMessage = extractedSummary === "Command failed without a recognizable error summary." && message
    ? message
    : extractedSummary;

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
  hintText: string
): Promise<GeneratedRuntimeRepro | undefined> {
  const payload = await discoverInputPayload(failure);

  if (payload !== undefined) {
    const target = await selectTargetExport(repoPath, capsuleId, failure, payload.value, hintText);

    if (target) {
      const reproPath = normalizePath(path.join(".bugcapsule", "repros", `${capsuleId}.ts`));
      const importSpecifier = importSpecifierFor(reproPath, target.file);
      const lineageFiles = await collectRuntimeLineageFiles(repoPath, target.file);
      const content = renderRuntimeRepro({
        reproPath,
        targetFile: target.file,
        targetName: target.name,
        importSpecifier,
        input: payload.value,
        failure,
        lineageFiles
      });

      return {
        path: reproPath,
        command: `npx tsx ${reproPath}`,
        targetExport: {
          file: target.file,
          name: target.name
        },
        inputSource: payload.source,
        input: payload.value,
        sliceStackTrace: failure.stackTrace.slice(0, target.stackIndex + 1),
        content
      };
    }
  }

  return buildGeneratedServerInteractionRepro(repoPath, capsuleId, failure, hintText);
}

async function buildGeneratedServerInteractionRepro(
  repoPath: string,
  capsuleId: string,
  failure: RuntimeFailure,
  hintText: string
): Promise<GeneratedRuntimeRepro | undefined> {
  const serverFile = await findRuntimeServerFile(repoPath, failure, hintText);

  if (!serverFile) {
    return undefined;
  }

  const reproPath = normalizePath(path.join(".bugcapsule", "repros", `${capsuleId}.ts`));
  const failedUrl = new URL(failure.url);
  const interactionPath = `${failedUrl.pathname}${failedUrl.search}`;
  const input = {
    method: failure.method,
    path: interactionPath
  };

  return {
    path: reproPath,
    command: `npx tsx ${reproPath}`,
    targetExport: {
      file: serverFile,
      name: "runtimeInteraction"
    },
    inputSource: `runtime interaction ${failure.method} ${interactionPath}`,
    input,
    sliceStackTrace: [],
    content: renderServerInteractionRepro({
      importSpecifier: importSpecifierFor(reproPath, serverFile),
      method: failure.method,
      path: interactionPath,
      port: portForCapsule(capsuleId)
    })
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

async function resolveRuntimeRepoPath(
  repoPath: string,
  failure: RuntimeFailure,
  hintText: string
): Promise<string> {
  const stackRepoPath = await nearestPackageRootFromStack(repoPath, failure.stackTrace);

  if (stackRepoPath) {
    return stackRepoPath;
  }

  return (await findRuntimeServerTarget(repoPath, failure, hintText))?.repoPath ?? repoPath;
}

async function nearestPackageRootFromStack(repoPath: string, stackTrace: StackFrame[]): Promise<string | undefined> {
  for (const frame of stackTrace) {
    const framePath = path.resolve(repoPath, frame.file);

    if (!isInsideRoot(repoPath, framePath)) {
      continue;
    }

    const packageRoot = await nearestPackageRoot(repoPath, framePath);

    if (packageRoot !== repoPath) {
      return packageRoot;
    }
  }

  return undefined;
}

function rebaseRuntimeFailure(
  failure: RuntimeFailure,
  fromRepoPath: string,
  toRepoPath: string
): RuntimeFailure {
  if (fromRepoPath === toRepoPath || failure.stackTrace.length === 0) {
    return failure;
  }

  return {
    ...failure,
    stackTrace: failure.stackTrace.map((frame) => ({
      ...frame,
      file: rebaseRuntimeFrameFile(frame.file, fromRepoPath, toRepoPath)
    }))
  };
}

function rebaseRuntimeFrameFile(filePath: string, fromRepoPath: string, toRepoPath: string): string {
  const absoluteFromOriginalRepo = path.resolve(fromRepoPath, filePath);

  if (isInsideRoot(toRepoPath, absoluteFromOriginalRepo)) {
    return normalizePath(path.relative(toRepoPath, absoluteFromOriginalRepo));
  }

  const absoluteFromRuntimeRepo = path.resolve(toRepoPath, filePath);
  if (isInsideRoot(toRepoPath, absoluteFromRuntimeRepo)) {
    return normalizePath(path.relative(toRepoPath, absoluteFromRuntimeRepo));
  }

  return filePath;
}

async function findRuntimeServerFile(repoPath: string, failure: RuntimeFailure, hintText: string): Promise<string | undefined> {
  return (await findRuntimeServerTarget(repoPath, failure, hintText))?.file;
}

async function findRuntimeServerTarget(
  repoPath: string,
  failure: RuntimeFailure,
  hintText: string
): Promise<{ repoPath: string; file: string; score: number } | undefined> {
  const endpointPath = new URL(failure.url).pathname;
  const files = await fg(["src/**/*.ts", "app/**/*.ts", "server.ts", "*/src/**/*.ts", "*/app/**/*.ts", "*/server.ts"], {
    cwd: repoPath,
    onlyFiles: true,
    dot: true,
    ignore: [
      "node_modules/**",
      "dist/**",
      ".next/**",
      "coverage/**",
      ".git/**",
      ".bugcapsule/**"
    ]
  });
  const tokens = tokenize(`${hintText} ${failure.errorMessage}`);
  const candidates: Array<{ repoPath: string; file: string; score: number }> = [];

  for (const filePath of files.map(normalizePath)) {
    const absolutePath = path.join(repoPath, filePath);
    let content: string;

    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }

    const score = scoreRuntimeServerFile(filePath, content, endpointPath, failure.method, tokens);

    if (score > 0) {
      const packageRoot = await nearestPackageRoot(repoPath, absolutePath);
      candidates.push({
        repoPath: packageRoot,
        file: normalizePath(path.relative(packageRoot, absolutePath)),
        score
      });
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score || left.repoPath.localeCompare(right.repoPath) || left.file.localeCompare(right.file))
    .at(0);
}

function scoreRuntimeServerFile(
  filePath: string,
  content: string,
  endpointPath: string,
  method: string,
  tokens: Set<string>
): number {
  let score = 0;

  if (content.includes(endpointPath)) {
    score += 8;
  }

  if (new RegExp(`method\\s*===\\s*["'\`]${escapeRegExp(method)}["'\`]`, "i").test(content)) {
    score += 2;
  }

  if (/\bcreateServer\b/.test(content)) {
    score += 3;
  }

  if (/\.listen\s*\(/.test(content)) {
    score += 3;
  }

  if (/(^|\/)(web\/server|server)\.ts$/.test(filePath)) {
    score += 3;
  }

  if (/fetch\s*\(/.test(content) && content.includes(endpointPath)) {
    score += 1;
  }

  const normalized = `${filePath} ${content}`.toLowerCase();
  for (const token of tokens) {
    if (normalized.includes(token)) {
      score += 2;
    }
  }

  return score;
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
    reproPath,
    targetFile: target.file,
    targetName: target.name,
    importSpecifier: importSpecifierFor(reproPath, target.file),
    input,
    failure,
    lineageFiles: []
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
    await cleanupRuntimeReproArtifacts(repoPath, reproPath);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderRuntimeRepro(options: {
  reproPath: string;
  targetFile: string;
  targetName: string;
  importSpecifier: string;
  input: unknown;
  failure: RuntimeFailure;
  lineageFiles: RuntimeLineageFile[];
}): string {
  if (options.lineageFiles.length === 0) {
    return renderDirectRuntimeRepro(options);
  }

  return renderLineageRuntimeRepro(options);
}

function renderDirectRuntimeRepro(options: {
  targetName: string;
  importSpecifier: string;
  input: unknown;
}): string {
  return `import { ${options.targetName} } from "${options.importSpecifier}";

const input = ${JSON.stringify(options.input, null, 2)} as const;

try {
  const result = await Promise.resolve(${options.targetName}(input as never));
  assertMeaningfulRuntimeResult(result);
  console.log(JSON.stringify({ ok: true, result }, null, 2));
} catch (error) {
  if (error instanceof Error) {
    console.error(error.stack ?? \`\${error.name}: \${error.message}\`);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
}

function assertMeaningfulRuntimeResult(value: unknown): void {
  const placeholder = findPlaceholderString(value, "result", new Set<object>());

  if (placeholder) {
    throw new Error(\`Runtime repro produced a placeholder value ("\${placeholder.value}") at \${placeholder.path}. This usually means the function was patched to silence a throw rather than fix the underlying cause. Inspect the upstream candidates in the capsule README before patching the failing function.\`);
  }
}

type PlaceholderString = {
  path: string;
  value: string;
};

const PLACEHOLDER_LITERALS = new Set([
  "unknown",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "tbd",
  "placeholder",
  "default",
  "xxx",
  "???",
  "not available",
  "not provided",
  "not set"
]);

function findPlaceholderString(value: unknown, path: string, seen: Set<object>): PlaceholderString | undefined {
  if (typeof value === "string") {
    return isPlaceholderString(value) ? { path, value } : undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findPlaceholderString(item, \`\${path}[\${index}]\`, seen);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  for (const [key, item] of Object.entries(value)) {
    const found = findPlaceholderString(item, \`\${path}.\${key}\`, seen);

    if (found) {
      return found;
    }
  }

  return undefined;
}

function isPlaceholderString(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || !/[A-Za-z0-9]/.test(trimmed) || PLACEHOLDER_LITERALS.has(trimmed.toLowerCase());
}
`;
}

function renderServerInteractionRepro(options: {
  importSpecifier: string;
  method: string;
  path: string;
  port: number;
}): string {
  return `process.env.PORT = ${JSON.stringify(String(options.port))};

const baseUrl = "http://127.0.0.1:" + process.env.PORT;
const interactionPath = ${JSON.stringify(options.path)};

await import(${JSON.stringify(options.importSpecifier)});
await waitForServer(baseUrl);

const response = await fetch(new URL(interactionPath, baseUrl), {
  method: ${JSON.stringify(options.method)},
  headers: {
    accept: "application/json,text/plain;q=0.8,*/*;q=0.5"
  }
});
const body = await response.text();

if (response.status >= 400) {
  console.error(body);
  process.exitCode = 1;
} else {
  console.log(body || JSON.stringify({ ok: true, status: response.status }));
}

setTimeout(() => process.exit(process.exitCode ?? 0), 50);

async function waitForServer(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await fetch(baseUrl);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Runtime server did not start.");
}
`;
}

function portForCapsule(capsuleId: string): number {
  let hash = 0;

  for (const char of capsuleId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return 31_000 + (hash % 20_000);
}

async function collectRuntimeLineageFiles(
  repoPath: string,
  targetFile: string
): Promise<RuntimeLineageFile[]> {
  const graph = await buildImportGraph(repoPath, [targetFile]);
  const filePaths = new Set<string>([
    targetFile,
    ...graph.nodes.keys()
  ]);
  const files: RuntimeLineageFile[] = [];

  for (const filePath of [...filePaths].sort()) {
    const absolutePath = path.join(repoPath, filePath);
    let content: string;

    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }

    files.push({
      path: filePath,
      exportedFunctions: findExportedFunctions(content)
    });
  }

  return files;
}

async function cleanupRuntimeReproArtifacts(repoPath: string, reproPath: string): Promise<void> {
  const baseName = path.basename(reproPath, path.extname(reproPath));
  const directory = path.dirname(path.join(repoPath, reproPath));

  await Promise.all([
    fs.rm(path.join(directory, `${baseName}.lineage`), { recursive: true, force: true }),
    fs.rm(path.join(directory, `${baseName}.lineage.json`), { force: true })
  ]);
}

function renderLineageRuntimeRepro(options: {
  reproPath: string;
  targetFile: string;
  targetName: string;
  input: unknown;
  failure: RuntimeFailure;
  lineageFiles: RuntimeLineageFile[];
}): string {
  return `import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type LineageFile = {
  path: string;
  exportedFunctions: string[];
};

type LineageEntry = {
  file: string;
  functionName: string;
  firstArg: unknown;
};

const TARGET_FILE = ${JSON.stringify(options.targetFile)};
const TARGET_EXPORT = ${JSON.stringify(options.targetName)};
const SOURCE_FILES = ${JSON.stringify(options.lineageFiles, null, 2)} satisfies LineageFile[];
const SOURCE_FILE_SET = new Set(SOURCE_FILES.map((file) => file.path));
const input = ${JSON.stringify(options.input, null, 2)} as const;
const reproFilePath = fileURLToPath(import.meta.url);
const reproDirectory = path.dirname(reproFilePath);
const reproBaseName = path.basename(reproFilePath, path.extname(reproFilePath));
const lineageRoot = path.join(reproDirectory, \`\${reproBaseName}.lineage\`);
const lineageOutputPath = path.join(reproDirectory, \`\${reproBaseName}.lineage.json\`);

const lineage = await prepareLineageModules();
lineage.recorder.__bugcapsule_setRequestBoundary(input);

try {
  const result = await Promise.resolve(lineage.target(input as never));
  assertMeaningfulRuntimeResult(result);
  console.log(JSON.stringify({ ok: true, result }, null, 2));
} catch (error) {
  await writeLineageTape(lineage.recorder, error);
  printLineageSummary(lineage.recorder.__bugcapsule_getLineage(), lineageOutputPath);

  if (error instanceof Error) {
    console.error(error.stack ?? \`\${error.name}: \${error.message}\`);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
}

async function prepareLineageModules(): Promise<{
  recorder: {
    __bugcapsule_setRequestBoundary(value: unknown): void;
    __bugcapsule_getLineage(): { requestBoundary: unknown; tape: LineageEntry[] };
  };
  target: (...args: unknown[]) => unknown;
}> {
  await fs.rm(lineageRoot, { recursive: true, force: true });
  await fs.mkdir(lineageRoot, { recursive: true });

  const recorderPath = path.join(lineageRoot, "modules", "__bugcapsule_recorder.ts");
  await fs.mkdir(path.dirname(recorderPath), { recursive: true });
  await fs.writeFile(recorderPath, recorderModuleSource(), "utf8");

  for (const sourceFile of SOURCE_FILES) {
    const sourcePath = path.resolve(sourceFile.path);
    const targetPath = lineageModulePath(sourceFile.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const original = await fs.readFile(sourcePath, "utf8");
    const transformed = transformSourceModule(sourceFile, original, recorderPath);
    await fs.writeFile(targetPath, transformed, "utf8");
  }

  const recorder = await import(pathToFileURL(recorderPath).href);
  const targetModule = await import(pathToFileURL(lineageModulePath(TARGET_FILE)).href);
  const target = targetModule[TARGET_EXPORT];

  if (typeof target !== "function") {
    throw new Error(\`Runtime lineage could not find export \${TARGET_EXPORT} in \${TARGET_FILE}.\`);
  }

  return {
    recorder,
    target
  };
}

function transformSourceModule(sourceFile: LineageFile, content: string, recorderPath: string): string {
  const wrapped = new Set<string>();
  let transformed = rewriteLocalImports(sourceFile.path, content);

  transformed = transformed.replace(/export\\s+(async\\s+)?function\\s+([A-Za-z_$][\\w$]*)\\s*\\(/g, (match, asyncKeyword: string | undefined, name: string) => {
    if (!sourceFile.exportedFunctions.includes(name)) {
      return match;
    }

    wrapped.add(name);
    return \`\${asyncKeyword ?? ""}function __bugcapsule_original_\${name}(\`;
  });

  if (wrapped.size === 0) {
    return transformed;
  }

  const recorderImport = relativeImportSpecifier(sourceFile.path, sourcePathFromAbsoluteRecorder(recorderPath));
  const wrappers = [...wrapped]
    .map((name) => \`export const \${name} = __bugcapsule_wrap(\${JSON.stringify(sourceFile.path)}, \${JSON.stringify(name)}, __bugcapsule_original_\${name});\`)
    .join("\\n");

  return \`import { __bugcapsule_wrap } from "\${recorderImport}";\\n\${transformed}\\n\${wrappers}\\n\`;
}

function rewriteLocalImports(fromFile: string, content: string): string {
  return content.replace(/(from\\s*["'])(\\.[^"']+)(["'])/g, (_match, prefix: string, specifier: string, suffix: string) => {
    const resolved = resolveSourceImport(fromFile, specifier);
    return resolved ? \`\${prefix}\${relativeImportSpecifier(fromFile, resolved)}\${suffix}\` : \`\${prefix}\${specifier}\${suffix}\`;
  }).replace(/(import\\s*\\(\\s*["'])(\\.[^"']+)(["']\\s*\\))/g, (_match, prefix: string, specifier: string, suffix: string) => {
    const resolved = resolveSourceImport(fromFile, specifier);
    return resolved ? \`\${prefix}\${relativeImportSpecifier(fromFile, resolved)}\${suffix}\` : \`\${prefix}\${specifier}\${suffix}\`;
  });
}

function resolveSourceImport(fromFile: string, specifier: string): string | undefined {
  const fromDirectory = path.posix.dirname(fromFile);
  const rawTarget = path.posix.normalize(path.posix.join(fromDirectory, specifier));
  const withoutJsExtension = rawTarget.replace(/\\.[cm]?js$/, "");
  const candidates = [
    rawTarget,
    withoutJsExtension,
    \`\${withoutJsExtension}.ts\`,
    \`\${withoutJsExtension}.tsx\`,
    \`\${withoutJsExtension}.mts\`,
    \`\${withoutJsExtension}.cts\`,
    path.posix.join(withoutJsExtension, "index.ts"),
    path.posix.join(withoutJsExtension, "index.tsx")
  ];

  return candidates.find((candidate) => SOURCE_FILE_SET.has(candidate));
}

function relativeImportSpecifier(fromFile: string, toFile: string): string {
  let relative = path.posix.relative(path.posix.dirname(fromFile), toFile);

  if (!relative.startsWith(".")) {
    relative = \`./\${relative}\`;
  }

  return relative.replace(/\\.[cm]?tsx?$/, ".js");
}

function sourcePathFromAbsoluteRecorder(_recorderPath: string): string {
  return "__bugcapsule_recorder.ts";
}

function lineageModulePath(sourceFile: string): string {
  return path.join(lineageRoot, "modules", sourceFile);
}

function recorderModuleSource(): string {
  return \`type LineageEntry = {
  file: string;
  functionName: string;
  firstArg: unknown;
};

let requestBoundary: unknown;
const tape: LineageEntry[] = [];

export function __bugcapsule_setRequestBoundary(value: unknown): void {
  requestBoundary = cloneForLineage(value);
}

export function __bugcapsule_getLineage(): { requestBoundary: unknown; tape: LineageEntry[] } {
  return {
    requestBoundary,
    tape: tape.map((entry) => ({ ...entry, firstArg: cloneForLineage(entry.firstArg) }))
  };
}

export function __bugcapsule_wrap<T extends (...args: any[]) => any>(file: string, functionName: string, fn: T): T {
  return new Proxy(fn, {
    apply(target, thisArg, args) {
      tape.push({
        file,
        functionName,
        firstArg: cloneForLineage(args[0])
      });
      return Reflect.apply(target, thisArg, args);
    }
  }) as T;
}

function cloneForLineage(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
\`;
}

async function writeLineageTape(
  recorder: { __bugcapsule_getLineage(): { requestBoundary: unknown; tape: LineageEntry[] } },
  error: unknown
): Promise<void> {
  const lineage = recorder.__bugcapsule_getLineage();
  await fs.writeFile(lineageOutputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    error: serializeError(error),
    requestBoundary: lineage.requestBoundary,
    tape: lineage.tape
  }, null, 2), "utf8");
}

function printLineageSummary(
  lineage: { requestBoundary: unknown; tape: LineageEntry[] },
  outputPath: string
): void {
  console.error("");
  console.error("Input lineage:");
  console.error(\`  Request boundary: \${summarizeValue(lineage.requestBoundary)}\`);

  for (const entry of lineage.tape) {
    console.error(\`  After \${entry.functionName} (\${entry.file}): firstArg = \${summarizeValue(entry.firstArg)}\`);
  }

  const finalEntry = lineage.tape.at(-1);

  if (finalEntry) {
    const boundaryMatch = findBoundaryValue(lineage.requestBoundary, finalEntry.firstArg, finalEntry.functionName);

    if (boundaryMatch) {
      console.error("");
      console.error("Boundary-vs-failure diff:");
      console.error(\`  Request boundary: \${boundaryMatch.path} = \${summarizeValue(boundaryMatch.value)}\`);
      console.error(\`  At failure site: \${finalEntry.functionName} firstArg = \${summarizeValue(finalEntry.firstArg)}\`);
      console.error(boundaryValuesEqual(boundaryMatch.value, finalEntry.firstArg)
        ? "  Difference: value reached the failure site unchanged."
        : "  Difference: value changed before it reached the failure site.");
    }
  }

  console.error(\`  Lineage tape: \${path.relative(process.cwd(), outputPath)}\`);
  console.error("");
}

function findBoundaryValue(root: unknown, failureValue: unknown, functionName: string): { path: string; value: unknown } | undefined {
  const exact = findMatchingValue(root, failureValue, "$", new Set<object>());

  if (exact) {
    return exact;
  }

  return findLikelyMalformedBoundaryValue(root, functionName);
}

function findMatchingValue(root: unknown, needle: unknown, currentPath: string, seen: Set<object>): { path: string; value: unknown } | undefined {
  if (boundaryValuesEqual(root, needle)) {
    return {
      path: currentPath,
      value: root
    };
  }

  if (!root || typeof root !== "object") {
    return undefined;
  }

  if (seen.has(root)) {
    return undefined;
  }

  seen.add(root);

  if (Array.isArray(root)) {
    for (const [index, item] of root.entries()) {
      const found = findMatchingValue(item, needle, \`\${currentPath}[\${index}]\`, seen);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  for (const [key, value] of Object.entries(root)) {
    const found = findMatchingValue(value, needle, currentPath === "$" ? key : \`\${currentPath}.\${key}\`, seen);

    if (found) {
      return found;
    }
  }

  return undefined;
}

function findLikelyMalformedBoundaryValue(root: unknown, functionName: string): { path: string; value: unknown } | undefined {
  const tokens = functionName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  const candidates: Array<{ path: string; value: unknown; score: number }> = [];

  collectMalformedBoundaryValues(root, "$", tokens, candidates, new Set<object>());
  return candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))[0];
}

function collectMalformedBoundaryValues(
  value: unknown,
  currentPath: string,
  tokens: string[],
  candidates: Array<{ path: string; value: unknown; score: number }>,
  seen: Set<object>
): void {
  if (isMalformedBoundaryValue(value)) {
    const normalizedPath = currentPath.toLowerCase();
    const score = tokens.reduce((sum, token) => sum + (normalizedPath.includes(token) ? 2 : 0), 0);
    candidates.push({
      path: currentPath,
      value,
      score
    });
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectMalformedBoundaryValues(item, \`\${currentPath}[\${index}]\`, tokens, candidates, seen);
    }
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    collectMalformedBoundaryValues(item, currentPath === "$" ? key : \`\${currentPath}.\${key}\`, tokens, candidates, seen);
  }
}

function isMalformedBoundaryValue(value: unknown): boolean {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim().length === 0;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value).length === 0;
  }

  return false;
}

function boundaryValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summarizeValue(value: unknown): string {
  const rendered = JSON.stringify(value);
  if (rendered === undefined) {
    return String(value);
  }
  return rendered.length > 220 ? \`\${rendered.slice(0, 217)}...\` : rendered;
}

function serializeError(error: unknown): { name?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {})
    };
  }

  return {
    message: String(error)
  };
}

function assertMeaningfulRuntimeResult(value: unknown): void {
  const placeholder = findPlaceholderString(value, "result", new Set<object>());

  if (placeholder) {
    throw new Error(\`Runtime repro produced a placeholder value ("\${placeholder.value}") at \${placeholder.path}. This usually means the function was patched to silence a throw rather than fix the underlying cause. Inspect the upstream candidates in the capsule README before patching the failing function.\`);
  }
}

type PlaceholderString = {
  path: string;
  value: string;
};

const PLACEHOLDER_LITERALS = new Set([
  "unknown",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "tbd",
  "placeholder",
  "default",
  "xxx",
  "???",
  "not available",
  "not provided",
  "not set"
]);

function findPlaceholderString(value: unknown, path: string, seen: Set<object>): PlaceholderString | undefined {
  if (typeof value === "string") {
    return isPlaceholderString(value) ? { path, value } : undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findPlaceholderString(item, \`\${path}[\${index}]\`, seen);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  for (const [key, item] of Object.entries(value)) {
    const found = findPlaceholderString(item, \`\${path}.\${key}\`, seen);

    if (found) {
      return found;
    }
  }

  return undefined;
}

function isPlaceholderString(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || !/[A-Za-z0-9]/.test(trimmed) || PLACEHOLDER_LITERALS.has(trimmed.toLowerCase());
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

function runtimeHintText(options: CreateCapsuleFromRuntimeOptions, failure: RuntimeFailure): string {
  return [
    options.bugDescription,
    options.interactionHint,
    failure.url,
    failure.errorMessage
  ].filter(Boolean).join(" ");
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

async function nearestPackageRoot(repoPath: string, filePath: string): Promise<string> {
  let current = path.dirname(filePath);
  const root = path.resolve(repoPath);

  while (isInsideRoot(root, current)) {
    if (await pathExists(path.join(current, "package.json"))) {
      return current;
    }

    if (current === root) {
      break;
    }

    current = path.dirname(current);
  }

  return root;
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
