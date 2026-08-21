import { parseArgs } from "node:util";
export const BUILT_IN_DEFAULTS = {
    organization: "https://dev.azure.com/SKMHHIS",
    project: "MS",
    repository: "MS-Web",
};
export function normalizeOrganization(value) {
    const trimmed = value.trim();
    return /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `https://dev.azure.com/${trimmed}`;
}
export function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            organization: { type: "string" },
            project: { type: "string" },
            repository: { type: "string" },
        },
        strict: true,
    });
    return {
        organization: normalizeOrganization(values.organization ?? BUILT_IN_DEFAULTS.organization),
        project: values.project ?? BUILT_IN_DEFAULTS.project,
        repository: values.repository ?? BUILT_IN_DEFAULTS.repository,
    };
}
function tokensOutsideQuotes(command) {
    return command
        .replace(/"[^"]*"/g, '""')
        .split(/\s+/)
        .filter(Boolean);
}
function hasFlag(tokens, names) {
    return tokens.some((t) => names.some((n) => t === n || t.startsWith(`${n}=`)));
}
export function planInjection(command, defaults) {
    const tokens = tokensOutsideQuotes(command.trim());
    if (tokens[0] === "devops" && tokens[1] === "configure")
        return [];
    const injected = [];
    if (!hasFlag(tokens, ["--organization", "--org"])) {
        injected.push({ flag: "--organization", value: defaults.organization });
    }
    if (!hasFlag(tokens, ["--project", "-p"])) {
        injected.push({ flag: "--project", value: defaults.project });
    }
    const isReposPr = tokens[0] === "repos" && tokens[1] === "pr";
    if (isReposPr && !hasFlag(tokens, ["--repository", "-r"])) {
        injected.push({ flag: "--repository", value: defaults.repository });
    }
    return injected;
}
export function appendFlags(command, flags) {
    let result = command;
    for (const { flag, value } of flags) {
        const quoted = /\s/.test(value) ? `"${value}"` : value;
        result += ` ${flag} ${quoted}`;
    }
    return result;
}
