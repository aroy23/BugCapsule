import type { BugCapsuleConfig } from "./types.js";

export function defineConfig(config: BugCapsuleConfig): BugCapsuleConfig {
  return config;
}

export type RuntimeConfig = {
  create: {
    defaultMaxFiles: number;
    defaultMaxDepth: number;
    verifyAfterCreate: boolean;
  };
  slicing: {
    forceInclude: string[];
    forceExclude: string[];
    preferMockFor: string[];
  };
  mocks: {
    defaultMode: NonNullable<BugCapsuleConfig["mocks"]>["defaultMode"];
  };
  apply: {
    requireCleanGitWorktree: boolean;
    createPatchFile: boolean;
    verifyOriginalCommand: boolean;
  };
};

export const defaultConfig: RuntimeConfig = {
  create: {
    defaultMaxFiles: 30,
    defaultMaxDepth: 6,
    verifyAfterCreate: true
  },
  slicing: {
    forceInclude: [],
    forceExclude: [
      "node_modules/**",
      "dist/**",
      ".next/**",
      "coverage/**",
      ".git/**",
      ".bugcapsule/**"
    ],
    preferMockFor: [
      "stripe",
      "@aws-sdk/*",
      "pg",
      "mysql2",
      "redis",
      "ioredis"
    ]
  },
  mocks: {
    defaultMode: "auto"
  },
  apply: {
    requireCleanGitWorktree: true,
    createPatchFile: true,
    verifyOriginalCommand: true
  }
};
