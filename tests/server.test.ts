import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { ExecResult, ExecuteOptions } from "../src/executor.js";

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

async function connect(executeFn: ReturnType<typeof makeFakeExecutor>["fake"]) {
  const server = createServer(executeFn);
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
  test("列出兩個工具", async () => {
    const { fake } = makeFakeExecutor();
    const client = await connect(fake);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "az_devops",
      "az_devops_help",
    ]);
  });

  test("az_devops 工具描述內嵌預設 org/project", async () => {
    const { fake } = makeFakeExecutor();
    const client = await connect(fake);
    const { tools } = await client.listTools();
    const azDevops = tools.find((t) => t.name === "az_devops");
    expect(azDevops?.description).toContain("SKMHHIS");
    expect(azDevops?.description).toContain("SKH-AOAI");
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
    expect(calls[0]?.commandLine).toBe("repos list --output json");
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
});
