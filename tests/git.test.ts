import { describe, expect, test } from "vitest";
import {
  buildFetchCommand,
  buildLsRemoteCommand,
  gitFetch,
  gitLsRemote,
} from "../src/git.js";
import type { ExecResult, ExecuteOptions } from "../src/executor.js";

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

  test("拒絕 shell metacharacter 注入的 refspec（command injection）", () => {
    for (const bad of [
      "$(id)",
      "`touch pwned`",
      "a&calc.exe",
      "a|calc.exe",
      "a;calc.exe",
      "a>pwned.txt",
      "a<pwned.txt",
      "a(pwned)",
      "a%pwned%",
      "a!pwned",
      "refs/heads/x\r\ncalc.exe",
    ]) {
      const result = buildFetchCommand({ repoPath: "D:\\repo", refspec: bad });
      expect(result.ok, `refspec ${JSON.stringify(bad)} 應被拒絕`).toBe(false);
    }
  });

  test("拒絕含 shell metacharacter 的 repoPath（command injection）", () => {
    for (const bad of [
      "D:\\repo$(id)",
      "D:\\repo`touch pwned`",
      "D:\\repo&calc.exe",
      "D:\\repo|calc.exe",
      "D:\\repo;calc.exe",
      "D:\\repo>pwned.txt",
      "D:\\repo<pwned.txt",
      "D:\\repo(pwned)",
      "D:\\repo%pwned%",
      "D:\\repo!pwned",
      "D:\\repo\r\ncalc.exe",
    ]) {
      const result = buildFetchCommand({ repoPath: bad });
      expect(result.ok, `repoPath ${JSON.stringify(bad)} 應被拒絕`).toBe(false);
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

  test("拒絕 shell metacharacter 注入的 pattern（command injection）", () => {
    for (const bad of ["$(id)", "`touch pwned`", "a&calc.exe", "a|calc.exe"]) {
      const result = buildLsRemoteCommand({ repoPath: "D:\\repo", pattern: bad });
      expect(result.ok, `pattern ${JSON.stringify(bad)} 應被拒絕`).toBe(false);
    }
  });
});

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
