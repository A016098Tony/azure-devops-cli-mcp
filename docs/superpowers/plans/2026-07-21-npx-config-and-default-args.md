# npx 啟動方式 + 預設值參數注入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓團隊成員從 GitHub 以 `npm install -g` 安裝後用 `command: npx` 設定 MCP,並由 server 依啟動參數(organization/project/repository,皆有內建預設值)自動補齊 az 命令參數。

**Architecture:** 新增 `src/defaults.ts` 負責 CLI 參數解析與注入規劃(純函式);`src/server.ts` 接收 `Defaults` 物件,執行前附加缺少的參數,失敗且 stderr 回報 `unrecognized arguments` 指到注入參數時移除該參數重試一次;`src/index.ts` 解析 `process.argv` 並傳入。

**Tech Stack:** Node >= 20(內建 `util.parseArgs`)、TypeScript、@modelcontextprotocol/sdk、vitest。不新增任何依賴。

**Spec:** `docs/superpowers/specs/2026-07-21-npx-config-and-default-args-design.md`

## Global Constraints

- Node >= 20;不新增 npm 依賴。
- 內建預設值:`organization=https://dev.azure.com/SKMHHIS`、`project=MS`、`repository=MS-Web`(spec 第 1 節,逐字使用)。
- 所有使用者可見訊息(錯誤、工具描述、README)使用繁體中文,風格比照現有程式碼。
- 不得改變既有行為:`validateScope` 範圍與 shell 字元防護、`ensureJsonOutput`、輸出截斷、`az_devops_help` 不注入任何參數。
- 每個 task 結束時 `npm test` 全綠再 commit。
- 測試命名沿用現有中文描述風格(見 `tests/command.test.ts`)。

---

### Task 1: `defaults.ts` — CLI 參數解析

**Files:**
- Create: `src/defaults.ts`
- Test: `tests/defaults.test.ts`

**Interfaces:**
- Consumes: 無(僅 `node:util` 的 `parseArgs`)
- Produces(後續 task 依賴,簽名逐字):
  - `interface Defaults { organization: string; project: string; repository: string }`
  - `const BUILT_IN_DEFAULTS: Defaults`
  - `function normalizeOrganization(value: string): string`
  - `function parseCliArgs(argv: string[]): Defaults`(未知參數擲出 Error)

- [ ] **Step 1: 寫失敗測試**

建立 `tests/defaults.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  BUILT_IN_DEFAULTS,
  normalizeOrganization,
  parseCliArgs,
} from "../src/defaults.js";

describe("parseCliArgs", () => {
  test("無參數時使用內建預設值", () => {
    expect(parseCliArgs([])).toEqual({
      organization: "https://dev.azure.com/SKMHHIS",
      project: "MS",
      repository: "MS-Web",
    });
  });

  test("可覆寫三個參數", () => {
    expect(
      parseCliArgs([
        "--organization",
        "https://dev.azure.com/OtherOrg",
        "--project",
        "P2",
        "--repository",
        "repo2",
      ]),
    ).toEqual({
      organization: "https://dev.azure.com/OtherOrg",
      project: "P2",
      repository: "repo2",
    });
  });

  test("organization 短名自動補成完整 URL", () => {
    expect(parseCliArgs(["--organization", "MyOrg"]).organization).toBe(
      "https://dev.azure.com/MyOrg",
    );
  });

  test("未知參數擲出錯誤", () => {
    expect(() => parseCliArgs(["--bogus", "x"])).toThrow();
  });
});

describe("normalizeOrganization", () => {
  test("完整 URL 原樣回傳", () => {
    expect(normalizeOrganization("https://dev.azure.com/SKMHHIS")).toBe(
      "https://dev.azure.com/SKMHHIS",
    );
  });

  test("短名補上 dev.azure.com 前綴", () => {
    expect(normalizeOrganization("SKMHHIS")).toBe(
      "https://dev.azure.com/SKMHHIS",
    );
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/defaults.test.ts`
Expected: FAIL,錯誤為找不到模組 `../src/defaults.js`

- [ ] **Step 3: 最小實作**

建立 `src/defaults.ts`:

```ts
import { parseArgs } from "node:util";

export interface Defaults {
  organization: string;
  project: string;
  repository: string;
}

export const BUILT_IN_DEFAULTS: Defaults = {
  organization: "https://dev.azure.com/SKMHHIS",
  project: "MS",
  repository: "MS-Web",
};

export function normalizeOrganization(value: string): string {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://dev.azure.com/${trimmed}`;
}

