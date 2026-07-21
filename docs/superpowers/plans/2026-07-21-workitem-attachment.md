# az_workitem_attach 工具實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 MCP 工具 `az_workitem_attach`，一次呼叫把本機檔案（文字或 binary）上傳為 Azure DevOps work item 附件並建立連結。

**Architecture:** 兩步驟 REST 流程（POST attachments → PATCH work item relation）由 Node `fetch` 直接執行，binary 以 Buffer 處理；az CLI 只負責取 token（`AZURE_DEVOPS_EXT_PAT` 環境變數優先，否則 `az account get-access-token`）。純邏輯集中在新檔 `src/attachment.ts`，`src/server.ts` 只做工具註冊與 I/O 注入。

**Tech Stack:** TypeScript (ESM/NodeNext)、@modelcontextprotocol/sdk、zod、vitest、Node 20+ 內建 `fetch`。

**Spec:** `docs/superpowers/specs/2026-07-21-workitem-attachment-design.md`

## Global Constraints

- Node.js >= 20，TypeScript ESM，import 路徑帶 `.js` 副檔名（NodeNext）
- 不新增任何 npm 依賴
- 所有使用者可見錯誤訊息一律繁體中文，風格比照 `src/server.ts` 的 `toToolResult`
- Azure DevOps REST `api-version=7.1`；AAD resource ID 固定為 `499b84ac-1321-427f-aa17-267ca6975798`
- 附件大小上限 100MB；不做 chunked upload、不做下載/刪除附件（YAGNI）
- 測試命令：`npx vitest run`（全部測試必須通過才能 commit）
- 版本號：完成本功能後 `package.json` 與 `src/server.ts` 的 version 同步升為 `0.3.0`

---

### Task 1: URL 組裝與 json-patch body（純函式）

**Files:**
- Create: `src/attachment.ts`
- Test: `tests/attachment.test.ts`

**Interfaces:**
- Consumes: 無（純函式，僅用 Node 內建模組）
- Produces（Task 3、4 依賴）:
  - `MAX_ATTACHMENT_BYTES: number`（= 100 * 1024 * 1024）
  - `ADO_RESOURCE_ID: string`
  - `buildUploadUrl(organization: string, project: string, fileName: string): string`
  - `buildLinkUrl(organization: string, workItemId: number): string`
  - `buildLinkPatchBody(attachmentUrl: string, comment?: string): JsonPatchAdd[]`

- [ ] **Step 1: 寫失敗測試**

建立 `tests/attachment.test.ts`：

```ts
import { describe, expect, test } from "vitest";
import {
  buildLinkPatchBody,
  buildLinkUrl,
  buildUploadUrl,
  MAX_ATTACHMENT_BYTES,
} from "../src/attachment.js";

describe("attachment URL 組裝", () => {
  test("buildUploadUrl 組出 attachments POST URL 並 encode 檔名", () => {
    expect(
      buildUploadUrl("https://dev.azure.com/SKMHHIS", "MS", "審查報告 v1.md"),
    ).toBe(
      "https://dev.azure.com/SKMHHIS/MS/_apis/wit/attachments" +
        "?fileName=%E5%AF%A9%E6%9F%A5%E5%A0%B1%E5%91%8A%20v1.md&api-version=7.1",
    );
  });

  test("buildUploadUrl 對 organization 尾端斜線與 project 特殊字元防禦", () => {
    expect(
      buildUploadUrl("https://dev.azure.com/SKMHHIS/", "My Project", "a.png"),
    ).toBe(
      "https://dev.azure.com/SKMHHIS/My%20Project/_apis/wit/attachments" +
        "?fileName=a.png&api-version=7.1",
    );
  });

  test("buildLinkUrl 組出 work item PATCH URL（org 層級、不含 project）", () => {
    expect(buildLinkUrl("https://dev.azure.com/SKMHHIS", 123)).toBe(
      "https://dev.azure.com/SKMHHIS/_apis/wit/workitems/123?api-version=7.1",
    );
  });
});

describe("buildLinkPatchBody", () => {
  test("含 comment 時帶 attributes", () => {
    expect(
      buildLinkPatchBody("https://dev.azure.com/x/_apis/wit/attachments/abc", "審查結果"),
    ).toEqual([
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "AttachedFile",
          url: "https://dev.azure.com/x/_apis/wit/attachments/abc",
          attributes: { comment: "審查結果" },
        },
      },
    ]);
  });

  test("無 comment 時省略 attributes", () => {
    const [op] = buildLinkPatchBody("https://example.test/a");
    expect(op.value).toEqual({
      rel: "AttachedFile",
      url: "https://example.test/a",
    });
  });
});

test("MAX_ATTACHMENT_BYTES 為 100MB", () => {
  expect(MAX_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/attachment.test.ts`
