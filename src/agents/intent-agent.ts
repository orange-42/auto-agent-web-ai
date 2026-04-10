import { BaseAgent } from "./base-agent";

/**
 * IntentAgent: 意图解析与环境预检先锋。
 *
 * 它的唯一目标是把一段长提示拆成“可执行工作流上下文”：
 * - 项目根路径
 * - PRD / API 文档链接
 * - 目标路由
 * - 核心组件路径
 *
 * 这一步最重要的不是总结需求，而是先把“项目在哪里”锁准。
 */
export class IntentAgent extends BaseAgent {
  protected getExecutionPolicy() {
    return {
      displayPhase: "意图解析",
      promptCharacterBudget: 16000,
    };
  }

  /**
   * 这里刻意允许它用目录探测工具先验证路径。
   * 只有目录真实存在，后续所有阶段才值得继续。
   */
  public async execute(input: { prompt: string }, lessons: string, onThought?: (t: string) => void): Promise<any> {
    const systemPrompt = `你是一个具备深度语义理解和环境感知能力的架构师级意图解析器。

### 任务核心目标 ###
用户会给你一段复杂的“作战手册”或任务指令，你需要抽丝剥茧。你的第一个任务就是：
1. **项目路径**: 从文本中锁定本地代码库的【绝对路径】（例如 /Users/allen/...）。
2. **PRD/API 链接**: 提取所有的飞书文档链接。
3. **目标路由**: 提取用户明确指定的目标页面路由（如果有）。
4. **核心组件路径**: 提取用户明确指定的核心组件物理路径（如果有）。

### 🚨 验证逻辑 (强制执行) ###
- 如果你在文本中发现疑似“路径”的字符串，你【必须】立即调用 \`list_dir\` 进行实地探测。
- 如果 \`list_dir\` 报错（不存在），请继续在文本中寻找或提示用户路径错误。
- 只有成功 \`list_dir\` 出内容的目录，才是我们认定的 projectPath。

### 输出格式 ###
    你必须输出一个包含以下字段的 JSON 代码块：
    {
      "projectPath": "通过 list_dir 验证成功的绝对路径",
      "prdUrl": "主要的 PRD 链接",
      "apiUrl": "主要的接口链接",
      "targetRoute": "用户指定的目标路由，没有则为空字符串",
      "targetComponentPath": "用户指定的核心组件相对路径，没有则为空字符串",
      "taskObjective": "一句中文，概括这次最终要完成的开发目标",
      "confidence_flags": ["本轮解析中的置信提示或潜在不确定点"],
      "reasoning": "你是如何分析并验证这个路径的？"
    }`;

    // 配合目录探测工具进行“先验验证”，避免模型只靠文本臆断 projectPath。
    const res = await this.callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: `用户长文意图：\n\n${input.prompt}` }
    ], onThought, ["list_dir", "filesystem:list_dir", "filesystem:list_directory"], 15);

    // callLLM 如果已经识别出 JSON，会直接给我们对象。
    if (typeof res === 'object' && res !== null && !res.raw_content) {
      return { parsed: res, raw: JSON.stringify(res) };
    }

    // 兼容部分模型返回裸字符串的场景。
    const cleaned = this.cleanJson(res);
    try {
      const parsed = JSON.parse(cleaned);
      return { parsed, raw: res };
    } catch (e) {
      return { parsed: {}, raw: res };
    }
  }
}