export function parseCliArgs(argv: string[]): Defaults {
  const { values } = parseArgs({
    args: argv,
    options: {
      organization: { type: "string" },
      project: { type: "string" },
      repository: { type: "string" },
    },
    strict: true,
  });
  return {
    organization: normalizeOrganization(
      values.organization ?? BUILT_IN_DEFAULTS.organization,
    ),
    project: values.project ?? BUILT_IN_DEFAULTS.project,
    repository: values.repository ?? BUILT_IN_DEFAULTS.repository,
  };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run tests/defaults.test.ts`
Expected: PASS(6 tests)

- [ ] **Step 5: 全部測試 + commit**

```bash
npm test
git add src/defaults.ts tests/defaults.test.ts
git commit -m "feat: parse CLI args for org/project/repository defaults"
```

---

### Task 2: `defaults.ts` — 注入規劃與命令組裝

**Files:**
- Modify: `src/defaults.ts`(追加到檔尾)
- Test: `tests/defaults.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的 `Defaults`
- Produces(Task 3 依賴,簽名逐字):
  - `interface InjectedFlag { flag: "--organization" | "--project" | "--repository"; value: string }`
  - `function planInjection(command: string, defaults: Defaults): InjectedFlag[]`
  - `function appendFlags(command: string, flags: InjectedFlag[]): string`

注入規則(spec 第 3 節):只掃描雙引號外的 token;`devops configure` 開頭完全不注入;無 `--org`/`--organization` 補 organization;無 `--project`/`-p` 補 project;`repos pr` 開頭且無 `--repository`/`-r` 補 repository。也要處理 `--flag=value` 連寫形式。

- [ ] **Step 1: 寫失敗測試**

在 `tests/defaults.test.ts` 檔尾追加(import 行加入 `planInjection`、`appendFlags`):

```ts
describe("planInjection", () => {
  const d = BUILT_IN_DEFAULTS;

  test("無相關參數時注入 org 與 project", () => {
    expect(planInjection("repos list --output json", d)).toEqual([
      { flag: "--organization", value: "https://dev.azure.com/SKMHHIS" },
      { flag: "--project", value: "MS" },
    ]);
  });

  test("已有 --org 時不注入 organization", () => {
    const flags = planInjection(
      "repos list --org https://dev.azure.com/X",
      d,
    );
    expect(flags.map((f) => f.flag)).toEqual(["--project"]);
  });

  test("已有 --organization=URL 連寫形式時不注入 organization", () => {
    const flags = planInjection(
      "repos list --organization=https://dev.azure.com/X",
      d,
    );
    expect(flags.map((f) => f.flag)).toEqual(["--project"]);
  });

  test("已有 -p 時不注入 project", () => {
    const flags = planInjection("boards work-item show --id 1 -p Other", d);
    expect(flags.map((f) => f.flag)).toEqual(["--organization"]);
  });

  test("repos pr 命令額外注入 repository", () => {
    expect(planInjection("repos pr list", d)).toEqual([
      { flag: "--organization", value: "https://dev.azure.com/SKMHHIS" },
      { flag: "--project", value: "MS" },
      { flag: "--repository", value: "MS-Web" },
    ]);
  });

  test("repos pr 已有 -r 時不注入 repository", () => {
    const flags = planInjection("repos pr list -r other-repo", d);
    expect(flags.map((f) => f.flag)).toEqual([
      "--organization",
      "--project",
    ]);
  });

  test("非 repos pr 命令不注入 repository", () => {
    const flags = planInjection("repos list", d);
    expect(flags.map((f) => f.flag)).not.toContain("--repository");
  });

  test("devops configure 完全不注入", () => {
    expect(planInjection("devops configure --list", d)).toEqual([]);
  });

  test("雙引號內出現 --project 字樣不影響判斷", () => {
    const flags = planInjection(
      `boards query --wiql "SELECT --project -p FROM x"`,
      d,
    );
    expect(flags.map((f) => f.flag)).toContain("--project");
  });
});

describe("appendFlags", () => {
  test("依序附加參數", () => {
    expect(
      appendFlags("repos list --output json", [
        { flag: "--organization", value: "https://dev.azure.com/SKMHHIS" },
        { flag: "--project", value: "MS" },
      ]),
    ).toBe(
      "repos list --output json --organization https://dev.azure.com/SKMHHIS --project MS",
    );
  });

  test("值含空白時以雙引號包起", () => {
    expect(
      appendFlags("repos list", [{ flag: "--project", value: "My Proj" }]),
    ).toBe('repos list --project "My Proj"');
  });

  test("空清單時原樣回傳", () => {
    expect(appendFlags("repos list", [])).toBe("repos list");
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/defaults.test.ts`
Expected: FAIL,`planInjection` / `appendFlags` 未匯出

- [ ] **Step 3: 最小實作**

在 `src/defaults.ts` 檔尾追加:

```ts
export interface InjectedFlag {
  flag: "--organization" | "--project" | "--repository";
  value: string;
}

function tokensOutsideQuotes(command: string): string[] {
  return command
    .replace(/"[^"]*"/g, '""')
    .split(/\s+/)
    .filter(Boolean);
}

function hasFlag(tokens: string[], names: string[]): boolean {
  return tokens.some((t) => names.some((n) => t === n || t.startsWith(`${n}=`)));
}

export function planInjection(
  command: string,
  defaults: Defaults,
): InjectedFlag[] {
  const tokens = tokensOutsideQuotes(command.trim());
  if (tokens[0] === "devops" && tokens[1] === "configure") return [];
  const injected: InjectedFlag[] = [];
  if (!hasFlag(tokens, ["--organization", "--org"])) {
    injected.push({ flag: "--organization", value: defaults.organization });
  }
  if (!hasFlag(tokens, ["--project", "-p"])) {
    injected.push({ flag: "--project", value: defaults.project });
  }
  const isReposPr = tokens[0] === "repos" && tokens[1] === "pr";
  if (isReposPr && !hasFlag(tokens, ["--repository", "-r"])) {
    injected.push({ flag: "--repository", value: defaults.repository });
  }
  return injected;
}

export function appendFlags(command: string, flags: InjectedFlag[]): string {
  let result = command;
  for (const { flag, value } of flags) {
    const quoted = /\s/.test(value) ? `"${value}"` : value;
    result += ` ${flag} ${quoted}`;
  }
  return result;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run tests/defaults.test.ts`
Expected: PASS(18 tests)

- [ ] **Step 5: 全部測試 + commit**

```bash
npm test
git add src/defaults.ts tests/defaults.test.ts
git commit -m "feat: plan default org/project/repository injection for az commands"
```

---

### Task 3: `server.ts` — 注入、失敗回退、動態工具描述

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: Task 1–2 的 `Defaults`、`BUILT_IN_DEFAULTS`、`InjectedFlag`、`planInjection`、`appendFlags`
- Produces(Task 4 依賴):`createServer(executeFn: typeof execute = execute, defaults: Defaults = BUILT_IN_DEFAULTS): McpServer`

- [ ] **Step 1: 更新既有測試 + 寫新失敗測試**

`tests/server.test.ts` 修改三處:

(1) `connect` helper 加上可選 `defaults` 參數(替換原函式):

```ts
import { BUILT_IN_DEFAULTS, type Defaults } from "../src/defaults.js";

async function connect(
  executeFn: ReturnType<typeof makeFakeExecutor>["fake"],
  defaults: Defaults = BUILT_IN_DEFAULTS,
) {
  const server = createServer(executeFn, defaults);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}
```

(2) 既有測試「az_devops 工具描述內嵌預設 org/project」整段替換:

```ts
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
```

(3) 既有測試「az_devops 執行合法命令並自動補 --output json」中的斷言改為:

```ts
    expect(calls[0]?.commandLine).toBe(
      "repos list --output json --organization https://dev.azure.com/SKMHHIS --project MS",
    );
```

並在 describe 區塊尾端新增測試:

```ts
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
```

備註:既有測試「az_devops_help 附加 --help 且不補 json、逾時 60 秒」斷言精確等於 `repos pr create --help`,即已驗證 help 不注入,無須新增測試。

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL(描述測試、commandLine 精確比對、重試測試皆失敗)

- [ ] **Step 3: 實作 server.ts**

`src/server.ts` 修改。import 區新增:

```ts
import {
  appendFlags,
  BUILT_IN_DEFAULTS,
  planInjection,
  type Defaults,
  type InjectedFlag,
} from "./defaults.js";
```

在 `scopeError` 之後新增:

```ts
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
```

`createServer` 簽名改為:

```ts
export function createServer(
  executeFn: typeof execute = execute,
  defaults: Defaults = BUILT_IN_DEFAULTS,
): McpServer {
```

`az_devops` 的 `description` 整段替換為:

```ts
      description:
        "執行 Azure DevOps CLI 命令（az 前綴由 server 自動加上，command 請勿包含）。" +
        "允許的命令群組：devops、repos、boards、pipelines、artifacts。" +
        `預設 organization 為 ${defaults.organization}、project 為 ${defaults.project}，` +
        `repos pr 命令預設 repository 為 ${defaults.repository}` +
        "（未指定時 server 會自動補上，通常不需要帶 --org/--project/--repository）。" +
        "未指定 -o/--output 時自動使用 --output json。" +
        '範例："repos pr list --status active"、"boards work-item show --id 123"。' +
        "不確定語法時，先用 az_devops_help 查詢。",
```

`az_devops` handler 整段替換為:

```ts
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
```

`az_devops_help` 不動。

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS(17 tests)

- [ ] **Step 5: 全部測試 + commit**

```bash
npm test
git add src/server.ts tests/server.test.ts
git commit -m "feat: inject default org/project/repo with unrecognized-args fallback"
```

---

### Task 4: `index.ts` 接線 + `package.json` prepare script

**Files:**
- Modify: `src/index.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `parseCliArgs`(Task 1)、`createServer(executeFn, defaults)`(Task 3)、`execute`(既有)
- Produces: 可執行的 bin(`azure-devops-cli-mcp`),支援 `--organization/--project/--repository`

- [ ] **Step 1: 改寫 index.ts**

`src/index.ts` 全檔替換為:

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseCliArgs, type Defaults } from "./defaults.js";
import { execute } from "./executor.js";
import { createServer } from "./server.js";

let defaults: Defaults;
try {
  defaults = parseCliArgs(process.argv.slice(2));
} catch (error) {
  console.error(`啟動參數錯誤：${(error as Error).message}`);
  console.error(
    "用法：azure-devops-cli-mcp [--organization <URL或短名>] [--project <名稱>] [--repository <名稱>]",
  );
  process.exit(1);
}

const server = createServer(execute, defaults);
await server.connect(new StdioServerTransport());
console.error(
  `azure-devops-cli-mcp server running on stdio ` +
    `(organization=${defaults.organization}, project=${defaults.project}, repository=${defaults.repository})`,
);
```

- [ ] **Step 2: package.json 加 prepare script 並升版**

`package.json` 的 `"version"` 改為 `"0.2.0"`,`"scripts"` 改為:

```json
  "scripts": {
    "build": "tsc",
    "prepare": "npm run build",
    "test": "vitest run"
  },
```

- [ ] **Step 3: 建置並驗證 CLI 參數行為**

Run(PowerShell):

```powershell
npm run build
node dist/index.js --bogus; "exit=$LASTEXITCODE"
```

Expected: stderr 顯示「啟動參數錯誤」與「用法」兩行,`exit=1`

- [ ] **Step 4: 驗證 npm 安裝鏈(prepare + bin)**

Run(PowerShell):

```powershell
npm install -g .
npx azure-devops-cli-mcp --bogus; "exit=$LASTEXITCODE"
```

Expected: 與 Step 3 相同的錯誤輸出,`exit=1`(證明 bin 與 prepare 建置鏈有效)。
驗證後可保留全域安裝(即團隊使用方式),或 `npm uninstall -g azure-devops-cli-mcp` 移除。

- [ ] **Step 5: 全部測試 + commit**

```bash
npm test
git add src/index.ts package.json
git commit -m "feat: wire CLI defaults into entrypoint and add prepare script"
```

---

### Task 5: README 更新

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1–4 完成後的實際行為(安裝命令、npx 設定、啟動參數)
- Produces: 團隊成員可獨立照做的安裝/設定文件

- [ ] **Step 1: 改寫 README**

`README.md` 中「前置需求」的最後一項(`az devops configure --defaults` 區塊,第 11–15 行)整段刪除,替換為:

```markdown
- 不需要 `az devops configure --defaults`：server 會自動帶入預設
  organization / project / repository（見下方「啟動參數」）。
```

「安裝與建置」與「Claude Desktop 設定」兩節(原第 17–47 行)整段替換為:

````markdown
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
````

最後,將既有「## 開發」一節的程式碼區塊開頭加上兩行,變成:

```
git clone https://github.com/A016098Tony/azure-devops-cli-mcp.git
npm install
npm test              # vitest 單元 + 整合測試（不需要 az）
node scripts/smoke.mjs  # 實機煙霧測試（需要 az login）
```

「工具」表格與「安全防護」一節內容與新行為無矛盾,保持不變。

- [ ] **Step 2: 驗證文件中的命令可執行**

Run: `npm test && npm run build`
Expected: 測試全綠、建置成功

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: npx-based team setup and startup args for defaults"
```
