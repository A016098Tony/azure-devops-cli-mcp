# npx 啟動方式 + 預設值參數注入 — 設計文件

日期:2026-07-21
狀態:已確認(使用者核准)

## 背景與目標

目前 MCP 設定必須寫 node.exe 與 `dist/index.js` 的絕對路徑,團隊其他成員難以共用;
且預設 organization/project 寫死在工具描述中,實際預設值依賴每台機器各自執行
`az devops configure --defaults`,行為不一致。

目標:

1. 團隊成員從 Git repo 以 `npm install -g` 安裝後,MCP 設定改用 `command: npx` 方式。
2. server 啟動參數可設定 `organization`、`project`、`repository`,三者皆選填,
   內建預設值:`organization=https://dev.azure.com/SKMHHIS`、`project=MS`、`repository=MS-Web`。
3. 命令未指定時由 server 自動補上這些參數,不再依賴各機器的 az defaults。

已排除的替代方案:

- 環境變數覆寫(`AZURE_DEVOPS_EXT_DEFAULTS_*`):實測無效,az devops 不支援。
- 只把預設值寫進工具描述、由模型自行帶參數:模型忘記帶時會 fallback 到各機器
  az defaults,行為不一致。
- 純例外清單(不做失敗回退):清單需跟隨 az CLI 版本維護,漏列即報錯,健壯性差。

## 設計

### 1. 啟動參數(CLI args)

`src/index.ts` 以 Node 內建 `util.parseArgs` 解析:

| 參數 | 預設值 |
|------|--------|
| `--organization` | `https://dev.azure.com/SKMHHIS` |
| `--project` | `MS` |
| `--repository` | `MS-Web` |

- `--organization` 若只給短名(如 `SKMHHIS`),自動補成 `https://dev.azure.com/SKMHHIS`。
- 未知參數直接報錯退出(stderr 說明 + 非零結束碼),避免打錯字沒發現。
- 解析結果組成 `Defaults` 物件傳入 `createServer()`。

### 2. 團隊 MCP 設定(README)

安裝(repo 為 public,不需 GitHub 帳號授權):

```
npm install -g git+https://github.com/A016098Tony/skh-msweb-azure-cli-mcp.git
```

`package.json` 需新增 `"prepare": "npm run build"` script:`dist/` 已被 gitignore,
repo 中沒有編譯產物;npm 從 git 安裝時會自動安裝 devDependencies 並執行 `prepare`,
如此 `dist/index.js` 才會在安裝當下編譯出來,`bin` 連結才有效。
(注意套件/bin 名稱是 `azure-devops-cli-mcp`,與 repo 名稱不同;npx 用的是套件名。)

Claude Desktop / Cowork / Claude Code 設定:

```json
{
  "mcpServers": {
    "azure-devops-cli": {
      "command": "npx",
      "args": ["azure-devops-cli-mcp", "--project", "MS", "--repository", "MS-Web"]
    }
  }
}
```

- args 全部可省略(使用內建預設值)。
- README 保留 Windows GUI 程序 PATH 問題說明,補充:找不到 `npx` 時,
  `command` 改用 `npx.cmd` 絕對路徑(以 `(Get-Command npx.cmd).Source` 查詢),args 不變。
- claude.ai 網頁版不支援本機 stdio MCP server,屬架構限制,不在本設計範圍。

### 3. 參數注入邏輯(新模組 `src/defaults.ts`)

時機:`validateScope` 通過後、執行前。只掃描**雙引號外**的 token,
避免 WIQL 或 `--query` 字串內容誤判。

規則:

- 命令無 `--org` / `--organization` → 補 `--organization <值>`
- 命令無 `--project` / `-p` → 補 `--project <值>`
- 命令以 `repos pr` 開頭且無 `--repository` / `-r` → 補 `--repository <值>`
- 例外:`devops configure` 開頭的命令完全不注入(不接受這些參數,且屬本機設定命令)
- `az_devops_help` 工具(`--help` 查詢)不注入

### 4. 失敗自動回退

執行後若失敗且 stderr 含 `unrecognized arguments`,且錯誤訊息提到的參數
正是本次**注入**的參數(非使用者自己帶的),則移除該注入參數後重跑一次。
最多重試一次。此機制取代「哪些命令不吃 --project」的例外清單維護。

### 5. 工具描述動態化

`src/server.ts` 的 `az_devops` 工具描述改由 `Defaults` 實際值組成
(例如「預設 organization 為 <值>、project 為 <值>,server 會自動補上,
通常不需要帶 --org/--project」),移除寫死的 SKMHHIS/SKH-AOAI 字樣。

### 6. 錯誤處理

- 啟動:未知 CLI 參數 → stderr 報錯 + 退出。
- 執行:回退重試後仍失敗 → 照現行 `toToolResult` 錯誤路徑回傳。
- 注入不改變既有 scope 驗證、shell 特殊字元防護、`ensureJsonOutput`、輸出截斷行為。

### 7. 測試

- `defaults.ts` 單元測試:
  - parseArgs:預設值、覆寫、短名補完整 URL、未知參數報錯
  - 注入:三參數各自的補與不補、引號內 token 不誤判、`repos pr` 才注入 repository、
    `devops configure` 不注入
- `server.ts` 整合測試(mock executeFn):
  - 命令實際被注入預設參數
  - `unrecognized arguments` 觸發移除注入參數並重試一次
  - help 工具不注入
- 既有測試全數維持通過。
