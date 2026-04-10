import * as dotenv from 'dotenv';
import { MCPHub } from './mcp-hub';
import { V2Orchestrator } from './orchestrator/loop-manager';
import { LLMConfig } from './agents/base-agent';
import path from 'path';

dotenv.config();

/**
 * CLI 入口。
 *
 * 相比 server.ts，这里没有 HTTP / SSE 层，适合本地快速单次调试。
 * 编排逻辑仍然完全复用 V2Orchestrator。
 */
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

  // CLI 模式下直接把阶段进度打印到 stdout，便于本地追踪。
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
