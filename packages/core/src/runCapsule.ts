import { capsulePathFor, readManifest } from "./manifest.js";
import { runShellCommand } from "./shell.js";
import { extractFailureSummary } from "./stackTraceParser.js";
import type { RunCapsuleOptions, RunCapsuleResult } from "./types.js";

export async function runCapsule(options: RunCapsuleOptions): Promise<RunCapsuleResult> {
  const capsulePath = capsulePathFor(options.repoPath, options.capsuleId);
  const manifest = await readManifest(capsulePath);
  const command = options.command ?? manifest.capsule.runCommand;
  const result = await runShellCommand(command, capsulePath);

  return {
    status: result.exitCode === 0 ? "passed" : "failed",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.exitCode === 0 ? {} : { failureSummary: extractFailureSummary(`${result.stderr}\n${result.stdout}`) })
  };
}
