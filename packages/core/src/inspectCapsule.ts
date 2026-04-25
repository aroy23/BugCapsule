import fs from "node:fs/promises";
import path from "node:path";

import { pathExists } from "./fileUtils.js";
import { capsulePathFor, readManifest } from "./manifest.js";
import type { BugCapsuleManifest, InspectCapsuleOptions, ListCapsulesOptions, ListCapsulesResult } from "./types.js";

export async function inspectCapsule(options: InspectCapsuleOptions): Promise<BugCapsuleManifest> {
  return readManifest(capsulePathFor(options.repoPath, options.capsuleId));
}

export async function listCapsules(options: ListCapsulesOptions): Promise<ListCapsulesResult> {
  const capsulesRoot = path.join(options.repoPath, ".bugcapsule", "capsules");

  if (!(await pathExists(capsulesRoot))) {
    return { capsules: [] };
  }

  const entries = await fs.readdir(capsulesRoot, { withFileTypes: true });
  const capsules = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const manifest = await readManifest(path.join(capsulesRoot, entry.name));
      capsules.push({
        capsuleId: manifest.capsuleId,
        status: "created_failing" as const,
        createdAt: manifest.createdAt,
        capsulePath: manifest.capsule.path,
        fileCount: manifest.files.length
      });
    } catch {
      capsules.push({
        capsuleId: entry.name,
        status: "unknown" as const,
        createdAt: "",
        capsulePath: path.join(capsulesRoot, entry.name),
        fileCount: 0
      });
    }
  }

  return { capsules: capsules.sort((left, right) => right.createdAt.localeCompare(left.createdAt)) };
}
