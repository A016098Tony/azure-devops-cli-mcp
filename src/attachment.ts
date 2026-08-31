import path from "node:path";
import type { execute } from "./executor.js";
import type { Defaults } from "./defaults.js";
import {
  API_VERSION,
  AUTH_HINT,
  isAuthFailure,
  readBodySnippet,
  resolveAuthHeader,
} from "./auth.js";
import { adoRest } from "./rest.js";

export { ADO_RESOURCE_ID, resolveAuthHeader, type AuthResult } from "./auth.js";

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

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


export interface AttachmentIo {
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, data: Buffer): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<unknown>;
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


// ---------- 下載 ----------

// 內嵌圖片可能出現的 HTML 欄位；與 get-workitem skill 掃描範圍一致
const HTML_FIELD_NAMES = [
  "System.Description",
  "Microsoft.VSTS.Common.AcceptanceCriteria",
  "Microsoft.VSTS.TCM.ReproSteps",
];

export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** 從 HTML 欄位擷取 ADO 附件 API 的 <img> URL（描述內嵌圖不會出現在 relations） */
export function extractInlineImageUrls(html: unknown): string[] {
  if (typeof html !== "string" || !html) return [];
  const urls: string[] = [];
  const regex = /<img[^>]*\ssrc="([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const src = decodeEntities(match[1]);
    if (src.includes("/_apis/wit/attachments/")) urls.push(src);
  }
  return urls;
}

/** searchParams.get 已做過一次 decode，不再 decodeURIComponent（單獨的 % 會 throw） */
export function fileNameFromAttachmentUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("fileName") || null;
  } catch {
    return null;
  }
}

/**
 * Windows 檔名不允許的字元。其中 ":" 最危險 —— NTFS 會把 "report:v1.md"
 * 當成 alternate data stream，writeFile 不報錯，但目錄裡只留下 0 bytes 的
 * "report"，內容藏在資料流裡。ADO 的附件名可能來自 Mac/Linux，這些字元合法。
 */
const ILLEGAL_FILENAME_CHARS = /[<>:"|?*\x00-\x1f]/g;

/** 只取檔名，擋掉伺服器回傳值裡的路徑穿越；path.win32 同時吃 / 與 \ */
export function safeFileName(name: string, fallback: string): string {
  const base = path.win32.basename(name.trim());
  // 結尾的點與空白會被 Windows 靜默去掉，先自己處理，回報的檔名才與實際相符
  const cleaned = base
    .replace(ILLEGAL_FILENAME_CHARS, "_")
    .replace(/[. ]+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

/**
 * 同一批下載內避免重名：main.png → main-2.png。
 * 不檢查磁碟上既有檔案，因此重跑同一個 work item 會覆蓋而非無限增生。
 */
export function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const ext = path.extname(name);
    candidate = `${path.basename(name, ext)}-${n}${ext}`;
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** 附件 URL 必須與 organization 同 origin，否則 Authorization header 會外洩到別的網域 */
export function isAllowedAttachmentUrl(
  url: string,
  organization: string,
): boolean {
  try {
    return new URL(url).origin === new URL(organization).origin;
  } catch {
    return false;
  }
}

export type DownloadOutcome =
  | { ok: true; buffer: Buffer }
  | { ok: false; error: string };

export async function downloadAttachment(
  io: Pick<AttachmentIo, "fetchFn">,
  authHeader: string,
  url: string,
  organization: string,
): Promise<DownloadOutcome> {
  if (!isAllowedAttachmentUrl(url, organization)) {
    return {
      ok: false,
      error: `拒絕下載：URL 不屬於 ${organization} 的網域（${url}）。`,
    };
  }

  let res: Response;
  try {
    res = await io.fetchFn(url, {
      headers: {
        Authorization: authHeader,
        Accept: "application/octet-stream",
      },
    });
  } catch (error) {
    return {
      ok: false,
      error: `下載附件時網路錯誤：${(error as Error).message}`,
    };
  }

  // 認證失敗時 ADO 回 203 + HTML 登入頁；先擋掉才不會把登入頁寫成 .png
  if (isAuthFailure(res.status)) return { ok: false, error: AUTH_HINT };
  if (!res.ok) {
    return {
      ok: false,
      error: `下載附件失敗（HTTP ${res.status}）：${await readBodySnippet(res)}`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    return {
      ok: false,
      error: `讀取附件內容失敗：${(error as Error).message}`,
    };
  }
  // 用實際位元組數判斷，Content-Length 不一定存在
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `附件超過 100MB 上限（${buffer.length} bytes）。`,
    };
  }
  return { ok: true, buffer };
}

export interface DownloadedFile {
  name: string;
  url: string;
  localPath: string;
  bytes: number;
}

export type DownloadFilesOutcome =
  | { ok: true; message: string; files: DownloadedFile[]; failures: string[] }
  | { ok: false; error: string };

interface WorkItemBody {
  fields?: Record<string, unknown>;
  relations?: Array<{
    rel?: string;
    url?: string;
    attributes?: { name?: string };
  }>;
}

export interface DownloadWorkItemParams {
  workItemId: number;
  outDir: string;
}

export interface DownloadUrlParams {
  url: string;
  outDir: string;
  fileName?: string;
}

async function ensureDir(
  io: AttachmentIo,
  dir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await io.mkdir(dir, { recursive: true });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `建立目錄失敗：${dir}（${(error as Error).message}）`,
    };
  }
}

