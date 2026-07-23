# Git 唯讀網路工具（az_git_fetch + az_git_ls_remote）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `az_git_fetch` 與 `az_git_ls_remote` 兩個唯讀 git 網路工具，讓 Cowork sandbox 內被 proxy 擋下的 `git fetch` 可以改由主機端的 MCP server 代跑。

**Architecture:** 新模組 `src/git.ts` 比照 `workItem.ts` 模式——純函式組裝命令（可獨立測試）+ 注入 `executeFn` 的 runner。執行時用既有 executor 的 `baseCommand: "git"` 覆寫，不改 `executor.ts`。server.ts 註冊兩個工具，結構化參數 + 嚴格驗證擋掉選項注入（`git fetch` 有 `--upload-pack=<命令>` 這類危險選項，所以 refspec 不可以 `-` 開頭）。

**Tech Stack:** TypeScript（ESM、NodeNext）、@modelcontextprotocol/sdk、zod、vitest。

**Spec:** `docs/superpowers/specs/2026-07-23-git-fetch-tools-design.md`

## Global Constraints

- 版本號：`package.json` 與 `server.ts` 的 `McpServer` version 皆由 `0.4.0` → `0.5.0`。
- 只提供唯讀網路操作（fetch、ls-remote）；**不提供** push、pull、checkout 或任何寫入操作。
- 所有使用者可見訊息（工具描述、錯誤訊息）用繁體中文，比照既有工具風格。
- `remote` 參數只允許 `^[A-Za-z0-9._-]+$`（remote 名稱，不接受 URL）。
- `refspec` / `pattern` 不可以 `-` 開頭、不可含空白或雙引號。
- `repoPath` 必須是絕對路徑（Windows `X:\`、UNC `\\`、或 POSIX `/` 開頭），不可含雙引號。
- 驗證失敗即拒絕，**不執行**任何命令。
- 所有工具輸出經 `truncateOutput`。
- 測試不真的執行 git：一律用 fake `executeFn`。
- Import 路徑帶 `.js` 副檔名（NodeNext ESM，比照既有 code）。
- 測試命令：`npx vitest run`（或 `npm test`）。

---

### Task 1: `src/git.ts` 命令組裝與參數驗證

**Files:**
- Create: `src/git.ts`
- Test: `tests/git.test.ts`

**Interfaces:**
- Consumes: 無（純函式，不依賴其他模組）
- Produces:
  - `interface GitFetchParams { repoPath: string; remote?: string; refspec?: string; prune?: boolean; timeoutMs?: number }`
  - `interface GitLsRemoteParams { repoPath: string; remote?: string; pattern?: string; heads?: boolean; tags?: boolean; timeoutMs?: number }`
  - `type BuildResult = { ok: true; command: string } | { ok: false; error: string }`
  - `buildFetchCommand(params: GitFetchParams): BuildResult`
  - `buildLsRemoteCommand(params: GitLsRemoteParams): BuildResult`
  - 組出的 command **不含** `git` 前綴（executor 會加 `baseCommand`）。

- [ ] **Step 1: 寫失敗測試**

建立 `tests/git.test.ts`：

```ts
import { describe, expect, test } from "vitest";
import { buildFetchCommand, buildLsRemoteCommand } from "../src/git.js";

