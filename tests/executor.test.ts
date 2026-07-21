import { describe, expect, test } from "vitest";
import { execute } from "../src/executor.js";

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
