# Azure DevOps REST 工具擴充實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 為 azure-devops-cli-mcp 新增七個 REST 工具（四讀、二寫、一通用 fallback），讓 skh-ms-web-pr-review skill 的全部 Azure DevOps 動作都能經由 MCP 完成。

**Architecture:** 專用工具優先、通用 `az_rest` fallback。共用認證抽到 `src/auth.ts`（PAT 優先、az login fallback，自 attachment.ts 抽出且 re-export 保持相容）；`src/rest.ts` 提供 `adoRest` 核心（URL 鎖定 organization、自動補 api-version、Content-Type 推斷、統一錯誤映射）；PR 與 work item 的路徑組裝／編排邏輯分別放 `src/pullRequest.ts` 與 `src/workItem.ts`，server.ts 只做工具註冊與輸出轉換。

**Tech Stack:** TypeScript（strict、ESM、NodeNext）、`@modelcontextprotocol/sdk`、`zod`、`vitest`、Node.js >= 20（fetch、AbortSignal.timeout 為內建）

**Spec:** `docs/superpowers/specs/2026-07-21-ado-rest-tools-design.md`

## Global Constraints

- 版本 0.3.0 → **0.4.0**（`package.json` 與 `src/server.ts` 的 `McpServer` version 都要改）
- REST URL 一律由 server 組合：`{defaults.organization}/{path}`；拒絕絕對 URL（`http://`、`https://`、`//` 開頭）與路徑段 `..`
- 未帶 `api-version` 時自動補 `api-version=7.1`
- Content-Type 自動推斷：PATCH 且 path 含 `_apis/wit/workitems` → `application/json-patch+json`，其餘有 body 時 → `application/json`；可用參數覆寫
- 認證：`AZURE_DEVOPS_EXT_PAT` 優先（Basic），否則 `az account get-access-token`（Bearer）；401/403/203 視為認證失敗
- 所有工具輸出經 `truncateOutput`（50KB 截斷）；錯誤以 `isError: true` 回傳，不中斷 MCP 協定
- REST 預設逾時 120 秒（`AbortSignal.timeout`）
- 既有三個工具（`az_devops`、`az_devops_help`、`az_workitem_attach`）行為不變；重構後既有 92 個測試必須維持全綠
- src 內相對 import 一律用 `.js` 副檔名（NodeNext 規則）
- 錯誤與工具描述文字使用繁體中文，風格比照現有工具

---

### Task 1: 抽出共用認證模組 `src/auth.ts`（重構，不改行為）

**Files:**
- Create: `src/auth.ts`
- Modify: `src/attachment.ts`

**Interfaces:**
- Consumes: `execute`（`src/executor.js`）
- Produces（Task 2 起使用）:
  - `ADO_RESOURCE_ID: string`、`API_VERSION: string`（`"7.1"`）、`AUTH_HINT: string`
  - `type AuthResult = { ok: true; header: string } | { ok: false; error: string }`
  - `resolveAuthHeader(env: NodeJS.ProcessEnv, executeFn: typeof execute): Promise<AuthResult>`
  - `isAuthFailure(status: number): boolean`
  - `readBodySnippet(res: Response): Promise<string>`
- 相容性要求：`src/attachment.ts` 必須 re-export `resolveAuthHeader` 與 `ADO_RESOURCE_ID`（`tests/attachment.test.ts` 從 `../src/attachment.js` import）

此 task 是純重構，以既有測試為安全網，不新增測試。

- [ ] **Step 1: 建立 `src/auth.ts`**

內容自 attachment.ts 搬移（`AUTH_HINT` 原為模組私有常數，改為 export）：

```ts
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
```

注意：原 attachment.ts 的錯誤訊息寫「PAT 需有 Work Items Read & Write scope」，抽共用後改為通用的「對應的 read/write scope」（REST 工具也會用到 Code scope）。已確認 `tests/attachment.test.ts` 對錯誤訊息只斷言「認證」子字串（`tests/attachment.test.ts:272`），此文案調整不會弄破既有測試；401/403/203 的判斷行為不可變。

- [ ] **Step 2: 修改 `src/attachment.ts` 改用共用模組**

刪除 attachment.ts 中的 `ADO_RESOURCE_ID`、`API_VERSION`、`AuthResult`、`resolveAuthHeader`、`AUTH_HINT`、`isAuthFailure`、`readBodySnippet` 定義，改為：

```ts
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

export { ADO_RESOURCE_ID, resolveAuthHeader, type AuthResult } from "./auth.js";

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
```

（其餘 `buildUploadUrl`、`buildLinkUrl`、`buildLinkPatchBody`、`AttachmentIo`、`attachFileToWorkItem` 等維持原樣不動。）

- [ ] **Step 3: 執行全部測試確認重構無破壞**

Run: `npx vitest run`
Expected: PASS（5 個測試檔、92 個測試全綠）

- [ ] **Step 4: Commit**

```bash
git add src/auth.ts src/attachment.ts
git commit -m "refactor: extract shared ADO auth helpers into auth.ts"
```

---

### Task 2: REST 核心模組 `src/rest.ts`

**Files:**
- Create: `src/rest.ts`
- Test: `tests/rest.test.ts`

**Interfaces:**
- Consumes: `resolveAuthHeader`、`isAuthFailure`、`readBodySnippet`、`AUTH_HINT`、`API_VERSION`（`src/auth.js`，Task 1）；`Defaults`（`src/defaults.js`）；`execute`（`src/executor.js`）
- Produces（Task 3–6 使用）:
  - `type RestMethod = "GET" | "POST" | "PATCH"`
  - `interface RestIo { fetchFn: typeof fetch; env: NodeJS.ProcessEnv }`
  - `interface RestRequest { method: RestMethod; path: string; body?: unknown; contentType?: string; timeoutMs?: number }`
  - `type RestOutcome = { ok: true; status: number; text: string } | { ok: false; error: string }`
  - `buildRestUrl(organization: string, path: string): { ok: true; url: string } | { ok: false; error: string }`
  - `inferContentType(method: RestMethod, path: string): string`
  - `adoRest(io: RestIo, executeFn: typeof execute, defaults: Defaults, req: RestRequest): Promise<RestOutcome>`

