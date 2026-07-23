export interface GitFetchParams {
  repoPath: string;
  remote?: string;
  refspec?: string;
  prune?: boolean;
  timeoutMs?: number;
}

export interface GitLsRemoteParams {
  repoPath: string;
  remote?: string;
  pattern?: string;
  heads?: boolean;
  tags?: boolean;
  timeoutMs?: number;
}

export type BuildResult =
  | { ok: true; command: string }
  | { ok: false; error: string };

// 只接受 remote 名稱（如 origin、upstream），擋掉 URL 與 - 開頭的選項注入
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Windows 磁碟機（D:\ 或 D:/）、UNC（\\host）、POSIX（/）
const ABSOLUTE_PATH_PATTERN = /^([A-Za-z]:[\\/]|\\\\|\/)/;

function validateCommon(
  repoPath: string,
  remote: string,
): string | undefined {
  const trimmedPath = repoPath.trim();
  if (!trimmedPath) return "repoPath 不可為空。";
  if (!ABSOLUTE_PATH_PATTERN.test(trimmedPath)) {
    return (
      `repoPath「${repoPath}」不是絕對路徑。` +
      "請提供主機端的絕對路徑，例如 D:\\mygithub\\MS-Web。"
    );
  }
  if (trimmedPath.includes('"')) return "repoPath 不可包含雙引號。";
  if (!REMOTE_NAME_PATTERN.test(remote)) {
    return (
      `不合法的 remote 名稱「${remote}」。` +
      "只接受已設定的 remote 名稱（如 origin），不接受 URL 或選項。"
    );
  }
  return undefined;
}

// refspec 與 ls-remote pattern 共用：擋 --upload-pack 這類可執行任意命令的選項
function validateRef(value: string, label: string): string | undefined {
  if (!value.trim()) return `${label} 不可為空白。`;
  if (value.startsWith("-")) return `${label} 不可以「-」開頭。`;
  if (/[\s"]/.test(value)) return `${label} 不可包含空白或雙引號。`;
  return undefined;
}

export function buildFetchCommand(params: GitFetchParams): BuildResult {
  const remote = params.remote ?? "origin";
  const commonError = validateCommon(params.repoPath, remote);
  if (commonError) return { ok: false, error: commonError };
  if (params.refspec !== undefined) {
    const refError = validateRef(params.refspec, "refspec");
    if (refError) return { ok: false, error: refError };
  }
  let command = `-C "${params.repoPath.trim()}" fetch ${remote}`;
  if (params.refspec !== undefined) command += ` "${params.refspec}"`;
  if (params.prune) command += " --prune";
  return { ok: true, command };
}

export function buildLsRemoteCommand(params: GitLsRemoteParams): BuildResult {
  const remote = params.remote ?? "origin";
  const commonError = validateCommon(params.repoPath, remote);
  if (commonError) return { ok: false, error: commonError };
  if (params.pattern !== undefined) {
    const patternError = validateRef(params.pattern, "pattern");
    if (patternError) return { ok: false, error: patternError };
  }
  let command = `-C "${params.repoPath.trim()}" ls-remote`;
  if (params.heads) command += " --heads";
  if (params.tags) command += " --tags";
  command += ` ${remote}`;
  if (params.pattern !== undefined) command += ` "${params.pattern}"`;
  return { ok: true, command };
}
