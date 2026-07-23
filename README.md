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
| `az_workitem_attach` | 上傳本機檔案為 work item 附件並建立連結（文字與 binary 皆可，上限 100MB）。例如把 code review 報告或錯誤截圖附到 work item。 |
| `az_pr_show` | 取得 PR 完整資訊（REST），含 source/target branch 與狀態。 |
| `az_pr_changes` | 取得 PR 異動檔案清單（REST iterations/changes），自動使用最新 iteration。 |
| `az_pr_workitems` | 取得 PR 關聯的 work item 清單（REST）。 |
| `az_workitem_relations` | 取得 work item 含 relations（REST，$expand=relations），可檢查附件重名。 |
| `az_pr_comment` | 在 PR 建立討論串留言或回覆既有討論串（REST）。 |
| `az_workitem_update` | 更新 work item 欄位／寫入 Discussion（REST json-patch，僅允許 /fields/*）。 |
| `az_rest` | 通用 Azure DevOps REST 呼叫（GET/POST/PATCH），供未涵蓋的端點使用。 |
| `az_git_fetch` | 在主機端對本機 repo 執行 `git fetch`（唯讀）。Cowork sandbox 內 fetch 被 proxy 擋下（403）時的替代路徑，fetch 完成後 sandbox 內即可用本機 git 操作 `origin/<branch>`。 |
| `az_git_ls_remote` | 在主機端查詢遠端 refs（`git ls-remote`，不下載物件），可先確認遠端分支存在。 |

REST 工具的認證與 `az_workitem_attach` 相同：優先使用 `AZURE_DEVOPS_EXT_PAT`
環境變數，否則使用 `az login` 的憑證。所有 REST URL 鎖定在預設 organization，
無法對其他主機發送請求。

僅允許 `devops`、`repos`、`boards`、`pipelines`、`artifacts` 五個命令群組；
其餘 az 命令（如 `vm`、`account`）一律拒絕。認證依賴本機的 `az login`
（`az_workitem_attach` 會內部執行 `az account get-access-token` 取 token；
若設定了 `AZURE_DEVOPS_EXT_PAT` 環境變數則優先使用該 PAT），
server 不儲存任何憑證。

### 安全防護

命令經由 shell 執行，因此雙引號外含有 shell 控制字元（`& | ; < > ( ) \` ^` 或換行）
或有未配對雙引號的命令會被拒絕，以免 `repos list & <任意命令>` 之類的串接繞過群組
限制而執行任意本機命令。含特殊字元的參數值（例如 WIQL 或 `--query` 的 JMESPath 運算式）
用雙引號包起來即可正常執行，例如：
`boards query --wiql "SELECT [System.Id] FROM WorkItems WHERE [System.State] <> 'Closed'"`。

### Git 工具

`az_git_fetch` / `az_git_ls_remote` 在主機端執行 git 的唯讀網路操作，
`repoPath` 必須是主機端的絕對路徑。參數經嚴格驗證：remote 只接受名稱
（不接受 URL）、refspec/pattern 不可以 `-` 開頭（擋 `--upload-pack` 等
危險選項）。不提供 push、pull 或任何寫入操作。認證使用主機端的
git credential（如 Git Credential Manager）。

## 開發

```
git clone https://github.com/A016098Tony/azure-devops-cli-mcp.git
npm install
npm test              # vitest 單元 + 整合測試（不需要 az）
node scripts/smoke.mjs  # 實機煙霧測試（需要 az login）
```
