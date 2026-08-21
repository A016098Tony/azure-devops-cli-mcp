import { adoRest } from "./rest.js";
// 欄位參考名稱如 System.State、Microsoft.VSTS.Common.Priority
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9.]*$/;
export function buildFieldPatch(fields, historyComment) {
    const patch = [];
    for (const [name, value] of Object.entries(fields ?? {})) {
        if (!FIELD_NAME_PATTERN.test(name)) {
            return {
                ok: false,
                error: `不合法的欄位名稱「${name}」。` +
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
export function getWorkItemRelations(io, executeFn, defaults, workItemId) {
    return adoRest(io, executeFn, defaults, {
        method: "GET",
        path: `_apis/wit/workitems/${workItemId}?$expand=relations`,
    });
}
export function updateWorkItem(io, executeFn, defaults, params) {
    const built = buildFieldPatch(params.fields, params.historyComment);
    if (!built.ok)
        return Promise.resolve(built);
    return adoRest(io, executeFn, defaults, {
        method: "PATCH",
        path: `_apis/wit/workitems/${params.workItemId}`,
        body: built.patch,
    });
}
