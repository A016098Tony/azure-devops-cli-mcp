import { describe, expect, test } from "vitest";
import {
  buildFieldPatch,
  getWorkItemRelations,
  updateWorkItem,
} from "../src/workItem.js";
import type { RestIo } from "../src/rest.js";
import { BUILT_IN_DEFAULTS } from "../src/defaults.js";
import type { ExecResult, ExecuteOptions } from "../src/executor.js";

const ORG = "https://dev.azure.com/SKMHHIS";

function noopExecutor(
  _commandLine: string,
  _options?: ExecuteOptions,
): Promise<ExecResult> {
  return Promise.resolve({ stdout: "", stderr: "", exitCode: 1, timedOut: false });
}

function makeIo(response: Response) {
  const requests: Array<{
    url: string;
    method: string | undefined;
    contentType: string | undefined;
    body: unknown;
  }> = [];
  const io: RestIo = {
    fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        url: String(url),
        method: init?.method,
        contentType: headers["Content-Type"],
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return response;
    }) as typeof fetch,
    env: { AZURE_DEVOPS_EXT_PAT: "pat" },
  };
  return { io, requests };
}

describe("buildFieldPatch", () => {
  test("fields 轉為 add 操作", () => {
    expect(
      buildFieldPatch({ "System.State": "Resolved", "System.Reason": "Fixed" }, undefined),
    ).toEqual({
      ok: true,
      patch: [
        { op: "add", path: "/fields/System.State", value: "Resolved" },
        { op: "add", path: "/fields/System.Reason", value: "Fixed" },
      ],
    });
  });

  test("historyComment 轉為 System.History", () => {
    expect(buildFieldPatch(undefined, "審查完成")).toEqual({
      ok: true,
      patch: [{ op: "add", path: "/fields/System.History", value: "審查完成" }],
    });
  });

  test("fields 與 historyComment 都沒有時拒絕", () => {
    const result = buildFieldPatch(undefined, undefined);
    expect(result.ok).toBe(false);
  });

  test("不合法的欄位名稱被拒絕（防 path 注入）", () => {
    for (const bad of ["System/State", "a b", "../x", "/fields/hack", ""]) {
      const result = buildFieldPatch({ [bad]: "v" }, undefined);
      expect(result.ok, `欄位 "${bad}" 應被拒絕`).toBe(false);
    }
  });
});

describe("getWorkItemRelations", () => {
  test("GET org 層級 workitems 帶 $expand=relations", async () => {
    const { io, requests } = makeIo(
      new Response('{"id":42,"relations":[]}', { status: 200 }),
    );
    const result = await getWorkItemRelations(io, noopExecutor, BUILT_IN_DEFAULTS, 42);
    expect(result.ok).toBe(true);
    expect(requests[0]?.url).toBe(
      `${ORG}/_apis/wit/workitems/42?$expand=relations&api-version=7.1`,
    );
    expect(requests[0]?.method).toBe("GET");
  });
});

describe("updateWorkItem", () => {
  test("PATCH json-patch body 與正確 Content-Type", async () => {
    const { io, requests } = makeIo(
      new Response('{"id":42,"rev":6}', { status: 200 }),
    );
    const result = await updateWorkItem(io, noopExecutor, BUILT_IN_DEFAULTS, {
      workItemId: 42,
      fields: { "System.State": "Resolved" },
      historyComment: "PR review 通過",
    });
    expect(result.ok).toBe(true);
    expect(requests[0]?.url).toBe(
      `${ORG}/_apis/wit/workitems/42?api-version=7.1`,
    );
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.contentType).toBe("application/json-patch+json");
    expect(requests[0]?.body).toEqual([
      { op: "add", path: "/fields/System.State", value: "Resolved" },
      { op: "add", path: "/fields/System.History", value: "PR review 通過" },
    ]);
  });

  test("patch 組合失敗時不發出請求", async () => {
    const { io, requests } = makeIo(new Response("{}", { status: 200 }));
    const result = await updateWorkItem(io, noopExecutor, BUILT_IN_DEFAULTS, {
      workItemId: 42,
    });
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});