Expected: FAIL（`Cannot find module '../src/attachment.js'` 或同義錯誤）

- [ ] **Step 3: 最小實作**

建立 `src/attachment.ts`：

```ts
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/attachment.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add src/attachment.ts tests/attachment.test.ts
git commit -m "feat: attachment URL builders and json-patch body"
```

---

### Task 2: 認證解析 resolveAuthHeader

**Files:**
- Modify: `src/attachment.ts`（附加在檔案尾端）
- Test: `tests/attachment.test.ts`（附加）

**Interfaces:**
- Consumes: `execute` 型別（`src/executor.ts` 的 `(commandLine, options) => Promise<ExecResult>`，會自動加 `az ` 前綴）、Task 1 的 `ADO_RESOURCE_ID`
- Produces（Task 3 依賴）:
  - `type AuthResult = { ok: true; header: string } | { ok: false; error: string }`
  - `resolveAuthHeader(env: NodeJS.ProcessEnv, executeFn: typeof execute): Promise<AuthResult>`

- [ ] **Step 1: 寫失敗測試**

在 `tests/attachment.test.ts` 加入（import 區塊補上 `resolveAuthHeader` 與型別）：

```ts
import type { ExecResult, ExecuteOptions } from "../src/executor.js";
import { resolveAuthHeader } from "../src/attachment.js";

function makeFakeExecutor(result: Partial<ExecResult> = {}) {
  const calls: Array<{ commandLine: string; options?: ExecuteOptions }> = [];
  const fake = (
    commandLine: string,
    options?: ExecuteOptions,
  ): Promise<ExecResult> => {
    calls.push({ commandLine, options });
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      ...result,
    });
  };
  return { fake, calls };
}

describe("resolveAuthHeader", () => {
  test("有 AZURE_DEVOPS_EXT_PAT 時用 Basic auth 且不呼叫 az", async () => {
    const { fake, calls } = makeFakeExecutor();
    const result = await resolveAuthHeader(
      { AZURE_DEVOPS_EXT_PAT: "mypat" },
      fake,
    );
    expect(result).toEqual({
      ok: true,
      header: `Basic ${Buffer.from(":mypat").toString("base64")}`,
    });
    expect(calls).toHaveLength(0);
  });

  test("無 PAT 時執行 az account get-access-token 取 Bearer token", async () => {
    const { fake, calls } = makeFakeExecutor({ stdout: "eyJtoken\n" });
    const result = await resolveAuthHeader({}, fake);
    expect(result).toEqual({ ok: true, header: "Bearer eyJtoken" });
    expect(calls[0]?.commandLine).toBe(
      "account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv",
    );
    expect(calls[0]?.options?.timeoutMs).toBe(30_000);
  });

  test("PAT 為空白字串時視同未設定，改走 az", async () => {
    const { fake, calls } = makeFakeExecutor({ stdout: "tok" });
    const result = await resolveAuthHeader({ AZURE_DEVOPS_EXT_PAT: "  " }, fake);
    expect(result).toEqual({ ok: true, header: "Bearer tok" });
    expect(calls).toHaveLength(1);
  });

  test("az 失敗時回傳中文錯誤並提示兩種認證方式", async () => {
    const { fake } = makeFakeExecutor({
      exitCode: 1,
      stderr: "ERROR: Please run 'az login'",
    });
    const result = await resolveAuthHeader({}, fake);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("az login");
      expect(result.error).toContain("AZURE_DEVOPS_EXT_PAT");
    }
  });

  test("az 成功但輸出為空時也視為失敗", async () => {
    const { fake } = makeFakeExecutor({ stdout: "  \n" });
    const result = await resolveAuthHeader({}, fake);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/attachment.test.ts`
