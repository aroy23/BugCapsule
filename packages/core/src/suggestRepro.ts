import path from "node:path";
import fg from "fast-glob";

import { defaultConfig } from "./config.js";
import { listProjectFiles, readJsonFile } from "./fileUtils.js";
import { normalizePath } from "./pathUtils.js";
import type { ReproCandidate, SuggestReproOptions, SuggestReproResult } from "./types.js";

type PackageJson = {
  scripts?: Record<string, string>;
};

type ScoredFile = {
  path: string;
  score: number;
  reason: string;
};

export async function suggestRepro(options: SuggestReproOptions): Promise<SuggestReproResult> {
  const repoPath = path.resolve(options.repoPath);
  const packageJson = await readJsonFile<PackageJson>(path.join(repoPath, "package.json"));
  const tokens = tokenize([
    options.bugDescription,
    options.url,
    options.errorText
  ].filter(Boolean).join(" "));
  const relatedFiles = await findRelatedFiles(repoPath, tokens);
  const candidates = rankCandidates([
    ...runtimeProbeCandidates(options),
    ...(await testCandidates(repoPath, packageJson, tokens)),
    ...packageScriptCandidates(packageJson, tokens),
    ...devServerCandidates(packageJson, options)
  ]);
  const status = candidates.some((candidate) => candidate.canCreateCapsule) ? "ready" : "needs_repro";

  return {
    status,
    repoPath,
    ...(options.bugDescription ? { bugDescription: options.bugDescription } : {}),
    ...(options.url ? { url: options.url } : {}),
    candidates,
    relatedFiles,
    agentWorkflow: buildWorkflow(status, candidates, relatedFiles, options)
  };
}

function runtimeProbeCandidates(options: SuggestReproOptions): ReproCandidate[] {
  if (!options.url) {
    return [];
  }

  return [
    {
      command: `MCP tool: bugcapsule_create_from_runtime`,
      kind: "runtime_probe",
      confidence: 0.82,
      reason: "A runtime URL was provided, so BugCapsule can probe page interactions and generate a capsule without a pre-existing test command.",
      canCreateCapsule: true,
      nextAction: "Call bugcapsule_create_from_runtime with the URL and bug description."
    }
  ];
}

async function testCandidates(
  repoPath: string,
  packageJson: PackageJson,
  tokens: Set<string>
): Promise<ReproCandidate[]> {
  if (!packageJson.scripts?.test) {
    return [];
  }

  const tests = await fg(["tests/**/*.test.ts", "test/**/*.test.ts", "src/**/*.test.ts", "**/*.spec.ts"], {
    cwd: repoPath,
    onlyFiles: true,
    dot: true,
    ignore: defaultConfig.slicing.forceExclude
  });

  return tests.map((testPath) => {
    const normalized = normalizePath(testPath);
    const score = scoreText(normalized, tokens);
    const filter = path.basename(normalized)
      .replace(/\.(?:test|spec)\.[cm]?tsx?$/, "")
      .replace(/\.[cm]?tsx?$/, "");

    return {
      command: `npm test -- ${filter}`,
      kind: "test" as const,
      confidence: confidence(score, tokens, 0.68),
      reason: score > 0
        ? `Test file name matches bug terms: ${normalized}`
        : `Existing test can be tried as a repro: ${normalized}`,
      canCreateCapsule: true,
      nextAction: "Run this command to confirm it fails with the observed bug, then call the MCP tool bugcapsule_create_from_command with it."
    };
  });
}

function packageScriptCandidates(packageJson: PackageJson, tokens: Set<string>): ReproCandidate[] {
  return Object.entries(packageJson.scripts ?? {})
    .filter(([name]) => name !== "test")
    .filter(([name, command]) => /repro|test|spec|e2e|integration|check/i.test(`${name} ${command}`))
    .map(([name, command]) => {
      const score = scoreText(`${name} ${command}`, tokens);
      const kind: ReproCandidate["kind"] = /repro/i.test(name) ? "runtime_script" : "package_script";

      return {
        command: `npm run ${name}`,
        kind,
        confidence: confidence(score, tokens, kind === "runtime_script" ? 0.55 : 0.44),
        reason: /repro/i.test(name)
          ? `Package script is explicitly named as a repro: ${name}`
          : `Package script may exercise the bug path: ${name}`,
        canCreateCapsule: true,
        nextAction: "Run this command to confirm it fails with the observed bug, then call the MCP tool bugcapsule_create_from_command with it."
      };
    });
}

