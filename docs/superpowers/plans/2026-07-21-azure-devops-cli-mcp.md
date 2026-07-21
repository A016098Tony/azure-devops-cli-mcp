# Azure DevOps CLI MCP Server 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一個本地 Node MCP server（stdio），把 MCP 工具呼叫橋接到本機 Azure DevOps CLI（`az devops/repos/boards/pipelines/artifacts`），供 Claude Desktop / Cowork 使用。

**Architecture:** 無狀態 passthrough：兩個工具（`az_devops` 執行、`az_devops_help` 查語法），每次呼叫以 `child_process.exec` spawn 一個新的 `az` 程序（Windows 上自動經 `cmd /c`），繼承本機 `az login` 工作階段。純函式的命令前處理（範圍驗證、JSON 補參、截斷）與 spawn 邏輯分離，server 層可注入假的 executor 做快速整合測試。

**Tech Stack:** TypeScript（strict、ESM、NodeNext）、`@modelcontextprotocol/sdk` ^1.x、`zod` ^3、`vitest` ^3、Node.js >= 20（本機 v24.14.0）

**Spec:** `docs/superpowers/specs/2026-07-21-azure-devops-cli-mcp-design.md`

## Global Constraints

- 僅允許五個命令群組：`devops`、`repos`、`boards`、`pipelines`、`artifacts`；其餘一律拒絕（含 `az` 前綴本身）
- 群組內完全開放，**不做** delete 黑名單、白名單、PAT 管理
- 未指定 `-o`/`--output` 時自動附加 `--output json`（`--help` 除外）
- 輸出上限 50KB（`OUTPUT_LIMIT = 50_000` 字元），超過即截斷並附提示
- 預設逾時 120 秒；`az_devops_help` 固定 60 秒
- 非零結束碼回傳 stderr 並標記 `isError: true`，不中斷 MCP 協定
- 工具描述需內嵌預設值：organization `https://dev.azure.com/SKMHHIS`、project `SKH-AOAI`
- package name：`azure-devops-cli-mcp`，version `0.1.0`
- 所有 src 內的相對 import 使用 `.js` 副檔名（NodeNext 規則）

---

### Task 1: 專案 scaffolding + 命令前處理模組（`command.ts`）

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/command.ts`
- Test: `tests/command.test.ts`

**Interfaces:**
- Consumes: 無（第一個 task）
- Produces（Task 3 會用到）:
  - `ALLOWED_GROUPS: readonly string[]` — 五個允許的群組
  - `validateScope(command: string): { ok: true } | { ok: false; error: string }`
  - `ensureJsonOutput(command: string): string` — 回傳（必要時）補上 `--output json` 的命令
  - `OUTPUT_LIMIT: number`（50_000）
  - `truncateOutput(text: string): string`

- [ ] **Step 1: 建立專案 scaffolding**

建立 `package.json`：

```json
{
  "name": "azure-devops-cli-mcp",
  "version": "0.1.0",
  "description": "Local MCP server bridging Claude Desktop/Cowork to the Azure DevOps CLI",
  "type": "module",
  "bin": {
    "azure-devops-cli-mcp": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  }
}
```

建立 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

建立 `.gitignore`：

```
node_modules/
dist/
```

安裝依賴：

Run: `npm install`
Expected: 安裝成功，產生 `package-lock.json` 與 `node_modules/`

- [ ] **Step 2: 寫失敗的測試**

建立 `tests/command.test.ts`：

```ts
import { describe, expect, test } from "vitest";
import {
  ALLOWED_GROUPS,
  OUTPUT_LIMIT,
  ensureJsonOutput,
  truncateOutput,
  validateScope,
} from "../src/command.js";