Expected: FAIL（`resolveAuthHeader` 未匯出）

- [ ] **Step 3: 最小實作**

在 `src/attachment.ts` 檔案頂端加入 import，尾端加入：

```ts
import type { execute } from "./executor.js";
```

```ts
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/attachment.test.ts`
Expected: PASS（11 tests）

- [ ] **Step 5: Commit**

```bash
git add src/attachment.ts tests/attachment.test.ts
git commit -m "feat: auth header resolution with PAT-first, az login fallback"
```

---

### Task 3: attachFileToWorkItem 兩步驟編排

**Files:**
- Modify: `src/attachment.ts`（附加在檔案尾端）
- Test: `tests/attachment.test.ts`（附加）

**Interfaces:**
- Consumes: Task 1 的 builders、Task 2 的 `resolveAuthHeader`、`Defaults`（`src/defaults.ts`：`{ organization, project, repository }`）
- Produces（Task 4 依賴）:
  - `interface AttachmentIo { readFile(filePath: string): Promise<Buffer>; fetchFn: typeof fetch; env: NodeJS.ProcessEnv }`
  - `interface AttachParams { workItemId: number; filePath: string; comment?: string; fileName?: string }`
  - `type AttachOutcome = { ok: true; message: string } | { ok: false; error: string }`
  - `attachFileToWorkItem(io: AttachmentIo, executeFn: typeof execute, defaults: Defaults, params: AttachParams): Promise<AttachOutcome>`

- [ ] **Step 1: 寫失敗測試**

在 `tests/attachment.test.ts` 加入（import 補上 `attachFileToWorkItem`、`type AttachmentIo` 與 `BUILT_IN_DEFAULTS`）：

