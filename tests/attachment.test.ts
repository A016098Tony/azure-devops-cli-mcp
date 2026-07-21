import { describe, expect, test } from "vitest";
import {
  buildLinkPatchBody,
  buildLinkUrl,
  buildUploadUrl,
  MAX_ATTACHMENT_BYTES,
  resolveAuthHeader,
} from "../src/attachment.js";
import type { ExecResult, ExecuteOptions } from "../src/executor.js";

describe("attachment URL 組裝", () => {
  test("buildUploadUrl 組出 attachments POST URL 並 encode 檔名", () => {
    expect(
      buildUploadUrl("https://dev.azure.com/SKMHHIS", "MS", "審查報告 v1.md"),
    ).toBe(
      "https://dev.azure.com/SKMHHIS/MS/_apis/wit/attachments" +
        "?fileName=%E5%AF%A9%E6%9F%A5%E5%A0%B1%E5%91%8A%20v1.md&api-version=7.1",
    );
  });

  test("buildUploadUrl 對 organization 尾端斜線與 project 特殊字元防禦", () => {
    expect(
      buildUploadUrl("https://dev.azure.com/SKMHHIS/", "My Project", "a.png"),
    ).toBe(
      "https://dev.azure.com/SKMHHIS/My%20Project/_apis/wit/attachments" +
        "?fileName=a.png&api-version=7.1",
    );
  });

  test("buildLinkUrl 組出 work item PATCH URL（org 層級、不含 project）", () => {
    expect(buildLinkUrl("https://dev.azure.com/SKMHHIS", 123)).toBe(
      "https://dev.azure.com/SKMHHIS/_apis/wit/workitems/123?api-version=7.1",
    );
  });
});

describe("buildLinkPatchBody", () => {
  test("含 comment 時帶 attributes", () => {
    expect(
      buildLinkPatchBody("https://dev.azure.com/x/_apis/wit/attachments/abc", "審查結果"),
    ).toEqual([
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "AttachedFile",
          url: "https://dev.azure.com/x/_apis/wit/attachments/abc",
          attributes: { comment: "審查結果" },
        },
      },
    ]);
  });

  test("無 comment 時省略 attributes", () => {
    const [op] = buildLinkPatchBody("https://example.test/a");
    expect(op.value).toEqual({
      rel: "AttachedFile",
      url: "https://example.test/a",
    });
  });
});

test("MAX_ATTACHMENT_BYTES 為 100MB", () => {
  expect(MAX_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
});

function makeFakeExecutor(result: Partial<ExecResult> = {}) {
  const calls: Array<{ commandLine: string; options?: ExecuteOptions }> = [];
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

describe("resolveAuthHeader", () => {
  test("有 AZURE_DEVOPS_EXT_PAT 時用 Basic auth 且不呼叫 az", async () => {
    const { fake, calls } = makeFakeExecutor();
    const result = await resolveAuthHeader(
      { AZURE_DEVOPS_EXT_PAT: "mypat" },
      fake,
    );
    expect(result).toEqual({
      ok: true,
      header: `Basic ${Buffer.from(":mypat").toString("base64")}`,
    });
    expect(calls).toHaveLength(0);
  });

  test("無 PAT 時執行 az account get-access-token 取 Bearer token", async () => {
    const { fake, calls } = makeFakeExecutor({ stdout: "eyJtoken\n" });
    const result = await resolveAuthHeader({}, fake);
    expect(result).toEqual({ ok: true, header: "Bearer eyJtoken" });
    expect(calls[0]?.commandLine).toBe(
      "account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv",
    );
    expect(calls[0]?.options?.timeoutMs).toBe(30_000);
  });

  test("PAT 為空白字串時視同未設定，改走 az", async () => {
    const { fake, calls } = makeFakeExecutor({ stdout: "tok" });
    const result = await resolveAuthHeader({ AZURE_DEVOPS_EXT_PAT: "  " }, fake);
    expect(result).toEqual({ ok: true, header: "Bearer tok" });
    expect(calls).toHaveLength(1);
  });

  test("az 失敗時回傳中文錯誤並提示兩種認證方式", async () => {
    const { fake } = makeFakeExecutor({
      exitCode: 1,
      stderr: "ERROR: Please run 'az login'",
    });
    const result = await resolveAuthHeader({}, fake);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("az login");
      expect(result.error).toContain("AZURE_DEVOPS_EXT_PAT");
    }
  });

  test("az 成功但輸出為空時也視為失敗", async () => {
    const { fake } = makeFakeExecutor({ stdout: "  \n" });
    const result = await resolveAuthHeader({}, fake);
    expect(result.ok).toBe(false);
  });
});
