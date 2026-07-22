import { describe, expect, test } from "vitest";
import {
  createPullRequestComment,
  getPullRequestChanges,
  listPullRequestWorkItems,
  prBasePath,
  showPullRequest,
} from "../src/pullRequest.js";
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

function makeIo(handlers: Array<(url: string) => Response>) {
  const urls: string[] = [];
  const io: RestIo = {
    fetchFn: (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      const handler = handlers.shift();
      if (!handler) throw new Error("unexpected extra fetch call");
      return handler(String(url));
    }) as typeof fetch,
    env: { AZURE_DEVOPS_EXT_PAT: "pat" },
  };
  return { io, urls };
}

describe("prBasePath", () => {
  test("預設 project/repository 並 encode", () => {
    expect(prBasePath(BUILT_IN_DEFAULTS, { prNumber: 104117 })).toBe(
      "MS/_apis/git/repositories/MS-Web/pullRequests/104117",
    );
  });

  test("可覆寫 project/repository", () => {
    expect(
      prBasePath(BUILT_IN_DEFAULTS, {
        prNumber: 5,
        project: "My Proj",
        repository: "R 2",
      }),
    ).toBe("My%20Proj/_apis/git/repositories/R%202/pullRequests/5");
  });
});

describe("showPullRequest", () => {
  test("GET PR 資訊", async () => {
    const { io, urls } = makeIo([
      () => new Response('{"pullRequestId":104117,"targetRefName":"refs/heads/master"}', { status: 200 }),
    ]);
    const result = await showPullRequest(io, noopExecutor, BUILT_IN_DEFAULTS, {
      prNumber: 104117,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain("targetRefName");
    expect(urls[0]).toBe(
      `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/104117?api-version=7.1`,
    );
  });
});

describe("listPullRequestWorkItems", () => {
  test("GET 關聯 work items", async () => {
    const { io, urls } = makeIo([
      () => new Response('{"count":1,"value":[{"id":"42"}]}', { status: 200 }),
    ]);
    const result = await listPullRequestWorkItems(io, noopExecutor, BUILT_IN_DEFAULTS, {
      prNumber: 104117,
    });
    expect(result.ok).toBe(true);
    expect(urls[0]).toBe(
      `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/104117/workitems?api-version=7.1`,
    );
  });
});

describe("getPullRequestChanges", () => {
  test("未指定 iteration 時先取最新 iteration 再取 changes", async () => {
    const { io, urls } = makeIo([
      () =>
        new Response('{"count":2,"value":[{"id":1},{"id":2}]}', { status: 200 }),
      () =>
        new Response('{"changeEntries":[{"item":{"path":"/a.cs"}}]}', {
          status: 200,
        }),
    ]);
    const result = await getPullRequestChanges(io, noopExecutor, BUILT_IN_DEFAULTS, {
      prNumber: 104117,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("[iterationId: 2]");
      expect(result.text).toContain("changeEntries");
    }
    expect(urls[0]).toBe(
      `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/104117/iterations?api-version=7.1`,
    );
    expect(urls[1]).toBe(
      `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/104117/iterations/2/changes?api-version=7.1`,
    );
  });

  test("指定 iterationId 時直接取 changes", async () => {
    const { io, urls } = makeIo([
      () => new Response('{"changeEntries":[]}', { status: 200 }),
    ]);
    const result = await getPullRequestChanges(io, noopExecutor, BUILT_IN_DEFAULTS, {
      prNumber: 104117,
      iterationId: 3,
    });
    expect(result.ok).toBe(true);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/iterations/3/changes");
  });

  test("iterations 為空時回傳明確錯誤", async () => {
    const { io } = makeIo([
      () => new Response('{"count":0,"value":[]}', { status: 200 }),
    ]);
    const result = await getPullRequestChanges(io, noopExecutor, BUILT_IN_DEFAULTS, {
      prNumber: 104117,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("iteration");
  });

  test("iterations 呼叫失敗時直接回傳該錯誤", async () => {
    const { io } = makeIo([() => new Response("nope", { status: 404 })]);
    const result = await getPullRequestChanges(io, noopExecutor, BUILT_IN_DEFAULTS, {
      prNumber: 99999,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("404");
  });
});

describe("createPullRequestComment", () => {
  function makeBodyCapturingIo() {
    const requests: Array<{ url: string; body: unknown }> = [];
    const io: RestIo = {
      fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response('{"id":148}', { status: 200 });
      }) as typeof fetch,
      env: { AZURE_DEVOPS_EXT_PAT: "pat" },
    };
    return { io, requests };
  }

  test("無 threadId 時 POST 新 thread，預設 status active", async () => {
    const { io, requests } = makeBodyCapturingIo();
    const result = await createPullRequestComment(
      io, noopExecutor, BUILT_IN_DEFAULTS,
      { prNumber: 104117, content: "看起來不錯" },
    );
    expect(result.ok).toBe(true);
    expect(requests[0]?.url).toBe(
      `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/104117/threads?api-version=7.1`,
    );
    expect(requests[0]?.body).toEqual({
      comments: [{ parentCommentId: 0, content: "看起來不錯", commentType: 1 }],
      status: "active",
    });
  });

  test("帶 filePath 與 line 時組出 threadContext（filePath 自動補 /）", async () => {
    const { io, requests } = makeBodyCapturingIo();
    await createPullRequestComment(
      io, noopExecutor, BUILT_IN_DEFAULTS,
      { prNumber: 1, content: "c", filePath: "src/a.cs", line: 5 },
    );
    expect(requests[0]?.body).toEqual({
      comments: [{ parentCommentId: 0, content: "c", commentType: 1 }],
      status: "active",
      threadContext: {
        filePath: "/src/a.cs",
        rightFileStart: { line: 5, offset: 1 },
        rightFileEnd: { line: 5, offset: 1 },
      },
    });
  });

  test("有 threadId 時 POST 回覆到該 thread", async () => {
    const { io, requests } = makeBodyCapturingIo();
    await createPullRequestComment(
      io, noopExecutor, BUILT_IN_DEFAULTS,
      { prNumber: 1, content: "回覆", threadId: 148 },
    );
    expect(requests[0]?.url).toBe(
      `${ORG}/MS/_apis/git/repositories/MS-Web/pullRequests/1/threads/148/comments?api-version=7.1`,
    );
    expect(requests[0]?.body).toEqual({
      content: "回覆",
      parentCommentId: 0,
      commentType: 1,
    });
  });

  test("content 空白時拒絕", async () => {
    const { io, requests } = makeBodyCapturingIo();
    const result = await createPullRequestComment(
      io, noopExecutor, BUILT_IN_DEFAULTS,
      { prNumber: 1, content: "   " },
    );
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  test("只給 line 沒給 filePath 時拒絕", async () => {
    const { io, requests } = makeBodyCapturingIo();
    const result = await createPullRequestComment(
      io, noopExecutor, BUILT_IN_DEFAULTS,
      { prNumber: 1, content: "c", line: 5 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("filePath");
    expect(requests).toHaveLength(0);
  });
});