```ts
import { attachFileToWorkItem, type AttachmentIo } from "../src/attachment.js";
import { BUILT_IN_DEFAULTS } from "../src/defaults.js";

function makeFakeFetch(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch call");
    return next;
  }) as typeof fetch;
  return { fetchFn, calls };
}

function makeIo(
  fetchFn: typeof fetch,
  overrides: Partial<AttachmentIo> = {},
): AttachmentIo {
  return {
    readFile: async () => Buffer.from([0x00, 0x9f, 0x92, 0x96]), // 非合法 UTF-8 的 binary
    fetchFn,
    env: { AZURE_DEVOPS_EXT_PAT: "pat" },
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const UPLOAD_OK = () =>
  jsonResponse(201, {
    id: "abc",
    url: "https://dev.azure.com/SKMHHIS/_apis/wit/attachments/abc",
  });

describe("attachFileToWorkItem", () => {
  test("成功：POST binary 原樣送出，再 PATCH 連結，回傳附件 URL", async () => {
    const { fetchFn, calls } = makeFakeFetch([UPLOAD_OK(), jsonResponse(200, { id: 42 })]);
    const io = makeIo(fetchFn);
    const result = await attachFileToWorkItem(io, async () => {
      throw new Error("PAT 模式不應呼叫 az");
    }, BUILT_IN_DEFAULTS, { workItemId: 42, filePath: "D:\\tmp\\shot.png" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toContain("shot.png");
      expect(result.message).toContain("#42");
      expect(result.message).toContain("/_apis/wit/attachments/abc");
    }
    // 第一步：上傳
    expect(calls[0]?.url).toBe(
      "https://dev.azure.com/SKMHHIS/MS/_apis/wit/attachments?fileName=shot.png&api-version=7.1",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(
      (calls[0]?.init.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/octet-stream");
    // binary Buffer 原樣傳給 fetch，不經任何字串轉換
    expect(calls[0]?.init.body).toEqual(Buffer.from([0x00, 0x9f, 0x92, 0x96]));
    // 第二步：連結
    expect(calls[1]?.url).toBe(
      "https://dev.azure.com/SKMHHIS/_apis/wit/workitems/42?api-version=7.1",
    );
    expect(calls[1]?.init.method).toBe("PATCH");
    expect(
      (calls[1]?.init.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/json-patch+json");
    expect(JSON.parse(String(calls[1]?.init.body))[0].value.rel).toBe(
      "AttachedFile",
    );
  });

  test("fileName 參數覆寫附件名稱", async () => {
    const { fetchFn, calls } = makeFakeFetch([UPLOAD_OK(), jsonResponse(200, {})]);
    await attachFileToWorkItem(makeIo(fetchFn), async () => {
      throw new Error("不應呼叫 az");
    }, BUILT_IN_DEFAULTS, {
      workItemId: 1,
      filePath: "D:\\tmp\\x.bin",
      fileName: "報告.bin",
      comment: "自動上傳",
    });
    expect(calls[0]?.url).toContain(
      `fileName=${encodeURIComponent("報告.bin")}`,
    );
    expect(JSON.parse(String(calls[1]?.init.body))[0].value.attributes).toEqual(
      { comment: "自動上傳" },
    );
  });

  test("檔案不存在：不發任何 API", async () => {
    const { fetchFn, calls } = makeFakeFetch([]);
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    const io = makeIo(fetchFn, { readFile: async () => { throw enoent; } });
    const result = await attachFileToWorkItem(io, async () => {
      throw new Error("不應呼叫 az");
    }, BUILT_IN_DEFAULTS, { workItemId: 1, filePath: "D:\\nope.txt" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("找不到檔案");
    expect(calls).toHaveLength(0);
  });

  test("路徑是目錄：明確錯誤", async () => {
    const { fetchFn } = makeFakeFetch([]);
    const eisdir = Object.assign(new Error("is a dir"), { code: "EISDIR" });
    const io = makeIo(fetchFn, { readFile: async () => { throw eisdir; } });
    const result = await attachFileToWorkItem(io, async () => {
      throw new Error("不應呼叫 az");
    }, BUILT_IN_DEFAULTS, { workItemId: 1, filePath: "D:\\dir" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("目錄");
  });

  test("超過 100MB：拒絕且不發 API", async () => {
    const { fetchFn, calls } = makeFakeFetch([]);
    const io = makeIo(fetchFn, {
      readFile: async () => Buffer.alloc(100 * 1024 * 1024 + 1),
    });
    const result = await attachFileToWorkItem(io, async () => {
      throw new Error("不應呼叫 az");
    }, BUILT_IN_DEFAULTS, { workItemId: 1, filePath: "D:\\big.zip" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("100MB");
    expect(calls).toHaveLength(0);
  });

  test("上傳收到 203（PAT 無效的 HTML 登入頁）視為認證失敗", async () => {
    const { fetchFn } = makeFakeFetch([new Response("<html>", { status: 203 })]);
    const result = await attachFileToWorkItem(
      makeIo(fetchFn),
      async () => { throw new Error("不應呼叫 az"); },
      BUILT_IN_DEFAULTS,
      { workItemId: 1, filePath: "D:\\a.txt" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("認證");
  });

  test("PATCH 404：指出 work item 不存在，並附上已上傳的附件 URL", async () => {
    const { fetchFn } = makeFakeFetch([
      UPLOAD_OK(),
      new Response("not found", { status: 404 }),
    ]);
    const result = await attachFileToWorkItem(
      makeIo(fetchFn),
      async () => { throw new Error("不應呼叫 az"); },
      BUILT_IN_DEFAULTS,
      { workItemId: 999999, filePath: "D:\\a.txt" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("999999");
      expect(result.error).toContain("/_apis/wit/attachments/abc");
    }
  });

  test("PATCH 非 404 失敗：錯誤含 HTTP 狀態與附件 URL", async () => {
    const { fetchFn } = makeFakeFetch([
      UPLOAD_OK(),
      new Response("rule violation", { status: 400 }),
    ]);
    const result = await attachFileToWorkItem(
      makeIo(fetchFn),
      async () => { throw new Error("不應呼叫 az"); },
      BUILT_IN_DEFAULTS,
      { workItemId: 1, filePath: "D:\\a.txt" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("400");
      expect(result.error).toContain("/_apis/wit/attachments/abc");
    }
  });

  test("fetch 拋出網路錯誤：回傳中文錯誤", async () => {
    const fetchFn = (async () => {
      throw new Error("getaddrinfo ENOTFOUND dev.azure.com");
    }) as unknown as typeof fetch;
    const result = await attachFileToWorkItem(
      makeIo(fetchFn),
      async () => { throw new Error("不應呼叫 az"); },
      BUILT_IN_DEFAULTS,
      { workItemId: 1, filePath: "D:\\a.txt" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("網路錯誤");
  });

  test("上傳回應缺少 url 欄位：解析錯誤", async () => {
    const { fetchFn } = makeFakeFetch([jsonResponse(201, { id: "abc" })]);
    const result = await attachFileToWorkItem(
      makeIo(fetchFn),
      async () => { throw new Error("不應呼叫 az"); },
      BUILT_IN_DEFAULTS,
      { workItemId: 1, filePath: "D:\\a.txt" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("解析");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/attachment.test.ts`
