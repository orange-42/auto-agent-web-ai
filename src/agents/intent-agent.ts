import { BaseAgent } from "./base-agent";

/**
 * 🎨 IntentAgent: 意图解析与环境预检先锋
 * 负责解析长文本“作战手册”，提取项目路径、PRD、API。
 */
export class IntentAgent extends BaseAgent {
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

    // 🚀 第一步：调用 LLM，配合 list_dir 进行实地探测
    const res = await this.callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: `用户长文意图：\n\n${input.prompt}` }
    ], onThought, ["list_dir", "filesystem:list_dir", "filesystem:list_directory"], 15);

    // 💡 callLLM 内部如果识别到 JSON，会自动返回解析后的对象
    if (typeof res === 'object' && res !== null && !res.raw_content) {
      return { parsed: res, raw: JSON.stringify(res) };
    }

    // 如果返回的是字符串（兼容模式），则手动解析
    const cleaned = this.cleanJson(res);
    try {
      const parsed = JSON.parse(cleaned);
      return { parsed, raw: res };
    } catch (e) {
      return { parsed: {}, raw: res };
    }
  }
}
