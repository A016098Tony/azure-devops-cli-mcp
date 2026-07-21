import { parseArgs } from "node:util";

export interface Defaults {
  organization: string;
  project: string;
  repository: string;
}

export const BUILT_IN_DEFAULTS: Defaults = {
  organization: "https://dev.azure.com/SKMHHIS",
  project: "MS",
  repository: "MS-Web",
};

export function normalizeOrganization(value: string): string {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://dev.azure.com/${trimmed}`;
}

export function parseCliArgs(argv: string[]): Defaults {
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
    organization: normalizeOrganization(
      values.organization ?? BUILT_IN_DEFAULTS.organization,
    ),
    project: values.project ?? BUILT_IN_DEFAULTS.project,
    repository: values.repository ?? BUILT_IN_DEFAULTS.repository,
  };
}

export interface InjectedFlag {
  flag: "--organization" | "--project" | "--repository";
  value: string;
}

function tokensOutsideQuotes(command: string): string[] {
  return command
    .replace(/"[^"]*"/g, '""')
    .split(/\s+/)
    .filter(Boolean);
}

function hasFlag(tokens: string[], names: string[]): boolean {
  return tokens.some((t) => names.some((n) => t === n || t.startsWith(`${n}=`)));
}

export function planInjection(
  command: string,
  defaults: Defaults,
): InjectedFlag[] {
  const tokens = tokensOutsideQuotes(command.trim());
  if (tokens[0] === "devops" && tokens[1] === "configure") return [];
  const injected: InjectedFlag[] = [];
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

export function appendFlags(command: string, flags: InjectedFlag[]): string {
  let result = command;
  for (const { flag, value } of flags) {
    const quoted = /\s/.test(value) ? `"${value}"` : value;
    result += ` ${flag} ${quoted}`;
  }
  return result;
}
