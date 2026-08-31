import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  attachFileToWorkItem,
  buildLinkPatchBody,
  buildLinkUrl,
  buildUploadUrl,
  decodeEntities,
  DOWNLOAD_ROOT,
  downloadAttachment,
  downloadAttachmentToDir,
  downloadWorkItemAttachments,
  extractInlineImageUrls,
  fileNameFromAttachmentUrl,
  isAllowedAttachmentUrl,
  MAX_ATTACHMENT_BYTES,
  resolveAuthHeader,
  safeFileName,
  uniqueName,
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
    writeFile: async () => {},
    mkdir: async () => undefined,
    rm: async () => {},
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


// ---------- 下載 ----------

const ORG = "https://dev.azure.com/SKMHHIS";
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const PNG_BYTES = Buffer.from([...PNG_MAGIC, 0x0d, 0x0a, 0x1a, 0x0a]);

const noAz = async (): Promise<ExecResult> => {
  throw new Error("PAT 模式不應呼叫 az");
};

/** 203 在 fetch spec 屬 2xx，所以 ok=true —— 正是要靠 isAuthFailure 才擋得掉 */
function binaryResponse(
  status: number,
  body: Uint8Array | ArrayBuffer,
): Response {
  const buf =
    body instanceof ArrayBuffer
      ? body
      : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buf,
    text: async () => "<binary>",
  } as unknown as Response;
}

function makeRecordingIo(fetchFn: typeof fetch) {
  const writes: Array<{ filePath: string; data: Buffer }> = [];
  const dirs: string[] = [];
  const removed: string[] = [];
  const io: AttachmentIo = {
    readFile: async () => Buffer.alloc(0),
    writeFile: async (filePath, data) => {
      writes.push({ filePath, data });
    },
    mkdir: async (dirPath) => {
      dirs.push(dirPath);
      return undefined;
    },
    rm: async (dirPath) => {
      removed.push(dirPath);
    },
    fetchFn,
    env: { AZURE_DEVOPS_EXT_PAT: "pat" },
  };
  return { io, writes, dirs, removed };
}

function workItemResponse(
  fields: Record<string, unknown>,
  relations?: unknown[],
): Response {
  return jsonResponse(200, {
    id: 160132,
    fields,
    ...(relations ? { relations } : {}),
  });
}

describe("extractInlineImageUrls", () => {
  test("只收 ADO 附件 API 的 img，並解 HTML entity", () => {
    const html =
      `<div><img src="${ORG}/034d5cd3-0000/_apis/wit/attachments/abc` +
      `?fileName=main.png&amp;api-version=7.1" />` +
      '<img src="https://cdn.example.test/logo.png" /></div>';
    expect(extractInlineImageUrls(html)).toEqual([
      `${ORG}/034d5cd3-0000/_apis/wit/attachments/abc?fileName=main.png&api-version=7.1`,
    ]);
  });

  test("空值與非字串回空陣列", () => {
    expect(extractInlineImageUrls(undefined)).toEqual([]);
    expect(extractInlineImageUrls("")).toEqual([]);
    expect(extractInlineImageUrls(42)).toEqual([]);
  });
});

describe("decodeEntities", () => {
  test("解常見 entity", () => {
    expect(decodeEntities("a&amp;b&lt;c&gt;d&quot;e&#39;f&nbsp;g")).toBe(
      'a&b<c>d"e\'f g',
    );
  });
});

