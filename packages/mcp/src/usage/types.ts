export type Pricing = {
  model: string;
  currency: string;
  input_per_million: number;
  output_per_million: number;
};

export type RecordedCall = {
  tool: string;
  timestamp: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: string;
  costUsd: number;
  error?: boolean;
};

export type SessionState = {
  sessionId: string;
  repoPath: string;
  startedAt: string;
  startedAtMs: number;
  lastActivityMs: number;
  latestCapsuleId?: string;
  calls: RecordedCall[];
  idleTimer?: NodeJS.Timeout;
  finalizing?: Promise<void>;
};

export type FinalizeReason = "apply_patch" | "idle" | "shutdown";

export type ComparisonBlock = {
  estimatedFullRepoTokens: number;
  capsuleTokens: number;
  tokenSavingsPercent: number;
  estimatedFullRepoCost: string;
  actualCost: string;
  costSavingsPercent: number;
};

export type FinalizedSession = {
  sessionId: string;
  repoPath: string;
  startedAt: string;
  endedAt: string;
  finalizeReason: FinalizeReason;
  pricing: Pricing;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: string;
  calls: RecordedCall[];
  comparison: ComparisonBlock;
};
