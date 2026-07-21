import { describe, expect, test } from "vitest";
import {
  attachFileToWorkItem,
  buildLinkPatchBody,
  buildLinkUrl,
  buildUploadUrl,
  MAX_ATTACHMENT_BYTES,
  resolveAuthHeader,
  type AttachmentIo,
} from "../src/attachment.js";
import { BUILT_IN_DEFAULTS } from "../src/defaults.js";
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

function makeFakeFetch(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch call");
    return next;
  }) as typeof fetch;
  return { fetchFn, calls };
}

function makeIo(
  fetchFn: typeof fetch,
  overrides: Partial<AttachmentIo> = {},
): AttachmentIo {
  return {
    readFile: async () => Buffer.from([0x00, 0x9f, 0x92, 0x96]), // 非合法 UTF-8 的 binary
    fetchFn,
    env: { AZURE_DEVOPS_EXT_PAT: "pat" },
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const UPLOAD_OK = () =>
  jsonResponse(201, {
    id: "abc",
    url: "https://dev.azure.com/SKMHHIS/_apis/wit/attachments/abc",
  });

describe("attachFileToWorkItem", () => {
  test("成功：POST binary 原樣送出，再 PATCH 連結，回傳附件 URL", async () => {
    const { fetchFn, calls } = makeFakeFetch([UPLOAD_OK(), jsonResponse(200, { id: 42 })]);
    const io = makeIo(fetchFn);
    const result = await attachFileToWorkItem(io, async () => {
      throw new Error("PAT 模式不應呼叫 az");
    }, BUILT_IN_DEFAULTS, { workItemId: 42, filePath: "D:\\tmp\\shot.png" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toContain("shot.png");
      expect(result.message).toContain("#42");
      expect(result.message).toContain("/_apis/wit/attachments/abc");
    }
    // 第一步：上傳
    expect(calls[0]?.url).toBe(
      "https://dev.azure.com/SKMHHIS/MS/_apis/wit/attachments?fileName=shot.png&api-version=7.1",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(
      (calls[0]?.init.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/octet-stream");
    // binary Buffer 原樣傳給 fetch，不經任何字串轉換
    expect(calls[0]?.init.body).toEqual(Buffer.from([0x00, 0x9f, 0x92, 0x96]));
    // 第二步：連結
    expect(calls[1]?.url).toBe(
      "https://dev.azure.com/SKMHHIS/_apis/wit/workitems/42?api-version=7.1",
    );
    expect(calls[1]?.init.method).toBe("PATCH");
    expect(
      (calls[1]?.init.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/json-patch+json");
    expect(JSON.parse(String(calls[1]?.init.body))[0].value.rel).toBe(
      "AttachedFile",
    );
  });

  test("fileName 參數覆寫附件名稱", async () => {
    const { fetchFn, calls } = makeFakeFetch([UPLOAD_OK(), jsonResponse(200, {})]);
    await attachFileToWorkItem(makeIo(fetchFn), async () => {
      throw new Error("不應呼叫 az");
    }, BUILT_IN_DEFAULTS, {
      workItemId: 1,
      filePath: "D:\\tmp\\x.bin",
      fileName: "報告.bin",
      comment: "自動上傳",
    });
    expect(calls[0]?.url).toContain(
      `fileName=${encodeURIComponent("報告.bin")}`,
    );
    expect(JSON.parse(String(calls[1]?.init.body))[0].value.attributes).toEqual(
      { comment: "自動上傳" },
    );
  });

  test("檔案不存在：不發任何 API", async () => {
    const { fetchFn, calls } = makeFakeFetch([]);
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    const io = makeIo(fetchFn, { readFile: async () => { throw enoent; } });
    const result = await attachFileToWorkItem(io, async () => {
      throw new Error("不應呼叫 az");
    }, BUILT_IN_DEFAULTS, { workItemId: 1, filePath: "D:\\nope.txt" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("找不到檔案");
    expect(calls).toHaveLength(0);
  });

  test("路徑是目錄：明確錯誤", async () => {
    const { fetchFn } = makeFakeFetch([]);
    const eisdir = Object.assign(new Error("is a dir"), { code: "EISDIR" });
    const io = makeIo(fetchFn, { readFile: async () => { throw eisdir; } });
    const result = await attachFileToWorkItem(io, async () => {
      throw new Error("不應呼叫 az");
    }, BUILT_IN_DEFAULTS, { workItemId: 1, filePath: "D:\\dir" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("目錄");
  });

  test("超過 100MB：拒絕且不發 API", async () => {
    const { fetchFn, calls } = makeFakeFetch([]);
    const io = makeIo(fetchFn, {
      readFile: async () => Buffer.alloc(100 * 1024 * 1024 + 1),
    });
    const result = await attachFileToWorkItem(io, async () => {
      throw new Error("不應呼叫 az");
    }, BUILT_IN_DEFAULTS, { workItemId: 1, filePath: "D:\\big.zip" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("100MB");
    expect(calls).toHaveLength(0);
  });

  test("上傳收到 203（PAT 無效的 HTML 登入頁）視為認證失敗", async () => {
    const { fetchFn } = makeFakeFetch([new Response("<html>", { status: 203 })]);
    const result = await attachFileToWorkItem(
      makeIo(fetchFn),
      async () => { throw new Error("不應呼叫 az"); },
      BUILT_IN_DEFAULTS,
      { workItemId: 1, filePath: "D:\\a.txt" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("認證");
  });

  test("PATCH 404：指出 work item 不存在，並附上已上傳的附件 URL", async () => {
    const { fetchFn } = makeFakeFetch([
      UPLOAD_OK(),
      new Response("not found", { status: 404 }),
    ]);
    const result = await attachFileToWorkItem(
      makeIo(fetchFn),
      async () => { throw new Error("不應呼叫 az"); },
      BUILT_IN_DEFAULTS,
      { workItemId: 999999, filePath: "D:\\a.txt" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("999999");
      expect(result.error).toContain("/_apis/wit/attachments/abc");
    }
  });

  test("PATCH 非 404 失敗：錯誤含 HTTP 狀態與附件 URL", async () => {
    const { fetchFn } = makeFakeFetch([
      UPLOAD_OK(),
      new Response("rule violation", { status: 400 }),
    ]);
    const result = await attachFileToWorkItem(
      makeIo(fetchFn),
      async () => { throw new Error("不應呼叫 az"); },
      BUILT_IN_DEFAULTS,
      { workItemId: 1, filePath: "D:\\a.txt" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("400");
      expect(result.error).toContain("/_apis/wit/attachments/abc");
    }
  });

  test("fetch 拋出網路錯誤：回傳中文錯誤", async () => {
    const fetchFn = (async () => {
      throw new Error("getaddrinfo ENOTFOUND dev.azure.com");
    }) as unknown as typeof fetch;
    const result = await attachFileToWorkItem(
      makeIo(fetchFn),
      async () => { throw new Error("不應呼叫 az"); },
      BUILT_IN_DEFAULTS,
      { workItemId: 1, filePath: "D:\\a.txt" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("網路錯誤");
  });

  test("上傳回應缺少 url 欄位：解析錯誤", async () => {
    const { fetchFn } = makeFakeFetch([jsonResponse(201, { id: "abc" })]);
    const result = await attachFileToWorkItem(
      makeIo(fetchFn),
      async () => { throw new Error("不應呼叫 az"); },
      BUILT_IN_DEFAULTS,
      { workItemId: 1, filePath: "D:\\a.txt" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("解析");
  });
});
