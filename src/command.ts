export const ALLOWED_GROUPS = [
  "devops",
  "repos",
  "boards",
  "pipelines",
  "artifacts",
] as const;

export const OUTPUT_LIMIT = 50_000;

// cmd.exe / shell 控制字元。命令會經由 shell 執行，若這些字元出現在雙引號外，
// 可串接或改寫成其他命令，繞過群組限制（等同注入）。含特殊字元的參數值請用雙引號包起來。
const SHELL_METACHARACTERS = /[&|;<>()`^\r\n]/;

export function validateScope(
  command: string,
): { ok: true } | { ok: false; error: string } {
  const trimmed = command.trim();
  const first = trimmed.split(/\s+/)[0] ?? "";
  if (!(ALLOWED_GROUPS as readonly string[]).includes(first)) {
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
  if ((trimmed.match(/"/g)?.length ?? 0) % 2 !== 0) {
    return {
      ok: false,
      error: "命令含有未配對的雙引號，基於安全考量已拒絕。",
    };
  }
  const outsideQuotes = trimmed.replace(/"[^"]*"/g, "");
  if (SHELL_METACHARACTERS.test(outsideQuotes)) {
    return {
      ok: false,
      error:
        "命令在雙引號外含有 shell 特殊字元（& | ; < > ( ) ` ^ 或換行），基於安全考量已拒絕。" +
        "若這些字元是參數值的一部分（例如 WIQL 或 --query），請用雙引號將該值包起來。",
    };
  }
  return { ok: true };
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
