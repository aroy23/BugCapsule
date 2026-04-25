#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoRoot = path.join(rootDir, ".tmp", "visual-demo");
const workDir = path.join(demoRoot, "acme-saas");
const capsuleId = "bc_visual_invoice";
const cliPath = path.join(rootDir, "packages", "cli", "dist", "cli.js");
const capsulePath = path.join(workDir, ".bugcapsule", "capsules", capsuleId);
const reportPath = path.join(demoRoot, "report.html");
const reportJsonPath = path.join(demoRoot, "report.json");

const fixTarget = `  const presentAddress = address as Address;
  return \`\${presentAddress.line1}, \${presentAddress.city}, \${presentAddress.country}\`;`;
const fixReplacement = `  if (!address) {
    return "";
  }

  return \`\${address.line1}, \${address.city}, \${address.country}\`;`;

const steps = [];

await main();

async function main() {
  await fs.rm(demoRoot, { recursive: true, force: true });
  await fs.mkdir(demoRoot, { recursive: true });

  await commandStep({
    title: "Build local BugCapsule packages",
    description: "Compile the SDK, skill package, and CLI used by the demo.",
    command: "npm run build --workspace @bugcapsule/core && npm run build --workspace @bugcapsule/skill && npm run build --workspace @bugcapsule/cli",
    cwd: rootDir,
    expected: "pass"
  });

  await prepareWorkspace();

  const originalFiles = await listFiles(workDir, {
    includeBugCapsule: false
  });

  await commandStep({
    title: "Run the original failing repro",
    description: "The full demo repo fails when a customer has no billing address.",
    command: "npm test -- export-missing-address",
    cwd: workDir,
    expected: "fail"
  });

  await commandStep({
    title: "Create a tiny BugCapsule",
    description: "BugCapsule captures the failure, slices imports, generates a manifest, and mocks Redis.",
    command: `node "${cliPath}" create --id ${capsuleId} --no-install -- npm test -- export-missing-address`,
    cwd: workDir,
    expected: "pass"
  });

  const manifest = JSON.parse(await fs.readFile(path.join(capsulePath, "capsule.json"), "utf8"));
  const capsuleFiles = await listFiles(capsulePath, {
    includeBugCapsule: true
  });

  await commandStep({
    title: "Replay the failure inside the capsule",
    description: "The tiny capsule reproduces the same TypeError without the rest of the repo.",
    command: "npm test",
    cwd: capsulePath,
    expected: "fail"
  });

  const fixStep = await editCapsuleFix();
  steps.push(fixStep);

  await commandStep({
    title: "Verify the fixed capsule",
    description: "The agent-sized reproduction now passes before touching the original repo.",
    command: "npm test",
    cwd: capsulePath,
    expected: "pass"
  });

  await commandStep({
    title: "Apply the capsule patch back",
    description: "BugCapsule copies only changed mapped files back and verifies both repro commands.",
    command: `node "${cliPath}" apply ${capsuleId} --verify --allow-dirty`,
    cwd: workDir,
    expected: "pass"
  });

  const patchPath = path.join(workDir, ".bugcapsule", "patches", `${capsuleId}.patch`);
  const patch = await fs.readFile(patchPath, "utf8");
  const fixedSource = await fs.readFile(path.join(workDir, "src", "billing", "customerAddress.ts"), "utf8");
  const report = {
    generatedAt: new Date().toISOString(),
    rootDir,
    workDir,
    capsulePath,
    capsuleId,
    reportPath,
    metrics: {
      originalFiles: originalFiles.length,
      capsuleFiles: capsuleFiles.length,
      contextReductionPercent: manifest.metrics.contextReductionPercent,
      mocks: manifest.mocks.map((mock) => mock.moduleName)
    },
    originalFiles,
    capsuleFiles,
    manifest,
    steps,
    patch,
    fixedSource
  };

  await fs.writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(reportPath, renderHtml(report));

  console.log("\nVisual demo complete.");
  console.log(`Report: ${reportPath}`);
  console.log(`Workdir: ${workDir}`);
  console.log(`Capsule: ${capsulePath}`);
}

async function prepareWorkspace() {
  await fs.mkdir(path.dirname(workDir), { recursive: true });
  await fs.cp(path.join(rootDir, "examples", "acme-saas"), workDir, {
    recursive: true,
    filter: (source) =>
      !source.includes(`${path.sep}.bugcapsule`) &&
      !source.includes(`${path.sep}dist`) &&
      !source.includes(`${path.sep}node_modules`)
  });

  steps.push({
    title: "Prepare isolated demo workspace",
    description: "Copy examples/acme-saas into .tmp so the visual demo never mutates the source fixture.",
    command: "copy examples/acme-saas → .tmp/visual-demo/acme-saas",
    cwd: rootDir,
    expected: "pass",
    exitCode: 0,
    status: "passed",
    durationMs: 0,
    stdout: `Workspace ready at ${workDir}`,
    stderr: ""
  });
}

