import { BaseAgent, LLMConfig } from "./base-agent";
import { MCPHub } from "../mcp-hub";

export class PRDAgent extends BaseAgent {

  public async execute(input: { query: string, rawContent?: string, focusContext?: string, gateFeedback?: string }, lessons: string, onThought?: (t: string) => void): Promise<any> {
    
    const systemPrompt = `你是一位顶尖产品经理。你的任务是将飞书需求文档转化为结构化的功能描述。

    1. **参考文档**: 你已经拥有了文档全文（见下方的“预读”部分）。你必须直接解析这些文本，**不得**回复“无法访问外部链接”或“无法读取文档”。
       - 只要“预读”或“高优先级证据锚点”里出现任何正文、表格、截图旁文字、页面位置或业务描述，就视为文档已可解析。
       - **严禁**输出“需要调用工具重新抓取文档”“等待文档解析”“当前没有文档内容”“预读为空所以无法判断”之类的推脱性描述。
       - 即使文档片段不完整，也必须基于现有证据和用户目标产出**非空**的 “logic_rules”、“content_verified”、“placement_hints”。
    2. **模块分解**: 识别核心模块及对应的业务逻辑规则。
    3. **语言底线**: **必须始终使用中文进行思考 (Reasoning/Thought) 和最终的 JSON 回复**。严禁输出英文分析；如果 reasoning 字段出现英文，该回答视为无效，必须重写。
    4. **任务导向**: 重点提取与用户原始指令相关的逻辑规则。
    5. **细节优先**: 如果文档中存在“功能详述 / 原型 / 截图 / 表格 / 功能说明 / 字段说明 / 页面位置”等内容，你必须优先吸收这些细节，而不是只总结外层背景。
    6. **实现线索抽取**: 必须明确提取以下信息（如果文档中可见）：
       - 按钮或入口应放在哪个页面、哪个区域、哪个模块
       - 按钮文案、状态文案、交互触发条件
       - 原型图/截图对应的页面线索
       - 可能需要补齐的依赖项，例如权限码、配置项、枚举、状态字段、数据记录字段

    预期 JSON 结构:
    {
      "reasoning": "分析过程 (必须中文)",
      "modules": [{"name": "模块名", "desc": "核心职责"}],
      "logic_rules": ["业务规则1", "业务规则2"],
      "content_verified": "对文档核心内容的简短摘要",
      "ui_requirements": ["页面/按钮/状态/文案相关要求"],
      "placement_hints": ["功能入口或按钮放置位置"],
      "dependency_checks": ["实现前后必须确认的依赖项、权限项、字段项"],
      "evidence_refs": ["支撑上述结论的文档证据锚点，如表格行、功能详述、截图旁文字说明"]
    }

${lessons}
    `;

    const userPrompt = `指令：${input.query}

    分析要求补充：
    - 如果“功能概述”和“功能详述/表格/截图说明”之间存在信息层级差异，优先相信更具体的功能详述内容。
    - 如果文档给出了多个页面或模块，请明确区分“全局入口”“订单详情入口”“退款联动”“数据记录字段”等不同落点。
    - 如果文档出现截图列或原型列，即使图片本身不可见，也要根据相邻文字说明提取页面位置与交互变化。
    - evidence_refs 请尽量保留可回放的文字证据锚点，而不是只写抽象结论。
    - 如果下方给出了“高优先级证据锚点”，你必须优先相信这些证据，并把它们转成 placement_hints 与 evidence_refs。
    ${input.gateFeedback ? `- 本轮必须修复的结构化缺口：${input.gateFeedback}` : ""}

${input.focusContext ? `高优先级证据锚点：\n${input.focusContext}\n` : ""}
${input.rawContent ? `预读：\n${input.rawContent}` : ''}`;
    
    return await this.callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], onThought, []);
  }
}
