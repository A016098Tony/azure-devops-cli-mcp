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
    version: "0.3.0",
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
      title: "上傳附件到 Work Item",
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

  return server;
}