Expected: FAIL（`attachFileToWorkItem` 未匯出）

- [ ] **Step 3: 實作**

在 `src/attachment.ts` 頂端補 import：

```ts
import path from "node:path";
import type { Defaults } from "./defaults.js";
```

檔案尾端加入：

```ts
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
      body: buffer,
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/attachment.test.ts`
Expected: PASS（21 tests）

- [ ] **Step 5: 跑全部測試**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/attachment.ts tests/attachment.test.ts
git commit -m "feat: two-step attach orchestration with binary-safe upload"
```

---

### Task 4: server 註冊 az_workitem_attach 工具 + 版本升 0.3.0

**Files:**
- Modify: `src/server.ts`
- Modify: `package.json`（version 欄位）
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `attachFileToWorkItem`、`AttachmentIo`
- Produces: `createServer(executeFn?, defaults?, io?: AttachmentIo)` — 第三個參數選填，預設用真實 `fs.readFile`/全域 `fetch`/`process.env`；`src/index.ts` 不需改動

- [ ] **Step 1: 寫失敗測試**

修改 `tests/server.test.ts`：

(a) 既有「列出兩個工具」測試改名並更新期望：

```ts
  test("列出三個工具", async () => {
    const { fake } = makeFakeExecutor();
    const client = await connect(fake);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "az_devops",
      "az_devops_help",
      "az_workitem_attach",
    ]);
  });
```

(b) `connect` helper 加上選填 `io` 參數（import 補 `type AttachmentIo` from `../src/attachment.js`）：

```ts
async function connect(
  executeFn: ReturnType<typeof makeFakeExecutor>["fake"],
  defaults: Defaults = BUILT_IN_DEFAULTS,
  io?: AttachmentIo,
) {
  const server = createServer(executeFn, defaults, io);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}
