# Git 唯讀網路工具設計（az_git_fetch + az_git_ls_remote）

**日期：** 2026-07-23
**版本目標：** 0.4.0 → 0.5.0
**Branch：** `add_azure_git_fetch`

## 背景與目標

skh-ms-web-pr-review skill 在 PR review 時需要以目標分支（例：`releases/s116/rc-092`）為基準：
先 `git fetch origin`，再確認 `origin/<target branch>` 存在且為最新。

但在 Claude Cowork 中，sandbox 的 proxy 會擋下 git 的網路操作（`git fetch` 回 403），
導致來源分支的 commit 不在本地。實測結果：

- **本機 git 操作正常**（`git diff`、`git rev-parse`、`git log` 都可用）。
- **只有需要連線遠端的操作被擋**（fetch/pull/push）。
- Cowork 曾自動 fallback 到 REST API（`az_pr_changes` + 逐檔取內容比對），可以完成 review，
  但 diff 品質不如本機 git diff、逐檔來回呼叫太耗 token 與時間，且 skill 流程本身依賴本機 git。

MCP server 是跑在主機上的本機 process，不經過 sandbox proxy。由 MCP 代跑 git 的網路操作，
sandbox 內的 Claude 再用本機 git 操作已更新的 refs，即可恢復 skill 原本的流程。

0.4.0 的 spec（`2026-07-21-ado-rest-tools-design.md`）曾把「本機 git 操作不納入 MCP」列為
範圍外；本設計因 sandbox proxy 這個新情況而修改該決策，但**只納入唯讀網路操作**，
本機唯讀操作（diff/log/rev-parse）在 sandbox 內本來就可用，仍不納入。

## 方案選擇

比較過三個方案：

- **方案 A（採用）：兩個專用工具**，結構化參數 + 嚴格驗證。
- 方案 B：單一工具用 `op` enum 分流 — 兩種操作參數不同，schema 混雜，省不了多少 code。
- 方案 C：通用字串式 git 工具 + 子命令白名單 — `git fetch` 有 `--upload-pack=<命令>`
  這類可執行任意指令的選項，字串層面的白名單驗證易漏，以「唯讀網路操作」這麼小的
  範圍不值得承擔風險。

方案 A 與此 MCP 既有哲學一致（專用工具優先、通用工具僅作 escape hatch），且結構化參數
可以從根本上擋掉選項注入。

## 架構

**新模組 `src/git.ts`**，比照 `pullRequest.ts` / `workItem.ts` 模式：純函式 + 注入
`executeFn`。執行時使用既有 executor 的 `baseCommand: "git"` 覆寫，不改動 `executor.ts`。

| 工具 | 性質 | 對應 skill 步驟 |
|---|---|---|
| `az_git_fetch` | 唯讀網路（下載 refs 與物件到本機 repo） | `git fetch origin <target branch>` |
| `az_git_ls_remote` | 唯讀網路（只查遠端 refs，不下載物件） | 確認 `origin/<target branch>` 存在 |

不提供：push、pull（會動工作目錄）、任何寫入操作。

## 工具規格

### `az_git_fetch`

- 參數：
  - `repoPath: string`（必填）— 本機 repo 的**主機端**絕對路徑
  - `remote?: string` — 遠端名稱，預設 `origin`
  - `refspec?: string` — 例如 `releases/s116/rc-092`；未提供時 fetch 該 remote 的全部分支
  - `prune?: boolean` — 加 `--prune`，清掉遠端已刪除分支的追蹤 ref
  - `timeout?: number` — 逾時秒數，預設 120
- 行為：`git -C "<repoPath>" fetch <remote> [refspec] [--prune]`
- 回傳：成功時合併 stdout + stderr（git fetch 的 ref 更新訊息輸出在 stderr，
  需一併回傳 Claude 才看得到哪些 ref 更新了）；無輸出時回「fetch 完成（無 ref 變更）」。

### `az_git_ls_remote`