describe("buildFetchCommand", () => {
  test("預設 remote origin、無 refspec", () => {
    expect(buildFetchCommand({ repoPath: "D:\\mygithub\\MS-Web" })).toEqual({
      ok: true,
      command: '-C "D:\\mygithub\\MS-Web" fetch origin',
    });
  });

  test("帶 refspec 與 prune", () => {
    expect(
      buildFetchCommand({
        repoPath: "D:\\mygithub\\MS-Web",
        refspec: "releases/s116/rc-092",
        prune: true,
      }),
    ).toEqual({
      ok: true,
      command:
        '-C "D:\\mygithub\\MS-Web" fetch origin "releases/s116/rc-092" --prune',
    });
  });

  test("含空白的路徑以雙引號包覆", () => {
    const result = buildFetchCommand({ repoPath: "D:\\My Repos\\MS-Web" });
    expect(result).toEqual({
      ok: true,
      command: '-C "D:\\My Repos\\MS-Web" fetch origin',
    });
  });

  test("POSIX 絕對路徑可通過", () => {
    expect(buildFetchCommand({ repoPath: "/home/user/repo" }).ok).toBe(true);
  });

  test("合法的完整 refspec（+ 開頭）可通過", () => {
    expect(
      buildFetchCommand({
        repoPath: "D:\\repo",
        refspec: "+refs/heads/*:refs/remotes/origin/*",
      }).ok,
    ).toBe(true);
  });

  test("拒絕空白與相對路徑的 repoPath", () => {
    for (const bad of ["", "   ", "repo", ".\\repo", "..\\repo"]) {
      const result = buildFetchCommand({ repoPath: bad });
      expect(result.ok, `repoPath "${bad}" 應被拒絕`).toBe(false);
    }
  });

  test("拒絕含雙引號的 repoPath", () => {
    expect(buildFetchCommand({ repoPath: 'D:\\a"b' }).ok).toBe(false);
  });

  test("拒絕不合法的 remote（URL、選項、空白）", () => {
    for (const bad of ["https://evil.example.com/x", "-origin", "o rigin", ""]) {
      const result = buildFetchCommand({ repoPath: "D:\\repo", remote: bad });
      expect(result.ok, `remote "${bad}" 應被拒絕`).toBe(false);
    }
  });

  test("拒絕危險的 refspec（- 開頭、空白、雙引號）", () => {
    for (const bad of ["--upload-pack=calc", "-x", "a b", 'a"b', "", "  "]) {
      const result = buildFetchCommand({ repoPath: "D:\\repo", refspec: bad });
      expect(result.ok, `refspec "${bad}" 應被拒絕`).toBe(false);
    }
  });
});

