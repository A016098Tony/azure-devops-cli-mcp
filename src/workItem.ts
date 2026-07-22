import type { execute } from "./executor.js";
import type { Defaults } from "./defaults.js";
import { adoRest, type RestIo, type RestOutcome } from "./rest.js";

export type FieldValue = string | number | boolean;

export interface WorkItemUpdateParams {
  workItemId: number;
  fields?: Record<string, FieldValue>;
  historyComment?: string;
}

// 欄位參考名稱如 System.State、Microsoft.VSTS.Common.Priority
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9.]*$/;

export function buildFieldPatch(
  fields: Record<string, FieldValue> | undefined,
  historyComment: string | undefined,
):
  | { ok: true; patch: Array<{ op: "add"; path: string; value: FieldValue }> }
  | { ok: false; error: string } {
  const patch: Array<{ op: "add"; path: string; value: FieldValue }> = [];
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (!FIELD_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error:
          `不合法的欄位名稱「${name}」。` +
          "請使用欄位參考名稱，例如 System.State、Microsoft.VSTS.Common.Priority。",
      };
    }
    patch.push({ op: "add", path: `/fields/${name}`, value });
  }
  if (historyComment !== undefined && historyComment.trim()) {
    patch.push({
      op: "add",
      path: "/fields/System.History",
      value: historyComment,
    });
  }
  if (patch.length === 0) {
    return {
      ok: false,
      error: "fields 與 historyComment 至少要提供一個。",
    };
  }
  return { ok: true, patch };
}

export function getWorkItemRelations(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  workItemId: number,
): Promise<RestOutcome> {
  return adoRest(io, executeFn, defaults, {
    method: "GET",
    path: `_apis/wit/workitems/${workItemId}?$expand=relations`,
  });
}

export function updateWorkItem(
  io: RestIo,
  executeFn: typeof execute,
  defaults: Defaults,
  params: WorkItemUpdateParams,
): Promise<RestOutcome> {
  const built = buildFieldPatch(params.fields, params.historyComment);
  if (!built.ok) return Promise.resolve(built);
  return adoRest(io, executeFn, defaults, {
    method: "PATCH",
    path: `_apis/wit/workitems/${params.workItemId}`,
    body: built.patch,
  });
}
