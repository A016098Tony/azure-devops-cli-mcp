import { exec } from "node:child_process";
export function execute(commandLine, options = {}) {
    const { timeoutMs = 120_000, baseCommand = "az" } = options;
    return new Promise((resolve) => {
        exec(`${baseCommand} ${commandLine}`, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
            const err = error;
            const timedOut = Boolean(err?.killed);
            const exitCode = err
                ? typeof err.code === "number"
                    ? err.code
                    : 1
                : 0;
            resolve({ stdout, stderr, exitCode, timedOut });
        });
    });
}
