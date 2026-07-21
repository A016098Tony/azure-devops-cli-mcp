export const ALLOWED_GROUPS = [
  "devops",
  "repos",
  "boards",
  "pipelines",
  "artifacts",
] as const;

export const OUTPUT_LIMIT = 50_000;

export function validateScope(
  command: string,
): { ok: true } | { ok: false; error: string } {
  const first = command.trim().split(/\s+/)[0] ?? "";
  if ((ALLOWED_GROUPS as readonly string[]).includes(first)) {
    return { ok: true };
  }
  const hint =
    first === "az"
      ? '命令請勿包含 "az" 前綴，直接以群組開頭，例如 "repos pr list"。'
      : "";
  return {
    ok: false,
    error:
      `不支援的命令群組「${first || "(空白)"}」。` +
      `僅允許：${ALLOWED_GROUPS.join("、")}。${hint}`,
  };
}

export function ensureJsonOutput(command: string): string {
  const tokens = command.split(/\s+/);
  const hasOutput = tokens.some(
    (t) => t === "-o" || t.startsWith("--output"),
  );
  return hasOutput ? command : `${command} --output json`;
}

export function truncateOutput(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return (
    text.slice(0, OUTPUT_LIMIT) +
    "\n\n[輸出已截斷：超過 50KB。請使用 --top、--query 或更嚴格的查詢條件縮小範圍。]"
  );
}
