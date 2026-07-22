import type { execute } from "./executor.js";

export const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";
export const API_VERSION = "7.1";

export const AUTH_HINT =
  "認證遭拒。請重新執行 az login，或確認 AZURE_DEVOPS_EXT_PAT 是否有效" +
  "（PAT 需有對應的 read/write scope）。";

export type AuthResult =
  | { ok: true; header: string }
  | { ok: false; error: string };

export async function resolveAuthHeader(
  env: NodeJS.ProcessEnv,
  executeFn: typeof execute,
): Promise<AuthResult> {
  const pat = env.AZURE_DEVOPS_EXT_PAT?.trim();
  if (pat) {
    return {
      ok: true,
      header: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
    };
  }
  const result = await executeFn(
    `account get-access-token --resource ${ADO_RESOURCE_ID} --query accessToken -o tsv`,
    { timeoutMs: 30_000 },
  );
  const token = result.stdout.trim();
  if (result.exitCode !== 0 || !token) {
    return {
      ok: false,
      error:
        "無法取得 Azure DevOps 認證。請先執行 az login，" +
        "或設定 AZURE_DEVOPS_EXT_PAT 環境變數（PAT 需有對應的 read/write scope）。",
    };
  }
  return { ok: true, header: `Bearer ${token}` };
}

// Azure DevOps 對無效 PAT 會回 203 + HTML 登入頁，而非 401
export function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403 || status === 203;
}

export async function readBodySnippet(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
