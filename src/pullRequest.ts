import type { execute } from "./executor.js";
import type { Defaults } from "./defaults.js";
import { adoRest, type RestIo, type RestOutcome } from "./rest.js";

export interface PrTarget {
  prNumber: number;
  project?: string;
  repository?: string;
}

export function prBasePath(defaults: Defaults, target: PrTarget): string {
  const project = encodeURIComponent(target.project ?? defaults.project);
  const repository = encodeURIComponent(
    target.repository ?? defaults.repository,
  );
  return `${project}/_apis/git/repositories/${repository}/pullRequests/${target.prNumber}`;
}

export function showPullRequest(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  target: PrTarget,
): Promise<RestOutcome> {
  return adoRest(io, executeFn, defaults, {
    method: "GET",
    path: prBasePath(defaults, target),
  });
}

export function listPullRequestWorkItems(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  target: PrTarget,
): Promise<RestOutcome> {
  return adoRest(io, executeFn, defaults, {
    method: "GET",
    path: `${prBasePath(defaults, target)}/workitems`,
  });
}

export async function getPullRequestChanges(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  params: PrTarget & { iterationId?: number },
): Promise<RestOutcome> {
  const base = prBasePath(defaults, params);
  let iterationId = params.iterationId;
  if (iterationId === undefined) {
    const iterations = await adoRest(io, executeFn, defaults, {
      method: "GET",
      path: `${base}/iterations`,
    });
    if (!iterations.ok) return iterations;
    let ids: number[];
    try {
      const parsed = JSON.parse(iterations.text) as {
        value?: Array<{ id?: number }>;
      };
      ids = (parsed.value ?? [])
        .map((it) => it.id)
        .filter((id): id is number => typeof id === "number");
    } catch (error) {
      return {
        ok: false,
        error: `解析 iterations 回應失敗：${(error as Error).message}`,
      };
    }
    if (ids.length === 0) {
      return { ok: false, error: "此 PR 沒有任何 iteration，無法取得變更。" };
    }
    iterationId = Math.max(...ids);
  }
  const changes = await adoRest(io, executeFn, defaults, {
    method: "GET",
    path: `${base}/iterations/${iterationId}/changes`,
  });
  if (!changes.ok) return changes;
  return {
    ok: true,
    status: changes.status,
    text: `[iterationId: ${iterationId}]\n${changes.text}`,
  };
}
