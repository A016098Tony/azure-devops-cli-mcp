# Azure DevOps CLI MCP Server — 設計文件

日期：2026-07-21
狀態：已由使用者核准

## 目的

Claude Desktop / Cowork 的沙箱環境無法直接執行本機的 `az` 命令。本專案建立一個跑在本機的 Node MCP server，作為 bridge（橋接器）：把 MCP 工具呼叫轉譯成本機 Azure DevOps CLI 的執行，再把結果回傳給 Claude。

目標是**完整涵蓋** Azure DevOps CLI 功能（passthrough），而非精選部分操作。

## 環境前提

- Azure CLI 2.67.0+，已安裝 `azure-devops` extension
- 本機已完成 `az login`（目前帳號 A016098@ms.skh.org.tw，可直接存取 SKMHHIS 組織，無需 PAT）
- `az devops configure` 預設值：organization `https://dev.azure.com/SKMHHIS`、project `SKH-AOAI`
- Node.js v24+、Windows 11

## 架構

```
Claude Desktop / Cowork
        │  (MCP stdio)
        ▼
 Node MCP Server（TypeScript, @modelcontextprotocol/sdk）
        │  child_process spawn（每次呼叫一個新程序）
        ▼
 az CLI（繼承本機環境與 az login 工作階段）
        ▼
 dev.azure.com/SKMHHIS
```

- **無狀態**：每次工具呼叫 spawn 一個新的 `az` 程序，不維護 session。
- **認證**：完全依賴本機既有的 `az login` 工作階段；server 本身不儲存、不轉發任何憑證。
- **Transport**：stdio（Claude Desktop / Cowork 的標準接法）。

## 工具定義

### `az_devops`（核心 passthrough）

執行任意 Azure DevOps 家族命令。

| 參數 | 型別 | 說明 |
|------|------|------|
| `command` | string（必填） | 不含 `az` 前綴的命令，例如 `repos pr list --status active` |
| `timeout` | number（選填） | 逾時秒數，預設 120 |

行為：

1. **範圍驗證**：命令的第一個 token 必須是 `devops`、`repos`、`boards`、`pipelines`、`artifacts` 之一，否則拒絕執行。這是唯一的限制——群組內的所有子命令（含 `delete`）皆允許（使用者已確認完全開放）。
2. **智慧補參**：若命令未指定 `-o` / `--output`，自動附加 `--output json`。
3. 工具描述（description）內嵌預設 org/project 資訊，讓 Claude 不需每次帶 `--org` / `--project`。

### `az_devops_help`（語法查詢）

| 參數 | 型別 | 說明 |
|------|------|------|
| `command` | string（必填） | 命令群組或子命令，例如 `boards work-item update` |

執行 `az <command> --help` 並回傳官方說明文字，讓 Claude 在不確定語法時先查再執行。`--help` 輸出不做 JSON 補參。範圍驗證與 `az_devops` 相同。

## 執行與錯誤處理

- Windows 上 `az` 是批次檔（`az.cmd`），以 `cmd /c` 執行完整命令字串。
- **非零結束碼**：將 stderr 內容作為工具結果回傳並標記 `isError: true`，讓 Claude 讀到 az 的錯誤訊息後自行修正命令，而不是中斷 MCP 協定。
- **輸出上限**：50KB。超過即截斷，並附註提示「請用 `--top`、`--query` 或查詢條件縮小範圍」。
- **逾時**：超過 timeout 即終止子程序，回傳逾時說明。
- **az 不存在**：回傳明確的安裝指引錯誤訊息。

## 專案結構

```
azure_cli_mcp/
├── package.json          # type: module；build/test scripts
├── tsconfig.json
├── src/
│   ├── index.ts          # server 進入點、工具註冊
│   └── executor.ts       # 命令範圍驗證、輸出補參、spawn、截斷
├── tests/                # vitest 單元測試
└── README.md             # 安裝步驟與 Claude Desktop 設定範例
```

## 測試與驗收

1. **單元測試（vitest）**：
   - 範圍驗證：允許五個群組、拒絕其他（如 `vm list`、空字串）
   - 輸出補參：無 `-o` 時附加 `--output json`；已有 `-o table` 時不重複附加
   - 截斷邏輯：超過 50KB 時截斷並附提示
2. **整合驗證（MCP Inspector 或實際呼叫）**：
   - `az_devops` 執行 `repos list` 成功回傳 JSON
   - `az_devops_help` 執行 `boards work-item update` 回傳說明文字
   - 超出範圍命令（如 `account show`）被拒絕
3. **交付**：README 內含可直接貼進 `claude_desktop_config.json` 的 `mcpServers` 設定片段（`node dist/index.js`）。

## 明確排除（YAGNI）

- 不做精選（curated）工具集
- 不做命令白名單／黑名單（完全開放，僅限五個群組）
- 不做 PAT 管理或任何憑證處理
- 不支援整個 az CLI（僅 DevOps 家族）
