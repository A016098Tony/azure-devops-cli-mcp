import { exec } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ExecuteOptions {
  timeoutMs?: number;
  baseCommand?: string;
}

export function execute(
  commandLine: string,
  options: ExecuteOptions = {},
): Promise<ExecResult> {
  const { timeoutMs = 120_000, baseCommand = "az" } = options;
  return new Promise((resolve) => {
    exec(
      `${baseCommand} ${commandLine}`,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const err = error as
          | (Error & { killed?: boolean; code?: unknown })
          | null;
        const timedOut = Boolean(err?.killed);
        const exitCode = err
          ? typeof err.code === "number"
            ? err.code
            : 1
          : 0;
        resolve({ stdout, stderr, exitCode, timedOut });
      },
    );
  });
}
