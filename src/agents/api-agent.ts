import * as fs from "fs";
import * as path from "path";
import { BaseAgent, LLMConfig } from "./base-agent";
import { MCPHub } from "../mcp-hub";
import { LLMMessage } from "../types";

export class APIAgent extends BaseAgent {

  public async execute(input: { prd: any, query?: string, apiUrl?: string, rawContent?: string }, lessons: string, onThought?: (thought: string) => void): Promise<any> {
    const systemPrompt = `你是一位顶级架构师。你的目标是解析 API 文档，并将需求映射到具体的项目组件及接口中。
    
    1. **参考文档**: 你已经拥有了文档全文（见下方的“API 文档预读”）。你必须直接使用这些内容，**禁止**回复“无法访问飞书”或“没有文档”。
    2. **对齐逻辑**: 结合用户的原始指令以及 PRD 模块，找到对应的接口 Endpoint。
    3. **语言底线**: **必须始终使用中文进行思考 (Reasoning/Thought) 和回复**。禁止输出英文 Reasoning；如果 reasoning 字段出现英文，该回答视为无效，必须重写。
    4. **精准映射**: 特别注意用户在原始指令中提到的关键改动组件路径，确保将其包含在 \`component_impact\` 中。

    输出要求: 请输出合法的 JSON 格式：
    {
      "reasoning": "分析过程 (必须中文)",
      "api_mappings": [
        { "endpoint": "/api/v1/order/lock", "method": "POST", "purpose": "锁定订单状态" }
      ],
      "component_impact": ["具体组件路径1.vue", "具体组件路径2.js"]
    }
    `;

    // 💡 策略性加固：将 PRD 结果伪装成“上一轮的回答”，而不是堆死在 User Prompt 里
    // 这能有效防止模型在解析嵌套 JSON 字符串时产生逻辑死锁
    const traceInput = { 
      prd: input.prd, 
      query: input.query,
      apiUrl: input.apiUrl,
      rawContent: input.rawContent?.length || 0 
    };
    fs.writeFileSync(path.join(process.cwd(), ".harness", "api_agent_input.json"), JSON.stringify(traceInput, null, 2));

    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `这是我的原始需求描述：\n${input.query || ""}` },
      { role: "assistant", content: `好的。我已经解析完 PRD 文档。核心模块: ${input.prd.modules.map((m: any) => m.name).join(", ")}。逻辑规则: ${input.prd.logic_rules.length} 条。我已经准备好基于这些需求分析 API 文档并给出接口映射 JSON。` },
      { role: "user", content: `这是 API 文档的正文（支持 10w 字符分析），请给出接口映射 JSON（必须包含所有必要的接口 Endpoint）：\n\n${input.rawContent?.substring(0, 100000) || ""}` }
    ];

    return await this.callLLM(messages, onThought, []);
  }
}