describe("buildLsRemoteCommand", () => {
  test("預設 remote origin、無 pattern", () => {
    expect(buildLsRemoteCommand({ repoPath: "D:\\repo" })).toEqual({
      ok: true,
      command: '-C "D:\\repo" ls-remote origin',
    });
  });

  test("heads/tags 旗標與 pattern", () => {
    expect(
      buildLsRemoteCommand({
        repoPath: "D:\\repo",
        heads: true,
        tags: true,
        pattern: "releases/s116/rc-092",
      }),
    ).toEqual({
      ok: true,
      command:
        '-C "D:\\repo" ls-remote --heads --tags origin "releases/s116/rc-092"',
    });
  });

  test("拒絕危險的 pattern（- 開頭）", () => {
    expect(
      buildLsRemoteCommand({ repoPath: "D:\\repo", pattern: "--exec=x" }).ok,
    ).toBe(false);
  });

  test("拒絕不合法的 remote", () => {
    expect(
      buildLsRemoteCommand({ repoPath: "D:\\repo", remote: "git@host:x" }).ok,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/git.test.ts`
Expected: FAIL —— `Cannot find module '../src/git.js'`（或等價的模組不存在錯誤）。

- [ ] **Step 3: 實作 `src/git.ts` 的組裝與驗證**

建立 `src/git.ts`：

```ts
export interface GitFetchParams {
  repoPath: string;
  remote?: string;
  refspec?: string;
  prune?: boolean;
  timeoutMs?: number;
}

export interface GitLsRemoteParams {
  repoPath: string;
  remote?: string;
  pattern?: string;
  heads?: boolean;
  tags?: boolean;
  timeoutMs?: number;
}

export type BuildResult =
  | { ok: true; command: string }
  | { ok: false; error: string };

// 只接受 remote 名稱（如 origin、upstream），擋掉 URL 與 - 開頭的選項注入
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
// Windows 磁碟機（D:\ 或 D:/）、UNC（\\host）、POSIX（/）
const ABSOLUTE_PATH_PATTERN = /^([A-Za-z]:[\\/]|\\\\|\/)/;

function validateCommon(
  repoPath: string,
  remote: string,
): string | undefined {
  const trimmedPath = repoPath.trim();
  if (!trimmedPath) return "repoPath 不可為空。";
  if (!ABSOLUTE_PATH_PATTERN.test(trimmedPath)) {
    return (
      `repoPath「${repoPath}」不是絕對路徑。` +
      "請提供主機端的絕對路徑，例如 D:\\mygithub\\MS-Web。"
    );
  }
  if (trimmedPath.includes('"')) return "repoPath 不可包含雙引號。";
  if (!REMOTE_NAME_PATTERN.test(remote)) {
    return (
      `不合法的 remote 名稱「${remote}」。` +
      "只接受已設定的 remote 名稱（如 origin），不接受 URL 或選項。"
    );
  }
  return undefined;
}

// refspec 與 ls-remote pattern 共用：擋 --upload-pack 這類可執行任意命令的選項
function validateRef(value: string, label: string): string | undefined {
  if (!value.trim()) return `${label} 不可為空白。`;
  if (value.startsWith("-")) return `${label} 不可以「-」開頭。`;
  if (/[\s"]/.test(value)) return `${label} 不可包含空白或雙引號。`;
  return undefined;
}

export function buildFetchCommand(params: GitFetchParams): BuildResult {
  const remote = params.remote ?? "origin";
  const commonError = validateCommon(params.repoPath, remote);
  if (commonError) return { ok: false, error: commonError };
  if (params.refspec !== undefined) {
    const refError = validateRef(params.refspec, "refspec");
    if (refError) return { ok: false, error: refError };
  }
  let command = `-C "${params.repoPath.trim()}" fetch ${remote}`;
  if (params.refspec !== undefined) command += ` "${params.refspec}"`;
  if (params.prune) command += " --prune";
  return { ok: true, command };
}

export function buildLsRemoteCommand(params: GitLsRemoteParams): BuildResult {
  const remote = params.remote ?? "origin";
  const commonError = validateCommon(params.repoPath, remote);
  if (commonError) return { ok: false, error: commonError };
  if (params.pattern !== undefined) {
    const patternError = validateRef(params.pattern, "pattern");
    if (patternError) return { ok: false, error: patternError };
  }
  let command = `-C "${params.repoPath.trim()}" ls-remote`;
  if (params.heads) command += " --heads";
  if (params.tags) command += " --tags";
  command += ` ${remote}`;
  if (params.pattern !== undefined) command += ` "${params.pattern}"`;
  return { ok: true, command };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run tests/git.test.ts`
Expected: PASS（全部測試綠）。

- [ ] **Step 5: Commit**

```bash
git add src/git.ts tests/git.test.ts
git commit -m "feat: add git fetch/ls-remote command building with option-injection guards"
```

---

### Task 2: `src/git.ts` runners（gitFetch / gitLsRemote）與錯誤映射

**Files:**
- Modify: `src/git.ts`（檔尾附加）
- Test: `tests/git.test.ts`（檔尾附加）

**Interfaces:**
- Consumes:
  - Task 1 的 `buildFetchCommand` / `buildLsRemoteCommand` / `GitFetchParams` / `GitLsRemoteParams`
  - `src/executor.ts` 的 `execute(commandLine: string, options?: { timeoutMs?: number; baseCommand?: string }): Promise<ExecResult>`，其中 `ExecResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean }`
- Produces:
  - `type GitOutcome = { ok: true; text: string } | { ok: false; error: string }`
  - `gitFetch(executeFn: typeof execute, params: GitFetchParams): Promise<GitOutcome>`
  - `gitLsRemote(executeFn: typeof execute, params: GitLsRemoteParams): Promise<GitOutcome>`
  - 兩者皆以 `baseCommand: "git"` 呼叫 executor；`timeoutMs` 預設 `120_000`。

- [ ] **Step 1: 寫失敗測試**

在 `tests/git.test.ts` 檔頭 import 區改為：

```ts
import { describe, expect, test } from "vitest";
import {
  buildFetchCommand,
  buildLsRemoteCommand,
  gitFetch,
  gitLsRemote,
} from "../src/git.js";
import type { ExecResult, ExecuteOptions } from "../src/executor.js";
```

檔尾附加：

```ts
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
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      ...result,
    });
  };
  return { fake, calls };
}

describe("gitFetch", () => {
  test("以 baseCommand git 與預設 timeout 執行", async () => {
    const { fake, calls } = makeFakeExecutor({
      stderr: " * [new branch] releases/s116/rc-092 -> origin/releases/s116/rc-092",
    });
    const result = await gitFetch(fake, {
      repoPath: "D:\\repo",
      refspec: "releases/s116/rc-092",
    });
    expect(result).toEqual({
      ok: true,
      text: "* [new branch] releases/s116/rc-092 -> origin/releases/s116/rc-092",
    });
    expect(calls[0]?.commandLine).toBe(
      '-C "D:\\repo" fetch origin "releases/s116/rc-092"',
    );
    expect(calls[0]?.options?.baseCommand).toBe("git");
    expect(calls[0]?.options?.timeoutMs).toBe(120_000);
  });

  test("自訂 timeoutMs 傳遞給 executor", async () => {
    const { fake, calls } = makeFakeExecutor();
    await gitFetch(fake, { repoPath: "D:\\repo", timeoutMs: 300_000 });
    expect(calls[0]?.options?.timeoutMs).toBe(300_000);
  });

  test("成功且 stdout 與 stderr 都有輸出時合併回傳", async () => {
    const { fake } = makeFakeExecutor({ stdout: "out", stderr: "err" });
    const result = await gitFetch(fake, { repoPath: "D:\\repo" });
    expect(result).toEqual({ ok: true, text: "out\nerr" });
  });

  test("成功但無輸出時回報無變更", async () => {
    const { fake } = makeFakeExecutor();
    const result = await gitFetch(fake, { repoPath: "D:\\repo" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain("無 ref 變更");
  });

  test("驗證失敗時不執行命令", async () => {
    const { fake, calls } = makeFakeExecutor();
    const result = await gitFetch(fake, {
      repoPath: "D:\\repo",
      refspec: "--upload-pack=calc",
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("git 不存在時附安裝提示", async () => {
    const { fake } = makeFakeExecutor({
      stderr: "'git' is not recognized as an internal or external command",
      exitCode: 1,
    });
    const result = await gitFetch(fake, { repoPath: "D:\\repo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("安裝");
  });

  test("不是 git repo 時附 repoPath 提示", async () => {
    const { fake } = makeFakeExecutor({
      stderr: "fatal: not a git repository (or any of the parent directories)",
      exitCode: 128,
    });
    const result = await gitFetch(fake, { repoPath: "D:\\repo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("主機端的絕對路徑");
  });

  test("認證失敗時附 credential 提示", async () => {
    const { fake } = makeFakeExecutor({
      stderr: "fatal: Authentication failed for 'https://dev.azure.com/SKMHHIS/...'",
      exitCode: 128,
    });
    const result = await gitFetch(fake, { repoPath: "D:\\repo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("credential");
  });

  test("逾時回傳明確訊息", async () => {
    const { fake } = makeFakeExecutor({ timedOut: true, exitCode: 1 });
    const result = await gitFetch(fake, { repoPath: "D:\\repo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("逾時");
  });
});

describe("gitLsRemote", () => {
  test("回傳 ref 清單", async () => {
    const { fake, calls } = makeFakeExecutor({
      stdout: "abc123\trefs/heads/releases/s116/rc-092\n",
    });
    const result = await gitLsRemote(fake, {
      repoPath: "D:\\repo",
      heads: true,
      pattern: "releases/s116/rc-092",
    });
    expect(result).toEqual({
      ok: true,
      text: "abc123\trefs/heads/releases/s116/rc-092",
    });
    expect(calls[0]?.commandLine).toBe(
      '-C "D:\\repo" ls-remote --heads origin "releases/s116/rc-092"',
    );
    expect(calls[0]?.options?.baseCommand).toBe("git");
  });

  test("無符合的 ref 時明確回報", async () => {
    const { fake } = makeFakeExecutor({ stdout: "" });
    const result = await gitLsRemote(fake, {
      repoPath: "D:\\repo",
      pattern: "no-such-branch",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain("沒有符合的 ref");
  });

  test("驗證失敗時不執行命令", async () => {
    const { fake, calls } = makeFakeExecutor();
    const result = await gitLsRemote(fake, {
      repoPath: "relative/path",
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/git.test.ts`
Expected: FAIL —— `gitFetch` / `gitLsRemote` 未匯出（`is not a function` 或 import 錯誤）。

- [ ] **Step 3: 實作 runners 與錯誤映射**

`src/git.ts` 檔頭加 import：

```ts
import type { execute, ExecResult } from "./executor.js";
```

檔尾附加：

```ts
export type GitOutcome =
  | { ok: true; text: string }
  | { ok: false; error: string };

const DEFAULT_GIT_TIMEOUT_MS = 120_000;

function mapGitFailure(result: ExecResult): string {
  if (result.timedOut) {
    return (
      "git 命令執行逾時，子程序已終止。" +
      "可調高 timeout 參數，或先用 az_git_ls_remote 確認遠端可連線。"
    );
  }
  let text =
    result.stderr || result.stdout || `git 命令失敗，結束碼 ${result.exitCode}。`;
  if (/'git' is not recognized|git: command not found/i.test(text)) {
    text +=
      "\n\n找不到 git。請先在主機安裝 Git：https://git-scm.com/downloads。";
  } else if (/not a git repository|cannot change to/i.test(text)) {
    text +=
      "\n\n請確認 repoPath 是主機端的絕對路徑" +
      "（sandbox 內看到的路徑可能與主機不同）。";
  } else if (
    /authentication failed|could not read username|403/i.test(text)
  ) {
    text +=
      "\n\n請確認主機端 git credential（如 Git Credential Manager）" +
      "可正常存取該遠端。";
  }
  return text;
}

function mergedOutput(result: ExecResult): string {
  return [result.stdout, result.stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
}

export async function gitFetch(
  executeFn: typeof execute,
  params: GitFetchParams,
): Promise<GitOutcome> {
  const built = buildFetchCommand(params);
  if (!built.ok) return built;
  const result = await executeFn(built.command, {
    timeoutMs: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    baseCommand: "git",
  });
  if (result.timedOut || result.exitCode !== 0) {
    return { ok: false, error: mapGitFailure(result) };
  }
  // git fetch 的 ref 更新訊息輸出在 stderr，需合併回傳
  const text = mergedOutput(result);
  return { ok: true, text: text || "fetch 完成（無 ref 變更）。" };
}

export async function gitLsRemote(
  executeFn: typeof execute,
  params: GitLsRemoteParams,
): Promise<GitOutcome> {
  const built = buildLsRemoteCommand(params);
  if (!built.ok) return built;
  const result = await executeFn(built.command, {
    timeoutMs: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    baseCommand: "git",
  });
  if (result.timedOut || result.exitCode !== 0) {
    return { ok: false, error: mapGitFailure(result) };
  }
  const text = result.stdout.trim();
  return { ok: true, text: text || "遠端沒有符合的 ref。" };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run tests/git.test.ts`
Expected: PASS（全部測試綠）。

- [ ] **Step 5: Commit**

```bash
git add src/git.ts tests/git.test.ts
git commit -m "feat: add gitFetch/gitLsRemote runners with error mapping"
```

---

### Task 3: server 註冊兩個工具 + 版本 0.5.0

**Files:**
- Modify: `src/server.ts`
- Modify: `package.json`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `gitFetch` / `gitLsRemote` / `GitOutcome`；server.ts 既有的 `truncateOutput`、`DEFAULT_TIMEOUT_SECONDS`、`ToolResult`。
- Produces: MCP 工具 `az_git_fetch`、`az_git_ls_remote`（tool list 由 10 個變 12 個）。

- [ ] **Step 1: 寫失敗測試**

修改 `tests/server.test.ts` 既有的工具清單測試（`列出十個工具`）：

```ts
  test("列出十二個工具", async () => {
    const { fake } = makeFakeExecutor();
    const client = await connect(fake);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "az_devops",
      "az_devops_help",
      "az_git_fetch",
      "az_git_ls_remote",
      "az_pr_changes",
      "az_pr_comment",
      "az_pr_show",
      "az_pr_workitems",
      "az_rest",
      "az_workitem_attach",
      "az_workitem_relations",
      "az_workitem_update",
    ]);
  });
```

並在檔尾（`REST 工具整合` describe 之後）附加新的 describe：

```ts
describe("git 工具整合", () => {
  test("az_git_fetch 以 baseCommand git 執行且秒轉毫秒", async () => {
    const { fake, calls } = makeFakeExecutor({
      stderr: " * [new branch] rc-092 -> origin/rc-092",
    });
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_git_fetch",
      arguments: {
        repoPath: "D:\\mygithub\\MS-Web",
        refspec: "releases/s116/rc-092",
        timeout: 300,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("origin/rc-092");
    expect(calls[0]?.commandLine).toBe(
      '-C "D:\\mygithub\\MS-Web" fetch origin "releases/s116/rc-092"',
    );
    expect(calls[0]?.options?.baseCommand).toBe("git");
    expect(calls[0]?.options?.timeoutMs).toBe(300_000);
  });

  test("az_git_fetch 驗證失敗時不執行且標記 isError", async () => {
    const { fake, calls } = makeFakeExecutor();
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_git_fetch",
      arguments: { repoPath: "relative/path" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("絕對路徑");
    expect(calls).toHaveLength(0);
  });

  test("az_git_ls_remote 組出正確命令", async () => {
    const { fake, calls } = makeFakeExecutor({
      stdout: "abc123\trefs/heads/releases/s116/rc-092\n",
    });
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_git_ls_remote",
      arguments: {
        repoPath: "D:\\mygithub\\MS-Web",
        heads: true,
        pattern: "releases/s116/rc-092",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("refs/heads/releases/s116/rc-092");
    expect(calls[0]?.commandLine).toBe(
      '-C "D:\\mygithub\\MS-Web" ls-remote --heads origin "releases/s116/rc-092"',
    );
    expect(calls[0]?.options?.baseCommand).toBe("git");
  });

  test("az_git_fetch git 失敗時回傳 stderr 並標記 isError", async () => {
    const { fake } = makeFakeExecutor({
      stderr: "fatal: Authentication failed",
      exitCode: 128,
    });
    const client = await connect(fake);
    const result = await client.callTool({
      name: "az_git_fetch",
      arguments: { repoPath: "D:\\repo" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("credential");
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL —— 工具清單不含 `az_git_fetch` / `az_git_ls_remote`；新 describe 的 callTool 回傳 tool not found 類錯誤。

- [ ] **Step 3: 在 server.ts 註冊工具並調版本**

`src/server.ts` 的 import 區（`workItem.js` import 之後）加入：

```ts
import { gitFetch, gitLsRemote, type GitOutcome } from "./git.js";
```

在 `restToolResult` 函式之後加入：

```ts
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
```

`McpServer` 版本改為 0.5.0：

```ts
  const server = new McpServer({
    name: "azure-devops-cli-mcp",
    version: "0.5.0",
  });
```

在 `az_rest` 的 `registerTool` 區塊之後、`return server;` 之前加入兩個工具：

```ts
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
```

`package.json` 版本改為：

```json
  "version": "0.5.0",
```

- [ ] **Step 4: 執行全部測試確認通過**

Run: `npx vitest run`
Expected: PASS —— 全部測試檔（含既有 8 個測試檔與新的 git.test.ts）全綠。

- [ ] **Step 5: Commit**

```bash
git add src/server.ts package.json tests/server.test.ts
git commit -m "feat: register az_git_fetch and az_git_ls_remote tools, bump to 0.5.0"
```

---

### Task 4: 文件與 smoke test

**Files:**
- Modify: `README.md`
- Modify: `scripts/smoke.mjs`

**Interfaces:**
- Consumes: Task 3 註冊的 `az_git_fetch` / `az_git_ls_remote` 工具名稱與參數。
- Produces: 無（文件與手動驗證腳本）。

- [ ] **Step 1: 更新 README 工具表**

`README.md` 的工具表（`| az_rest | ...` 那一列之後）加入兩列：

```markdown
| `az_git_fetch` | 在主機端對本機 repo 執行 `git fetch`（唯讀）。Cowork sandbox 內 fetch 被 proxy 擋下（403）時的替代路徑，fetch 完成後 sandbox 內即可用本機 git 操作 `origin/<branch>`。 |
| `az_git_ls_remote` | 在主機端查詢遠端 refs（`git ls-remote`，不下載物件），可先確認遠端分支存在。 |
```

並在「安全防護」小節之後（`## 開發` 之前）加入：

```markdown
### Git 工具

`az_git_fetch` / `az_git_ls_remote` 在主機端執行 git 的唯讀網路操作，
`repoPath` 必須是主機端的絕對路徑。參數經嚴格驗證：remote 只接受名稱
（不接受 URL）、refspec/pattern 不可以 `-` 開頭（擋 `--upload-pack` 等
危險選項）。不提供 push、pull 或任何寫入操作。認證使用主機端的
git credential（如 Git Credential Manager）。
```

- [ ] **Step 2: 擴充 smoke test**

`scripts/smoke.mjs` 在 `az_rest` 區塊之後、`await client.close();` 之前加入：

```js
console.log("\n--- az_git_ls_remote: 目前 repo 的 origin heads ---");
const lsRemote = await client.callTool({
  name: "az_git_ls_remote",
  arguments: { repoPath: process.cwd(), heads: true },
});
console.log("isError:", lsRemote.isError ?? false);
console.log(lsRemote.content[0].text.slice(0, 300));

console.log("\n--- az_git_fetch: 目前 repo fetch origin ---");
const fetchResult = await client.callTool({
  name: "az_git_fetch",
  arguments: { repoPath: process.cwd() },
});
console.log("isError:", fetchResult.isError ?? false);
console.log(fetchResult.content[0].text.slice(0, 300));

console.log("\n--- az_git_fetch: 相對路徑（應拒絕）---");
const badPath = await client.callTool({
  name: "az_git_fetch",
  arguments: { repoPath: "relative/path" },
});
console.log("isError:", badPath.isError ?? false);
console.log(badPath.content[0].text);
```

- [ ] **Step 3: 執行完整驗證**

```bash
npm run build && npx vitest run
```

Expected: build 無錯誤、全部測試 PASS。

（選擇性人工驗證，需要網路與 git credential：`node scripts/smoke.mjs`，
預期 ls-remote 列出 origin 分支、fetch 成功、相對路徑被拒。）

- [ ] **Step 4: Commit**

```bash
git add README.md scripts/smoke.mjs
git commit -m "docs: document git tools and extend smoke test"
```