function devServerCandidates(packageJson: PackageJson, options: SuggestReproOptions): ReproCandidate[] {
  return Object.entries(packageJson.scripts ?? {})
    .filter(([name]) => /^(dev|start|serve)$/.test(name))
    .map(([name]) => ({
      command: `npm run ${name}`,
      kind: "dev_server" as const,
      confidence: options.url ? 0.5 : 0.28,
      reason: options.url
        ? `Use this to run the app while reproducing ${options.url}.`
        : "Use this to run the app while reproducing the bug in a browser.",
      canCreateCapsule: false,
      nextAction: "Start the app, reproduce the bug in the browser, capture the error text/stack, then call bugcapsule_create_from_runtime if a local URL is available or identify a failing command."
    }));
}

async function findRelatedFiles(repoPath: string, tokens: Set<string>): Promise<ScoredFile[]> {
  const files = await listProjectFiles(repoPath);

  return files
    .filter((file) => /\.(?:c|m)?tsx?$/.test(file))
    .map((file) => ({
      path: file,
      score: scoreText(file, tokens),
      reason: "Path matches bug description terms."
    }))
    .filter((file) => file.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 12);
}

function buildWorkflow(
  status: SuggestReproResult["status"],
  candidates: ReproCandidate[],
  relatedFiles: ScoredFile[],
  options: SuggestReproOptions
): SuggestReproResult["agentWorkflow"] {
  if (status === "ready") {
    const best = candidates.find((candidate) => candidate.canCreateCapsule);
    const runtimeProbe = candidates.find((candidate) => candidate.kind === "runtime_probe");

    if (runtimeProbe && options.url) {
      return [
        {
          step: 1,
          action: "probe_runtime",
          detail: "Call bugcapsule_create_from_runtime with the repo path, URL, and broad user-visible symptom."
        },
        {
          step: 2,
          action: "fix_capsule",
          detail: "Open the returned capsulePath, run the returned capsule runCommand, and fix only mapped capsule files."
        },
        {
          step: 3,
          action: "apply_back",
          detail: "Call bugcapsule_fix_step with action='apply_patch' after the capsule passes."
        }
      ];
    }

    return [
      {
        step: 1,
        action: "try_candidate_command",
        detail: `Run the highest-confidence candidate: ${best?.command ?? "no command found"}`
      },
      {
        step: 2,
        action: "confirm_failure",
        detail: "Confirm it fails with the same user-visible bug or stack trace."
      },
      {
        step: 3,
        action: "create_capsule",
        detail: "Call the MCP tool bugcapsule_create_from_command with the confirmed failing command."
      },
      {
        step: 4,
        action: "fix_capsule",
        detail: "Follow the agentWorkflow returned by bugcapsule_create_from_command."
      }
    ];
  }

  return [
    {
      step: 1,
      action: "run_app",
      detail: candidates.find((candidate) => candidate.kind === "dev_server")?.command ?? "Start the app using its dev/start script."
    },
    {
      step: 2,
      action: "reproduce_in_browser",
      detail: options.url
        ? `Open ${options.url}, reproduce the user-visible bug, and capture the runtime error.`
        : "Open the affected page, reproduce the user-visible bug, and capture the runtime error."
    },
    {
      step: 3,
        action: "create_repro_command",
        detail: relatedFiles.length > 0
        ? `Use the related files as starting points: ${relatedFiles.map((file) => file.path).join(", ")}`
        : "Add a small failing test or scripts/reproduce-<bug>.ts that triggers the same runtime error."
    },
    {
      step: 4,
      action: "create_capsule",
      detail: "Once that repro command fails, call the MCP tool bugcapsule_create_from_command with it."
    }
  ];
}

function rankCandidates(candidates: ReproCandidate[]): ReproCandidate[] {
  return candidates
    .sort((left, right) => right.confidence - left.confidence || Number(right.canCreateCapsule) - Number(left.canCreateCapsule))
    .slice(0, 8);
}

function tokenize(value: string): Set<string> {
  const ignored = new Set([
    "the",
    "and",
    "for",
    "with",
    "when",
    "that",
    "this",
    "from",
    "error",
    "bug",
    "page",
    "click",
    "button"
  ]);

  return new Set(value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !ignored.has(token)));
}

function scoreText(value: string, tokens: Set<string>): number {
  const normalized = value.toLowerCase();
  let score = 0;

  for (const token of tokens) {
    if (normalized.includes(token)) {
      score += 1;
    }
  }

  return score;
}

function confidence(score: number, tokens: Set<string>, base: number): number {
  if (tokens.size === 0) {
    return Number(base.toFixed(2));
  }

  return Number(Math.min(0.96, base + score / Math.max(tokens.size, 1) * 0.42).toFixed(2));
}