describe("validateScope", () => {
  test.each(["devops", "repos", "boards", "pipelines", "artifacts"])(
    "允許 %s 群組",
    (group) => {
      expect(validateScope(`${group} list`)).toEqual({ ok: true });
    },
  );

  test("拒絕群組以外的命令", () => {
    const result = validateScope("vm list");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("vm");
  });

  test("拒絕帶 az 前綴的命令並提示", () => {
    const result = validateScope("az repos list");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("az");
  });

  test("拒絕空字串", () => {
    expect(validateScope("").ok).toBe(false);
    expect(validateScope("   ").ok).toBe(false);
  });

  test("允許前後有空白的合法命令", () => {
    expect(validateScope("  repos pr list  ")).toEqual({ ok: true });
  });

  test("ALLOWED_GROUPS 恰為五個群組", () => {
    expect([...ALLOWED_GROUPS]).toEqual([
      "devops",
      "repos",
      "boards",
      "pipelines",
      "artifacts",
    ]);
  });
});

describe("ensureJsonOutput", () => {
  test("無輸出參數時附加 --output json", () => {
    expect(ensureJsonOutput("repos list")).toBe("repos list --output json");
  });

  test("已有 -o 時不附加", () => {
    expect(ensureJsonOutput("repos list -o table")).toBe("repos list -o table");
  });

  test("已有 --output 時不附加", () => {
    expect(ensureJsonOutput("repos list --output tsv")).toBe(
      "repos list --output tsv",
    );
  });

  test("已有 --output=json 形式時不附加", () => {
    expect(ensureJsonOutput("repos list --output=json")).toBe(
      "repos list --output=json",
    );
  });
});

describe("truncateOutput", () => {
  test("50KB 以內原樣回傳", () => {
    const text = "a".repeat(OUTPUT_LIMIT);
    expect(truncateOutput(text)).toBe(text);
  });

  test("超過 50KB 截斷並附提示", () => {
    const text = "a".repeat(OUTPUT_LIMIT + 1);
    const result = truncateOutput(text);
    expect(result.length).toBeLessThan(text.length + 200);
    expect(result).toContain("截斷");
    expect(result).toContain("--top");
  });
});
```

- [ ] **Step 3: 執行測試確認失敗**

Run: `npx vitest run tests/command.test.ts`
Expected: FAIL — `Cannot find module '../src/command.js'`（或同義的解析錯誤）

- [ ] **Step 4: 實作 `src/command.ts`**

```ts
export const ALLOWED_GROUPS = [
  "devops",
  "repos",
  "boards",
  "pipelines",
  "artifacts",
] as const;

export const OUTPUT_LIMIT = 50_000;

export function validateScope(
  command: string,
): { ok: true } | { ok: false; error: string } {
  const first = command.trim().split(/\s+/)[0] ?? "";
  if ((ALLOWED_GROUPS as readonly string[]).includes(first)) {
    return { ok: true };
  }
  const hint =
    first === "az"
      ? '命令請勿包含 "az" 前綴，直接以群組開頭，例如 "repos pr list"。'
      : "";
  return {
    ok: false,
    error:
      `不支援的命令群組「${first || "(空白)"}」。` +
      `僅允許：${ALLOWED_GROUPS.join("、")}。${hint}`,
  };
}

export function ensureJsonOutput(command: string): string {
  const tokens = command.split(/\s+/);
  const hasOutput = tokens.some(
    (t) => t === "-o" || t.startsWith("--output"),
  );
  return hasOutput ? command : `${command} --output json`;
}

export function truncateOutput(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return (
    text.slice(0, OUTPUT_LIMIT) +
    "\n\n[輸出已截斷：超過 50KB。請使用 --top、--query 或更嚴格的查詢條件縮小範圍。]"
  );
}
```

- [ ] **Step 5: 執行測試確認通過**

Run: `npx vitest run tests/command.test.ts`
Expected: PASS（全部測試綠燈）

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/command.ts tests/command.test.ts
git commit -m "feat: scaffold project and add command preprocessing module"
```

---

### Task 2: 命令執行器（`executor.ts`）

**Files:**
- Create: `src/executor.ts`
- Test: `tests/executor.test.ts`

