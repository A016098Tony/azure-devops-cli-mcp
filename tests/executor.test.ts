import { afterEach, describe, expect, test } from "vitest";
import {
  acpToEncoding,
  decodeOutput,
  execute,
} from "../src/executor.js";

// 「公文」的 Big5（cp950）位元組，與 UTF-8 的 e5 85 ac e6 96 87 不同
const BIG5_GONG_WEN = Uint8Array.from([0xa4, 0xbd, 0xa4, 0xe5]);

describe("acpToEncoding", () => {
  test.each([
    [950, "big5"],
    [936, "gbk"],
    [932, "shift_jis"],
    [949, "euc-kr"],
    [874, "windows-874"],
    [1252, "windows-1252"],
    [65001, "utf-8"],
  ])("ACP %i 對應 %s", (acp, expected) => {
    expect(acpToEncoding(acp)).toBe(expected);
  });

  test("未知或缺少的 ACP 退回 utf-8", () => {
    expect(acpToEncoding(undefined)).toBe("utf-8");
    expect(acpToEncoding(99999)).toBe("utf-8");
  });
});

describe("decodeOutput", () => {
  test("合法 UTF-8 原樣通過，且不查詢備援編碼", () => {
    let consulted = false;
    const text = decodeOutput(Buffer.from("公文 ok", "utf8"), () => {
      consulted = true;
      return "big5";
    });
    expect(text).toBe("公文 ok");
    expect(consulted).toBe(false);
  });

  test("純 ASCII 不查詢備援編碼", () => {
    let consulted = false;
    const text = decodeOutput(Buffer.from("plain ascii"), () => {
      consulted = true;
      return "big5";
    });
    expect(text).toBe("plain ascii");
    expect(consulted).toBe(false);
  });

  test("非 UTF-8 的 Big5 位元組以備援編碼解碼", () => {
    expect(decodeOutput(BIG5_GONG_WEN, () => "big5")).toBe("公文");
  });

  test("備援編碼名稱無效時退回 UTF-8 而不崩潰", () => {
    const text = decodeOutput(BIG5_GONG_WEN, () => "not-a-real-label");
    expect(text).toContain("�");
  });

  test("空輸出回傳空字串", () => {
    expect(decodeOutput(Buffer.alloc(0), () => "big5")).toBe("");
  });
});

describe("execute 的輸出解碼", () => {
  const original = process.env.AZ_OUTPUT_ENCODING;
  afterEach(() => {
    if (original === undefined) delete process.env.AZ_OUTPUT_ENCODING;
    else process.env.AZ_OUTPUT_ENCODING = original;
  });

  test("UTF-8 的中文 stdout 不亂碼", async () => {
    const result = await execute(
      '-e "process.stdout.write(Buffer.from([0xe5,0x85,0xac,0xe6,0x96,0x87]))"',
      { baseCommand: "node" },
    );
    expect(result.stdout).toBe("公文");
  });

  test("Big5 的 stdout 依 AZ_OUTPUT_ENCODING 解碼", async () => {
    process.env.AZ_OUTPUT_ENCODING = "big5";
    const result = await execute(
      '-e "process.stdout.write(Buffer.from([0xa4,0xbd,0xa4,0xe5]))"',
      { baseCommand: "node" },
    );
    expect(result.stdout).toBe("公文");
  });

  test("Big5 的 stderr 同樣被解碼", async () => {
    process.env.AZ_OUTPUT_ENCODING = "big5";
    const result = await execute(
      '-e "process.stderr.write(Buffer.from([0xa4,0xbd,0xa4,0xe5]));process.exit(2)"',
      { baseCommand: "node" },
    );
    expect(result.stderr).toBe("公文");
    expect(result.exitCode).toBe(2);
  });
});

describe("execute", () => {
  test("回傳 stdout 與結束碼 0", async () => {
    const result = await execute("hello", { baseCommand: "cmd /c echo" });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("非零結束碼被保留", async () => {
    const result = await execute("3", { baseCommand: "cmd /c exit" });
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  test("逾時會終止子程序並標記 timedOut", async () => {
    const result = await execute('-e "setTimeout(() => {}, 10000)"', {
      baseCommand: "node",
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
  }, 10_000);

  test("找不到執行檔時回傳非零結束碼", async () => {
    const result = await execute("whatever", {
      baseCommand: "definitely-not-a-real-command-12345",
    });
    expect(result.exitCode).not.toBe(0);
  });
});
