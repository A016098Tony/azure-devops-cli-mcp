import { describe, expect, test } from "vitest";
import {
  ALLOWED_GROUPS,
  OUTPUT_LIMIT,
  ensureJsonOutput,
  truncateOutput,
  validateScope,
} from "../src/command.js";

describe("validateScope", () => {
  test.each(["devops", "repos", "boards", "pipelines", "artifacts"])(
    "允許 %s 群組",
    (group) => {
      expect(validateScope(`${group} list`)).toEqual({ ok: true });
    },
  );

  test("拒絕群組以外的命令", () => {
    const result = validateScope("vm list");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("vm");
  });

  test("拒絕帶 az 前綴的命令並提示", () => {
    const result = validateScope("az repos list");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("az");
  });

  test("拒絕空字串", () => {
    expect(validateScope("").ok).toBe(false);
    expect(validateScope("   ").ok).toBe(false);
  });

  test("允許前後有空白的合法命令", () => {
    expect(validateScope("  repos pr list  ")).toEqual({ ok: true });
  });

  test("ALLOWED_GROUPS 恰為五個群組", () => {
    expect([...ALLOWED_GROUPS]).toEqual([
      "devops",
      "repos",
      "boards",
      "pipelines",
      "artifacts",
    ]);
  });
});

describe("ensureJsonOutput", () => {
  test("無輸出參數時附加 --output json", () => {
    expect(ensureJsonOutput("repos list")).toBe("repos list --output json");
  });

  test("已有 -o 時不附加", () => {
    expect(ensureJsonOutput("repos list -o table")).toBe("repos list -o table");
  });

  test("已有 --output 時不附加", () => {
    expect(ensureJsonOutput("repos list --output tsv")).toBe(
      "repos list --output tsv",
    );
  });

  test("已有 --output=json 形式時不附加", () => {
    expect(ensureJsonOutput("repos list --output=json")).toBe(
      "repos list --output=json",
    );
  });
});

describe("truncateOutput", () => {
  test("50KB 以內原樣回傳", () => {
    const text = "a".repeat(OUTPUT_LIMIT);
    expect(truncateOutput(text)).toBe(text);
  });

  test("超過 50KB 截斷並附提示", () => {
    const text = "a".repeat(OUTPUT_LIMIT + 1);
    const result = truncateOutput(text);
    expect(result.length).toBeLessThan(text.length + 200);
    expect(result).toContain("截斷");
    expect(result).toContain("--top");
  });
});
