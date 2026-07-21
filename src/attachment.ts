import type { execute } from "./executor.js";

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