**Interfaces:**
- Consumes: 無
- Produces（Task 3 會用到）:
  - `interface ExecResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }`
  - `interface ExecuteOptions { timeoutMs?: number; baseCommand?: string }`
  - `execute(commandLine: string, options?: ExecuteOptions): Promise<ExecResult>` — 預設 `baseCommand = "az"`、`timeoutMs = 120_000`；**永不 reject**，所有結果（含逾時、找不到程式）都 resolve 成 `ExecResult`

設計說明：用 Node 內建 `child_process.exec` —— 它在 Windows 上自動經 `cmd /c` 執行（符合 spec 的 `az.cmd` 需求），且內建 timeout 與 maxBuffer。`baseCommand` 參數讓測試可以不依賴 `az`（改用 `cmd /c echo`、`node` 等）。`az` 不存在時，cmd 會回非零結束碼且 stderr 帶有 "'az' is not recognized..."，訊息自然流回給 Claude，無需特判。

- [ ] **Step 1: 寫失敗的測試**

建立 `tests/executor.test.ts`（測試以 Windows 為執行環境，與本專案部署環境一致）：

```ts
import { describe, expect, test } from "vitest";
import { execute } from "../src/executor.js";

describe("execute", () => {
  test("回傳 stdout 與結束碼 0", async () => {
    const result = await execute("hello", { baseCommand: "cmd /c echo" });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("非零結束碼被保留", async () => {
    const result = await execute("3", { baseCommand: "cmd /c exit" });
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  test("逾時會終止子程序並標記 timedOut", async () => {
    const result = await execute('-e "setTimeout(() => {}, 10000)"', {
      baseCommand: "node",
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
  }, 10_000);

  test("找不到執行檔時回傳非零結束碼", async () => {
    const result = await execute("whatever", {
      baseCommand: "definitely-not-a-real-command-12345",
    });
    expect(result.exitCode).not.toBe(0);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/executor.test.ts`
Expected: FAIL — `Cannot find module '../src/executor.js'`

- [ ] **Step 3: 實作 `src/executor.ts`**

```ts
import { exec } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ExecuteOptions {
  timeoutMs?: number;
  baseCommand?: string;
}

export function execute(
  commandLine: string,
  options: ExecuteOptions = {},
): Promise<ExecResult> {
  const { timeoutMs = 120_000, baseCommand = "az" } = options;
  return new Promise((resolve) => {
    exec(
      `${baseCommand} ${commandLine}`,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const err = error as
          | (Error & { killed?: boolean; code?: unknown })
          | null;
        const timedOut = Boolean(err?.killed);
        const exitCode = err
          ? typeof err.code === "number"
            ? err.code
            : 1
          : 0;
        resolve({ stdout, stderr, exitCode, timedOut });
      },
    );
  });
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run tests/executor.test.ts`
Expected: PASS（4 個測試綠燈；逾時測試約需 0.5 秒）

- [ ] **Step 5: Commit**

```bash
git add src/executor.ts tests/executor.test.ts
git commit -m "feat: add az command executor with timeout handling"
```

---

### Task 3: MCP server（`server.ts` + `index.ts`）與整合測試

**Files:**
- Create: `src/server.ts`
- Create: `src/index.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes:
  - `validateScope`、`ensureJsonOutput`、`truncateOutput`（來自 `src/command.js`，Task 1）
  - `execute`、`ExecResult`、`ExecuteOptions`（來自 `src/executor.js`，Task 2）
- Produces:
  - `createServer(executeFn?: typeof execute): McpServer` — 可注入假 executor 供測試
  - `dist/index.js` — 最終進入點（Task 4 的 README 會引用）

- [ ] **Step 1: 寫失敗的整合測試**

建立 `tests/server.test.ts`（用 SDK 的 `InMemoryTransport` 在同程序內連接 client 與 server，executor 用 stub，不碰真實 `az`）：

```ts
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
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — `Cannot find module '../src/server.js'`

