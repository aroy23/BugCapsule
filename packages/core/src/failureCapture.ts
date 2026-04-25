import path from "node:path";

import { ensureDir, writeTextFile } from "./fileUtils.js";
import { parseStackTrace, extractFailureSummary } from "./stackTraceParser.js";
import { runShellCommand } from "./shell.js";
import type { CapturedFailure } from "./types.js";

export async function captureFailure(repoPath: string, command: string, capsuleId: string): Promise<CapturedFailure> {
  const result = await runShellCommand(command, repoPath);
  const combinedOutput = `${result.stderr}\n${result.stdout}`;
  const capturesPath = path.join(repoPath, ".bugcapsule", "captures", capsuleId);

  await ensureDir(capturesPath);
  await writeTextFile(path.join(capturesPath, "original.stdout.log"), result.stdout);
  await writeTextFile(path.join(capturesPath, "original.stderr.log"), result.stderr);

  return {
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    failureSummary: extractFailureSummary(combinedOutput),
    stackTrace: parseStackTrace(combinedOutput, repoPath)
  };
}