describe("檔名處理", () => {
  test("fileNameFromAttachmentUrl 取 query 的 fileName（已解碼一次，不再重複解）", () => {
    expect(
      fileNameFromAttachmentUrl(
        `${ORG}/_apis/wit/attachments/a?fileName=%E5%9C%96%201.png`,
      ),
    ).toBe("圖 1.png");
  });

  test("沒有 fileName 或非合法 URL 時回 null", () => {
    expect(fileNameFromAttachmentUrl(`${ORG}/_apis/wit/attachments/a`)).toBeNull();
    expect(fileNameFromAttachmentUrl("not a url")).toBeNull();
  });

  test("safeFileName 擋掉路徑穿越，只留檔名", () => {
    expect(safeFileName("../../evil.exe", "fb")).toBe("evil.exe");
    expect(safeFileName("..\\..\\evil.exe", "fb")).toBe("evil.exe");
    expect(safeFileName("C:\\Windows\\System32\\evil.dll", "fb")).toBe(
      "evil.dll",
    );
    expect(safeFileName("   ", "fb")).toBe("fb");
    expect(safeFileName("..", "fb")).toBe("fb");
  });

  test("safeFileName 清掉 Windows 非法字元（: 會被 NTFS 當成 data stream）", () => {
    expect(safeFileName("report:v1.md", "fb")).toBe("report_v1.md");
    expect(safeFileName("a?b.png", "fb")).toBe("a_b.png");
    expect(safeFileName('x<y>z|w*v".png', "fb")).toBe("x_y_z_w_v_.png");
    expect(safeFileName("tab\there.png", "fb")).toBe("tab_here.png");
  });

  test("safeFileName 去掉結尾的點與空白，但保留開頭的點", () => {
    expect(safeFileName("file.txt.", "fb")).toBe("file.txt");
    expect(safeFileName("file.txt...", "fb")).toBe("file.txt");
    expect(safeFileName("...", "fb")).toBe("fb");
    expect(safeFileName(".gitignore", "fb")).toBe(".gitignore");
  });

  test("uniqueName 同批重名改為 -2、-3（比對不分大小寫）", () => {
    const used = new Set<string>();
    expect(uniqueName("main.png", used)).toBe("main.png");
    expect(uniqueName("main.png", used)).toBe("main-2.png");
    expect(uniqueName("main.png", used)).toBe("main-3.png");
    expect(uniqueName("MAIN.PNG", used)).toBe("MAIN-4.PNG");
  });
});

describe("isAllowedAttachmentUrl", () => {
  test("同 origin 放行；實測附件 URL 的 project 是 GUID，所以只能比 origin", () => {
    expect(isAllowedAttachmentUrl(`${ORG}/_apis/wit/attachments/a`, ORG)).toBe(
      true,
    );
    expect(
      isAllowedAttachmentUrl(
        "https://dev.azure.com/SKMHHIS/034d5cd3-0000/_apis/wit/attachments/a",
        ORG,
      ),
    ).toBe(true);
  });

  test("不同 host、不同 scheme、非法 URL 一律擋", () => {
    expect(isAllowedAttachmentUrl("https://evil.test/a", ORG)).toBe(false);
    expect(isAllowedAttachmentUrl("http://dev.azure.com/a", ORG)).toBe(false);
    expect(isAllowedAttachmentUrl("not a url", ORG)).toBe(false);
  });
});

