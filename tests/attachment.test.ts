import { describe, expect, test } from "vitest";
import {
  buildLinkPatchBody,
  buildLinkUrl,
  buildUploadUrl,
  MAX_ATTACHMENT_BYTES,
} from "../src/attachment.js";

describe("attachment URL 組裝", () => {
  test("buildUploadUrl 組出 attachments POST URL 並 encode 檔名", () => {
    expect(
      buildUploadUrl("https://dev.azure.com/SKMHHIS", "MS", "審查報告 v1.md"),
    ).toBe(
      "https://dev.azure.com/SKMHHIS/MS/_apis/wit/attachments" +
        "?fileName=%E5%AF%A9%E6%9F%A5%E5%A0%B1%E5%91%8A%20v1.md&api-version=7.1",
    );
  });

  test("buildUploadUrl 對 organization 尾端斜線與 project 特殊字元防禦", () => {
    expect(
      buildUploadUrl("https://dev.azure.com/SKMHHIS/", "My Project", "a.png"),
    ).toBe(
      "https://dev.azure.com/SKMHHIS/My%20Project/_apis/wit/attachments" +
        "?fileName=a.png&api-version=7.1",
    );
  });

  test("buildLinkUrl 組出 work item PATCH URL（org 層級、不含 project）", () => {
    expect(buildLinkUrl("https://dev.azure.com/SKMHHIS", 123)).toBe(
      "https://dev.azure.com/SKMHHIS/_apis/wit/workitems/123?api-version=7.1",
    );
  });
});

describe("buildLinkPatchBody", () => {
  test("含 comment 時帶 attributes", () => {
    expect(
      buildLinkPatchBody("https://dev.azure.com/x/_apis/wit/attachments/abc", "審查結果"),
    ).toEqual([
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "AttachedFile",
          url: "https://dev.azure.com/x/_apis/wit/attachments/abc",
          attributes: { comment: "審查結果" },
        },
      },
    ]);
  });

  test("無 comment 時省略 attributes", () => {
    const [op] = buildLinkPatchBody("https://example.test/a");
    expect(op.value).toEqual({
      rel: "AttachedFile",
      url: "https://example.test/a",
    });
  });
});

test("MAX_ATTACHMENT_BYTES 為 100MB", () => {
  expect(MAX_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
});
