import { spawn } from "node:child_process";

import { redactSecrets } from "./fileUtils.js";

export type CommandResult = {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export async function runShellCommand(command: string, cwd: string): Promise<CommandResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      stderr += `\n${error.message}`;
    });

    child.on("close", (code) => {
      resolve({
        command,
        cwd,
        exitCode: code ?? 1,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        durationMs: Date.now() - startedAt
      });
    });
  });
}
