import { randomUUID } from "node:crypto";

import { costForTokens, formatUsd, loadPricing } from "./pricing.js";
import { estimateCapsuleTokens, estimateRepoTokens } from "./repoTokens.js";
import type { FinalizeReason, FinalizedSession, Pricing, RecordedCall, SessionState } from "./types.js";
import { writeSessionLog } from "./writers.js";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export type RecordCallInput = {
  tool: string;
  repoPath: string;
  capsuleIdHint?: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  timestamp: string;
  error?: boolean;
};

export class SessionTracker {
  private readonly sessions = new Map<string, SessionState>();
  private readonly pricingCache = new Map<string, Pricing>();

  async recordCall(input: RecordCallInput): Promise<void> {
    try {
      const session = this.getOrCreateSession(input.repoPath);
      const pricing = await this.getPricing(input.repoPath);

      const costUsd = costForTokens(pricing, input.inputTokens, input.outputTokens);
      const call: RecordedCall = {
        tool: input.tool,
        timestamp: input.timestamp,
        durationMs: input.durationMs,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cost: formatUsd(costUsd),
        costUsd,
        ...(input.error ? { error: true } : {})
      };

      session.calls.push(call);
      session.lastActivityMs = Date.now();
      if (input.capsuleIdHint) {
        session.latestCapsuleId = input.capsuleIdHint;
      }

      this.refreshIdleTimer(session);
    } catch (error) {
      logTrackerError("recordCall", error);
    }
  }

  async finalizeSession(repoPath: string, reason: FinalizeReason): Promise<void> {
    const session = this.sessions.get(repoPath);
    if (!session) {
      return;
    }

    if (session.finalizing) {
      await session.finalizing;
      return;
    }

    const finalizing = this.doFinalize(session, reason).catch((error) => {
      logTrackerError("finalizeSession", error);
    });

    session.finalizing = finalizing;
    await finalizing;
  }

  async finalizeAll(reason: FinalizeReason): Promise<void> {
    const repoPaths = Array.from(this.sessions.keys());
    await Promise.all(repoPaths.map((repoPath) => this.finalizeSession(repoPath, reason)));
  }

  private async doFinalize(session: SessionState, reason: FinalizeReason): Promise<void> {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      delete session.idleTimer;
    }

    this.sessions.delete(session.repoPath);

    const pricing = await this.getPricing(session.repoPath);
    const totalInputTokens = session.calls.reduce((sum, call) => sum + call.inputTokens, 0);
    const totalOutputTokens = session.calls.reduce((sum, call) => sum + call.outputTokens, 0);
    const totalCostUsd = session.calls.reduce((sum, call) => sum + call.costUsd, 0);

    const estimatedFullRepoTokens = await safeEstimate(() => estimateRepoTokens(session.repoPath));
    const capsuleTokens = await safeEstimate(() => estimateCapsuleTokens(session.repoPath, session.latestCapsuleId));

    const estimatedFullRepoCostUsd = (estimatedFullRepoTokens / 1_000_000) * pricing.input_per_million;
    const tokenSavingsPercent = computeSavingsPercent(estimatedFullRepoTokens, capsuleTokens);
    const costSavingsPercent = computeSavingsPercent(estimatedFullRepoCostUsd, totalCostUsd);

    const finalized: FinalizedSession = {
      sessionId: session.sessionId,
      repoPath: session.repoPath,
      startedAt: session.startedAt,
      endedAt: new Date().toISOString(),
      finalizeReason: reason,
      pricing,
      totalInputTokens,
      totalOutputTokens,
      totalCost: formatUsd(totalCostUsd),
      calls: session.calls,
      comparison: {
        estimatedFullRepoTokens,
        capsuleTokens,
        tokenSavingsPercent,
        estimatedFullRepoCost: formatUsd(estimatedFullRepoCostUsd),
        actualCost: formatUsd(totalCostUsd),
        costSavingsPercent
      }
    };

    try {
      await writeSessionLog(finalized);
    } catch (error) {
      logTrackerError("writeSessionLog", error);
    }
  }

  private getOrCreateSession(repoPath: string): SessionState {
    const existing = this.sessions.get(repoPath);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const session: SessionState = {
      sessionId: randomUUID(),
      repoPath,
      startedAt: new Date(now).toISOString(),
      startedAtMs: now,
      lastActivityMs: now,
      calls: []
    };
    this.sessions.set(repoPath, session);
    return session;
  }

  private refreshIdleTimer(session: SessionState): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    const timer = setTimeout(() => {
      void this.finalizeSession(session.repoPath, "idle");
    }, IDLE_TIMEOUT_MS);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    session.idleTimer = timer;
  }

  private async getPricing(repoPath: string): Promise<Pricing> {
    const cached = this.pricingCache.get(repoPath);
    if (cached) {
      return cached;
    }
    const pricing = await loadPricing(repoPath);
    this.pricingCache.set(repoPath, pricing);
    return pricing;
  }
}

async function safeEstimate(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (error) {
    logTrackerError("estimate", error);
    return 0;
  }
}

function computeSavingsPercent(baseline: number, actual: number): number {
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return 0;
  }
  const savings = ((baseline - actual) / baseline) * 100;
  if (!Number.isFinite(savings)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Number(savings.toFixed(1))));
}

function logTrackerError(label: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[bugcapsule-usage] ${label} failed: ${message}\n`);
}
