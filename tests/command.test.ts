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

  test("拒絕以 & 串接的命令（shell 注入）", () => {
    const result = validateScope("repos list & echo PWNED");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("特殊字元");
  });

  test.each(["|", ";", "<", ">", "(", ")", "`", "^"])(
    "拒絕引號外的 shell 特殊字元 %s",
    (meta) => {
      expect(validateScope(`repos list ${meta} more`).ok).toBe(false);
    },
  );

  test("拒絕含換行的命令", () => {
    expect(validateScope("repos list\ndel x").ok).toBe(false);
  });

  test("允許特殊字元位於雙引號內的 WIQL 查詢", () => {
    expect(
      validateScope(
        `boards query --wiql "SELECT [System.Id] FROM WorkItems WHERE [System.State] <> 'Active'"`,
      ),
    ).toEqual({ ok: true });
  });

  test("允許 --query 內含 JMESPath pipe（雙引號內）", () => {
    expect(
      validateScope(`repos pr list --query "[?isDraft] | [0]"`),
    ).toEqual({ ok: true });
  });

  test("拒絕未配對的雙引號", () => {
    const result = validateScope(`repos show --query "abc`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("引號");
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
