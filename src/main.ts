import * as dotenv from 'dotenv';
import { MCPHub } from './mcp-hub';
import { V2Orchestrator } from './orchestrator/loop-manager';
import { LLMConfig } from './agents/base-agent';
import path from 'path';

dotenv.config();

async function main() {
  const mcpHub = new MCPHub(path.join(process.cwd(), 'mcp-config.json'));
  await mcpHub.initialize();

  const modelConfig: LLMConfig = {
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: process.env.OPENAI_API_BASE || "https://api.openai.com/v1",
    model: process.env.OPENAI_MODEL || "gpt-4-turbo",
    modelId: process.env.OPENAI_MODEL || "gpt-4-turbo"
  };

  const orchestrator = new V2Orchestrator(modelConfig, mcpHub);

  console.log("\n🤖 Feishu Requirement to Code Agent [V2 Engine] Ready.");
  console.log("-----------------------------------------");
  
  const args = process.argv.slice(2);
  const userQuery = args[0];

  if (!userQuery) {
    console.log("Usage: npm run start \"Your instruction task manual\"");
    process.exit(0);
  }

  // CLI 注入监听，方便调试
  orchestrator.on("step-progress", (data: any) => {
    if (data.thought) console.log(`\n💭 Thought: ${data.thought.substring(0, 500)}...`);
    if (data.content) console.log(`\n✅ Progress: ${data.content}`);
  });

  orchestrator.on("workflow-complete", (data: any) => {
    console.log("\n🏁 Workflow Finished:", data.status);
    process.exit(0);
  });

  await orchestrator.runFullPipeline(userQuery);
}

main().catch(console.error);
