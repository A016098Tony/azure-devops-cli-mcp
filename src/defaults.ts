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