/** 下載單一附件 URL 到 outDir（不建子目錄）。 */
export async function downloadAttachmentToDir(
  io: AttachmentIo,
  executeFn: typeof execute,
  defaults: Defaults,
  params: DownloadUrlParams,
): Promise<DownloadFilesOutcome> {
  const auth = await resolveAuthHeader(io.env, executeFn);
  if (!auth.ok) return { ok: false, error: auth.error };

  const outDir = path.resolve(params.outDir);
  const created = await ensureDir(io, outDir);
  if (!created.ok) return created;

  const raw =
    params.fileName?.trim() ||
    fileNameFromAttachmentUrl(params.url) ||
    "attachment";
  const name = safeFileName(raw, "attachment");

  const result = await downloadAttachment(
    io,
    auth.header,
    params.url,
    defaults.organization,
  );
  if (!result.ok) return { ok: false, error: result.error };

  const localPath = path.join(outDir, name);
  try {
    await io.writeFile(localPath, result.buffer);
  } catch (error) {
    return {
      ok: false,
      error: `寫入檔案失敗：${localPath}（${(error as Error).message}）`,
    };
  }
  return {
    ok: true,
    message: `已下載「${name}」（${result.buffer.length} bytes）到 ${localPath}`,
    files: [{ name, url: params.url, localPath, bytes: result.buffer.length }],
    failures: [],
  };
}

/**
 * 下載 work item 的所有圖檔與附件到 <outDir>/workitem-<id>/。
 * 兩個來源都收：HTML 欄位的內嵌圖片（→ images/）與 relations 的
 * AttachedFile（→ attachments/）。內嵌圖片不會出現在 relations，
 * 只走 relations 會漏掉需求描述裡的 UI 截圖。
 */
