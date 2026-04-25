import path from "node:path";

import { ensureDir, pathExists, writeTextFile } from "./fileUtils.js";

export async function initBugCapsule(repoPath: string): Promise<{ created: string[] }> {
  const created: string[] = [];
  const directories = [
    ".bugcapsule/capsules",
    ".bugcapsule/cache",
    ".bugcapsule/captures",
    ".bugcapsule/evaluations",
    ".bugcapsule/patches"
  ];

  for (const directory of directories) {
    await ensureDir(path.join(repoPath, directory));
    created.push(directory);
  }

  const configPath = path.join(repoPath, "bugcapsule.config.ts");

  if (!(await pathExists(configPath))) {
    await writeTextFile(configPath, `import { defineConfig } from "@bugcapsule/core";\n\nexport default defineConfig({\n  project: {\n    language: "typescript",\n    packageManager: "auto",\n    testRunner: "auto"\n  },\n  create: {\n    defaultMaxFiles: 30,\n    defaultMaxDepth: 6,\n    verifyAfterCreate: true\n  },\n  slicing: {\n    forceInclude: [],\n    forceExclude: [\n      "node_modules/**",\n      "dist/**",\n      ".next/**",\n      "coverage/**"\n    ],\n    preferMockFor: [\n      "stripe",\n      "@aws-sdk/*",\n      "pg",\n      "mysql2",\n      "redis",\n      "ioredis"\n    ]\n  },\n  mocks: {\n    defaultMode: "auto"\n  },\n  apply: {\n    requireCleanGitWorktree: true,\n    createPatchFile: true,\n    verifyOriginalCommand: true\n  },\n  telemetry: {\n    enabled: false\n  }\n});\n`);
    created.push("bugcapsule.config.ts");
  }

  return { created };
}
