import * as fs from "fs";
import * as path from "path";
import { BaseAgent, LLMConfig } from "./base-agent";
import { MCPHub } from "../mcp-hub";
import { LLMMessage } from "../types";

/**
 * APIAgent 负责把 PRD 需求映射到接口能力。
 *
 * 输出重点不是“接口原文复述”，而是：
 * - 哪些 endpoint 与当前需求直接相关
 * - 这些接口会影响到哪些组件
 * - 是否有顺序、状态码、字段结构上的约束
 */
export class APIAgent extends BaseAgent {
  protected getExecutionPolicy() {
    return {
      displayPhase: "读取 API 文档",
      promptCharacterBudget: 24000,
    };
  }

  /**
   * 这里会把上一阶段的 PRD 结果压成简短摘要，作为 API 文档解析的先验上下文，
   * 避免模型在大段 API 正文中偏题。
   */
  public async execute(input: { prd: any, query?: string, apiUrl?: string, rawContent?: string, prdFocusContext?: string, gateFeedback?: string }, lessons: string, onThought?: (thought: string) => void): Promise<any> {
    const systemPrompt = `你是一位顶级架构师。你的目标是解析 API 文档，并将需求映射到具体的项目组件及接口中。
    
    1. **参考文档**: 你已经拥有了文档全文（见下方的“API 文档预读”）。你必须直接使用这些内容，**禁止**回复“无法访问飞书”或“没有文档”。
    2. **对齐逻辑**: 结合用户的原始指令以及 PRD 模块，找到对应的接口 Endpoint。
    3. **语言底线**: **必须始终使用中文进行思考 (Reasoning/Thought) 和回复**。禁止输出英文 Reasoning；如果 reasoning 字段出现英文，该回答视为无效，必须重写。
    4. **精准映射**: 特别注意用户在原始指令中提到的关键改动组件路径，确保将其包含在 \`component_impact\` 中。

    输出要求: 请输出合法的 JSON 格式：
    {
      "reasoning": "分析过程 (必须中文)",
      "api_mappings": [
        { "endpoint": "/api/v1/resource/detail", "method": "GET", "purpose": "获取当前页面所需的核心数据或状态" }
      ],
      "component_impact": ["具体组件路径1.vue", "具体组件路径2.js"],
      "constraints": ["字段/方法/交互/顺序上的接口约束"],
      "evidence_refs": ["文档中的接口段落、字段说明、状态码或调用规则锚点"]
    }
    `;

    // 额外把输入落到 harness，方便复盘“为什么这次 API 映射出了偏差”。
    const traceInput = { 
      prd: input.prd, 
      query: input.query,
      apiUrl: input.apiUrl,
      rawContent: input.rawContent?.length || 0 
    };
    fs.writeFileSync(path.join(process.cwd(), ".harness", "api_agent_input.json"), JSON.stringify(traceInput, null, 2));

    const compactPrd = {
      logic_rules: Array.isArray(input.prd?.logic_rules) ? input.prd.logic_rules.slice(0, 6) : [],
      placement_hints: Array.isArray(input.prd?.placement_hints) ? input.prd.placement_hints.slice(0, 6) : [],
      dependency_checks: Array.isArray(input.prd?.dependency_checks) ? input.prd.dependency_checks.slice(0, 6) : [],
      evidence_refs: Array.isArray(input.prd?.evidence_refs) ? input.prd.evidence_refs.slice(0, 6) : [],
    };

    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `这是我的原始需求描述：\n${input.query || ""}` },
      { role: "assistant", content: `好的。我已经拿到了结构化 PRD 线索，并会优先基于这些线索分析 API 文档。\nPRD 摘要：${JSON.stringify(compactPrd, null, 2)}\n${input.prdFocusContext ? `PRD 细节锚点：\n${input.prdFocusContext}` : ""}` },
      { role: "user", content: `${input.gateFeedback ? `本轮必须修复的结构化缺口：${input.gateFeedback}\n\n` : ""}这是 API 文档的正文（支持 10w 字符分析），请给出接口映射 JSON（必须包含所有必要的接口 Endpoint，并保留 evidence_refs）：\n\n${input.rawContent?.substring(0, 100000) || ""}` }
    ];

    return await this.callLLM(messages, onThought, []);
  }
}
