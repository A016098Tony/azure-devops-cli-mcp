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
