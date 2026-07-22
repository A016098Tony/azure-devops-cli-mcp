# Azure DevOps REST 工具擴充設計（方案 C：專用工具 + 通用 fallback）

**日期：** 2026-07-21
**版本目標：** 0.3.0 → 0.4.0
**Branch：** `add_rest_support`

## 背景與目標

skh-ms-web-pr-review skill 要求「所有 Azure DevOps 動作優先走 REST API」，但目前 MCP 只有
`az_devops`（CLI passthrough）、`az_devops_help`、`az_workitem_attach` 三個工具：

- PR iterations / iteration changes **沒有任何 CLI 等價命令**，MCP 完全做不到。
- skill 目前的 REST 呼叫（取 token + curl）全部繞過 MCP 直接跑 shell。

本設計新增七個工具，讓 skill 的全部 Azure DevOps 動作（不含本機 git 操作）都能經由 MCP 完成，
並涵蓋未來的寫入需求（發 PR comment、更新 work item）。

## 架構

採用「專用工具優先、通用 REST fallback」的混合結構，延續 `az_workitem_attach` 的既有哲學
（編排與高頻操作做成專用工具）：

| 層 | 工具 | 性質 |
|---|---|---|
| 專用（讀） | `az_pr_show`、`az_pr_changes`、`az_pr_workitems`、`az_workitem_relations` | skill 步驟 2、3、6 直接對應 |
| 專用（寫） | `az_pr_comment`、`az_workitem_update` | body 形狀在 server 端驗證 |
| 通用 | `az_rest` | 未涵蓋端點的 escape hatch |
| 既有 | `az_devops`、`az_devops_help`、`az_workitem_attach` | 不動 |

### 共用模組

**`src/auth.ts`（自 attachment.ts 抽出）**

- `resolveAuthHeader(env, executeFn)`：PAT（`AZURE_DEVOPS_EXT_PAT`）優先，否則
  `az account get-access-token --resource 499b84ac-...` 取 Bearer token。
- `isAuthFailure(status)`：401 / 403 / 203（無效 PAT 回 203 + HTML 登入頁）。
- `readBodySnippet(res)`：錯誤回應擷取前 500 字。
- `ADO_RESOURCE_ID`、`API_VERSION` 常數。
- `attachment.ts` 改為 import 共用模組，行為不變。

**`src/rest.ts`（新增）**

核心函式：

```ts
adoRest(io, executeFn, defaults, {
  method: "GET" | "POST" | "PATCH",
  path: string,          // organization 之後的相對路徑，可含 query string
  body?: unknown,
  contentType?: string,
  timeoutMs?: number,
}): Promise<RestOutcome>  // { ok: true; status; text } | { ok: false; error }
```

規則：

- URL 由 server 組合：`{defaults.organization}/{path}`。拒絕絕對 URL（`http://`、`https://`、`//`）
  與路徑穿越（`..`），工具無法打其他主機。
- 未帶 `api-version` 時自動補 `api-version=7.1`（已有時不動）。
- Content-Type 自動判斷：PATCH 且 path 含 `_apis/wit/workitems` → `application/json-patch+json`；
  其餘有 body 時 → `application/json`；呼叫端可用 `contentType` 覆寫。
- 錯誤處理沿用 attachment.ts 模式：`isAuthFailure` → 認證提示、404 → 明確訊息、
  其他非 2xx → HTTP 狀態 + body 片段。
- 回應輸出經 `truncateOutput`（50KB 截斷）。
- 預設逾時 120 秒。

## 工具規格

所有工具的 organization / project / repository 預設取自 `Defaults`
（`SKMHHIS` / `MS` / `MS-Web`），除特別註明外提供選填參數覆寫 project 與 repository。

### 專用（讀）

**`az_pr_show`** — skill 步驟 2.1

- 參數：`prNumber: number`（int, positive）、`project?`、`repository?`
- 行為：`GET {project}/_apis/git/repositories/{repository}/pullRequests/{prNumber}`
- 回傳：PR 完整 JSON（含 `title`、`sourceRefName`、`targetRefName`、`status`）。

**`az_pr_changes`** — skill 步驟 3（兩步編排）

- 參數：`prNumber: number`、`iterationId?: number`、`project?`、`repository?`
- 行為：未指定 `iterationId` 時先 `GET .../pullRequests/{prNumber}/iterations` 取最新一筆的 id，
  再 `GET .../iterations/{id}/changes`；有指定則直接取 changes。
- 回傳：changes JSON，並在文字開頭註明使用的 iterationId。
- iterations 為空（理論上不會發生）→ 明確錯誤訊息。

**`az_pr_workitems`** — skill 步驟 6.2

- 參數：`prNumber: number`、`project?`、`repository?`
- 行為：`GET .../pullRequests/{prNumber}/workitems`
- 回傳：關聯 work item 的 id/url 清單 JSON。

