#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseCliArgs, type Defaults } from "./defaults.js";
import { execute } from "./executor.js";
import { createServer } from "./server.js";

let defaults: Defaults;
try {
  defaults = parseCliArgs(process.argv.slice(2));
} catch (error) {
  console.error(`啟動參數錯誤：${(error as Error).message}`);
  console.error(
    "用法：azure-devops-cli-mcp [--organization <URL或短名>] [--project <名稱>] [--repository <名稱>]",
  );
  process.exit(1);
}

const server = createServer(execute, defaults);
await server.connect(new StdioServerTransport());
console.error(
  `azure-devops-cli-mcp server running on stdio ` +
    `(organization=${defaults.organization}, project=${defaults.project}, repository=${defaults.repository})`,
);