export async function downloadWorkItemAttachments(
  io: AttachmentIo,
  executeFn: typeof execute,
  defaults: Defaults,
  params: DownloadWorkItemParams,
): Promise<DownloadFilesOutcome> {
  // $expand=all 一次帶回 fields 與 relations
  const rest = await adoRest(io, executeFn, defaults, {
    method: "GET",
    path: `_apis/wit/workitems/${params.workItemId}?$expand=all`,
  });
  if (!rest.ok) return { ok: false, error: rest.error };

  let workItem: WorkItemBody;
  try {
    workItem = JSON.parse(rest.text) as WorkItemBody;
  } catch (error) {
    return {
      ok: false,
      error: `解析 work item 回應失敗：${(error as Error).message}`,
    };
  }

  const auth = await resolveAuthHeader(io.env, executeFn);
  if (!auth.ok) return { ok: false, error: auth.error };

  const root = path.join(
    path.resolve(params.outDir),
    `workitem-${params.workItemId}`,
  );
  const files: DownloadedFile[] = [];
  const failures: string[] = [];

  // 1. HTML 欄位的內嵌圖片
  const fields = workItem.fields ?? {};
  const seen = new Set<string>();
  const inlineUrls: string[] = [];
  for (const fieldName of HTML_FIELD_NAMES) {
    for (const url of extractInlineImageUrls(fields[fieldName])) {
      if (seen.has(url)) continue;
      seen.add(url);
      inlineUrls.push(url);
    }
  }

  if (inlineUrls.length > 0) {
    const dir = path.join(root, "images");
    const created = await ensureDir(io, dir);
    if (!created.ok) return created;
    const used = new Set<string>();
    for (const url of inlineUrls) {
      const fallback = `inline-${used.size + 1}.png`;
      const name = uniqueName(
        safeFileName(fileNameFromAttachmentUrl(url) ?? fallback, fallback),
        used,
      );
      const result = await downloadAttachment(
        io,
        auth.header,
        url,
        defaults.organization,
      );
      if (!result.ok) {
        failures.push(`內嵌圖片 ${name}：${result.error}`);
        continue;
      }
      const localPath = path.join(dir, name);
      try {
        await io.writeFile(localPath, result.buffer);
      } catch (error) {
        failures.push(
          `內嵌圖片 ${name}：寫入失敗（${(error as Error).message}）`,
        );
        continue;
      }
      files.push({ name, url, localPath, bytes: result.buffer.length });
    }
  }

  // 2. relations 的 AttachedFile（不限圖片）
  const attached = (workItem.relations ?? []).filter(
    (rel): rel is { rel: string; url: string; attributes?: { name?: string } } =>
      rel.rel === "AttachedFile" && typeof rel.url === "string" && !!rel.url,
  );

  if (attached.length > 0) {
    const dir = path.join(root, "attachments");
    const created = await ensureDir(io, dir);
    if (!created.ok) return created;
    const used = new Set<string>();
    for (const rel of attached) {
      // relations 以 attributes.name 為主，URL 的 fileName 為輔
      const raw =
        rel.attributes?.name ||
        fileNameFromAttachmentUrl(rel.url) ||
        "attachment";
      const name = uniqueName(safeFileName(raw, "attachment"), used);
      const result = await downloadAttachment(
        io,
        auth.header,
        rel.url,
        defaults.organization,
      );
      if (!result.ok) {
        failures.push(`附件 ${name}：${result.error}`);
        continue;
      }
      const localPath = path.join(dir, name);
      try {
        await io.writeFile(localPath, result.buffer);
      } catch (error) {
        failures.push(`附件 ${name}：寫入失敗（${(error as Error).message}）`);
        continue;
      }
      files.push({ name, url: rel.url, localPath, bytes: result.buffer.length });
    }
  }

  if (files.length === 0 && failures.length === 0) {
    return {
      ok: true,
      message: `Work item #${params.workItemId} 沒有內嵌圖片，也沒有附件。`,
      files,
      failures,
    };
  }

  const lines = [
    `Work item #${params.workItemId} 已下載 ${files.length} 個檔案到 ${root}：`,
    ...files.map((f) => `- ${f.localPath}（${f.bytes} bytes）`),
  ];
  if (failures.length > 0) {
    lines.push(
      "",
      `以下 ${failures.length} 個項目失敗：`,
      ...failures.map((m) => `- ${m}`),
    );
  }
  return { ok: true, message: lines.join("\n"), files, failures };
}