**`az_workitem_relations`** — skill 步驟 6.3 / 6.4 驗證

- 參數：`workItemId: number`
- 行為：`GET _apis/wit/workitems/{workItemId}?$expand=relations`（org 層級，不帶 project）
- 回傳：work item JSON（含 `relations`，可檢查 `AttachedFile` 的 `attributes.name`）。

### 專用（寫）

**`az_pr_comment`**

- 參數：
  - `prNumber: number`、`content: string`（非空）
  - `threadId?: number` — 有值時回覆既有 thread
  - `filePath?: string` + `line?: number` — 新 thread 錨定到檔案/行（`filePath` 需以 `/` 開頭，
    server 自動補）；只有 `line` 沒有 `filePath` 時拒絕
  - `status?: "active" | "closed" | "fixed" | "wontFix" | "pending"` — 新 thread 的初始狀態，預設 active
  - `project?`、`repository?`
- 行為：
  - 無 `threadId` → `POST .../pullRequests/{prNumber}/threads`，body 為
    `{ comments: [{ parentCommentId: 0, content, commentType: 1 }], status, threadContext? }`；
    `threadContext` 由 `filePath`/`line` 組成（`rightFileStart`/`rightFileEnd` 同行）。
  - 有 `threadId` → `POST .../threads/{threadId}/comments`，body 為
    `{ content, parentCommentId: 0, commentType: 1 }`；此時忽略 `filePath`/`line`/`status`。
- 回傳：建立的 thread/comment id 與摘要。

**`az_workitem_update`**

- 參數：
  - `workItemId: number`
  - `fields?: Record<string, string | number | boolean>` — 欄位參考名稱 → 新值，
    如 `{ "System.State": "Resolved" }`
  - `historyComment?: string` — 寫入 `System.History`（等同在 Discussion 留言）
  - `fields` 與 `historyComment` 至少要有一個
- 行為：server 組 json-patch 陣列——每個 field 一筆
  `{ op: "add", path: "/fields/{name}", value }`（ADO 的 add 對已存在欄位等同 replace），
  `historyComment` 轉為 `/fields/System.History`；
  `PATCH _apis/wit/workitems/{workItemId}`，Content-Type `application/json-patch+json`。
- 管控：**不接受呼叫端自組 patch**；path 僅允許 `/fields/*`，不開放 `/relations`
  （relations 寫入由 `az_workitem_attach` 或未來專用工具負責）。
- 欄位名稱格式驗證：`/^[A-Za-z][A-Za-z0-9.]*$/`（防 path 注入）。
- 回傳：更新後 work item 的 id / rev 與已變更欄位摘要。

### 通用 fallback

**`az_rest`**

- 參數：`method: "GET" | "POST" | "PATCH"`、`path: string`、`body?: string`（JSON 字串）、
  `contentType?: string`、`timeout?: number`（秒，預設 120）
- 行為：直接走 `adoRest`。description 明確引導：「優先使用專用工具；此工具僅供未涵蓋的端點」。
- `body` 提供時需為合法 JSON，否則拒絕（GET 不允許 body）。

## 錯誤處理（全工具一致）

- 認證失敗（401/403/203）→ 提示重跑 `az login` 或檢查 `AZURE_DEVOPS_EXT_PAT`。
- 404 → 指明資源（PR / work item / thread）不存在。
- 其他非 2xx → `HTTP {status}` + 回應 body 前 500 字。
- 網路錯誤 → 錯誤訊息原文。
- 全部回傳皆經 `truncateOutput`；錯誤以 `isError: true` 回傳，不中斷 MCP 協定。

## 測試策略

- 比照 attachment 測試風格：vitest、fake `fetchFn` / fake executor、`InMemoryTransport` 整合測試。
- `rest.ts` 單元測試：URL 組合（api-version 補齊、絕對 URL / `..` 拒絕）、Content-Type 自動判斷、
  各類 HTTP 錯誤映射。
- 每個工具：成功案例、認證失敗、404、輸出截斷；`az_pr_changes` 加測 iteration 編排；
  `az_pr_comment` 加測 thread 建立 vs 回覆分流與 threadContext 組合；
  `az_workitem_update` 加測 patch 組合與欄位名稱驗證。
- `auth.ts` 抽出後，attachment 既有測試需維持全綠（重構不改行為）。

## 範圍外（後續建議）

- 本機 git 操作（fetch/diff/show）不納入 MCP，仍由 skill 直接執行。
- 更新 skh-ms-web-pr-review skill：把「az account get-access-token + 直接打 REST」的步驟
  改為指名使用本次新增的工具（`az_pr_show`、`az_pr_changes`、`az_pr_workitems`、
  `az_workitem_relations`），使所有 Azure DevOps 動作真正經由 MCP。
- DELETE method、PR 建立/核准/合併等操作：目前無需求，未來視情況以專用工具擴充。
