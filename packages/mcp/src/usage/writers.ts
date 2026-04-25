import fs from "node:fs/promises";
import path from "node:path";

import type { FinalizedSession } from "./types.js";

export async function writeSessionLog(session: FinalizedSession): Promise<{ jsonPath: string; markdownPath: string }> {
  const logsDir = path.join(session.repoPath, ".bugcapsule", "logs");
  await fs.mkdir(logsDir, { recursive: true });

  const baseName = `${safeTimestamp(session.startedAt)}-session`;
  const jsonPath = path.join(logsDir, `${baseName}.json`);
  const markdownPath = path.join(logsDir, `${safeTimestamp(session.startedAt)}-summary.md`);

  await fs.writeFile(jsonPath, `${JSON.stringify(buildJsonPayload(session), null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, buildMarkdown(session), "utf8");

  return { jsonPath, markdownPath };
}

function buildJsonPayload(session: FinalizedSession): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    repoPath: session.repoPath,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    finalizeReason: session.finalizeReason,
    pricing: session.pricing,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    totalCost: session.totalCost,
    calls: session.calls.map((call) => ({
      tool: call.tool,
      timestamp: call.timestamp,
      durationMs: call.durationMs,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cost: call.cost,
      ...(call.error ? { error: true } : {})
    })),
    comparison: session.comparison
  };
}

function buildMarkdown(session: FinalizedSession): string {
  const lines: string[] = [];
  lines.push(`# BugCapsule Session ${session.sessionId}`);
  lines.push("");
  lines.push(`- Repo: \`${session.repoPath}\``);
  lines.push(`- Started: ${session.startedAt}`);
  lines.push(`- Ended: ${session.endedAt}`);
  lines.push(`- Finalize reason: ${session.finalizeReason}`);
  lines.push(`- Pricing profile: ${session.pricing.model} (input $${session.pricing.input_per_million}/M, output $${session.pricing.output_per_million}/M)`);
  lines.push("");
  lines.push("> Accuracy note: this MCP summary estimates tool request/response payload size only. It is not provider model usage, and it should not be used as an exact token or cost benchmark.");
  lines.push("");
  lines.push("## Calls");
  lines.push("");
  lines.push("| # | Tool | Timestamp | Duration (ms) | Input tokens | Output tokens | Cost |");
  lines.push("| - | ---- | --------- | ------------- | ------------ | ------------- | ---- |");

  if (session.calls.length === 0) {
    lines.push("| _(no calls)_ |  |  |  |  |  |  |");
  } else {
    session.calls.forEach((call, index) => {
      const errorMark = call.error ? " (error)" : "";
      lines.push(
        `| ${index + 1} | \`${call.tool}\`${errorMark} | ${call.timestamp} | ${call.durationMs} | ${call.inputTokens} | ${call.outputTokens} | ${call.cost} |`
      );
    });
  }

  lines.push("");
  lines.push("## MCP Payload Estimate");
  lines.push("");
  lines.push(`- Estimated input tokens: ${session.totalInputTokens}`);
  lines.push(`- Estimated output tokens: ${session.totalOutputTokens}`);
  lines.push(`- Estimated listed-price cost: ${session.totalCost}`);
  lines.push("");
  lines.push("## Approximate Comparison vs. Full-Repo Context");
  lines.push("");
  lines.push(`- Estimated full-repo tokens: ${session.comparison.estimatedFullRepoTokens}`);
  lines.push(`- Capsule tokens: ${session.comparison.capsuleTokens}`);
  lines.push(`- Estimated full-repo cost: ${session.comparison.estimatedFullRepoCost}`);
  lines.push(`- Estimated MCP payload cost: ${session.comparison.actualCost}`);
  lines.push("");
  lines.push(
    `Approximate payload reduction: ~${session.comparison.costSavingsPercent.toFixed(1)}% on listed-price cost and ~${session.comparison.tokenSavingsPercent.toFixed(1)}% on tokens vs. dumping the full repo as context.`
  );
  lines.push("");

  return lines.join("\n");
}

function safeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}
