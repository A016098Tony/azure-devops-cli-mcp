import type { execute } from "./executor.js";
import type { Defaults } from "./defaults.js";
import {
  API_VERSION,
  AUTH_HINT,
  isAuthFailure,
  readBodySnippet,
  resolveAuthHeader,
} from "./auth.js";

export type RestMethod = "GET" | "POST" | "PATCH";

export interface RestIo {
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
}

export interface RestRequest {
  method: RestMethod;
  path: string;
  body?: unknown;
  contentType?: string;
  timeoutMs?: number;
}

export type RestOutcome =
  | { ok: true; status: number; text: string }
  | { ok: false; error: string };

const DEFAULT_REST_TIMEOUT_MS = 120_000;

export function buildRestUrl(
  organization: string,
  path: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = path.trim().replace(/^\/+/, "");
  if (/^https?:\/\//i.test(path.trim()) || path.trim().startsWith("//")) {
    return {
      ok: false,
      error:
        "path 必須是 organization 之後的相對路徑（例如 " +
        '"MS/_apis/git/repositories/MS-Web/pullRequests/1"），不可為絕對 URL。',
    };
  }
  const [pathPart] = trimmed.split("?");
  if (pathPart.split("/").some((segment) => segment === "..")) {
    return { ok: false, error: "path 不可包含路徑穿越（..）。" };
  }
  const base = organization.replace(/\/+$/, "");
  let url = `${base}/${trimmed}`;
  if (!/[?&]api-version=/.test(trimmed)) {
    url += (trimmed.includes("?") ? "&" : "?") + `api-version=${API_VERSION}`;
  }
  return { ok: true, url };
}

export function inferContentType(method: RestMethod, path: string): string {
  if (method === "PATCH" && path.includes("_apis/wit/workitems")) {
    return "application/json-patch+json";
  }
  return "application/json";
}

export async function adoRest(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  req: RestRequest,
): Promise<RestOutcome> {
  const built = buildRestUrl(defaults.organization, req.path);
  if (!built.ok) return built;
  if (req.method === "GET" && req.body !== undefined) {
    return { ok: false, error: "GET 請求不可帶 body。" };
  }

  const auth = await resolveAuthHeader(io.env, executeFn);
  if (!auth.ok) return { ok: false, error: auth.error };

  const headers: Record<string, string> = { Authorization: auth.header };
  let body: string | undefined;
  if (req.body !== undefined) {
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    headers["Content-Type"] =
      req.contentType ?? inferContentType(req.method, req.path);
  }

  let res: Response;
  try {
    res = await io.fetchFn(built.url, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_REST_TIMEOUT_MS),
    });
  } catch (error) {
    const err = error as Error;
    if (err.name === "TimeoutError") {
      return { ok: false, error: "REST 呼叫逾時，可調高 timeout 參數。" };
    }
    return { ok: false, error: `REST 呼叫網路錯誤：${err.message}` };
  }

  if (isAuthFailure(res.status)) return { ok: false, error: AUTH_HINT };
  if (res.status === 404) {
    return {
      ok: false,
      error: `資源不存在（HTTP 404）：${await readBodySnippet(res)}`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `REST 呼叫失敗（HTTP ${res.status}）：${await readBodySnippet(res)}`,
    };
  }
  return { ok: true, status: res.status, text: await res.text() };
}
