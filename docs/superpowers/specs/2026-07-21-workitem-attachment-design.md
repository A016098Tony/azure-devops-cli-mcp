# Work Item 附件上傳工具設計

日期：2026-07-21
狀態：已核可

## 目標

讓 MCP server 能將本機檔案（純文字與 binary 皆可）上傳為 Azure DevOps work item 附件。
新增一個專用 MCP 工具 `az_workitem_attach`，一次呼叫完成「上傳附件 + 連結到 work item」兩步驟。

## 背景與方案選擇

Azure DevOps 附件上傳是兩步驟 REST 流程：

1. `POST {org}/{project}/_apis/wit/attachments?fileName={name}&api-version=7.1`
   （body 為檔案內容，`Content-Type: application/octet-stream`）→ 回傳 `{ id, url }`
2. `PATCH {org}/_apis/wit/workitems/{id}?api-version=7.1`
   （`Content-Type: application/json-patch+json`）加一筆 `AttachedFile` relation

評估過的方案：

- **方案 A（採用）**：專用工具，az CLI 只負責取 token，HTTP 由 Node `fetch` 自己發。
  binary 以 Buffer 處理絕對安全；az login 與 PAT 兩種認證都支援；檔案路徑不經過
  shell，沒有跳脫字元問題。
- 方案 B（否決）：內部 shell 出去跑 `az rest`。`az rest` 只能用 az login 的 AAD 憑證
  （PAT 使用者不能用），且 `--body @檔案` 以文字模式讀檔，binary 有損毀風險。
- 方案 C（否決）：通用 `az rest` passthrough 工具。把使用者 token 開放給任意 Azure
  API 呼叫，安全範圍失控；模型還得自行編排兩步驟；binary 問題未解。

## 工具介面

```
az_workitem_attach
  workItemId : number   — 目標 work item ID（必填）
  filePath   : string   — 本機檔案的絕對路徑（必填）
  comment    : string?  — 附件備註，顯示在 work item 附件上
  fileName   : string?  — 覆寫附件顯示名稱；預設取 filePath 的檔名
```

- `organization` 與 `project` 沿用現有 `Defaults`（`src/defaults.ts`）注入，
  模型不需自帶。
- 此工具不走 `validateScope` 的命令字串路徑；輸入為結構化參數，無 shell 注入面。

## 元件

- `src/attachment.ts`（新增，純邏輯、可單元測試）：
  - 組 attachments POST URL（`fileName` 需 `encodeURIComponent`，支援中文檔名）
  - 組 work item PATCH URL 與 json-patch body
  - token 取得策略（見下）
- `src/server.ts`：註冊 `az_workitem_attach`，串接 attachment 邏輯、`fs.readFile`
  與 `fetch`。

## Token 取得策略

1. 環境變數 `AZURE_DEVOPS_EXT_PAT` 有值 → Basic auth（`base64(":" + PAT)`）。
   環境變數是使用者主動設定的明確訊號，且不需開子程序。
2. 否則執行
   `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv`
   → Bearer token（`499b84ac-…` 為 Azure DevOps 的固定 AAD resource ID）。
3. 兩者皆失敗 → 明確錯誤，提示執行 `az login` 或設定 `AZURE_DEVOPS_EXT_PAT`。

## 資料流

1. `fs.readFile(filePath)` 讀成 Buffer（binary 安全）
2. 取得 token
3. POST attachments API，body 為 Buffer → 取回 attachment `url`
4. PATCH work item，json-patch 加 `AttachedFile` relation（含 `comment`）
5. 回傳成功訊息：附件名稱、attachment URL、work item ID

## 錯誤處理

| 情況 | 行為 |
| --- | --- |
| 檔案不存在／是目錄 | 明確中文錯誤，不發任何 API |
| 檔案超過 100MB | 拒絕（不做 chunked upload，YAGNI） |
| 401 / 403 | 提示重新 `az login`，或檢查 PAT 是否有 Work Items (Read & Write) scope |
| PATCH 404 | 指出 work item ID 不存在 |
| 步驟 3 成功、步驟 4 失敗 | 錯誤訊息附上已上傳的 attachment URL，說明附件已在雲端、僅未連結 |

錯誤訊息一律繁體中文，風格比照現有 `toToolResult`。

## 測試

vitest，沿用現有測試風格：

- `attachment.ts` 純函式：URL 組裝、json-patch body、中文檔名 encode、
  token 策略（PAT 環境變數 vs az fallback）
- 工具 handler：mock `fetch` 與 `executeFn`，驗證兩步驟順序、binary Buffer
  原樣送出、各錯誤分支訊息

## 範圍外

- Chunked upload（>100MB 檔案）
- 從 work item 下載或刪除附件
- 通用 REST passthrough
