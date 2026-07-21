import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke-test", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({ command: "node", args: ["dist/index.js"] }),
);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

console.log("\n--- az_devops_help: repos pr list ---");
const help = await client.callTool({
  name: "az_devops_help",
  arguments: { command: "repos pr list" },
});
console.log("isError:", help.isError ?? false);
console.log(help.content[0].text.slice(0, 300));

console.log("\n--- az_devops: devops project list ---");
const projects = await client.callTool({
  name: "az_devops",
  arguments: { command: "devops project list" },
});
console.log("isError:", projects.isError ?? false);
console.log(projects.content[0].text.slice(0, 500));

console.log("\n--- az_devops: 範圍外命令（應拒絕）---");
const rejected = await client.callTool({
  name: "az_devops",
  arguments: { command: "account show" },
});
console.log("isError:", rejected.isError ?? false);
console.log(rejected.content[0].text);

await client.close();
process.exit(0);
