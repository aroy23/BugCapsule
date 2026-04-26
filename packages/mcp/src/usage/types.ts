export type Pricing = {
  profile?: string;
  provider?: string;
  model: string;
  displayName?: string;
  currency: string;
  input_per_million: number;
  cached_input_per_million?: number;
  output_per_million: number;
  evaluation_encoding?: string;
  source?: string;
  verifiedAt?: string;
  notes?: string;
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
