import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureJsonOutput, truncateOutput, validateScope } from "./command.js";
import { execute, type ExecResult } from "./executor.js";
import {
  appendFlags,
  BUILT_IN_DEFAULTS,
  planInjection,
  type Defaults,
  type InjectedFlag,
} from "./defaults.js";
import {
  attachFileToWorkItem,
  type AttachmentIo,
} from "./attachment.js";
import { adoRest, type RestMethod, type RestOutcome } from "./rest.js";
import {
  createPullRequestComment,
  getPullRequestChanges,
  listPullRequestWorkItems,
  showPullRequest,
} from "./pullRequest.js";
import { getWorkItemRelations, updateWorkItem } from "./workItem.js";
import { gitFetch, gitLsRemote, type GitOutcome } from "./git.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const HELP_TIMEOUT_MS = 60_000;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function toToolResult(result: ExecResult): ToolResult {
  if (result.timedOut) {
    return {
      content: [
        {
          type: "text",
          text: "命令執行逾時，子程序已終止。可調高 timeout 參數，或用 --top、--query 縮小查詢範圍。",
        },
      ],
      isError: true,
    };
  }
  if (result.exitCode !== 0) {
    let text =
      result.stderr || result.stdout || `命令失敗，結束碼 ${result.exitCode}。`;
    if (/'az' is not recognized|az: command not found/i.test(text)) {
      text +=
        "\n\n找不到 Azure CLI。請先安裝：https://aka.ms/installazurecliwindows，" +
        "並執行 az extension add --name azure-devops 與 az login。";
    }
    return { content: [{ type: "text", text: truncateOutput(text) }], isError: true };
  }
  let text = result.stdout || "(無輸出)";
  if (result.stderr.trim()) {
    text += `\n\n[stderr]\n${result.stderr}`;
  }
  return { content: [{ type: "text", text: truncateOutput(text) }] };
}

function scopeError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

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

function gitToolResult(outcome: GitOutcome): ToolResult {
  if (!outcome.ok) {
    return {
      content: [{ type: "text", text: truncateOutput(outcome.error) }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: truncateOutput(outcome.text) }],
  };
}

async function executeWithInjection(
  executeFn: typeof execute,
  command: string,
  injected: InjectedFlag[],
  options: { timeoutMs: number },
): Promise<ExecResult> {
  const first = await executeFn(appendFlags(command, injected), options);
  if (first.exitCode === 0 || injected.length === 0) return first;
  if (!/unrecognized arguments/i.test(first.stderr)) return first;
  const remaining = injected.filter((f) => !first.stderr.includes(f.flag));
  if (remaining.length === injected.length) return first;
  return executeFn(appendFlags(command, remaining), options);
}

