import { exec, execFileSync } from "node:child_process";

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

const UTF8 = "utf-8";

const ACP_ENCODINGS: Record<number, string> = {
  950: "big5",
  936: "gbk",
  932: "shift_jis",
  949: "euc-kr",
  65001: UTF8,
};

// Windows ANSI code page → TextDecoder 編碼名稱；未知值退回 utf-8
export function acpToEncoding(acp: number | undefined): string {
  if (acp === undefined) return UTF8;
  const known = ACP_ENCODINGS[acp];
  if (known) return known;
  if (acp === 874 || (acp >= 1250 && acp <= 1258)) return `windows-${acp}`;
  return UTF8;
}

// 先嚴格當 UTF-8；失敗才改用備援編碼（只在需要時才呼叫 getFallbackEncoding）
export function decodeOutput(
  buf: Uint8Array,
  getFallbackEncoding: () => string,
): string {
  if (buf.length === 0) return "";
  try {
    return new TextDecoder(UTF8, { fatal: true }).decode(buf);
  } catch {
    // 不是合法 UTF-8，往下用備援編碼
  }
  try {
    return new TextDecoder(getFallbackEncoding()).decode(buf);
  } catch {
    return new TextDecoder(UTF8).decode(buf);
  }
}

// az.cmd 以 python -I 啟動，PYTHON* 環境變數無效；往 pipe 輸出時 Python 用 ANSI code page
// （不是 chcp 的 OEM code page），所以要查 ACP
function readAnsiCodePage(): number | undefined {
  try {
    const out = execFileSync(
      "reg",
      [
        "query",
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
        "/v",
        "ACP",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 },
    );
    const match = /ACP\s+REG_SZ\s+(\d+)/.exec(out);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

let cachedSystemEncoding: string | undefined;

function fallbackEncoding(): string {
  const override = process.env.AZ_OUTPUT_ENCODING?.trim();
  if (override) return override;
  if (process.platform !== "win32") return UTF8;
  cachedSystemEncoding ??= acpToEncoding(readAnsiCodePage());
  return cachedSystemEncoding;
}

export function execute(
  commandLine: string,
  options: ExecuteOptions = {},
): Promise<ExecResult> {
  const { timeoutMs = 120_000, baseCommand = "az" } = options;
  return new Promise((resolve) => {
    exec(
      `${baseCommand} ${commandLine}`,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: "buffer",
      },
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
        resolve({
          stdout: decodeOutput(stdout, fallbackEncoding),
          stderr: decodeOutput(stderr, fallbackEncoding),
          exitCode,
          timedOut,
        });
      },
    );
  });
}
