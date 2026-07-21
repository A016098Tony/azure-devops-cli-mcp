import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { ExecResult, ExecuteOptions } from "../src/executor.js";
import { BUILT_IN_DEFAULTS, type Defaults } from "../src/defaults.js";
import type { AttachmentIo } from "../src/attachment.js";

interface RecordedCall {
  commandLine: string;
  options: ExecuteOptions | undefined;
}

function makeFakeExecutor(result: Partial<ExecResult> = {}) {
  const calls: RecordedCall[] = [];
  const fake = (
    commandLine: string,
    options?: ExecuteOptions,
  ): Promise<ExecResult> => {
    calls.push({ commandLine, options });
    return Promise.resolve({
      stdout: "[]",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      ...result,
    });
  };
  return { fake, calls };
}

async function connect(
  executeFn: ReturnType<typeof makeFakeExecutor>["fake"],
  defaults: Defaults = BUILT_IN_DEFAULTS,
  io?: AttachmentIo,
) {
  const server = createServer(executeFn, defaults, io);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("\n");
}

describe("azure-devops-cli-mcp server", () => {
  test("列出三個工具", async () => {
    const { fake } = makeFakeExecutor();
    const client = await connect(fake);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "az_devops",
      "az_devops_help",
      "az_workitem_attach",
    ]);
  });

  test("az_devops 工具描述內嵌預設 org/project/repository", async () => {
    const { fake } = makeFakeExecutor();
    const client = await connect(fake);
    const { tools } = await client.listTools();
    const azDevops = tools.find((t) => t.name === "az_devops");
    expect(azDevops?.description).toContain("https://dev.azure.com/SKMHHIS");
    expect(azDevops?.description).toContain("MS");
    expect(azDevops?.description).toContain("MS-Web");
    expect(azDevops?.description).not.toContain("SKH-AOAI");
  });

  test("az_devops 執行合法命令並自動補 --output json", async () => {
    const { fake, calls } = makeFakeExecutor({ stdout: '[{"id": 1}]' });
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_devops",
      arguments: { command: "repos list" },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('"id": 1');
    expect(calls[0]?.commandLine).toBe(
      "repos list --output json --organization https://dev.azure.com/SKMHHIS --project MS",
    );
    expect(calls[0]?.options?.timeoutMs).toBe(120_000);
  });

  test("az_devops 傳遞自訂 timeout（秒轉毫秒）", async () => {
    const { fake, calls } = makeFakeExecutor();
    const client = await connect(fake);
    await client.callTool({
      name: "az_devops",
      arguments: { command: "pipelines runs list", timeout: 300 },
    });
    expect(calls[0]?.options?.timeoutMs).toBe(300_000);
  });

  test("az_devops 拒絕範圍外的命令且不執行", async () => {
    const { fake, calls } = makeFakeExecutor();
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_devops",
      arguments: { command: "vm list" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("vm");
    expect(calls).toHaveLength(0);
  });

  test("非零結束碼回傳 stderr 並標記 isError", async () => {
    const { fake } = makeFakeExecutor({
      stdout: "",
      stderr: "ERROR: TF401019: repository not found",
      exitCode: 1,
    });
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_devops",
      arguments: { command: "repos show -r nope" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TF401019");
  });

  test("az 不存在時附上安裝指引", async () => {
    const { fake } = makeFakeExecutor({
      stdout: "",
      stderr:
        "'az' is not recognized as an internal or external command, operable program or batch file.",
      exitCode: 1,
    });
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_devops",
      arguments: { command: "repos list" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("安裝");
  });

  test("成功但有 stderr 警告時一併附上", async () => {
    const { fake } = makeFakeExecutor({
      stdout: "[]",
      stderr: "WARNING: extension update available",
      exitCode: 0,
    });
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_devops",
      arguments: { command: "repos list" },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("WARNING");
  });

  test("逾時回傳明確訊息", async () => {
    const { fake } = makeFakeExecutor({ timedOut: true, exitCode: 1 });
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_devops",
      arguments: { command: "boards query --wiql SELECT" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("逾時");
  });

  test("超長輸出被截斷", async () => {
    const { fake } = makeFakeExecutor({ stdout: "x".repeat(60_000) });
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_devops",
      arguments: { command: "repos list" },
    });
    expect(textOf(result).length).toBeLessThan(60_000);
    expect(textOf(result)).toContain("截斷");
  });

  test("az_devops_help 附加 --help 且不補 json、逾時 60 秒", async () => {
    const { fake, calls } = makeFakeExecutor({
      stdout: "Command\n  az repos ...",
    });
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_devops_help",
      arguments: { command: "repos pr create" },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0]?.commandLine).toBe("repos pr create --help");
    expect(calls[0]?.options?.timeoutMs).toBe(60_000);
  });

  test("az_devops_help 同樣做範圍驗證", async () => {
    const { fake, calls } = makeFakeExecutor();
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_devops_help",
      arguments: { command: "vm create" },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("repos pr 命令注入預設 repository", async () => {
    const { fake, calls } = makeFakeExecutor();
    const client = await connect(fake);
    await client.callTool({
      name: "az_devops",
      arguments: { command: "repos pr list --status active" },
    });
    expect(calls[0]?.commandLine).toBe(
      "repos pr list --status active --output json --organization https://dev.azure.com/SKMHHIS --project MS --repository MS-Web",
    );
  });

  test("自訂 defaults 反映在注入與工具描述", async () => {
    const { fake, calls } = makeFakeExecutor();
    const custom: Defaults = {
      organization: "https://dev.azure.com/OtherOrg",
      project: "P2",
      repository: "R2",
    };
    const client = await connect(fake, custom);
    const { tools } = await client.listTools();
    expect(
      tools.find((t) => t.name === "az_devops")?.description,
    ).toContain("OtherOrg");
    await client.callTool({
      name: "az_devops",
      arguments: { command: "repos list" },
    });
    expect(calls[0]?.commandLine).toBe(
      "repos list --output json --organization https://dev.azure.com/OtherOrg --project P2",
    );
  });

  test("注入參數不被接受時移除該參數重試一次", async () => {
    const commandLines: string[] = [];
    const fake = (
      commandLine: string,
      options?: ExecuteOptions,
    ): Promise<ExecResult> => {
      void options;
      commandLines.push(commandLine);
      if (commandLines.length === 1) {
        return Promise.resolve({
          stdout: "",
          stderr: "ERROR: unrecognized arguments: --project MS",
          exitCode: 2,
          timedOut: false,
        });
      }
      return Promise.resolve({
        stdout: "[]",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
    };
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_devops",
      arguments: { command: "devops user list" },
    });
    expect(result.isError).toBeFalsy();
    expect(commandLines).toHaveLength(2);
    expect(commandLines[1]).toBe(
      "devops user list --output json --organization https://dev.azure.com/SKMHHIS",
    );
  });

  test("使用者自帶參數造成 unrecognized 時不重試", async () => {
    const { fake, calls } = makeFakeExecutor({
      stdout: "",
      stderr: "ERROR: unrecognized arguments: --bogus x",
      exitCode: 2,
    });
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_devops",
      arguments: { command: "repos list --bogus x" },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("非 unrecognized 的失敗不重試", async () => {
    const { fake, calls } = makeFakeExecutor({
      stdout: "",
      stderr: "ERROR: TF400813: not authorized",
      exitCode: 1,
    });
    const client = await connect(fake);
    await client.callTool({
      name: "az_devops",
      arguments: { command: "repos list" },
    });
    expect(calls).toHaveLength(1);
  });

  test("az_workitem_attach 成功上傳並回報附件 URL", async () => {
    const { fake } = makeFakeExecutor();
    const responses = [
      new Response(
        JSON.stringify({
          id: "abc",
          url: "https://dev.azure.com/SKMHHIS/_apis/wit/attachments/abc",
        }),
        { status: 201 },
      ),
      new Response("{}", { status: 200 }),
    ];
    const io: AttachmentIo = {
      readFile: async () => Buffer.from("報告內容"),
      fetchFn: (async () => responses.shift()!) as typeof fetch,
      env: { AZURE_DEVOPS_EXT_PAT: "pat" },
    };
    const client = await connect(fake, BUILT_IN_DEFAULTS, io);
    const result = await client.callTool({
      name: "az_workitem_attach",
      arguments: { workItemId: 42, filePath: "D:\\tmp\\report.md" },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("report.md");
    expect(textOf(result)).toContain("#42");
  });

  test("az_workitem_attach 失敗時標記 isError", async () => {
    const { fake } = makeFakeExecutor();
    const enoent = Object.assign(new Error("no such file"), {
      code: "ENOENT",
    });
    const io: AttachmentIo = {
      readFile: async () => { throw enoent; },
      fetchFn: (async () => new Response("{}")) as typeof fetch,
      env: { AZURE_DEVOPS_EXT_PAT: "pat" },
    };
    const client = await connect(fake, BUILT_IN_DEFAULTS, io);
    const result = await client.callTool({
      name: "az_workitem_attach",
      arguments: { workItemId: 1, filePath: "D:\\nope.md" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("找不到檔案");
  });

  test("az_workitem_attach 工具描述內嵌預設 org/project", async () => {
    const { fake } = makeFakeExecutor();
    const client = await connect(fake);
    const { tools } = await client.listTools();
    const attach = tools.find((t) => t.name === "az_workitem_attach");
    expect(attach?.description).toContain("https://dev.azure.com/SKMHHIS");
    expect(attach?.description).toContain("MS");
  });
});