async function editCapsuleFix() {
  const startedAt = Date.now();
  const filePath = path.join(capsulePath, "src", "billing", "customerAddress.ts");
  const before = await fs.readFile(filePath, "utf8");

  if (!before.includes(fixTarget)) {
    throw new Error(`Could not find expected buggy source in ${filePath}`);
  }

  const after = before.replace(fixTarget, fixReplacement);
  await fs.writeFile(filePath, after);

  return {
    title: "Fix the bug in the tiny capsule",
    description: "The simulated agent adds the null guard only inside the capsule.",
    command: "edit src/billing/customerAddress.ts",
    cwd: capsulePath,
    expected: "pass",
    exitCode: 0,
    status: "passed",
    durationMs: Date.now() - startedAt,
    stdout: "Added a null-address guard to the capsule source file.",
    stderr: "",
    before,
    after
  };
}

async function commandStep({ title, description, command, cwd, expected }) {
  const startedAt = Date.now();
  const result = await runShell(command, cwd);
  const status = expected === "fail"
    ? result.exitCode === 0 ? "unexpected-pass" : "expected-failure"
    : result.exitCode === 0 ? "passed" : "failed";
  const step = {
    title,
    description,
    command,
    cwd,
    expected,
    exitCode: result.exitCode,
    status,
    durationMs: Date.now() - startedAt,
    stdout: result.stdout,
    stderr: result.stderr
  };

  steps.push(step);

  if (status === "failed" || status === "unexpected-pass") {
    await fs.writeFile(reportPath, renderHtml({
      generatedAt: new Date().toISOString(),
      rootDir,
      workDir,
      capsulePath,
      capsuleId,
      reportPath,
      metrics: {
        originalFiles: 0,
        capsuleFiles: 0,
        contextReductionPercent: 0,
        mocks: []
      },
      originalFiles: [],
      capsuleFiles: [],
      manifest: undefined,
      steps,
      patch: "",
      fixedSource: ""
    }));
    throw new Error(`Visual demo step failed: ${title}`);
  }

  return step;
}

function runShell(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr
      });
    });
  });
}