export function createServer(
  executeFn: typeof execute = execute,
  defaults: Defaults = BUILT_IN_DEFAULTS,
  io: AttachmentIo = { readFile, fetchFn: fetch, env: process.env },
): McpServer {
  const server = new McpServer({
    name: "azure-devops-cli-mcp",
    version: "0.5.0",
  });

  server.registerTool(
    "az_devops",
    {
      title: "Azure DevOps CLI",
      description:
        "執行 Azure DevOps CLI 命令（az 前綴由 server 自動加上，command 請勿包含）。" +
        "允許的命令群組：devops、repos、boards、pipelines、artifacts。" +
        `預設 organization 為 ${defaults.organization}、project 為 ${defaults.project}，` +
        `repos pr 命令預設 repository 為 ${defaults.repository}` +
        "（未指定時 server 會自動補上，通常不需要帶 --org/--project/--repository）。" +
        "未指定 -o/--output 時自動使用 --output json。" +
        '範例："repos pr list --status active"、"boards work-item show --id 123"。' +
        "不確定語法時，先用 az_devops_help 查詢。",
      inputSchema: {
        command: z
          .string()
          .describe('不含 "az" 前綴的命令，例如 "repos pr list --status active"'),
        timeout: z
          .number()
          .optional()
          .describe("逾時秒數，預設 120"),
      },
    },
    async ({ command, timeout }) => {
      const scope = validateScope(command);
      if (!scope.ok) return scopeError(scope.error);
      const base = ensureJsonOutput(command.trim());
      const injected = planInjection(base, defaults);
      const result = await executeWithInjection(executeFn, base, injected, {
        timeoutMs: (timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
      });
      return toToolResult(result);
    },
  );

  server.registerTool(
    "az_devops_help",
    {
      title: "Azure DevOps CLI 說明查詢",
      description:
        "查詢 Azure DevOps CLI 命令的官方說明（等同 az <command> --help）。" +
        "在不確定子命令或參數語法時先用這個工具，再用 az_devops 執行。" +
        '範例：command 傳 "boards work-item update" 會回傳該命令的完整參數說明。',
      inputSchema: {
        command: z
          .string()
          .describe('命令群組或子命令，不含 "az" 前綴，例如 "repos pr create"'),
      },
    },
    async ({ command }) => {
      const scope = validateScope(command);
      if (!scope.ok) return scopeError(scope.error);
      const result = await executeFn(`${command.trim()} --help`, {
        timeoutMs: HELP_TIMEOUT_MS,
      });
      return toToolResult(result);
    },
  );

  server.registerTool(
    "az_workitem_attach",
    {
      title: "Attach File to Work Item",
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

  server.registerTool(
    "az_git_fetch",
    {
      title: "Git Fetch (host-side)",
      description:
        "在主機端對本機 repo 執行 git fetch（唯讀網路操作，不動工作目錄）。" +
        "典型情境：Cowork sandbox 內 git fetch 被 proxy 擋下（403）時，" +
        "用此工具在主機端代跑；完成後 sandbox 內即可用本機 git 操作 origin/<branch>。" +
        "不提供 push/pull 等寫入操作。",
      inputSchema: {
        repoPath: z
          .string()
          .describe(
            "本機 repo 的「主機端」絕對路徑（例如 D:\\mygithub\\MS-Web；" +
              "sandbox 內看到的路徑可能與主機不同）",
          ),
        remote: z
          .string()
          .optional()
          .describe("遠端名稱，預設 origin（只接受 remote 名稱，不接受 URL）"),
        refspec: z
          .string()
          .optional()
          .describe(
            '要 fetch 的分支或 refspec，例如 "releases/s116/rc-092"；' +
              "未指定時 fetch 該 remote 的全部分支",
          ),
        prune: z
          .boolean()
          .optional()
          .describe("加 --prune，清除遠端已刪除分支的追蹤 ref"),
        timeout: z.number().optional().describe("逾時秒數，預設 120"),
      },
    },
    async ({ repoPath, remote, refspec, prune, timeout }) =>
      gitToolResult(
        await gitFetch(executeFn, {
          repoPath,
          remote,
          refspec,
          prune,
          timeoutMs: (timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        }),
      ),
  );

  server.registerTool(
    "az_git_ls_remote",
    {
      title: "Git Ls-Remote (host-side)",
      description:
        "在主機端查詢本機 repo 的遠端 refs（git ls-remote，不下載物件）。" +
        "適合在 fetch 前快速確認遠端分支是否存在，" +
        "例如確認 releases/s116/rc-092 存在於 origin。",
      inputSchema: {
        repoPath: z
          .string()
          .describe(
            "本機 repo 的「主機端」絕對路徑（例如 D:\\mygithub\\MS-Web）",
          ),
        remote: z
          .string()
          .optional()
          .describe("遠端名稱，預設 origin（只接受 remote 名稱，不接受 URL）"),
        pattern: z
          .string()
          .optional()
          .describe('ref 過濾，例如 "releases/s116/rc-092"'),
        heads: z.boolean().optional().describe("只列分支（--heads）"),
        tags: z.boolean().optional().describe("只列 tag（--tags）"),
        timeout: z.number().optional().describe("逾時秒數，預設 120"),
      },
    },
    async ({ repoPath, remote, pattern, heads, tags, timeout }) =>
      gitToolResult(
        await gitLsRemote(executeFn, {
          repoPath,
          remote,
          pattern,
          heads,
          tags,
          timeoutMs: (timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        }),
      ),
  );

  return server;
}
