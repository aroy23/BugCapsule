import { readManifest, capsulePathFor } from "./manifest.js";
import { runShellCommand } from "./shell.js";
import { integrityFailureMessage, validateCapsuleIntegrity } from "./workflow.js";
import type { VerifyCapsuleOptions, VerifyCapsuleResult } from "./types.js";

export async function verifyCapsule(options: VerifyCapsuleOptions): Promise<VerifyCapsuleResult> {
  const capsulePath = capsulePathFor(options.repoPath, options.capsuleId);
  const manifest = await readManifest(capsulePath);
  const checks: VerifyCapsuleResult["checks"] = [];
  const integrity = await validateCapsuleIntegrity(manifest);

  checks.push({
    name: "capsule integrity",
    status: integrity.status,
    ...(integrity.status === "failed" ? { stderr: integrityFailureMessage(integrity) } : {})
  });

  if (integrity.status !== "passed") {
    return {
      status: "failed",
      checks
    };
  }

  const capsule = await runShellCommand(manifest.capsule.runCommand, capsulePath);

  checks.push({
    name: "capsule repro",
    status: capsule.exitCode === 0 ? "passed" : "failed",
    command: manifest.capsule.runCommand,
    stdout: capsule.stdout,
    stderr: capsule.stderr
  });

  const original = await runShellCommand(manifest.originalRepro.command, options.repoPath);
  checks.push({
    name: "original repro",
    status: original.exitCode === 0 ? "passed" : "failed",
    command: manifest.originalRepro.command,
    stdout: original.stdout,
    stderr: original.stderr
  });

  if (options.runFullProjectTests) {
    const full = await runShellCommand("npm test", options.repoPath);
    checks.push({
      name: "full project tests",
      status: full.exitCode === 0 ? "passed" : "failed",
      command: "npm test",
      stdout: full.stdout,
      stderr: full.stderr
    });
  }

  return {
    status: checks.every((check) => check.status === "passed" || check.status === "skipped") ? "passed" : "failed",
    checks
  };
}
