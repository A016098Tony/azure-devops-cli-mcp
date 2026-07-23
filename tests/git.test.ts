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
