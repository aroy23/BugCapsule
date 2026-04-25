import fs from "node:fs/promises";
import path from "node:path";

import { pathExists, readJsonFile } from "./fileUtils.js";
import type { Framework, PackageManager, ProjectInfo, TestRunner } from "./types.js";

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export async function detectProject(repoPath: string): Promise<ProjectInfo> {
  const rootPath = path.resolve(repoPath);
  const packageJsonPath = path.join(rootPath, "package.json");

  await fs.access(packageJsonPath);

  const packageJson = await readJsonFile<PackageJson>(packageJsonPath);
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies
  };

  const tsconfigPath = await pathExists(path.join(rootPath, "tsconfig.json"))
    ? path.join(rootPath, "tsconfig.json")
    : undefined;

  return {
    rootPath,
    packageManager: await detectPackageManager(rootPath),
    testRunner: detectTestRunner(packageJson, dependencies),
    framework: detectFramework(dependencies),
    ...(tsconfigPath ? { tsconfigPath } : {}),
    packageJsonPath
  };
}

async function detectPackageManager(rootPath: string): Promise<PackageManager> {
  if (await pathExists(path.join(rootPath, "package-lock.json"))) {
    return "npm";
  }

  if (await pathExists(path.join(rootPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (await pathExists(path.join(rootPath, "yarn.lock"))) {
    return "yarn";
  }

  return "npm";
}

function detectTestRunner(packageJson: PackageJson, dependencies: Record<string, string | undefined>): TestRunner {
  const scripts = Object.values(packageJson.scripts ?? {}).join("\n");

  if (dependencies.vitest || /\bvitest\b/.test(scripts)) {
    return "vitest";
  }

  if (dependencies.jest || /\bjest\b/.test(scripts)) {
    return "jest";
  }

  if (dependencies["@playwright/test"] || /\bplaywright\b/.test(scripts)) {
    return "playwright";
  }

  return "unknown";
}

function detectFramework(dependencies: Record<string, string | undefined>): Framework {
  if (dependencies.next) {
    return "next";
  }

  if (dependencies.vite) {
    return "vite";
  }

  return "node";
}