async function listFiles(directory, options) {
  const files = [];

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(directory, absolutePath).split(path.sep).join("/");

      if (shouldSkip(relativePath, entry, options)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  await walk(directory);
  return files.sort();
}

function shouldSkip(relativePath, entry, options) {
  if (!options.includeBugCapsule && relativePath.startsWith(".bugcapsule/")) {
    return true;
  }

  return entry.name === "node_modules" || entry.name === "dist" || entry.name === ".DS_Store";
}

function renderHtml(report) {
  const success = report.steps.every((step) => step.status === "passed" || step.status === "expected-failure");
  const flowItems = [
    ["Full repo", `${report.metrics.originalFiles} files`],
    ["Capsule", `${report.metrics.capsuleFiles} files`],
    ["Failing test", "reproduced"],
    ["Capsule fix", "passing"],
    ["Apply back", success ? "verified" : "check report"]
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BugCapsule Visual Demo</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17202a;
      --muted: #52606d;
      --line: #d8dee8;
      --panel: #ffffff;
      --bg: #f6f8fb;
      --green: #13795b;
      --red: #b42318;
      --amber: #9a6700;
      --blue: #195bc2;
      --code: #111827;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }

    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px;
    }

    header {
      display: grid;
      gap: 18px;
      margin-bottom: 24px;
    }

    h1, h2, h3 {
      margin: 0;
      letter-spacing: 0;
    }

    h1 {
      font-size: 34px;
      line-height: 1.1;
    }

    h2 {
      font-size: 20px;
      margin-bottom: 12px;
    }

    h3 {
      font-size: 15px;
    }

    .subtle {
      color: var(--muted);
      margin: 0;
    }

    .status {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 11px;
      background: var(--panel);
      font-weight: 700;
      font-size: 13px;
    }

    .status.ok {
      color: var(--green);
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }

    .metric, .section, .step, .flow-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .metric {
      padding: 16px;
    }

    .metric strong {
      display: block;
      font-size: 28px;
      line-height: 1.1;
    }

    .metric span {
      display: block;
      color: var(--muted);
      margin-top: 6px;
      font-size: 13px;
    }

    .flow {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
      align-items: stretch;
    }

    .flow-card {
      position: relative;
      padding: 14px;
      min-height: 82px;
    }

    .flow-card:not(:last-child)::after {
      content: "→";
      position: absolute;
      right: -14px;
      top: 26px;
      color: var(--blue);
      font-weight: 800;
      z-index: 2;
    }

    .flow-card span {
      display: block;
      color: var(--muted);
      margin-top: 5px;
      font-size: 13px;
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }

    .section {
      padding: 18px;
      margin-top: 16px;
    }

    .file-list {
      display: grid;
      gap: 4px;
      max-height: 270px;
      overflow: auto;
      padding-right: 4px;
    }

    .file-list code {
      color: var(--code);
      background: #eef2f7;
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .steps {
      display: grid;
      gap: 12px;
    }

    .step {
      overflow: hidden;
    }

    .step-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
    }

    .step-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .badge {
      display: inline-flex;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 3px 8px;
      font-weight: 700;
      font-size: 12px;
      white-space: nowrap;
      height: fit-content;
    }

    .badge.passed {
      color: var(--green);
      border-color: #9ed7c2;
      background: #eefbf5;
    }

    .badge.expected-failure {
      color: var(--amber);
      border-color: #f0d58c;
      background: #fff8e6;
    }

    .badge.failed, .badge.unexpected-pass {
      color: var(--red);
      border-color: #f4b7ad;
      background: #fff1ef;
    }

    details {
      padding: 12px 16px 16px;
    }

    summary {
      cursor: pointer;
      color: var(--blue);
      font-weight: 700;
      margin-bottom: 10px;
    }

    pre {
      margin: 0;
      overflow: auto;
      border-radius: 8px;
      background: #111827;
      color: #f9fafb;
      padding: 14px;
      font-size: 12px;
      line-height: 1.5;
      max-height: 420px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .code-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }

    @media (max-width: 860px) {
      main {
        padding: 18px;
      }

      .metrics, .flow, .grid, .code-grid {
        grid-template-columns: 1fr;
      }

      .flow-card:not(:last-child)::after {
        content: "↓";
        right: 16px;
        top: auto;
        bottom: -18px;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>BugCapsule Visual Demo</h1>
        <p class="subtle">Generated ${escapeHtml(new Date(report.generatedAt).toLocaleString())}</p>
      </div>
      <span class="status ${success ? "ok" : ""}">${success ? "End-to-end verified" : "Needs attention"}</span>
    </header>

    <section class="metrics" aria-label="Demo metrics">
      <div class="metric"><strong>${report.metrics.originalFiles}</strong><span>Original repo files</span></div>
      <div class="metric"><strong>${report.metrics.capsuleFiles}</strong><span>Capsule files</span></div>
      <div class="metric"><strong>${report.metrics.contextReductionPercent}%</strong><span>Context reduction</span></div>
      <div class="metric"><strong>${escapeHtml(report.metrics.mocks.join(", ") || "none")}</strong><span>Generated mocks</span></div>
    </section>

    <section class="section">
      <h2>Flow</h2>
      <div class="flow">
        ${flowItems.map(([title, detail]) => `<div class="flow-card"><h3>${escapeHtml(title)}</h3><span>${escapeHtml(detail)}</span></div>`).join("")}
      </div>
    </section>

    <section class="grid">
      <div class="section">
        <h2>Original Repo Slice</h2>
        <p class="path">${escapeHtml(report.workDir)}</p>
        <div class="file-list">${report.originalFiles.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>
      </div>
      <div class="section">
        <h2>Generated Capsule</h2>
        <p class="path">${escapeHtml(report.capsulePath)}</p>
        <div class="file-list">${report.capsuleFiles.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>
      </div>
    </section>

    <section class="section">
      <h2>End-to-End Run</h2>
      <div class="steps">
        ${report.steps.map(renderStep).join("")}
      </div>
    </section>

    <section class="section">
      <h2>Applied Patch</h2>
      <pre>${escapeHtml(report.patch || "Patch is available after apply-back completes.")}</pre>
    </section>

    <section class="section">
      <h2>Fixed Source</h2>
      <pre>${escapeHtml(report.fixedSource || "")}</pre>
    </section>
  </main>
</body>
</html>
`;
}

function renderStep(step) {
  const output = [step.stdout, step.stderr].filter(Boolean).join("\n");

  return `<article class="step">
    <div class="step-head">
      <div>
        <h3>${escapeHtml(step.title)}</h3>
        <p class="subtle">${escapeHtml(step.description)}</p>
        <div class="step-meta">
          <span>${escapeHtml(step.command)}</span>
          <span>${Math.round(step.durationMs)}ms</span>
          <span>exit ${step.exitCode}</span>
        </div>
      </div>
      <span class="badge ${escapeHtml(step.status)}">${escapeHtml(step.status.replace("-", " "))}</span>
    </div>
    <details>
      <summary>Command output</summary>
      <pre>${escapeHtml(output || "No output.")}</pre>
    </details>
  </article>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