- 參數：
  - `repoPath: string`（必填）— 同上
  - `remote?: string` — 預設 `origin`
  - `pattern?: string` — ref 過濾，例如 `releases/s116/rc-092`
  - `heads?: boolean` / `tags?: boolean` — 對應 `--heads` / `--tags`
  - `timeout?: number` — 預設 120
- 行為：`git -C "<repoPath>" ls-remote [--heads] [--tags] <remote> [pattern]`
- 回傳：符合的 ref 清單（`<sha>\t<refname>`）；無符合時明確回「遠端沒有符合的 ref」。

### 參數驗證（兩工具共用，驗證失敗即拒絕、不執行命令）

| 參數 | 規則 | 目的 |
|---|---|---|
| `repoPath` | 非空、絕對路徑（Windows `X:\` 或 POSIX `/` 開頭） | 及早給出清楚錯誤 |
| `remote` | `^[A-Za-z0-9._-]+$` | 擋 URL 與 `-` 開頭的選項注入，只允許已設定的 remote 名稱 |
| `refspec` / `pattern` | 非空白、不可以 `-` 開頭 | 擋 `--upload-pack` 等危險選項；`+refs/heads/*:...` 合法格式可通過 |

命令組裝時 `repoPath` 以雙引號包覆（處理路徑空白）；`refspec` / `pattern` 同樣加引號。

### 工具描述

比照既有工具以繁中撰寫，並註明典型情境：「Cowork sandbox 內 git fetch 被 proxy 擋下（403）
時，用此工具在主機端代跑；fetch 完成後 sandbox 內即可用本機 git 操作
`origin/<branch>`」。`repoPath` 的描述強調必須是**主機端**看得到的絕對路徑。

## 錯誤處理

沿用 `toToolResult` 模式（`isError: true`，訊息繁中），git 專屬的錯誤映射：

- 找不到 `git`（`'git' is not recognized` / `git: command not found`）→ 附安裝提示。
- `not a git repository` / 路徑不存在 → 原樣回傳 stderr，附提示
  「請確認 repoPath 是主機端的絕對路徑（sandbox 內看到的路徑可能與主機不同）」。
- 認證失敗（stderr 含 `Authentication failed`、`403`、`fatal: could not read`）→ 附提示
  「請確認主機端 git credential（如 Git Credential Manager）可正常存取該遠端」。
- 逾時 → 沿用既有 timedOut 處理。
- 其他非零結束碼 → stderr 原樣回傳。
- 全部輸出經 `truncateOutput`。

## 測試策略

vitest，比照既有測試風格，用 fake `executeFn`，不真的執行 git：

1. **驗證邏輯**：拒絕 `-` 開頭的 refspec/pattern、拒絕含 `://` 或空白或 `-` 開頭的
   remote、拒絕空字串與相對路徑的 repoPath；合法輸入（含 `+refs/...:refs/...` refspec）通過。
2. **命令組裝**：含空白路徑正確加引號、`--prune` / `--heads` / `--tags` 旗標正確、
   refspec/pattern 正確附加、remote 預設 `origin`、`baseCommand` 為 `git`。
3. **server 層**：兩個工具已註冊；成功結果、驗證錯誤、git 錯誤（含各類錯誤提示映射）、
   逾時各自映射為正確的 ToolResult。
4. 既有測試維持全綠。

## 其他改動

- `package.json` 與 `McpServer` version：0.4.0 → 0.5.0。
- README：補兩個工具的說明與使用範例。
- Smoke test 文件：補這兩個工具的手動驗證步驟（對真實 repo fetch 一次）。

## 範圍外（後續建議）

- **更新 skh-ms-web-pr-review skill**（不在本 repo）：加上「sandbox 內 fetch 被擋時，
  改呼叫 `az_git_fetch`（必要時先用 `az_git_ls_remote` 確認分支存在）」的指引，
  讓下次 review 自動走新路徑而不是臨時 fallback 到 REST。
- 本機唯讀 git 操作（diff/log/rev-parse）：sandbox 內可直接執行，不納入。
- push / pull / checkout 等會寫入的操作：無需求，不納入。