- [ ] **Step 1: 寫失敗的測試 `tests/rest.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import {
  adoRest,
  buildRestUrl,
  inferContentType,
  type RestIo,
} from "../src/rest.js";
import { BUILT_IN_DEFAULTS } from "../src/defaults.js";
import type { ExecResult, ExecuteOptions } from "../src/executor.js";

const ORG = "https://dev.azure.com/SKMHHIS";

function noopExecutor(
  _commandLine: string,
  _options?: ExecuteOptions,
): Promise<ExecResult> {
  return Promise.resolve({ stdout: "", stderr: "", exitCode: 1, timedOut: false });
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function makeIo(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  env: NodeJS.ProcessEnv = { AZURE_DEVOPS_EXT_PAT: "pat" },
) {
  const calls: FetchCall[] = [];
  const io: RestIo = {
    fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }) as typeof fetch,
    env,
  };
  return { io, calls };
}

describe("buildRestUrl", () => {
  test("無 query 時補 ?api-version=7.1", () => {
    expect(buildRestUrl(ORG, "MS/_apis/git/repositories/MS-Web/pullRequests/1")).toEqual({
      ok: true,
      url: `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/1?api-version=7.1`,
    });
  });

  test("已有 query 時用 & 補 api-version", () => {
    expect(buildRestUrl(ORG, "_apis/wit/workitems/9?$expand=relations")).toEqual({
      ok: true,
      url: `${ORG}/_apis/wit/workitems/9?$expand=relations&api-version=7.1`,
    });
  });

  test("已含 api-version 時不重複附加", () => {
    expect(buildRestUrl(ORG, "MS/_apis/x?api-version=7.2-preview")).toEqual({
      ok: true,
      url: `${ORG}/MS/_apis/x?api-version=7.2-preview`,
    });
  });

  test("去除 path 開頭的斜線與 organization 尾端斜線", () => {
    expect(buildRestUrl(`${ORG}/`, "/MS/_apis/x")).toEqual({
      ok: true,
      url: `${ORG}/MS/_apis/x?api-version=7.1`,
    });
  });

  test("拒絕絕對 URL", () => {
    const result = buildRestUrl(ORG, "https://evil.example.com/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("相對路徑");
  });

  test("拒絕 // 開頭（protocol-relative URL）", () => {
    expect(buildRestUrl(ORG, "//evil.example.com/x").ok).toBe(false);
  });

  test("拒絕路徑段中的 ..", () => {
    expect(buildRestUrl(ORG, "MS/../other/_apis/x").ok).toBe(false);
  });
});

describe("inferContentType", () => {
  test("PATCH 到 wit/workitems 用 json-patch+json", () => {
    expect(inferContentType("PATCH", "_apis/wit/workitems/9")).toBe(
      "application/json-patch+json",
    );
  });

  test("POST 用 application/json", () => {
    expect(
      inferContentType("POST", "MS/_apis/git/repositories/MS-Web/pullRequests/1/threads"),
    ).toBe("application/json");
  });

  test("PATCH 到非 workitems 端點用 application/json", () => {
    expect(inferContentType("PATCH", "MS/_apis/git/repositories/MS-Web/pullRequests/1")).toBe(
      "application/json",
    );
  });
});

describe("adoRest", () => {
  test("GET 成功回傳 status 與 text，帶 PAT Basic 認證", async () => {
    const { io, calls } = makeIo(() => new Response('{"id": 1}', { status: 200 }));
    const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "MS/_apis/x",
    });
    expect(result).toEqual({ ok: true, status: 200, text: '{"id": 1}' });
    expect(calls[0]?.url).toBe(`${ORG}/MS/_apis/x?api-version=7.1`);
    expect(calls[0]?.init?.method).toBe("GET");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(":pat").toString("base64")}`,
    );
    expect(headers["Content-Type"]).toBeUndefined();
  });

  test("無 PAT 時經 executor 取 token 用 Bearer", async () => {
    const executorCalls: string[] = [];
    const tokenExecutor = (
      commandLine: string,
      _options?: ExecuteOptions,
    ): Promise<ExecResult> => {
      executorCalls.push(commandLine);
      return Promise.resolve({
        stdout: "token123\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
    };
    const { io, calls } = makeIo(() => new Response("{}", { status: 200 }), {});
    const result = await adoRest(io, tokenExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "MS/_apis/x",
    });
    expect(result.ok).toBe(true);
    expect(executorCalls[0]).toContain("account get-access-token");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token123");
  });

  test("物件 body 序列化為 JSON 並帶推斷的 Content-Type", async () => {
    const { io, calls } = makeIo(() => new Response("{}", { status: 200 }));
    await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "PATCH",
      path: "_apis/wit/workitems/9",
      body: [{ op: "add", path: "/fields/System.State", value: "Resolved" }],
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json-patch+json");
    expect(calls[0]?.init?.body).toBe(
      '[{"op":"add","path":"/fields/System.State","value":"Resolved"}]',
    );
  });

  test("字串 body 原樣傳遞，contentType 可覆寫", async () => {
    const { io, calls } = makeIo(() => new Response("{}", { status: 200 }));
    await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "POST",
      path: "MS/_apis/x",
      body: '{"a":1}',
      contentType: "application/custom+json",
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/custom+json");
    expect(calls[0]?.init?.body).toBe('{"a":1}');
  });

  test("GET 帶 body 直接拒絕，不發出請求", async () => {
    const { io, calls } = makeIo(() => new Response("{}", { status: 200 }));
    const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "MS/_apis/x",
      body: "{}",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("GET");
    expect(calls).toHaveLength(0);
  });

  test("認證失敗（401/203）回傳認證提示", async () => {
    for (const status of [401, 203]) {
      const { io } = makeIo(() => new Response("denied", { status }));
      const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
        method: "GET",
        path: "MS/_apis/x",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("az login");
    }
  });

  test("404 回傳資源不存在", async () => {
    const { io } = makeIo(() => new Response("not found", { status: 404 }));
    const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "MS/_apis/x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("404");
  });

  test("其他非 2xx 回傳 HTTP 狀態與 body 片段", async () => {
    const { io } = makeIo(() => new Response("server broke", { status: 500 }));
    const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "MS/_apis/x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("500");
      expect(result.error).toContain("server broke");
    }
  });

  test("網路錯誤回傳錯誤訊息", async () => {
    const { io } = makeIo(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "MS/_apis/x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
  });

  test("path 不合法時不發出請求", async () => {
    const { io, calls } = makeIo(() => new Response("{}", { status: 200 }));
    const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "https://evil.example.com/x",
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/rest.test.ts`
Expected: FAIL — `Cannot find module '../src/rest.js'`

- [ ] **Step 3: 實作 `src/rest.ts`**

```ts
import type { execute } from "./executor.js";
import type { Defaults } from "./defaults.js";
import {
  API_VERSION,
  AUTH_HINT,
  isAuthFailure,
  readBodySnippet,
  resolveAuthHeader,
} from "./auth.js";

export type RestMethod = "GET" | "POST" | "PATCH";

export interface RestIo {
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
}

export interface RestRequest {
  method: RestMethod;
  path: string;
  body?: unknown;
  contentType?: string;
  timeoutMs?: number;
}

export type RestOutcome =
  | { ok: true; status: number; text: string }
  | { ok: false; error: string };

const DEFAULT_REST_TIMEOUT_MS = 120_000;

export function buildRestUrl(
  organization: string,
  path: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = path.trim().replace(/^\/+/, "");
  if (/^https?:\/\//i.test(path.trim()) || path.trim().startsWith("//")) {
    return {
      ok: false,
      error:
        "path 必須是 organization 之後的相對路徑（例如 " +
        '"MS/_apis/git/repositories/MS-Web/pullRequests/1"），不可為絕對 URL。',
    };
  }
  const [pathPart] = trimmed.split("?");
  if (pathPart.split("/").some((segment) => segment === "..")) {
    return { ok: false, error: "path 不可包含路徑穿越（..）。" };
  }
  const base = organization.replace(/\/+$/, "");
  let url = `${base}/${trimmed}`;
  if (!/[?&]api-version=/.test(trimmed)) {
    url += (trimmed.includes("?") ? "&" : "?") + `api-version=${API_VERSION}`;
  }
  return { ok: true, url };
}

export function inferContentType(method: RestMethod, path: string): string {
  if (method === "PATCH" && path.includes("_apis/wit/workitems")) {
    return "application/json-patch+json";
  }
  return "application/json";
}

export async function adoRest(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  req: RestRequest,
): Promise<RestOutcome> {
  const built = buildRestUrl(defaults.organization, req.path);
  if (!built.ok) return built;
  if (req.method === "GET" && req.body !== undefined) {
    return { ok: false, error: "GET 請求不可帶 body。" };
  }

  const auth = await resolveAuthHeader(io.env, executeFn);
  if (!auth.ok) return { ok: false, error: auth.error };

  const headers: Record<string, string> = { Authorization: auth.header };
  let body: string | undefined;
  if (req.body !== undefined) {
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    headers["Content-Type"] =
      req.contentType ?? inferContentType(req.method, req.path);
  }

  let res: Response;
  try {
    res = await io.fetchFn(built.url, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_REST_TIMEOUT_MS),
    });
  } catch (error) {
    const err = error as Error;
    if (err.name === "TimeoutError") {
      return { ok: false, error: "REST 呼叫逾時，可調高 timeout 參數。" };
    }
    return { ok: false, error: `REST 呼叫網路錯誤：${err.message}` };
  }

  if (isAuthFailure(res.status)) return { ok: false, error: AUTH_HINT };
  if (res.status === 404) {
    return {
      ok: false,
      error: `資源不存在（HTTP 404）：${await readBodySnippet(res)}`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `REST 呼叫失敗（HTTP ${res.status}）：${await readBodySnippet(res)}`,
    };
  }
  return { ok: true, status: res.status, text: await res.text() };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run tests/rest.test.ts`
Expected: PASS（全部綠燈）

- [ ] **Step 5: 全部測試 + Commit**

Run: `npx vitest run`
Expected: PASS

```bash
git add src/rest.ts tests/rest.test.ts
git commit -m "feat: add adoRest core with org-locked URL building and error mapping"
```

---

### Task 3: PR 讀取函式（`src/pullRequest.ts`：show / changes / workitems）

**Files:**
- Create: `src/pullRequest.ts`
- Test: `tests/pullRequest.test.ts`

**Interfaces:**
- Consumes: `adoRest`、`RestIo`、`RestOutcome`（`src/rest.js`，Task 2）；`Defaults`；`execute`
- Produces（Task 4、6 使用）:
  - `interface PrTarget { prNumber: number; project?: string; repository?: string }`
  - `prBasePath(defaults: Defaults, target: PrTarget): string`
  - `showPullRequest(io: RestIo, executeFn: typeof execute, defaults: Defaults, target: PrTarget): Promise<RestOutcome>`
  - `listPullRequestWorkItems(io, executeFn, defaults, target: PrTarget): Promise<RestOutcome>`
  - `getPullRequestChanges(io, executeFn, defaults, params: PrTarget & { iterationId?: number }): Promise<RestOutcome>`

- [ ] **Step 1: 寫失敗的測試 `tests/pullRequest.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import {
  getPullRequestChanges,
  listPullRequestWorkItems,
  prBasePath,
  showPullRequest,
} from "../src/pullRequest.js";
import type { RestIo } from "../src/rest.js";
import { BUILT_IN_DEFAULTS } from "../src/defaults.js";
import type { ExecResult, ExecuteOptions } from "../src/executor.js";

const ORG = "https://dev.azure.com/SKMHHIS";

function noopExecutor(
  _commandLine: string,
  _options?: ExecuteOptions,
): Promise<ExecResult> {
  return Promise.resolve({ stdout: "", stderr: "", exitCode: 1, timedOut: false });
}

function makeIo(handlers: Array<(url: string) => Response>) {
  const urls: string[] = [];
  const io: RestIo = {
    fetchFn: (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      const handler = handlers.shift();
      if (!handler) throw new Error("unexpected extra fetch call");
      return handler(String(url));
    }) as typeof fetch,
    env: { AZURE_DEVOPS_EXT_PAT: "pat" },
  };
  return { io, urls };
}

describe("prBasePath", () => {
  test("預設 project/repository 並 encode", () => {
    expect(prBasePath(BUILT_IN_DEFAULTS, { prNumber: 104117 })).toBe(
      "MS/_apis/git/repositories/MS-Web/pullRequests/104117",
    );
  });

  test("可覆寫 project/repository", () => {
    expect(
      prBasePath(BUILT_IN_DEFAULTS, {
        prNumber: 5,
        project: "My Proj",
        repository: "R 2",
      }),
    ).toBe("My%20Proj/_apis/git/repositories/R%202/pullRequests/5");
  });
});

describe("showPullRequest", () => {
  test("GET PR 資訊", async () => {
    const { io, urls } = makeIo([
      () => new Response('{"pullRequestId":104117,"targetRefName":"refs/heads/master"}', { status: 200 }),
    ]);
    const result = await showPullRequest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      prNumber: 104117,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain("targetRefName");
    expect(urls[0]).toBe(
      `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/104117?api-version=7.1`,
    );
  });
});

describe("listPullRequestWorkItems", () => {
  test("GET 關聯 work items", async () => {
    const { io, urls } = makeIo([
      () => new Response('{"count":1,"value":[{"id":"42"}]}', { status: 200 }),
    ]);
    const result = await listPullRequestWorkItems(io, noopExecutor, BUILT_IN_DEFAULTS, {
      prNumber: 104117,
    });
    expect(result.ok).toBe(true);
    expect(urls[0]).toBe(
      `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/104117/workitems?api-version=7.1`,
    );
  });
});

describe("getPullRequestChanges", () => {
  test("未指定 iteration 時先取最新 iteration 再取 changes", async () => {
    const { io, urls } = makeIo([
      () =>
        new Response('{"count":2,"value":[{"id":1},{"id":2}]}', { status: 200 }),
      () =>
        new Response('{"changeEntries":[{"item":{"path":"/a.cs"}}]}', {
          status: 200,
        }),
    ]);
    const result = await getPullRequestChanges(io, noopExecutor, BUILT_IN_DEFAULTS, {
      prNumber: 104117,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("[iterationId: 2]");
      expect(result.text).toContain("changeEntries");
    }
    expect(urls[0]).toBe(
      `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/104117/iterations?api-version=7.1`,
    );
    expect(urls[1]).toBe(
      `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/104117/iterations/2/changes?api-version=7.1`,
    );
  });

  test("指定 iterationId 時直接取 changes", async () => {
    const { io, urls } = makeIo([
      () => new Response('{"changeEntries":[]}', { status: 200 }),
    ]);
    const result = await getPullRequestChanges(io, noopExecutor, BUILT_IN_DEFAULTS, {
      prNumber: 104117,
      iterationId: 3,
    });
    expect(result.ok).toBe(true);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/iterations/3/changes");
  });

  test("iterations 為空時回傳明確錯誤", async () => {
    const { io } = makeIo([
      () => new Response('{"count":0,"value":[]}', { status: 200 }),
    ]);
    const result = await getPullRequestChanges(io, noopExecutor, BUILT_IN_DEFAULTS, {
      prNumber: 104117,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("iteration");
  });

  test("iterations 呼叫失敗時直接回傳該錯誤", async () => {
    const { io } = makeIo([() => new Response("nope", { status: 404 })]);
    const result = await getPullRequestChanges(io, noopExecutor, BUILT_IN_DEFAULTS, {
      prNumber: 99999,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("404");
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/pullRequest.test.ts`
Expected: FAIL — `Cannot find module '../src/pullRequest.js'`

- [ ] **Step 3: 實作 `src/pullRequest.ts`（本 task 只含讀取部分）**

```ts
import type { execute } from "./executor.js";
import type { Defaults } from "./defaults.js";
import { adoRest, type RestIo, type RestOutcome } from "./rest.js";

export interface PrTarget {
  prNumber: number;
  project?: string;
  repository?: string;
}

export function prBasePath(defaults: Defaults, target: PrTarget): string {
  const project = encodeURIComponent(target.project ?? defaults.project);
  const repository = encodeURIComponent(
    target.repository ?? defaults.repository,
  );
  return `${project}/_apis/git/repositories/${repository}/pullRequests/${target.prNumber}`;
}

export function showPullRequest(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  target: PrTarget,
): Promise<RestOutcome> {
  return adoRest(io, executeFn, defaults, {
    method: "GET",
    path: prBasePath(defaults, target),
  });
}

export function listPullRequestWorkItems(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  target: PrTarget,
): Promise<RestOutcome> {
  return adoRest(io, executeFn, defaults, {
    method: "GET",
    path: `${prBasePath(defaults, target)}/workitems`,
  });
}

export async function getPullRequestChanges(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  params: PrTarget & { iterationId?: number },
): Promise<RestOutcome> {
  const base = prBasePath(defaults, params);
  let iterationId = params.iterationId;
  if (iterationId === undefined) {
    const iterations = await adoRest(io, executeFn, defaults, {
      method: "GET",
      path: `${base}/iterations`,
    });
    if (!iterations.ok) return iterations;
    let ids: number[];
    try {
      const parsed = JSON.parse(iterations.text) as {
        value?: Array<{ id?: number }>;
      };
      ids = (parsed.value ?? [])
        .map((it) => it.id)
        .filter((id): id is number => typeof id === "number");
    } catch (error) {
      return {
        ok: false,
        error: `解析 iterations 回應失敗：${(error as Error).message}`,
      };
    }
    if (ids.length === 0) {
      return { ok: false, error: "此 PR 沒有任何 iteration，無法取得變更。" };
    }
    iterationId = Math.max(...ids);
  }
  const changes = await adoRest(io, executeFn, defaults, {
    method: "GET",
    path: `${base}/iterations/${iterationId}/changes`,
  });
  if (!changes.ok) return changes;
  return {
    ok: true,
    status: changes.status,
    text: `[iterationId: ${iterationId}]\n${changes.text}`,
  };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run tests/pullRequest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pullRequest.ts tests/pullRequest.test.ts
git commit -m "feat: add PR read helpers (show, changes with iteration orchestration, workitems)"
```

---

### Task 4: PR 留言函式（`createPullRequestComment`）

**Files:**
- Modify: `src/pullRequest.ts`
- Test: `tests/pullRequest.test.ts`（追加）

**Interfaces:**
- Consumes: `prBasePath`、`adoRest`（同檔案／Task 2）
- Produces（Task 6 使用）:
  - `type ThreadStatus = "active" | "closed" | "fixed" | "wontFix" | "pending"`
  - `interface PrCommentParams extends PrTarget { content: string; threadId?: number; filePath?: string; line?: number; status?: ThreadStatus }`
  - `createPullRequestComment(io: RestIo, executeFn: typeof execute, defaults: Defaults, params: PrCommentParams): Promise<RestOutcome>`

- [ ] **Step 1: 在 `tests/pullRequest.test.ts` 追加失敗的測試**

在檔案 import 區塊加入 `createPullRequestComment`，檔尾追加：

```ts
describe("createPullRequestComment", () => {
  function makeBodyCapturingIo() {
    const requests: Array<{ url: string; body: unknown }> = [];
    const io: RestIo = {
      fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response('{"id":148}', { status: 200 });
      }) as typeof fetch,
      env: { AZURE_DEVOPS_EXT_PAT: "pat" },
    };
    return { io, requests };
  }

  test("無 threadId 時 POST 新 thread，預設 status active", async () => {
    const { io, requests } = makeBodyCapturingIo();
    const result = await createPullRequestComment(
      io, noopExecutor, BUILT_IN_DEFAULTS,
      { prNumber: 104117, content: "看起來不錯" },
    );
    expect(result.ok).toBe(true);
    expect(requests[0]?.url).toBe(
      `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/104117/threads?api-version=7.1`,
    );
    expect(requests[0]?.body).toEqual({
      comments: [{ parentCommentId: 0, content: "看起來不錯", commentType: 1 }],
      status: "active",
    });
  });

  test("帶 filePath 與 line 時組出 threadContext（filePath 自動補 /）", async () => {
    const { io, requests } = makeBodyCapturingIo();
    await createPullRequestComment(
      io, noopExecutor, BUILT_IN_DEFAULTS,
      { prNumber: 1, content: "c", filePath: "src/a.cs", line: 5 },
    );
    expect(requests[0]?.body).toEqual({
      comments: [{ parentCommentId: 0, content: "c", commentType: 1 }],
      status: "active",
      threadContext: {
        filePath: "/src/a.cs",
        rightFileStart: { line: 5, offset: 1 },
        rightFileEnd: { line: 5, offset: 1 },
      },
    });
  });

  test("有 threadId 時 POST 回覆到該 thread", async () => {
    const { io, requests } = makeBodyCapturingIo();
    await createPullRequestComment(
      io, noopExecutor, BUILT_IN_DEFAULTS,
      { prNumber: 1, content: "回覆", threadId: 148 },
    );
    expect(requests[0]?.url).toBe(
      `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/1/threads/148/comments?api-version=7.1`,
    );
    expect(requests[0]?.body).toEqual({
      content: "回覆",
      parentCommentId: 0,
      commentType: 1,
    });
  });

  test("content 空白時拒絕", async () => {
    const { io, requests } = makeBodyCapturingIo();
    const result = await createPullRequestComment(
      io, noopExecutor, BUILT_IN_DEFAULTS,
      { prNumber: 1, content: "   " },
    );
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  test("只給 line 沒給 filePath 時拒絕", async () => {
    const { io, requests } = makeBodyCapturingIo();
    const result = await createPullRequestComment(
      io, noopExecutor, BUILT_IN_DEFAULTS,
      { prNumber: 1, content: "c", line: 5 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("filePath");
    expect(requests).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/pullRequest.test.ts`
Expected: FAIL — `createPullRequestComment` 未匯出

- [ ] **Step 3: 在 `src/pullRequest.ts` 追加實作**

```ts
export type ThreadStatus = "active" | "closed" | "fixed" | "wontFix" | "pending";

export interface PrCommentParams extends PrTarget {
  content: string;
  threadId?: number;
  filePath?: string;
  line?: number;
  status?: ThreadStatus;
}

export function createPullRequestComment(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  params: PrCommentParams,
): Promise<RestOutcome> {
  if (!params.content.trim()) {
    return Promise.resolve({ ok: false, error: "content 不可為空。" });
  }
  const base = prBasePath(defaults, params);

  if (params.threadId !== undefined) {
    return adoRest(io, executeFn, defaults, {
      method: "POST",
      path: `${base}/threads/${params.threadId}/comments`,
      body: { content: params.content, parentCommentId: 0, commentType: 1 },
    });
  }

  if (params.line !== undefined && !params.filePath) {
    return Promise.resolve({
      ok: false,
      error: "指定 line 時必須同時提供 filePath。",
    });
  }

  const body: Record<string, unknown> = {
    comments: [
      { parentCommentId: 0, content: params.content, commentType: 1 },
    ],
    status: params.status ?? "active",
  };
  if (params.filePath) {
    const filePath = params.filePath.startsWith("/")
      ? params.filePath
      : `/${params.filePath}`;
    const threadContext: Record<string, unknown> = { filePath };
    if (params.line !== undefined) {
      threadContext.rightFileStart = { line: params.line, offset: 1 };
      threadContext.rightFileEnd = { line: params.line, offset: 1 };
    }
    body.threadContext = threadContext;
  }
  return adoRest(io, executeFn, defaults, {
    method: "POST",
    path: `${base}/threads`,
    body,
  });
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run tests/pullRequest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pullRequest.ts tests/pullRequest.test.ts
git commit -m "feat: add PR comment creation (new thread with file anchor, or reply)"
```

---

### Task 5: Work item 函式（`src/workItem.ts`：relations / update）

**Files:**
- Create: `src/workItem.ts`
- Test: `tests/workItem.test.ts`

**Interfaces:**
- Consumes: `adoRest`、`RestIo`、`RestOutcome`（Task 2）
- Produces（Task 6 使用）:
  - `type FieldValue = string | number | boolean`
  - `interface WorkItemUpdateParams { workItemId: number; fields?: Record<string, FieldValue>; historyComment?: string }`
  - `buildFieldPatch(fields: Record<string, FieldValue> | undefined, historyComment: string | undefined): { ok: true; patch: Array<{ op: "add"; path: string; value: FieldValue }> } | { ok: false; error: string }`
  - `getWorkItemRelations(io: RestIo, executeFn: typeof execute, defaults: Defaults, workItemId: number): Promise<RestOutcome>`
  - `updateWorkItem(io, executeFn, defaults, params: WorkItemUpdateParams): Promise<RestOutcome>`

- [ ] **Step 1: 寫失敗的測試 `tests/workItem.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import {
  buildFieldPatch,
  getWorkItemRelations,
  updateWorkItem,
} from "../src/workItem.js";
import type { RestIo } from "../src/rest.js";
import { BUILT_IN_DEFAULTS } from "../src/defaults.js";
import type { ExecResult, ExecuteOptions } from "../src/executor.js";

const ORG = "https://dev.azure.com/SKMHHIS";

function noopExecutor(
  _commandLine: string,
  _options?: ExecuteOptions,
): Promise<ExecResult> {
  return Promise.resolve({ stdout: "", stderr: "", exitCode: 1, timedOut: false });
}

function makeIo(response: Response) {
  const requests: Array<{
    url: string;
    method: string | undefined;
    contentType: string | undefined;
    body: unknown;
  }> = [];
  const io: RestIo = {
    fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        url: String(url),
        method: init?.method,
        contentType: headers["Content-Type"],
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return response;
    }) as typeof fetch,
    env: { AZURE_DEVOPS_EXT_PAT: "pat" },
  };
  return { io, requests };
}

describe("buildFieldPatch", () => {
  test("fields 轉為 add 操作", () => {
    expect(
      buildFieldPatch({ "System.State": "Resolved", "System.Reason": "Fixed" }, undefined),
    ).toEqual({
      ok: true,
      patch: [
        { op: "add", path: "/fields/System.State", value: "Resolved" },
        { op: "add", path: "/fields/System.Reason", value: "Fixed" },
      ],
    });
  });

  test("historyComment 轉為 System.History", () => {
    expect(buildFieldPatch(undefined, "審查完成")).toEqual({
      ok: true,
      patch: [{ op: "add", path: "/fields/System.History", value: "審查完成" }],
    });
  });

  test("fields 與 historyComment 都沒有時拒絕", () => {
    const result = buildFieldPatch(undefined, undefined);
    expect(result.ok).toBe(false);
  });

  test("不合法的欄位名稱被拒絕（防 path 注入）", () => {
    for (const bad of ["System/State", "a b", "../x", "/fields/hack", ""]) {
      const result = buildFieldPatch({ [bad]: "v" }, undefined);
      expect(result.ok, `欄位 "${bad}" 應被拒絕`).toBe(false);
    }
  });
});

describe("getWorkItemRelations", () => {
  test("GET org 層級 workitems 帶 $expand=relations", async () => {
    const { io, requests } = makeIo(
      new Response('{"id":42,"relations":[]}', { status: 200 }),
    );
    const result = await getWorkItemRelations(io, noopExecutor, BUILT_IN_DEFAULTS, 42);
    expect(result.ok).toBe(true);
    expect(requests[0]?.url).toBe(
      `${ORG}/_apis/wit/workitems/42?$expand=relations&api-version=7.1`,
    );
    expect(requests[0]?.method).toBe("GET");
  });
});

describe("updateWorkItem", () => {
  test("PATCH json-patch body 與正確 Content-Type", async () => {
    const { io, requests } = makeIo(
      new Response('{"id":42,"rev":6}', { status: 200 }),
    );
    const result = await updateWorkItem(io, noopExecutor, BUILT_IN_DEFAULTS, {
      workItemId: 42,
      fields: { "System.State": "Resolved" },
      historyComment: "PR review 通過",
    });
    expect(result.ok).toBe(true);
    expect(requests[0]?.url).toBe(
      `${ORG}/_apis/wit/workitems/42?api-version=7.1`,
    );
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.contentType).toBe("application/json-patch+json");
    expect(requests[0]?.body).toEqual([
      { op: "add", path: "/fields/System.State", value: "Resolved" },
      { op: "add", path: "/fields/System.History", value: "PR review 通過" },
    ]);
  });

  test("patch 組合失敗時不發出請求", async () => {
    const { io, requests } = makeIo(new Response("{}", { status: 200 }));
    const result = await updateWorkItem(io, noopExecutor, BUILT_IN_DEFAULTS, {
      workItemId: 42,
    });
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/workItem.test.ts`
Expected: FAIL — `Cannot find module '../src/workItem.js'`

- [ ] **Step 3: 實作 `src/workItem.ts`**

```ts
import type { execute } from "./executor.js";
import type { Defaults } from "./defaults.js";
import { adoRest, type RestIo, type RestOutcome } from "./rest.js";

export type FieldValue = string | number | boolean;

export interface WorkItemUpdateParams {
  workItemId: number;
  fields?: Record<string, FieldValue>;
  historyComment?: string;
}

// 欄位參考名稱如 System.State、Microsoft.VSTS.Common.Priority
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9.]*$/;

export function buildFieldPatch(
  fields: Record<string, FieldValue> | undefined,
  historyComment: string | undefined,
):
  | { ok: true; patch: Array<{ op: "add"; path: string; value: FieldValue }> }
  | { ok: false; error: string } {
  const patch: Array<{ op: "add"; path: string; value: FieldValue }> = [];
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (!FIELD_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error:
          `不合法的欄位名稱「${name}」。` +
          "請使用欄位參考名稱，例如 System.State、Microsoft.VSTS.Common.Priority。",
      };
    }
    patch.push({ op: "add", path: `/fields/${name}`, value });
  }
  if (historyComment !== undefined && historyComment.trim()) {
    patch.push({
      op: "add",
      path: "/fields/System.History",
      value: historyComment,
    });
  }
  if (patch.length === 0) {
    return {
      ok: false,
      error: "fields 與 historyComment 至少要提供一個。",
    };
  }
  return { ok: true, patch };
}

export function getWorkItemRelations(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  workItemId: number,
): Promise<RestOutcome> {
  return adoRest(io, executeFn, defaults, {
    method: "GET",
    path: `_apis/wit/workitems/${workItemId}?$expand=relations`,
  });
}

export function updateWorkItem(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  params: WorkItemUpdateParams,
): Promise<RestOutcome> {
  const built = buildFieldPatch(params.fields, params.historyComment);
  if (!built.ok) return Promise.resolve(built);
  return adoRest(io, executeFn, defaults, {
    method: "PATCH",
    path: `_apis/wit/workitems/${params.workItemId}`,
    body: built.patch,
  });
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run tests/workItem.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workItem.ts tests/workItem.test.ts
git commit -m "feat: add work item relations fetch and field-patch update"
```

---

### Task 6: 註冊七個工具到 server + 整合測試 + 版本 0.4.0

**Files:**
- Modify: `src/server.ts`
- Modify: `package.json`（version → `0.4.0`）
- Test: `tests/server.test.ts`（修改「列出三個工具」＋追加整合測試）

**Interfaces:**
- Consumes:
  - `adoRest`、`RestOutcome`（`src/rest.js`）
  - `showPullRequest`、`getPullRequestChanges`、`listPullRequestWorkItems`、`createPullRequestComment`、`ThreadStatus`（`src/pullRequest.js`）
  - `getWorkItemRelations`、`updateWorkItem`（`src/workItem.js`）
- Produces: 十個工具的 MCP server（`az_devops`、`az_devops_help`、`az_workitem_attach`、`az_pr_show`、`az_pr_changes`、`az_pr_workitems`、`az_workitem_relations`、`az_pr_comment`、`az_workitem_update`、`az_rest`）
- 注意：`createServer` 簽名不變（`io: AttachmentIo` 結構上相容 `RestIo`，直接傳入 REST 函式即可）

- [ ] **Step 1: 修改既有測試並追加失敗的整合測試（`tests/server.test.ts`）**

**1a.** 把「列出三個工具」測試改為：

```ts
  test("列出十個工具", async () => {
    const { fake } = makeFakeExecutor();
    const client = await connect(fake);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "az_devops",
      "az_devops_help",
      "az_pr_changes",
      "az_pr_comment",
      "az_pr_show",
      "az_pr_workitems",
      "az_rest",
      "az_workitem_attach",
      "az_workitem_relations",
      "az_workitem_update",
    ]);
  });
```

**1b.** 檔尾追加整合測試（fake fetch 經 `AttachmentIo` 注入；`readFile` 用不到，給丟錯的 stub）：

```ts
describe("REST 工具整合", () => {
  function makeRestIo(
    handler: (url: string, init?: RequestInit) => Response,
  ) {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const io: AttachmentIo = {
      readFile: async () => {
        throw new Error("not used");
      },
      fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return handler(String(url), init);
      }) as typeof fetch,
      env: { AZURE_DEVOPS_EXT_PAT: "pat" },
    };
    return { io, requests };
  }

  test("az_pr_show 以預設 project/repository 組 URL", async () => {
    const { fake } = makeFakeExecutor();
    const { io, requests } = makeRestIo(
      () => new Response('{"pullRequestId":104117}', { status: 200 }),
    );
    const client = await connect(fake, BUILT_IN_DEFAULTS, io);
    const result = await client.callTool({
      name: "az_pr_show",
      arguments: { prNumber: 104117 },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("104117");
    expect(requests[0]?.url).toBe(
      "https://dev.azure.com/SKMHHIS/MS/_apis/git/repositories/MS-Web/pullRequests/104117?api-version=7.1",
    );
  });

  test("az_pr_changes 未指定 iteration 時自動取最新", async () => {
    const { fake } = makeFakeExecutor();
    const responses = [
      new Response('{"value":[{"id":1},{"id":4}]}', { status: 200 }),
      new Response('{"changeEntries":[]}', { status: 200 }),
    ];
    const { io, requests } = makeRestIo(() => responses.shift()!);
    const client = await connect(fake, BUILT_IN_DEFAULTS, io);
    const result = await client.callTool({
      name: "az_pr_changes",
      arguments: { prNumber: 104117 },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("[iterationId: 4]");
    expect(requests[1]?.url).toContain("/iterations/4/changes");
  });

  test("az_workitem_relations 走 org 層級端點", async () => {
    const { fake } = makeFakeExecutor();
    const { io, requests } = makeRestIo(
      () => new Response('{"id":42,"relations":[]}', { status: 200 }),
    );
    const client = await connect(fake, BUILT_IN_DEFAULTS, io);
    const result = await client.callTool({
      name: "az_workitem_relations",
      arguments: { workItemId: 42 },
    });
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe(
      "https://dev.azure.com/SKMHHIS/_apis/wit/workitems/42?$expand=relations&api-version=7.1",
    );
  });

  test("az_pr_comment 建立新 thread", async () => {
    const { fake } = makeFakeExecutor();
    const { io, requests } = makeRestIo(
      () => new Response('{"id":148}', { status: 200 }),
    );
    const client = await connect(fake, BUILT_IN_DEFAULTS, io);
    const result = await client.callTool({
      name: "az_pr_comment",
      arguments: { prNumber: 104117, content: "審查意見" },
    });
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toContain("/pullRequests/104117/threads?");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.comments[0].content).toBe("審查意見");
  });

  test("az_workitem_update 缺 fields 與 historyComment 時拒絕", async () => {
    const { fake } = makeFakeExecutor();
    const { io, requests } = makeRestIo(
      () => new Response("{}", { status: 200 }),
    );
    const client = await connect(fake, BUILT_IN_DEFAULTS, io);
    const result = await client.callTool({
      name: "az_workitem_update",
      arguments: { workItemId: 42 },
    });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  test("az_rest 拒絕絕對 URL", async () => {
    const { fake } = makeFakeExecutor();
    const { io, requests } = makeRestIo(
      () => new Response("{}", { status: 200 }),
    );
    const client = await connect(fake, BUILT_IN_DEFAULTS, io);
    const result = await client.callTool({
      name: "az_rest",
      arguments: { method: "GET", path: "https://evil.example.com/x" },
    });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  test("az_rest 拒絕不合法 JSON body", async () => {
    const { fake } = makeFakeExecutor();
    const { io, requests } = makeRestIo(
      () => new Response("{}", { status: 200 }),
    );
    const client = await connect(fake, BUILT_IN_DEFAULTS, io);
    const result = await client.callTool({
      name: "az_rest",
      arguments: { method: "POST", path: "MS/_apis/x", body: "not json {" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("JSON");
    expect(requests).toHaveLength(0);
  });

  test("az_rest 認證失敗回傳提示", async () => {
    const { fake } = makeFakeExecutor();
    const { io } = makeRestIo(() => new Response("denied", { status: 401 }));
    const client = await connect(fake, BUILT_IN_DEFAULTS, io);
    const result = await client.callTool({
      name: "az_rest",
      arguments: { method: "GET", path: "MS/_apis/x" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("az login");
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — 「列出十個工具」與「REST 工具整合」全部失敗（新工具未註冊）

- [ ] **Step 3: 修改 `src/server.ts` 註冊七個工具**

**3a.** import 區塊追加：

```ts
import { adoRest, type RestMethod, type RestOutcome } from "./rest.js";
import {
  createPullRequestComment,
  getPullRequestChanges,
  listPullRequestWorkItems,
  showPullRequest,
} from "./pullRequest.js";
import { getWorkItemRelations, updateWorkItem } from "./workItem.js";
```

**3b.** `McpServer` version 改為 `"0.4.0"`。

**3c.** 在 `scopeError` 之後加共用轉換函式：

```ts
function restToolResult(outcome: RestOutcome): ToolResult {
  if (!outcome.ok) {
    return {
      content: [{ type: "text", text: truncateOutput(outcome.error) }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: truncateOutput(outcome.text || "(無輸出)") }],
  };
}
```

**3d.** 在 `createServer` 內（`az_workitem_attach` 註冊之後、`return server` 之前）註冊七個工具。共用的 zod 片段先定義：

```ts
  const prNumberSchema = z.number().int().positive().describe("PR 編號");
  const projectSchema = z
    .string()
    .optional()
    .describe(`覆寫預設 project（預設 ${defaults.project}）`);
  const repositorySchema = z
    .string()
    .optional()
    .describe(`覆寫預設 repository（預設 ${defaults.repository}）`);

  server.registerTool(
    "az_pr_show",
    {
      title: "Show Pull Request",
      description:
        "以 REST API 取得 PR 完整資訊（title、sourceRefName、targetRefName、status 等）。" +
        `預設 organization 為 ${defaults.organization}、project 為 ${defaults.project}、` +
        `repository 為 ${defaults.repository}。`,
      inputSchema: {
        prNumber: prNumberSchema,
        project: projectSchema,
        repository: repositorySchema,
      },
    },
    async (params) =>
      restToolResult(await showPullRequest(io, executeFn, defaults, params)),
  );

  server.registerTool(
    "az_pr_changes",
    {
      title: "List Pull Request Changes",
      description:
        "以 REST API 取得 PR 的異動檔案清單（iteration changes）。" +
        "未指定 iterationId 時自動使用最新 iteration，並在輸出開頭註明。" +
        `預設 organization/project/repository 同 az_pr_show。`,
      inputSchema: {
        prNumber: prNumberSchema,
        iterationId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("指定 iteration，預設取最新"),
        project: projectSchema,
        repository: repositorySchema,
      },
    },
    async (params) =>
      restToolResult(
        await getPullRequestChanges(io, executeFn, defaults, params),
      ),
  );

  server.registerTool(
    "az_pr_workitems",
    {
      title: "List Pull Request Work Items",
      description:
        "以 REST API 取得 PR 關聯的 work item 清單（id 與 url）。" +
        `預設 organization/project/repository 同 az_pr_show。`,
      inputSchema: {
        prNumber: prNumberSchema,
        project: projectSchema,
        repository: repositorySchema,
      },
    },
    async (params) =>
      restToolResult(
        await listPullRequestWorkItems(io, executeFn, defaults, params),
      ),
  );

  server.registerTool(
    "az_workitem_relations",
    {
      title: "Show Work Item Relations",
      description:
        "以 REST API 取得 work item 的完整資訊含 relations（$expand=relations），" +
        "可用於檢查附件（AttachedFile 的 attributes.name）是否已存在。" +
        `預設 organization 為 ${defaults.organization}。`,
      inputSchema: {
        workItemId: z.number().int().positive().describe("Work item ID"),
      },
    },
    async ({ workItemId }) =>
      restToolResult(
        await getWorkItemRelations(io, executeFn, defaults, workItemId),
      ),
  );

  server.registerTool(
    "az_pr_comment",
    {
      title: "Create Pull Request Comment",
      description:
        "在 PR 上留言。未指定 threadId 時建立新的討論串（可用 filePath/line 錨定到檔案行）；" +
        "指定 threadId 時回覆該討論串（此時忽略 filePath/line/status）。" +
        `預設 organization/project/repository 同 az_pr_show。`,
      inputSchema: {
        prNumber: prNumberSchema,
        content: z.string().describe("留言內容（不可為空）"),
        threadId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("回覆既有討論串的 thread ID"),
        filePath: z
          .string()
          .optional()
          .describe("新討論串錨定的檔案路徑（自動補開頭的 /）"),
        line: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("錨定的行號（需搭配 filePath）"),
        status: z
          .enum(["active", "closed", "fixed", "wontFix", "pending"])
          .optional()
          .describe("新討論串的初始狀態，預設 active"),
        project: projectSchema,
        repository: repositorySchema,
      },
    },
    async (params) =>
      restToolResult(
        await createPullRequestComment(io, executeFn, defaults, params),
      ),
  );

  server.registerTool(
    "az_workitem_update",
    {
      title: "Update Work Item Fields",
      description:
        "以 REST API 更新 work item 欄位（json-patch 由 server 組裝，僅允許 /fields/*）。" +
        'fields 的 key 為欄位參考名稱，例如 {"System.State": "Resolved"}；' +
        "historyComment 會寫入 System.History（等同在 Discussion 留言）。" +
        "fields 與 historyComment 至少要提供一個。" +
        `預設 organization 為 ${defaults.organization}。`,
      inputSchema: {
        workItemId: z.number().int().positive().describe("Work item ID"),
        fields: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('欄位參考名稱 → 新值，例如 {"System.State": "Resolved"}'),
        historyComment: z
          .string()
          .optional()
          .describe("寫入 System.History 的留言"),
      },
    },
    async (params) =>
      restToolResult(await updateWorkItem(io, executeFn, defaults, params)),
  );

  server.registerTool(
    "az_rest",
    {
      title: "Azure DevOps REST (generic)",
      description:
        "對 Azure DevOps 發送任意 REST 請求（GET/POST/PATCH）。" +
        "優先使用專用工具（az_pr_show、az_pr_changes、az_pr_workitems、" +
        "az_workitem_relations、az_pr_comment、az_workitem_update、az_workitem_attach）；" +
        "此工具僅供未涵蓋的端點使用。" +
        `path 為 organization（${defaults.organization}）之後的相對路徑，` +
        "未帶 api-version 時自動補 7.1。",
      inputSchema: {
        method: z.enum(["GET", "POST", "PATCH"]).describe("HTTP method"),
        path: z
          .string()
          .describe(
            '相對路徑，例如 "MS/_apis/git/repositories/MS-Web/pullRequests/1/threads"',
          ),
        body: z
          .string()
          .optional()
          .describe("JSON 字串（GET 不可帶）"),
        contentType: z
          .string()
          .optional()
          .describe("覆寫 Content-Type，預設自動判斷"),
        timeout: z.number().optional().describe("逾時秒數，預設 120"),
      },
    },
    async ({ method, path, body, contentType, timeout }) => {
      if (body !== undefined) {
        try {
          JSON.parse(body);
        } catch {
          return {
            content: [
              { type: "text" as const, text: "body 不是合法的 JSON 字串。" },
            ],
            isError: true,
          };
        }
      }
      const outcome = await adoRest(io, executeFn, defaults, {
        method: method as RestMethod,
        path,
        body,
        contentType,
        timeoutMs: (timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
      });
      return restToolResult(outcome);
    },
  );
```

**3e.** `package.json` 的 `"version"` 改為 `"0.4.0"`。

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run`
Expected: PASS（全部測試檔綠燈，含既有 92 個 + 本計畫新增的測試）

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts package.json
git commit -m "feat: register PR/work-item REST tools and generic az_rest, bump to 0.4.0"
```

---

### Task 7: 建置、README、實機煙霧測試

**Files:**
- Modify: `README.md`（工具表）
- Modify: `scripts/smoke.mjs`（追加一個唯讀 REST 呼叫）

**Interfaces:**
- Consumes: `dist/index.js`（build 產物）；本機已 `az login`
- Produces: 可部署的 0.4.0 版本與文件

- [ ] **Step 1: 建置**

Run: `npm run build`
Expected: 成功，`dist/` 產出含 `auth.js`、`rest.js`、`pullRequest.js`、`workItem.js`

- [ ] **Step 2: 更新 README.md 工具表**

在 README 的工具表加入七列（表格欄位比照既有格式）：

```markdown
| `az_pr_show` | 取得 PR 完整資訊（REST），含 source/target branch 與狀態。 |
| `az_pr_changes` | 取得 PR 異動檔案清單（REST iterations/changes），自動使用最新 iteration。 |
| `az_pr_workitems` | 取得 PR 關聯的 work item 清單（REST）。 |
| `az_workitem_relations` | 取得 work item 含 relations（REST，$expand=relations），可檢查附件重名。 |
| `az_pr_comment` | 在 PR 建立討論串留言或回覆既有討論串（REST）。 |
| `az_workitem_update` | 更新 work item 欄位／寫入 Discussion（REST json-patch，僅允許 /fields/*）。 |
| `az_rest` | 通用 Azure DevOps REST 呼叫（GET/POST/PATCH），供未涵蓋的端點使用。 |
```

並在工具表下方補一段認證說明：

```markdown
REST 工具的認證與 `az_workitem_attach` 相同：優先使用 `AZURE_DEVOPS_EXT_PAT`
環境變數，否則使用 `az login` 的憑證。所有 REST URL 鎖定在預設 organization，
無法對其他主機發送請求。
```

- [ ] **Step 3: 在 `scripts/smoke.mjs` 追加唯讀 REST 煙霧測試**

在 `await client.close();` 之前追加（`az_rest` 打 projects 端點是唯讀且必定存在）：

```js
console.log("\n--- az_rest: GET _apis/projects ---");
const rest = await client.callTool({
  name: "az_rest",
  arguments: { method: "GET", path: "_apis/projects" },
});
console.log("isError:", rest.isError ?? false);
console.log(rest.content[0].text.slice(0, 300));
```

- [ ] **Step 4: 執行實機煙霧測試**

Run: `node scripts/smoke.mjs`
Expected: 原有輸出全部正常，且 `az_rest` 段 `isError: false`、輸出 JSON 含 project 名稱（如 `MS`）

- [ ] **Step 5: 最終驗證**

Run: `npx vitest run && npm run build`
Expected: 全部測試 PASS、建置無錯誤

- [ ] **Step 6: Commit**

```bash
git add README.md scripts/smoke.mjs
git commit -m "docs: document REST tools and extend smoke test"
```

---

## 後續（本計畫範圍外）

- 更新 skh-ms-web-pr-review skill：把「az account get-access-token + 直接打 REST」的步驟改為指名使用 `az_pr_show`、`az_pr_changes`、`az_pr_workitems`、`az_workitem_relations`，使所有 Azure DevOps 動作真正經由 MCP。
