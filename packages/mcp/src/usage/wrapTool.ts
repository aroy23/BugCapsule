import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { estimateTokens, estimateTokensForJson } from "./tokenizer.js";
import type { SessionTracker } from "./sessionTracker.js";

const APPLY_PATCH_TOOL = "bugcapsule_apply_patch";

type AnyToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  _meta?: Record<string, unknown>;
};
type AnyToolHandler = (args: any, extra: any) => any;
type ToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
};

export function registerTrackedTool(
  mcp: McpServer,
  tracker: SessionTracker,
  name: string,
  config: AnyToolConfig,
  handler: AnyToolHandler
): void {
  const wrapped: AnyToolHandler = async (args: Record<string, unknown>, extra: unknown) => {
    const startTime = Date.now();
    const timestamp = new Date(startTime).toISOString();
    const inputTokens = estimateTokensForJson(args ?? {});
    const repoPath = typeof args?.repoPath === "string" ? args.repoPath : undefined;
    const argsCapsuleId = typeof args?.capsuleId === "string" ? args.capsuleId : undefined;

    let resultText = "";
    let result: ToolResult | undefined;
    let threw = false;

    try {
      result = (await handler(args, extra)) as ToolResult;
      resultText = extractTextContent(result);
      return result;
    } catch (error) {
      threw = true;
      throw error;
    } finally {
      const durationMs = Date.now() - startTime;
      const outputTokens = estimateTokens(resultText);
      const resultCapsuleId = resultText ? findCapsuleIdInResult(resultText) : undefined;
      const capsuleIdHint = argsCapsuleId ?? resultCapsuleId;

      if (repoPath) {
        void tracker
          .recordCall({
            tool: name,
            repoPath,
            ...(capsuleIdHint ? { capsuleIdHint } : {}),
            inputTokens,
            outputTokens,
            durationMs,
            timestamp,
            ...(threw ? { error: true } : {})
          })
          .then(async () => {
            if (!threw && name === APPLY_PATCH_TOOL) {
              await tracker.finalizeSession(repoPath, "apply_patch");
            }
          })
          .catch(() => {
            /* tracker errors must never affect tool callers */
          });
      }
    }
  };

  mcp.registerTool(name, config as any, wrapped as any);
}

function extractTextContent(result: ToolResult | undefined): string {
  if (!result || !Array.isArray(result.content)) {
    return "";
  }
  let combined = "";
  for (const part of result.content) {
    if (part && typeof part.text === "string") {
      combined += part.text;
    }
  }
  return combined;
}

function findCapsuleIdInResult(resultText: string): string | undefined {
  if (!resultText) {
    return undefined;
  }
  const match = resultText.match(/"capsuleId"\s*:\s*"([^"\\]+)"/);
  return match ? match[1] : undefined;
}
