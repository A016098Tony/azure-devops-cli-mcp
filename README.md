# azure-devops-cli-mcp

本地 MCP server，把 Claude Desktop / Cowork 橋接到本機的 Azure DevOps CLI。
Claude 可透過它完整使用 `az devops`、`az repos`、`az boards`、`az pipelines`、`az artifacts`。

## 前置需求

- Node.js >= 20
- Azure CLI（含 azure-devops extension）：`az extension add --name azure-devops`
- 已完成 `az login`
- 不需要 `az devops configure --defaults`：server 會自動帶入預設
  organization / project / repository（見下方「啟動參數」）。

## 安裝（團隊成員）

```
npm install -g git+https://github.com/A016098Tony/azure-devops-cli-mcp.git
```

安裝時會自動編譯（`prepare` script），不需另外執行 build。
更新版本時重跑同一行命令即可。

## Claude Desktop 設定

開啟 `claude_desktop_config.json`（Windows 完整路徑：
`C:\Users\<你的帳號>\AppData\Roaming\Claude\claude_desktop_config.json`；也可從
Claude Desktop → Settings → Developer → Edit Config 開啟），在 `mcpServers` 加入：

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

此設定檔 Claude Desktop（含 Cowork）與 Claude Code 共用同一格式。
claude.ai 網頁版不支援本機 stdio MCP server。

### 啟動參數

三個參數皆選填，未指定時使用內建預設值：

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `--organization` | `https://dev.azure.com/SKMHHIS` | 可只給短名（如 `SKMHHIS`），自動補完整 URL |
| `--project` | `MS` | 預設專案 |
| `--repository` | `MS-Web` | 只套用在 `repos pr` 命令 |

命令未指定 `--org` / `--project`（`repos pr` 未指定 `--repository`）時，
server 會自動補上這些預設值；命令中明確指定時以命令為準。
若某個 az 子命令不接受被補上的參數，server 會自動移除該參數重試一次。

> **Windows + nvm 注意**：桌面應用（GUI 程序）繼承的 PATH 可能與終端機不同，
> 若出現「找不到 npx」，把 `command` 改成 `npx.cmd` 的絕對路徑
> （用 `(Get-Command npx.cmd).Source` 查出，例如 `C:\nvm4w\nodejs\npx.cmd`），
> `args` 不變。

**務必完整結束並重新啟動 Claude Desktop**（關閉分頁不夠，要整個結束再開）才會載入。
啟動後可在對話框左下角的「+」→ Connectors 看到 `azure-devops-cli` 及其工具。

## 工具

| 工具 | 用途 |
|------|------|
| `az_devops` | 執行任意 DevOps 家族命令，例如 `repos pr list --status active`。未指定輸出格式時自動用 JSON。 |
| `az_devops_help` | 查詢命令語法，等同 `az <command> --help`。 |

僅允許 `devops`、`repos`、`boards`、`pipelines`、`artifacts` 五個命令群組；
其餘 az 命令（如 `vm`、`account`）一律拒絕。認證完全依賴本機的 `az login`，
server 不儲存任何憑證。

### 安全防護

命令經由 shell 執行，因此雙引號外含有 shell 控制字元（`& | ; < > ( ) \` ^` 或換行）
或有未配對雙引號的命令會被拒絕，以免 `repos list & <任意命令>` 之類的串接繞過群組
限制而執行任意本機命令。含特殊字元的參數值（例如 WIQL 或 `--query` 的 JMESPath 運算式）
用雙引號包起來即可正常執行，例如：
`boards query --wiql "SELECT [System.Id] FROM WorkItems WHERE [System.State] <> 'Closed'"`。

## 開發

```
git clone https://github.com/A016098Tony/azure-devops-cli-mcp.git
npm install
npm test              # vitest 單元 + 整合測試（不需要 az）
node scripts/smoke.mjs  # 實機煙霧測試（需要 az login）
```