```

(c) describe 區塊尾端加入新測試：

```ts
  test("az_workitem_attach 成功上傳並回報附件 URL", async () => {
    const { fake } = makeFakeExecutor();
    const responses = [
      new Response(
        JSON.stringify({
          id: "abc",
          url: "https://dev.azure.com/SKMHHIS/_apis/wit/attachments/abc",
        }),
        { status: 201 },
      ),
      new Response("{}", { status: 200 }),
    ];
    const io: AttachmentIo = {
      readFile: async () => Buffer.from("報告內容"),
      fetchFn: (async () => responses.shift()!) as typeof fetch,
      env: { AZURE_DEVOPS_EXT_PAT: "pat" },
    };
    const client = await connect(fake, BUILT_IN_DEFAULTS, io);
    const result = await client.callTool({
      name: "az_workitem_attach",
      arguments: { workItemId: 42, filePath: "D:\\tmp\\report.md" },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("report.md");
    expect(textOf(result)).toContain("#42");
  });

  test("az_workitem_attach 失敗時標記 isError", async () => {
    const { fake } = makeFakeExecutor();
    const enoent = Object.assign(new Error("no such file"), {
      code: "ENOENT",
    });
    const io: AttachmentIo = {
      readFile: async () => { throw enoent; },
      fetchFn: (async () => new Response("{}")) as typeof fetch,
      env: { AZURE_DEVOPS_EXT_PAT: "pat" },
    };
    const client = await connect(fake, BUILT_IN_DEFAULTS, io);
    const result = await client.callTool({
      name: "az_workitem_attach",
      arguments: { workItemId: 1, filePath: "D:\\nope.md" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("找不到檔案");
  });

  test("az_workitem_attach 工具描述內嵌預設 org/project", async () => {
    const { fake } = makeFakeExecutor();
    const client = await connect(fake);
    const { tools } = await client.listTools();
    const attach = tools.find((t) => t.name === "az_workitem_attach");
    expect(attach?.description).toContain("https://dev.azure.com/SKMHHIS");
    expect(attach?.description).toContain("MS");
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL（工具數量不符、`az_workitem_attach` 不存在）

- [ ] **Step 3: 實作 server 註冊**

修改 `src/server.ts`：

(a) 頂端 import 加入：

```ts
import { readFile } from "node:fs/promises";
import {
  attachFileToWorkItem,
  type AttachmentIo,
} from "./attachment.js";
```

(b) `createServer` 簽名加第三個參數：

```ts
export function createServer(
  executeFn: typeof execute = execute,
  defaults: Defaults = BUILT_IN_DEFAULTS,
  io: AttachmentIo = { readFile, fetchFn: fetch, env: process.env },
): McpServer {
```

(c) `McpServer` 建構的 version 改為 `"0.3.0"`。

(d) 在 `return server;` 前註冊新工具：

```ts
  server.registerTool(
    "az_workitem_attach",
    {
      title: "上傳附件到 Work Item",
      description:
        "將本機檔案上傳為 Azure DevOps work item 附件並建立連結" +
        "（純文字與 binary 檔皆可，上限 100MB）。" +
        `預設 organization 為 ${defaults.organization}、project 為 ${defaults.project}。` +
        "認證優先使用 AZURE_DEVOPS_EXT_PAT 環境變數，否則使用 az login 的憑證。",
      inputSchema: {
        workItemId: z
          .number()
          .int()
          .positive()
          .describe("目標 work item ID"),
        filePath: z.string().describe("本機檔案的絕對路徑"),
        comment: z
          .string()
          .optional()
          .describe("附件備註，顯示在 work item 附件上"),
        fileName: z
          .string()
          .optional()
          .describe("覆寫附件顯示名稱，預設取 filePath 的檔名"),
      },
    },
    async (params) => {
      const outcome = await attachFileToWorkItem(
        io,
        executeFn,
        defaults,
        params,
      );
      if (!outcome.ok) {
        return {
          content: [{ type: "text", text: truncateOutput(outcome.error) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: truncateOutput(outcome.message) }],
      };
    },
  );
```

(e) `package.json` 的 `"version": "0.2.0"` 改為 `"0.3.0"`。

- [ ] **Step 4: 跑全部測試確認通過**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 5: 確認 build 通過**

Run: `npm run build`
Expected: tsc 無錯誤

- [ ] **Step 6: Commit**

```bash
git add src/server.ts package.json tests/server.test.ts
git commit -m "feat: register az_workitem_attach tool and bump to 0.3.0"
```

---

### Task 5: README 更新

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 4 完成後的工具行為
- Produces: 使用者文件

- [ ] **Step 1: 更新工具表格與認證說明**

`README.md` 的「## 工具」表格加一列（在 `az_devops_help` 之後）：

```markdown
| `az_workitem_attach` | 上傳本機檔案為 work item 附件並建立連結（文字與 binary 皆可，上限 100MB）。例如把 code review 報告或錯誤截圖附到 work item。 |
```

同節「認證完全依賴本機的 `az login`，server 不儲存任何憑證。」改為：

```markdown
僅允許 `devops`、`repos`、`boards`、`pipelines`、`artifacts` 五個命令群組；
其餘 az 命令（如 `vm`、`account`）一律拒絕。認證依賴本機的 `az login`
（`az_workitem_attach` 會內部執行 `az account get-access-token` 取 token；
若設定了 `AZURE_DEVOPS_EXT_PAT` 環境變數則優先使用該 PAT），
server 不儲存任何憑證。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document az_workitem_attach tool and auth notes"
```

---

## 驗證（實機，選做）

實作完成後可用 smoke 方式實測（需 `az login` 且對 org 有權限）：

```bash
npm run build
echo test-content > %TEMP%\attach-test.txt
```

用 MCP client（或暫時在 `scripts/smoke.mjs` 加一段）呼叫
`az_workitem_attach`，`arguments: { workItemId: <真實ID>, filePath: "<上面的檔案>" }`，
到 Azure DevOps 網頁確認 work item 附件出現且內容正確；
再用一張 PNG 測 binary，下載回來比對檔案大小一致。
