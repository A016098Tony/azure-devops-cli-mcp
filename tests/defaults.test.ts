import { describe, expect, test } from "vitest";
import {
  BUILT_IN_DEFAULTS,
  normalizeOrganization,
  parseCliArgs,
  planInjection,
  appendFlags,
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