- [ ] **Step 3: 實作 `src/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureJsonOutput, truncateOutput, validateScope } from "./command.js";
import { execute, type ExecResult } from "./executor.js";

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

export function createServer(executeFn: typeof execute = execute): McpServer {
  const server = new McpServer({
    name: "azure-devops-cli-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "az_devops",
    {
      title: "Azure DevOps CLI",
      description:
        "執行 Azure DevOps CLI 命令（az 前綴由 server 自動加上，command 請勿包含）。" +
        "允許的命令群組：devops、repos、boards、pipelines、artifacts。" +
        "預設 organization 為 https://dev.azure.com/SKMHHIS、預設 project 為 SKH-AOAI" +
        "（已由 az devops configure 設定，通常不需要帶 --org/--project）。" +
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
      const result = await executeFn(ensureJsonOutput(command.trim()), {
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

  return server;
}
```

- [ ] **Step 4: 實作 `src/index.ts`**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
await server.connect(new StdioServerTransport());
console.error("azure-devops-cli-mcp server running on stdio");
```

（注意：stdio transport 下 stdout 保留給 MCP 協定，啟動訊息必須走 `console.error`。）

- [ ] **Step 5: 執行整合測試確認通過**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS（13 個測試綠燈）

- [ ] **Step 6: 執行全部測試**

Run: `npx vitest run`
Expected: PASS（command、executor、server 三個檔案全部綠燈）

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/index.ts tests/server.test.ts
git commit -m "feat: add MCP server with az_devops and az_devops_help tools"
```

---

### Task 4: 建置、實機煙霧測試、README 與 Claude Desktop 設定

**Files:**
- Create: `scripts/smoke.mjs`
- Create: `README.md`

**Interfaces:**
- Consumes: `dist/index.js`（Task 3 的建置產物）；本機需已 `az login` 且安裝 azure-devops extension
- Produces: 可直接部署使用的完整套件與文件

- [ ] **Step 1: 建置**

Run: `npm run build`
Expected: 成功，產生 `dist/index.js`、`dist/server.js`、`dist/command.js`、`dist/executor.js`

- [ ] **Step 2: 建立實機煙霧測試腳本**

建立 `scripts/smoke.mjs`（用 SDK client 透過 stdio 啟動真正的 server，打真實的 `az`）：

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke-test", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({ command: "node", args: ["dist/index.js"] }),
);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

console.log("\n--- az_devops_help: repos pr list ---");
const help = await client.callTool({
  name: "az_devops_help",
  arguments: { command: "repos pr list" },
});
console.log("isError:", help.isError ?? false);
console.log(help.content[0].text.slice(0, 300));

console.log("\n--- az_devops: devops project list ---");
const projects = await client.callTool({
  name: "az_devops",
  arguments: { command: "devops project list" },
});
console.log("isError:", projects.isError ?? false);
console.log(projects.content[0].text.slice(0, 500));

console.log("\n--- az_devops: 範圍外命令（應拒絕）---");
const rejected = await client.callTool({
  name: "az_devops",
  arguments: { command: "account show" },
});
console.log("isError:", rejected.isError ?? false);
console.log(rejected.content[0].text);

await client.close();
process.exit(0);
```

- [ ] **Step 3: 執行煙霧測試**

Run: `node scripts/smoke.mjs`
Expected:
- `tools: az_devops, az_devops_help`
- help 呼叫 `isError: false`，輸出含 `az repos pr list` 的說明文字
- project list 呼叫 `isError: false`，輸出為 JSON、含 `SKH-AOAI`
- 範圍外命令 `isError: true`，錯誤訊息含「不支援的命令群組」

（az 首次呼叫可能需 10–30 秒，屬正常。若 project list 失敗且 stderr 提示登入過期，先執行 `az login` 再重試。）

- [ ] **Step 4: 撰寫 README.md**

````markdown
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

## 開發

```
npm test              # vitest 單元 + 整合測試（不需要 az）
node scripts/smoke.mjs  # 實機煙霧測試（需要 az login）
```
````

- [ ] **Step 5: 最終驗證全部測試**

Run: `npx vitest run && npm run build`
Expected: 全部測試 PASS、建置無錯誤

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke.mjs README.md
git commit -m "docs: add smoke test script and README with Claude Desktop setup"
```
