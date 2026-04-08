import { BaseAgent, LLMConfig } from "./base-agent";
import { MCPHub } from "../mcp-hub";

export class QAAgent extends BaseAgent {

  public async execute(
    input: {
      baseUrl: string;
      targetRoute?: string;
      verificationPoints: string[];
      testCases?: Array<{
        name?: string;
        goal?: string;
        preconditions?: string[];
        steps?: string[];
        expected?: string[];
      }>;
      changedFiles?: string[];
      codingSummary?: string;
      targetComponentPath?: string;
      artifacts?: any;
    },
    lessons: string,
    onThought?: (thought: string) => void,
  ): Promise<any> {
    const structuredCases = Array.isArray(input.testCases) ? input.testCases.slice(0, 4) : [];
    const qaCases = Array.from(new Set(input.verificationPoints || [])).filter(Boolean).slice(0, 4);

    const systemPrompt = `你是一位轻量化 Web QA 工程师。你的目标是在尽量少的浏览器操作下，基于给定验证点完成自动化 UI 验证。

**1. 执行策略**
- 只验证最关键的 1-4 条验证点，禁止无限扩展测试范围。
- 优先使用只读验证：\`navigate_page\`、\`wait_for\`、\`take_snapshot\`、\`evaluate_script\`。
- 只有验证点明确要求用户交互时，才执行 \`click\`。
- 同一个页面优先复用，不要重复创建新页面。
- 如果目标路由包含动态参数且缺少真实参数，先打开站点根地址观察能否通过页面已有入口到达；如果无法可靠进入，明确标记为 \`skipped\`，不要盲目乱点。

**2. 成本控制**
- 严禁长时间探索页面结构。
- 截图/快照只在必要时调用，避免重复快照。
- 每完成一个验证点，就尽快收敛到结论，不要为了“更完整”继续做额外检查。

**3. 输出要求**
必须输出 JSON：
{
  "reasoning": "本轮如何执行验证、哪些验证点可测/不可测（必须中文）",
  "overall_status": "passed | failed | skipped",
  "tested_url": "实际测试页面 URL",
  "static_validation": ["进入 QA 前已经确认的静态校验结论"],
  "cases": [
    { "name": "验证点名称", "status": "passed | failed | skipped", "evidence": "关键证据或失败原因" }
  ],
  "blocked_reasons": ["若有无法测试的原因，列在这里"],
  "qa_summary": "一句话总结 QA 结果"
}

**4. 语言要求**
必须全过程使用中文进行思考和回复。`;

    const userPrompt = `【测试站点】: ${input.baseUrl}

【目标路由】: ${input.targetRoute || "未提供，优先从站点根路径开始"}

【核心组件】: ${input.targetComponentPath || "未提供"}

【结构化测试用例】:
${structuredCases.length > 0
  ? structuredCases.map((item, index) => [
      `${index + 1}. ${item?.name || item?.goal || `用例 ${index + 1}`}`,
      item?.goal ? `   目标：${item.goal}` : "",
      Array.isArray(item?.steps) && item.steps.length > 0 ? `   步骤：${item.steps.join("；")}` : "",
      Array.isArray(item?.expected) && item.expected.length > 0 ? `   预期：${item.expected.join("；")}` : "",
    ].filter(Boolean).join("\n")).join("\n")
  : "暂无结构化测试用例，将回退为轻量验证点执行。"}

【本轮验证点】:
${qaCases.length > 0 ? qaCases.map((item, index) => `${index + 1}. ${item}`).join("\n") : "暂无明确验证点，请优先验证页面是否可访问且核心入口是否存在。"}

【最近代码改动摘要】:
${input.codingSummary || "未提供"}

【阶段工件 - CodeArtifact】:
${JSON.stringify(input.artifacts?.code || {}, null, 2)}

【变更文件】:
${(input.changedFiles || []).join("\n") || "未提供"}

【执行要求】:
- 先打开站点并等待页面稳定。
- 优先验证最能代表本轮改动成败的用例。
- 如页面无法访问、路由无法到达、关键数据缺失，请明确给出 skipped 或 failed，不要编造通过结果。

${lessons}`;

    const toolPattern = [
      "chrome-devtools:new_page",
      "chrome-devtools:select_page",
      "chrome-devtools:navigate_page",
      "chrome-devtools:take_snapshot",
      "chrome-devtools:evaluate_script",
      "chrome-devtools:wait_for",
      "chrome-devtools:click",
    ];

    return await this.callLLM(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      onThought,
      toolPattern,
      8,
    );
  }
}
