# azure-devops-cli-mcp

本地 MCP server，把 Claude Desktop / Cowork 橋接到本機的 Azure DevOps CLI。
Claude 可透過它完整使用 `az devops`、`az repos`、`az boards`、`az pipelines`、`az artifacts`。

## 前置需求

- Node.js >= 20
- Azure CLI（含 azure-devops extension）：`az extension add --name azure-devops`
- 已完成 `az login`
- 已設定預設組織與專案：

  ```
  az devops configure --defaults organization=https://dev.azure.com/SKMHHIS project=SKH-AOAI
  ```

## 安裝與建置

```
npm install
npm run build
```

## Claude Desktop 設定

在 `claude_desktop_config.json`（Windows 路徑：`%APPDATA%\Claude\claude_desktop_config.json`）
的 `mcpServers` 加入：

```json
{
  "mcpServers": {
    "azure-devops-cli": {
      "command": "node",
      "args": ["D:\\mygithub\\azure_cli_mcp\\dist\\index.js"]
    }
  }
}
```

重啟 Claude Desktop 後即可使用。

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
npm test              # vitest 單元 + 整合測試（不需要 az）
node scripts/smoke.mjs  # 實機煙霧測試（需要 az login）
```