describe("downloadAttachment", () => {
  test("binary 原樣取回，PNG magic bytes 不被字串轉換破壞", async () => {
    const { fetchFn, calls } = makeFakeFetch([binaryResponse(200, PNG_BYTES)]);
    const result = await downloadAttachment(
      { fetchFn },
      "Bearer t",
      `${ORG}/_apis/wit/attachments/a`,
      ORG,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.buffer.subarray(0, 4)]).toEqual(PNG_MAGIC);
      expect(result.buffer).toEqual(PNG_BYTES);
    }
    expect(
      (calls[0]?.init.headers as Record<string, string>).Accept,
    ).toBe("application/octet-stream");
  });

  test("跨 origin 直接拒絕，完全不發出請求（Authorization 不外洩）", async () => {
    const { fetchFn, calls } = makeFakeFetch([]);
    const result = await downloadAttachment(
      { fetchFn },
      "Bearer secret",
      "https://evil.test/steal",
      ORG,
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("203 視為認證失敗（ADO 回 HTML 登入頁），不當成檔案內容", async () => {
    const { fetchFn } = makeFakeFetch([
      binaryResponse(203, Buffer.from("<html>login</html>")),
    ]);
    const result = await downloadAttachment(
      { fetchFn },
      "Bearer t",
      `${ORG}/_apis/wit/attachments/a`,
      ORG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("az login");
  });

  test("HTTP 404 回錯誤", async () => {
    const { fetchFn } = makeFakeFetch([
      binaryResponse(404, Buffer.from("nope")),
    ]);
    const result = await downloadAttachment(
      { fetchFn },
      "Bearer t",
      `${ORG}/_apis/wit/attachments/a`,
      ORG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("404");
  });

  test("超過 100MB 上限時拒絕（以實際位元組數判斷）", async () => {
    const { fetchFn } = makeFakeFetch([
      binaryResponse(200, new ArrayBuffer(MAX_ATTACHMENT_BYTES + 1)),
    ]);
    const result = await downloadAttachment(
      { fetchFn },
      "Bearer t",
      `${ORG}/_apis/wit/attachments/a`,
      ORG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("100MB");
  });
});

describe("downloadWorkItemAttachments", () => {
  test("同時收 HTML 內嵌圖與 relations 附件，分別落在 images/ 與 attachments/", async () => {
    const inlineUrl = `${ORG}/034d5cd3-0000/_apis/wit/attachments/img1?fileName=main.png`;
    const attachUrl = `${ORG}/034d5cd3-0000/_apis/wit/attachments/att1`;
    const { fetchFn } = makeFakeFetch([
      workItemResponse(
        { "System.Description": `<p><img src="${inlineUrl}"></p>` },
        [
          {
            rel: "AttachedFile",
            url: attachUrl,
            attributes: { name: "spec.md" },
          },
          { rel: "Hyperlink", url: "https://example.test/x" },
        ],
      ),
      binaryResponse(200, PNG_BYTES),
      binaryResponse(200, Buffer.from("# spec")),
    ]);
    const { io, writes, dirs } = makeRecordingIo(fetchFn);
    const result = await downloadWorkItemAttachments(
      io,
      noAz,
      BUILT_IN_DEFAULTS,
      { workItemId: 160132 },
    );

    expect(result.ok).toBe(true);
    const root = path.join(DOWNLOAD_ROOT, "workitem-160132");
    expect(dirs).toEqual([
      path.join(root, "images"),
      path.join(root, "attachments"),
    ]);
    // 內嵌圖不在 relations 裡，只走 relations 會漏掉它
    expect(writes.map((w) => w.filePath)).toEqual([
      path.join(root, "images", "main.png"),
      path.join(root, "attachments", "spec.md"),
    ]);
    expect(writes[0]?.data).toEqual(PNG_BYTES);
    // Hyperlink 不是附件
    expect(writes).toHaveLength(2);
  });

  test("relations 缺席且沒有內嵌圖時，回成功並說明沒有東西可下載", async () => {
    const { fetchFn } = makeFakeFetch([workItemResponse({})]);
    const { io, writes, dirs } = makeRecordingIo(fetchFn);
    const result = await downloadWorkItemAttachments(
      io,
      noAz,
      BUILT_IN_DEFAULTS,
      { workItemId: 5 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files).toEqual([]);
      expect(result.message).toContain("沒有內嵌圖片");
    }
    expect(writes).toHaveLength(0);
    expect(dirs).toHaveLength(0);
  });

  test("三個 HTML 欄位都掃，重複的 URL 只下載一次", async () => {
    const url = `${ORG}/_apis/wit/attachments/i?fileName=a.png`;
    const { fetchFn } = makeFakeFetch([
      workItemResponse({
        "System.Description": `<img src="${url}">`,
        "Microsoft.VSTS.Common.AcceptanceCriteria": `<img src="${url}">`,
        "Microsoft.VSTS.TCM.ReproSteps": `<img src="${ORG}/_apis/wit/attachments/j?fileName=b.png">`,
      }),
      binaryResponse(200, PNG_BYTES),
      binaryResponse(200, PNG_BYTES),
    ]);
    const { io, writes } = makeRecordingIo(fetchFn);
    await downloadWorkItemAttachments(io, noAz, BUILT_IN_DEFAULTS, {
      workItemId: 7
    });
    expect(writes.map((w) => path.basename(w.filePath))).toEqual([
      "a.png",
      "b.png",
    ]);
  });

  test("同名附件不互相覆蓋", async () => {
    const { fetchFn } = makeFakeFetch([
      workItemResponse({}, [
        {
          rel: "AttachedFile",
          url: `${ORG}/_apis/wit/attachments/1`,
          attributes: { name: "main.png" },
        },
        {
          rel: "AttachedFile",
          url: `${ORG}/_apis/wit/attachments/2`,
          attributes: { name: "main.png" },
        },
      ]),
      binaryResponse(200, PNG_BYTES),
      binaryResponse(200, PNG_BYTES),
    ]);
    const { io, writes } = makeRecordingIo(fetchFn);
    await downloadWorkItemAttachments(io, noAz, BUILT_IN_DEFAULTS, {
      workItemId: 7
    });
    expect(writes.map((w) => path.basename(w.filePath))).toEqual([
      "main.png",
      "main-2.png",
    ]);
  });

  test("單一檔案失敗不中斷其他檔案，記在 failures", async () => {
    const { fetchFn } = makeFakeFetch([
      workItemResponse({}, [
        {
          rel: "AttachedFile",
          url: `${ORG}/_apis/wit/attachments/1`,
          attributes: { name: "bad.png" },
        },
        {
          rel: "AttachedFile",
          url: `${ORG}/_apis/wit/attachments/2`,
          attributes: { name: "good.png" },
        },
      ]),
      binaryResponse(500, Buffer.from("boom")),
      binaryResponse(200, PNG_BYTES),
    ]);
    const { io, writes } = makeRecordingIo(fetchFn);
    const result = await downloadWorkItemAttachments(
      io,
      noAz,
      BUILT_IN_DEFAULTS,
      { workItemId: 7 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("bad.png");
      expect(result.files).toHaveLength(1);
    }
    expect(writes.map((w) => path.basename(w.filePath))).toEqual(["good.png"]);
  });

  test("認證失敗的 203 登入頁不會被寫成檔案", async () => {
    const { fetchFn } = makeFakeFetch([
      workItemResponse({}, [
        {
          rel: "AttachedFile",
          url: `${ORG}/_apis/wit/attachments/1`,
          attributes: { name: "shot.png" },
        },
      ]),
      binaryResponse(203, Buffer.from("<html>login</html>")),
    ]);
    const { io, writes } = makeRecordingIo(fetchFn);
    const result = await downloadWorkItemAttachments(
      io,
      noAz,
      BUILT_IN_DEFAULTS,
      { workItemId: 7 },
    );
    expect(writes).toHaveLength(0);
    if (result.ok) expect(result.failures[0]).toContain("az login");
  });

  test("relations 帶路徑穿越檔名時只取檔名", async () => {
    const { fetchFn } = makeFakeFetch([
      workItemResponse({}, [
        {
          rel: "AttachedFile",
          url: `${ORG}/_apis/wit/attachments/1`,
          attributes: { name: "..\\..\\evil.exe" },
        },
      ]),
      binaryResponse(200, Buffer.from("x")),
    ]);
    const { io, writes } = makeRecordingIo(fetchFn);
    await downloadWorkItemAttachments(io, noAz, BUILT_IN_DEFAULTS, {
      workItemId: 7
    });
    expect(path.basename(writes[0]?.filePath ?? "")).toBe("evil.exe");
    expect(writes[0]?.filePath).not.toContain("..");
  });

  test("附件 URL 指向別的網域時該檔失敗，其餘照常", async () => {
    const { fetchFn } = makeFakeFetch([
      workItemResponse({ "System.Description": '<img src="https://evil.test/_apis/wit/attachments/x">' }),
    ]);
    const { io, writes } = makeRecordingIo(fetchFn);
    const result = await downloadWorkItemAttachments(
      io,
      noAz,
      BUILT_IN_DEFAULTS,
      { workItemId: 7 },
    );
    expect(writes).toHaveLength(0);
    if (result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("拒絕下載");
    }
  });
});

describe("downloadAttachmentToDir", () => {
  test("落在 DOWNLOAD_ROOT/single 底下，檔名取自 URL", async () => {
    const { fetchFn } = makeFakeFetch([binaryResponse(200, PNG_BYTES)]);
    const { io, writes, dirs } = makeRecordingIo(fetchFn);
    const result = await downloadAttachmentToDir(
      io,
      noAz,
      BUILT_IN_DEFAULTS,
      {
        url: `${ORG}/_apis/wit/attachments/a?fileName=orig.png`,
      },
    );
    expect(result.ok).toBe(true);
    expect(dirs).toEqual([path.join(DOWNLOAD_ROOT, "single")]);
    expect(writes[0]?.filePath).toBe(
      path.join(DOWNLOAD_ROOT, "single", "orig.png"),
    );
    expect(writes[0]?.data).toEqual(PNG_BYTES);
  });

  test("沒給 fileName 時取 URL 的 fileName", async () => {
    const { fetchFn } = makeFakeFetch([binaryResponse(200, PNG_BYTES)]);
    const { io, writes } = makeRecordingIo(fetchFn);
    await downloadAttachmentToDir(io, noAz, BUILT_IN_DEFAULTS, {
      url: `${ORG}/_apis/wit/attachments/a?fileName=orig.png`
    });
    expect(path.basename(writes[0]?.filePath ?? "")).toBe("orig.png");
  });

  test("跨 origin 的 url 拒絕且不寫檔、不發請求", async () => {
    const { fetchFn, calls } = makeFakeFetch([]);
    const { io, writes } = makeRecordingIo(fetchFn);
    const result = await downloadAttachmentToDir(
      io,
      noAz,
      BUILT_IN_DEFAULTS,
      { url: "https://evil.test/steal" },
    );
    expect(result.ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("檔名落地到真實檔案系統（mock 的 writeFile 測不到這一層）", () => {
  test("清理後的檔名確實建立成檔案，內容不會被 NTFS data stream 吞掉", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ado-dl-"));
    try {
      // "report:v1.md" 未清理時，NTFS 會寫成 "report" 的 alternate data stream：
      // writeFile 不報錯，但目錄裡只剩 0 bytes 的 "report"
      for (const raw of ["report:v1.md", "a?b.png", "shot.png"]) {
        const name = safeFileName(raw, "fallback");
        const dest = path.join(dir, name);
        await fsp.writeFile(dest, Buffer.from("DATA"));
        expect((await fsp.stat(dest)).size).toBe(4);
      }
      expect((await fsp.readdir(dir)).sort()).toEqual([
        "a_b.png",
        "report_v1.md",
        "shot.png",
      ]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("下載位置由 server 決定", () => {
  test("路徑固定在系統暫存目錄，呼叫端無法指定", async () => {
    const { fetchFn } = makeFakeFetch([
      workItemResponse({}, [
        {
          rel: "AttachedFile",
          url: `${ORG}/_apis/wit/attachments/1`,
          attributes: { name: "a.md" },
        },
      ]),
      binaryResponse(200, Buffer.from("x")),
    ]);
    const { io, writes } = makeRecordingIo(fetchFn);
    await downloadWorkItemAttachments(io, noAz, BUILT_IN_DEFAULTS, {
      workItemId: 42,
    });
    const root = path.join(DOWNLOAD_ROOT, "workitem-42");
    expect(writes[0]?.filePath).toBe(path.join(root, "attachments", "a.md"));
    expect(DOWNLOAD_ROOT.startsWith(os.tmpdir())).toBe(true);
  });

  test("下載前先清空該 work item 的資料夾，舊檔不會殘留", async () => {
    const { fetchFn } = makeFakeFetch([workItemResponse({})]);
    const { io, removed } = makeRecordingIo(fetchFn);
    await downloadWorkItemAttachments(io, noAz, BUILT_IN_DEFAULTS, {
      workItemId: 42,
    });
    expect(removed).toEqual([path.join(DOWNLOAD_ROOT, "workitem-42")]);
  });

  test("清空失敗時整批中止，不會在殘留舊檔的情況下混入新檔", async () => {
    const { fetchFn } = makeFakeFetch([workItemResponse({})]);
    const { io, writes } = makeRecordingIo(fetchFn);
    io.rm = async () => {
      throw new Error("EBUSY");
    };
    const result = await downloadWorkItemAttachments(
      io,
      noAz,
      BUILT_IN_DEFAULTS,
      { workItemId: 42 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("清除舊下載資料夾失敗");
    expect(writes).toHaveLength(0);
  });
});

describe("url 模式的 fileName（只決定檔名，決定不了目錄）", () => {
  const singleDir = path.join(DOWNLOAD_ROOT, "single");

  async function runSingle(params: {
    url: string;
    fileName?: string;
  }): Promise<{ filePath: string | undefined }> {
    const { fetchFn } = makeFakeFetch([binaryResponse(200, PNG_BYTES)]);
    const { io, writes } = makeRecordingIo(fetchFn);
    await downloadAttachmentToDir(io, noAz, BUILT_IN_DEFAULTS, params);
    return { filePath: writes[0]?.filePath };
  }

  test("有給 fileName 時優先使用", async () => {
    const { filePath } = await runSingle({
      url: `${ORG}/_apis/wit/attachments/a?fileName=orig.png`,
      fileName: "design.md",
    });
    expect(filePath).toBe(path.join(singleDir, "design.md"));
  });

  test("沒給 fileName 時退回 URL 的 fileName", async () => {
    const { filePath } = await runSingle({
      url: `${ORG}/_apis/wit/attachments/a?fileName=orig.png`,
    });
    expect(filePath).toBe(path.join(singleDir, "orig.png"));
  });

  test("兩者都沒有時存成 attachment（relations 的 URL 就是這種）", async () => {
    const { filePath } = await runSingle({
      url: `${ORG}/_apis/wit/attachments/3636ff63-68b2-4951-ad24-4a5e14813c23`,
    });
    expect(filePath).toBe(path.join(singleDir, "attachment"));
  });

  test("fileName 帶路徑穿越時只取檔名，跳不出 single/", async () => {
    const { filePath } = await runSingle({
      url: `${ORG}/_apis/wit/attachments/a`,
      fileName: "..\\..\\..\\Windows\\System32\\evil.exe",
    });
    expect(filePath).toBe(path.join(singleDir, "evil.exe"));
    expect(filePath).not.toContain("..");
  });

  test("fileName 含 Windows 非法字元時一併清理", async () => {
    const { filePath } = await runSingle({
      url: `${ORG}/_apis/wit/attachments/a`,
      fileName: "report:v1.md",
    });
    expect(filePath).toBe(path.join(singleDir, "report_v1.md"));
  });

  test("fileName 是空白字串時視同未提供", async () => {
    const { filePath } = await runSingle({
      url: `${ORG}/_apis/wit/attachments/a?fileName=orig.png`,
      fileName: "   ",
    });
    expect(filePath).toBe(path.join(singleDir, "orig.png"));
  });
});
