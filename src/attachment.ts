import path from "node:path";
import type { execute } from "./executor.js";
import type { Defaults } from "./defaults.js";

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";
const API_VERSION = "7.1";

function trimTrailingSlash(organization: string): string {
  return organization.replace(/\/+$/, "");
}

export function buildUploadUrl(
  organization: string,
  project: string,
  fileName: string,
): string {
  return (
    `${trimTrailingSlash(organization)}/${encodeURIComponent(project)}` +
    `/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}` +
    `&api-version=${API_VERSION}`
  );
}

export function buildLinkUrl(
  organization: string,
  workItemId: number,
): string {
  return (
    `${trimTrailingSlash(organization)}/_apis/wit/workitems/${workItemId}` +
    `?api-version=${API_VERSION}`
  );
}

export interface JsonPatchAdd {
  op: "add";
  path: "/relations/-";
  value: {
    rel: "AttachedFile";
    url: string;
    attributes?: { comment: string };
  };
}

export function buildLinkPatchBody(
  attachmentUrl: string,
  comment?: string,
): JsonPatchAdd[] {
  return [
    {
      op: "add",
      path: "/relations/-",
      value: {
        rel: "AttachedFile",
        url: attachmentUrl,
        ...(comment ? { attributes: { comment } } : {}),
      },
    },
  ];
}

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
        "或設定 AZURE_DEVOPS_EXT_PAT 環境變數（PAT 需有 Work Items Read & Write scope）。",
    };
  }
  return { ok: true, header: `Bearer ${token}` };
}

export interface AttachmentIo {
  readFile(filePath: string): Promise<Buffer>;
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
}

export interface AttachParams {
  workItemId: number;
  filePath: string;
  comment?: string;
  fileName?: string;
}

export type AttachOutcome =
  | { ok: true; message: string }
  | { ok: false; error: string };

const AUTH_HINT =
  "認證遭拒。請重新執行 az login，或確認 AZURE_DEVOPS_EXT_PAT 是否有效" +
  "（PAT 需有 Work Items Read & Write scope）。";

// Azure DevOps 對無效 PAT 會回 203 + HTML 登入頁，而非 401
function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403 || status === 203;
}

async function readBodySnippet(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

export async function attachFileToWorkItem(
  io: AttachmentIo,
  executeFn: typeof execute,
  defaults: Defaults,
  params: AttachParams,
): Promise<AttachOutcome> {
  let buffer: Buffer;
  try {
    buffer = await io.readFile(params.filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, error: `找不到檔案：${params.filePath}` };
    }
    if (code === "EISDIR") {
      return { ok: false, error: `路徑是目錄而非檔案：${params.filePath}` };
    }
    return { ok: false, error: `讀取檔案失敗：${(error as Error).message}` };
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: "檔案超過 100MB 上限，請改用 Azure DevOps 網頁手動上傳。",
    };
  }

  const auth = await resolveAuthHeader(io.env, executeFn);
  if (!auth.ok) return { ok: false, error: auth.error };

  // path.win32 同時支援 / 與 \ 分隔（team 以 Windows 為主）
  const fileName =
    params.fileName?.trim() || path.win32.basename(params.filePath);
  const uploadUrl = buildUploadUrl(
    defaults.organization,
    defaults.project,
    fileName,
  );

  let uploadRes: Response;
  try {
    uploadRes = await io.fetchFn(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: auth.header,
        "Content-Type": "application/octet-stream",
      },
      body: buffer as BodyInit,
    });
  } catch (error) {
    return {
      ok: false,
      error: `上傳附件時網路錯誤：${(error as Error).message}`,
    };
  }
  if (isAuthFailure(uploadRes.status)) return { ok: false, error: AUTH_HINT };
  if (!uploadRes.ok) {
    return {
      ok: false,
      error: `上傳附件失敗（HTTP ${uploadRes.status}）：${await readBodySnippet(uploadRes)}`,
    };
  }
  let attachmentUrl: string;
  try {
    const body = (await uploadRes.json()) as { url?: string };
    if (!body.url) throw new Error("回應缺少 url 欄位");
    attachmentUrl = body.url;
  } catch (error) {
    return {
      ok: false,
      error: `解析上傳回應失敗：${(error as Error).message}`,
    };
  }

  const linkUrl = buildLinkUrl(defaults.organization, params.workItemId);
  const orphanHint =
    `\n附件已上傳到 ${attachmentUrl}，但尚未連結到 work item。`;
  let linkRes: Response;
  try {
    linkRes = await io.fetchFn(linkUrl, {
      method: "PATCH",
      headers: {
        Authorization: auth.header,
        "Content-Type": "application/json-patch+json",
      },
      body: JSON.stringify(buildLinkPatchBody(attachmentUrl, params.comment)),
    });
  } catch (error) {
    return {
      ok: false,
      error: `連結附件時網路錯誤：${(error as Error).message}${orphanHint}`,
    };
  }
  if (isAuthFailure(linkRes.status)) {
    return { ok: false, error: `${AUTH_HINT}${orphanHint}` };
  }
  if (linkRes.status === 404) {
    return {
      ok: false,
      error: `Work item #${params.workItemId} 不存在，請確認 ID。${orphanHint}`,
    };
  }
  if (!linkRes.ok) {
    return {
      ok: false,
      error:
        `連結附件失敗（HTTP ${linkRes.status}）：` +
        `${await readBodySnippet(linkRes)}${orphanHint}`,
    };
  }
  return {
    ok: true,
    message:
      `已將「${fileName}」上傳並連結到 work item #${params.workItemId}。\n` +
      `附件 URL：${attachmentUrl}`,
  };
}
