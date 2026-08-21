import { adoRest } from "./rest.js";
export function prBasePath(defaults, target) {
    const project = encodeURIComponent(target.project ?? defaults.project);
    const repository = encodeURIComponent(target.repository ?? defaults.repository);
    return `${project}/_apis/git/repositories/${repository}/pullRequests/${target.prNumber}`;
}
export function showPullRequest(io, executeFn, defaults, target) {
    return adoRest(io, executeFn, defaults, {
        method: "GET",
        path: prBasePath(defaults, target),
    });
}
export function listPullRequestWorkItems(io, executeFn, defaults, target) {
    return adoRest(io, executeFn, defaults, {
        method: "GET",
        path: `${prBasePath(defaults, target)}/workitems`,
    });
}
export async function getPullRequestChanges(io, executeFn, defaults, params) {
    const base = prBasePath(defaults, params);
    let iterationId = params.iterationId;
    if (iterationId === undefined) {
        const iterations = await adoRest(io, executeFn, defaults, {
            method: "GET",
            path: `${base}/iterations`,
        });
        if (!iterations.ok)
            return iterations;
        let ids;
        try {
            const parsed = JSON.parse(iterations.text);
            ids = (parsed.value ?? [])
                .map((it) => it.id)
                .filter((id) => typeof id === "number");
        }
        catch (error) {
            return {
                ok: false,
                error: `解析 iterations 回應失敗：${error.message}`,
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
    if (!changes.ok)
        return changes;
    return {
        ok: true,
        status: changes.status,
        text: `[iterationId: ${iterationId}]\n${changes.text}`,
    };
}
export function createPullRequestComment(io, executeFn, defaults, params) {
    if (!params.content.trim()) {
        return Promise.resolve({ ok: false, error: "content 不可為空。" });
    }
    const base = prBasePath(defaults, params);
    if (params.threadId !== undefined) {
        return adoRest(io, executeFn, defaults, {
            method: "POST",
            path: `${base}/threads/${params.threadId}/comments`,
            body: { content: params.content, parentCommentId: 0, commentType: 1 },
        });
    }
    if (params.line !== undefined && !params.filePath) {
        return Promise.resolve({
            ok: false,
            error: "指定 line 時必須同時提供 filePath。",
        });
    }
    const body = {
        comments: [
            { parentCommentId: 0, content: params.content, commentType: 1 },
        ],
        status: params.status ?? "active",
    };
    if (params.filePath) {
        const filePath = params.filePath.startsWith("/")
            ? params.filePath
            : `/${params.filePath}`;
        const threadContext = { filePath };
        if (params.line !== undefined) {
            threadContext.rightFileStart = { line: params.line, offset: 1 };
            threadContext.rightFileEnd = { line: params.line, offset: 1 };
        }
        body.threadContext = threadContext;
    }
    return adoRest(io, executeFn, defaults, {
        method: "POST",
        path: `${base}/threads`,
        body,
    });
}
