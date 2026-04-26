import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyCapsule } from "./applyCapsule.js";
import { createCapsule } from "./createCapsule.js";
import { runFixStep } from "./fixStep.js";
import { runShellCommand } from "./shell.js";
import { writeInvoiceFixtureRepo } from "./testFixtures.js";
import type { BugCapsuleManifest } from "./types.js";

const tempRoot = path.resolve(".tmp-tests/workflow");

describe("deterministic BugCapsule workflow", () => {
  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("rejects out-of-order actions and applies only the verified editable file set", async () => {
    const repoPath = path.join(tempRoot, "hash-gate");
    const created = await createFixtureCapsule(repoPath, "bc_hash_gate");

    await expect(runFixStep({
      repoPath,
      capsuleId: created.capsuleId,
      action: "verify_capsule"
    })).resolves.toMatchObject({
      status: "rejected",
      currentState: "created",
      requiredNextAction: "inspect"
    });

    await runFixStep({ repoPath, capsuleId: created.capsuleId, action: "inspect" });
    await runFixStep({ repoPath, capsuleId: created.capsuleId, action: "reproduce_initial" });
    await writePassingCapsuleFix(created.capsulePath);

    await expect(runFixStep({
      repoPath,
      capsuleId: created.capsuleId,
      action: "verify_capsule"
    })).resolves.toMatchObject({
      status: "ok",
      currentState: "capsule_passed",
      requiredNextAction: "apply_patch",
      receipt: {
        action: "verify_capsule",
        result: "passed"
      }
    });

    await fs.appendFile(path.join(created.capsulePath, "src/billing/customerAddress.ts"), "\n// changed after verification\n", "utf8");

    await expect(runFixStep({
      repoPath,
      capsuleId: created.capsuleId,
      action: "apply_patch"
    })).resolves.toMatchObject({
      status: "rejected",
      currentState: "awaiting_fix",
      requiredNextAction: "verify_capsule",
      message: "Editable capsule files changed after the passing verification receipt. Re-run bugcapsule_fix_step with action='verify_capsule' before applying."
    });

    await runFixStep({ repoPath, capsuleId: created.capsuleId, action: "verify_capsule" });
    const applied = await runFixStep({ repoPath, capsuleId: created.capsuleId, action: "apply_patch" });

    expect(applied).toMatchObject({
      status: "ok",
      currentState: "applied",
      requiredNextAction: "done",
      applyResult: {
        status: "applied_verified",
        modifiedOriginalFiles: ["src/billing/customerAddress.ts"]
      }
    });
  });

  it("allows strict apply to override a dirty original repo when requested", async () => {
    const repoPath = path.join(tempRoot, "dirty-strict-apply");
    const created = await createFixtureCapsule(repoPath, "bc_dirty_strict_apply");

    await runFixStep({ repoPath, capsuleId: created.capsuleId, action: "inspect" });
    await runFixStep({ repoPath, capsuleId: created.capsuleId, action: "reproduce_initial" });
    await writePassingCapsuleFix(created.capsulePath);
    await runFixStep({ repoPath, capsuleId: created.capsuleId, action: "verify_capsule" });
    await initializeGitCheckpoint(repoPath);
    await fs.writeFile(path.join(repoPath, "README.md"), "local notes\n", "utf8");

    await expect(runFixStep({
      repoPath,
      capsuleId: created.capsuleId,
      action: "apply_patch"
    })).resolves.toMatchObject({
      status: "failed",
      currentState: "capsule_passed",
      requiredNextAction: "apply_patch",
      applyResult: {
        status: "failed",
        message: "Original repo has uncommitted changes inside the target repo path. Re-run with allowDirty to override."
      }
    });

    const applied = await runFixStep({
      repoPath,
      capsuleId: created.capsuleId,
      action: "apply_patch",
      allowDirty: true
    });

    expect(applied).toMatchObject({
      status: "ok",
      currentState: "applied",
      requiredNextAction: "done",
      applyResult: {
        status: "applied_verified",
        modifiedOriginalFiles: ["src/billing/customerAddress.ts"]
      }
    });
  });

  it("refuses verification when locked capsule files change", async () => {
    const repoPath = path.join(tempRoot, "locked-file");
    const created = await createFixtureCapsule(repoPath, "bc_locked_file");

    await runFixStep({ repoPath, capsuleId: created.capsuleId, action: "inspect" });
    await runFixStep({ repoPath, capsuleId: created.capsuleId, action: "reproduce_initial" });
    await fs.appendFile(path.join(created.capsulePath, "package.json"), "\n", "utf8");

    await expect(runFixStep({
      repoPath,
      capsuleId: created.capsuleId,
      action: "verify_capsule"
    })).resolves.toMatchObject({
      status: "failed",
      currentState: "initial_failure_confirmed",
      requiredNextAction: "verify_capsule",
      message: "Capsule integrity check failed (modified locked files: package.json). Non-editable capsule files must not change."
    });
  });

  it("keeps legacy 0.1 capsules apply-compatible", async () => {
    const repoPath = path.join(tempRoot, "legacy");
    const created = await createFixtureCapsule(repoPath, "bc_legacy");
    const manifestPath = path.join(created.capsulePath, "capsule.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as BugCapsuleManifest;

    manifest.schemaVersion = "0.1";
    delete manifest.workflow;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writePassingCapsuleFix(created.capsulePath);

    const applied = await applyCapsule({
      repoPath,
      capsuleId: created.capsuleId,
      verify: true,
      allowDirty: true
    });

    expect(applied.status).toBe("applied_verified");
    expect(applied.modifiedOriginalFiles).toEqual(["src/billing/customerAddress.ts"]);
  });
});

async function createFixtureCapsule(repoPath: string, capsuleId: string): Promise<{
  capsuleId: string;
  capsulePath: string;
}> {
  await writeInvoiceFixtureRepo(repoPath);
  const created = await createCapsule({
    repoPath,
    command: "npm test -- export-missing-address",
    capsuleId,
    installDependencies: false,
    verifyCapsule: true
  });

  expect(created.status).toBe("created_failing");
  return {
    capsuleId: created.capsuleId,
    capsulePath: created.capsulePath
  };
}

async function writePassingCapsuleFix(capsulePath: string): Promise<void> {
  const capsuleCustomerAddressPath = path.join(capsulePath, "src/billing/customerAddress.ts");
  const originalContent = await fs.readFile(capsuleCustomerAddressPath, "utf8");
  await fs.writeFile(capsuleCustomerAddressPath, originalContent.replace(
    "  const presentAddress = address as Address;\n  return `${presentAddress.line1}, ${presentAddress.city}, ${presentAddress.country}`;",
    "  if (!address) {\n    return \"\";\n  }\n\n  return `${address.line1}, ${address.city}, ${address.country}`;"
  ));
}

async function initializeGitCheckpoint(repoPath: string): Promise<void> {
  await runShellCommand("git init", repoPath);
  await runShellCommand("git add .", repoPath);
  await runShellCommand("git -c user.name=BugCapsule -c user.email=bugcapsule@example.test commit -m initial", repoPath);
}
