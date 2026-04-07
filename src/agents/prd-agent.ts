import { BaseAgent, LLMConfig } from "./base-agent";
import { MCPHub } from "../mcp-hub";

export class PRDAgent extends BaseAgent {

  public async execute(input: { query: string, rawContent?: string }, lessons: string, onThought?: (t: string) => void): Promise<any> {
    
    const systemPrompt = `你是一位顶尖产品经理。你的任务是将飞书需求文档转化为结构化的功能描述。

    1. **参考文档**: 你已经拥有了文档全文（见下方的“预读”部分）。你必须直接解析这些文本，**不得**回复“无法访问外部链接”或“无法读取文档”。
    2. **模块分解**: 识别核心模块及对应的业务逻辑规则。
    3. **语言底线**: **必须始终使用中文进行思考 (Reasoning/Thought) 和最终的 JSON 回复**。严禁输出英文分析；如果 reasoning 字段出现英文，该回答视为无效，必须重写。
    4. **任务导向**: 重点提取与用户原始指令相关的逻辑规则。

    预期 JSON 结构:
    {
      "reasoning": "分析过程 (必须中文)",
      "modules": [{"name": "模块名", "desc": "核心职责"}],
      "logic_rules": ["业务规则1", "业务规则2"],
      "content_verified": "对文档核心内容的简短摘要"
    }

    ${lessons}
    `;

    const userPrompt = `指令：${input.query}\n\n${input.rawContent ? `预读：\n${input.rawContent}` : ''}`;
    
    return await this.callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], onThought, []);
  }
}
