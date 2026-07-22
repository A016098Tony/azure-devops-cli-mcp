import { describe, expect, test } from "vitest";
import {
  adoRest,
  buildRestUrl,
  inferContentType,
  type RestIo,
} from "../src/rest.js";
import { BUILT_IN_DEFAULTS } from "../src/defaults.js";
import type { ExecResult, ExecuteOptions } from "../src/executor.js";

const ORG = "https://dev.azure.com/SKMHHIS";

function noopExecutor(
  _commandLine: string,
  _options?: ExecuteOptions,
): Promise<ExecResult> {
  return Promise.resolve({ stdout: "", stderr: "", exitCode: 1, timedOut: false });
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function makeIo(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  env: NodeJS.ProcessEnv = { AZURE_DEVOPS_EXT_PAT: "pat" },
) {
  const calls: FetchCall[] = [];
  const io: RestIo = {
    fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }) as typeof fetch,
    env,
  };
  return { io, calls };
}

describe("buildRestUrl", () => {
  test("無 query 時補 ?api-version=7.1", () => {
    expect(buildRestUrl(ORG, "MS/_apis/git/repositories/MS-Web/pullRequests/1")).toEqual({
      ok: true,
      url: `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/1?api-version=7.1`,
    });
  });

  test("已有 query 時用 & 補 api-version", () => {
    expect(buildRestUrl(ORG, "_apis/wit/workitems/9?$expand=relations")).toEqual({
      ok: true,
      url: `${ORG}/_apis/wit/workitems/9?$expand=relations&api-version=7.1`,
    });
  });

  test("已含 api-version 時不重複附加", () => {
    expect(buildRestUrl(ORG, "MS/_apis/x?api-version=7.2-preview")).toEqual({
      ok: true,
      url: `${ORG}/MS/_apis/x?api-version=7.2-preview`,
    });
  });

  test("去除 path 開頭的斜線與 organization 尾端斜線", () => {
    expect(buildRestUrl(`${ORG}/`, "/MS/_apis/x")).toEqual({
      ok: true,
      url: `${ORG}/MS/_apis/x?api-version=7.1`,
    });
  });

  test("拒絕絕對 URL", () => {
    const result = buildRestUrl(ORG, "https://evil.example.com/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("相對路徑");
  });

  test("拒絕 // 開頭（protocol-relative URL）", () => {
    expect(buildRestUrl(ORG, "//evil.example.com/x").ok).toBe(false);
  });

  test("拒絕路徑段中的 ..", () => {
    expect(buildRestUrl(ORG, "MS/../other/_apis/x").ok).toBe(false);
  });
});

describe("inferContentType", () => {
  test("PATCH 到 wit/workitems 用 json-patch+json", () => {
    expect(inferContentType("PATCH", "_apis/wit/workitems/9")).toBe(
      "application/json-patch+json",
    );
  });

  test("POST 用 application/json", () => {
    expect(
      inferContentType("POST", "MS/_apis/git/repositories/MS-Web/pullRequests/1/threads"),
    ).toBe("application/json");
  });

  test("PATCH 到非 workitems 端點用 application/json", () => {
    expect(inferContentType("PATCH", "MS/_apis/git/repositories/MS-Web/pullRequests/1")).toBe(
      "application/json",
    );
  });
});

describe("adoRest", () => {
  test("GET 成功回傳 status 與 text，帶 PAT Basic 認證", async () => {
    const { io, calls } = makeIo(() => new Response('{"id": 1}', { status: 200 }));
    const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "MS/_apis/x",
    });
    expect(result).toEqual({ ok: true, status: 200, text: '{"id": 1}' });
    expect(calls[0]?.url).toBe(`${ORG}/MS/_apis/x?api-version=7.1`);
    expect(calls[0]?.init?.method).toBe("GET");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(":pat").toString("base64")}`,
    );
    expect(headers["Content-Type"]).toBeUndefined();
  });

  test("無 PAT 時經 executor 取 token 用 Bearer", async () => {
    const executorCalls: string[] = [];
    const tokenExecutor = (
      commandLine: string,
      _options?: ExecuteOptions,
    ): Promise<ExecResult> => {
      executorCalls.push(commandLine);
      return Promise.resolve({
        stdout: "token123\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
    };
    const { io, calls } = makeIo(() => new Response("{}", { status: 200 }), {});
    const result = await adoRest(io, tokenExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "MS/_apis/x",
    });
    expect(result.ok).toBe(true);
    expect(executorCalls[0]).toContain("account get-access-token");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token123");
  });

  test("物件 body 序列化為 JSON 並帶推斷的 Content-Type", async () => {
    const { io, calls } = makeIo(() => new Response("{}", { status: 200 }));
    await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "PATCH",
      path: "_apis/wit/workitems/9",
      body: [{ op: "add", path: "/fields/System.State", value: "Resolved" }],
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json-patch+json");
    expect(calls[0]?.init?.body).toBe(
      '[{"op":"add","path":"/fields/System.State","value":"Resolved"}]',
    );
  });

  test("字串 body 原樣傳遞，contentType 可覆寫", async () => {
    const { io, calls } = makeIo(() => new Response("{}", { status: 200 }));
    await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "POST",
      path: "MS/_apis/x",
      body: '{"a":1}',
      contentType: "application/custom+json",
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/custom+json");
    expect(calls[0]?.init?.body).toBe('{"a":1}');
  });

  test("GET 帶 body 直接拒絕，不發出請求", async () => {
    const { io, calls } = makeIo(() => new Response("{}", { status: 200 }));
    const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "MS/_apis/x",
      body: "{}",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("GET");
    expect(calls).toHaveLength(0);
  });

  test("認證失敗（401/203）回傳認證提示", async () => {
    for (const status of [401, 203]) {
      const { io } = makeIo(() => new Response("denied", { status }));
      const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
        method: "GET",
        path: "MS/_apis/x",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("az login");
    }
  });

  test("404 回傳資源不存在", async () => {
    const { io } = makeIo(() => new Response("not found", { status: 404 }));
    const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "MS/_apis/x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("404");
  });

  test("其他非 2xx 回傳 HTTP 狀態與 body 片段", async () => {
    const { io } = makeIo(() => new Response("server broke", { status: 500 }));
    const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "MS/_apis/x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("500");
      expect(result.error).toContain("server broke");
    }
  });

  test("網路錯誤回傳錯誤訊息", async () => {
    const { io } = makeIo(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "MS/_apis/x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
  });

  test("path 不合法時不發出請求", async () => {
    const { io, calls } = makeIo(() => new Response("{}", { status: 200 }));
    const result = await adoRest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      method: "GET",
      path: "https://evil.example.com/x",
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
