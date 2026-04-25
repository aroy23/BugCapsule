import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureBugCapsuleGitignoreEntry } from "./gitignore.js";

const tempRoot = path.resolve(".tmp-tests/gitignore");

describe("ensureBugCapsuleGitignoreEntry", () => {
  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("creates .gitignore when it does not exist", async () => {
    await fs.mkdir(tempRoot, { recursive: true });

    const result = await ensureBugCapsuleGitignoreEntry(tempRoot);

    expect(result).toMatchObject({
      created: true,
      updated: true
    });
    await expect(fs.readFile(path.join(tempRoot, ".gitignore"), "utf8")).resolves.toBe(".bugcapsule/\n");
  });

  it("appends .bugcapsule to an existing .gitignore once", async () => {
    await fs.mkdir(tempRoot, { recursive: true });
    const gitignorePath = path.join(tempRoot, ".gitignore");
    await fs.writeFile(gitignorePath, "node_modules/\ndist/");

    const first = await ensureBugCapsuleGitignoreEntry(tempRoot);
    const second = await ensureBugCapsuleGitignoreEntry(tempRoot);

    expect(first).toMatchObject({
      created: false,
      updated: true
    });
    expect(second).toMatchObject({
      created: false,
      updated: false
    });
    await expect(fs.readFile(gitignorePath, "utf8")).resolves.toBe("node_modules/\ndist/\n.bugcapsule/\n");
  });

  it("recognizes existing BugCapsule ignore variants", async () => {
    await fs.mkdir(tempRoot, { recursive: true });
    const gitignorePath = path.join(tempRoot, ".gitignore");
    await fs.writeFile(gitignorePath, "node_modules/\n.bugcapsule/**\n");

    const result = await ensureBugCapsuleGitignoreEntry(tempRoot);

    expect(result.updated).toBe(false);
    await expect(fs.readFile(gitignorePath, "utf8")).resolves.toBe("node_modules/\n.bugcapsule/**\n");
  });
});
