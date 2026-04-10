import { BaseAgent, LLMConfig } from "./base-agent";
import { MCPHub } from "../mcp-hub";
import { summarizeText } from "../harness-logger";

export interface HermesEvolutionInput {
  workflowStatus: "success" | "error" | "aborted";
  finalMessage?: string;
  snapshot: {
    runId: string;
    mode: string;
    status: string;
    originalPrompt: string;
    model?: string;
    baseUrl?: string;
    projectPath?: string;
    targetRoute?: string;
    targetComponentPath?: string;
    taskObjective?: string;
  };
  phaseSummaries: Array<{
    stage: string;
    summary?: string;
    humanSummary?: string;
    error?: string;
  }>;
  signals: {
    latestError?: string;
    emptyResponseStages?: string[];
    repeatedReadStages?: string[];
    repeatedWriteStages?: string[];
    apiCoverageGaps?: string[];
    qaWarnings?: string[];
    stageRetries?: string[];
  };
}

/**
 * HermesAgent 是“赛后复盘器”。
 *
 * 它不参与主流程决策，也不回写代码；
 * 只在工作流结束后读取阶段摘要和异常信号，把它们提炼成 lessons，
 * 供后续 run 作为经验注入。
 */
export class HermesAgent extends BaseAgent {
  /**
   * 这里会把整次 run 压成一份可供复盘的 compactInput，
   * 避免把整个 debug snapshot 原封不动塞给模型造成噪声。
   */
  public async execute(
    input: HermesEvolutionInput,
    lessons: string = "",
    onThought?: (thought: string) => void,
  ): Promise<any> {
    const compactInput = {
      workflowStatus: input.workflowStatus,
      finalMessage: summarizeText(input.finalMessage || ""),
      snapshot: {
        ...input.snapshot,
        originalPrompt: summarizeText(input.snapshot.originalPrompt || ""),
      },
      phaseSummaries: Array.isArray(input.phaseSummaries) ? input.phaseSummaries.slice(0, 8) : [],
      signals: {
        latestError: summarizeText(input.signals?.latestError || ""),
        emptyResponseStages: Array.isArray(input.signals?.emptyResponseStages)
          ? input.signals.emptyResponseStages.slice(0, 6)
          : [],
        repeatedReadStages: Array.isArray(input.signals?.repeatedReadStages)
          ? input.signals.repeatedReadStages.slice(0, 6)
          : [],
        repeatedWriteStages: Array.isArray(input.signals?.repeatedWriteStages)
          ? input.signals.repeatedWriteStages.slice(0, 6)
          : [],
        apiCoverageGaps: Array.isArray(input.signals?.apiCoverageGaps)
          ? input.signals.apiCoverageGaps.slice(0, 6)
          : [],
        qaWarnings: Array.isArray(input.signals?.qaWarnings)
          ? input.signals.qaWarnings.slice(0, 8)
          : [],
        stageRetries: Array.isArray(input.signals?.stageRetries)
          ? input.signals.stageRetries.slice(0, 8)
          : [],
      },
    };

    const systemPrompt = `你是 Hermes Agent，负责在工作流结束后做“赛后复盘 + 自我进化提炼”。

你的职责不是重跑任务，而是把一次 run 的关键信号压缩成可复用的结构化经验，供下次任务直接引用。

硬性要求：
1. 必须始终使用中文进行 reasoning 和最终 JSON 输出。
2. 只保留高价值经验，最多输出 4 条 lessons；如果没有明显问题，也至少输出 1 条“成功模式”。
3. lesson 必须可执行，不能写成空话。例如要明确“在哪个阶段”“遇到什么信号”“下次怎么做”。
4. 如果 workflowStatus=error/aborted，优先提炼失败模式、根因和预防动作。
5. 如果 workflowStatus=success，优先提炼成功模式、稳定路径和可复用约束。

输出 JSON 契约：
{
  "reasoning": "中文复盘分析",
  "overall_grade": "S|A|F",
  "run_summary": "一句话总结本次 run 的成败与主要特征",
  "operator_notes": ["给操作者的短建议"],
  "lessons": [
    {
      "title": "经验标题",
      "stage": "INTENT|PRD|API|PLAN|CODING|VERIFY|SYSTEM",
      "applicable_stages": ["PLAN", "CODING"],
      "severity": "low|medium|high",
      "tags": ["关键词"],
      "context": "这条经验适用于什么场景",
      "lesson": "下次可直接注入 prompt 的短指令",
      "errorLog": "可选，核心异常或症状",
      "rootCause": "根因判断",
      "promptPatch": "建议注入给后续 agent 的提示补丁",
      "checklist": ["执行前/执行中检查项"]
    }
  ]
}

禁止输出 Markdown 报告或多余正文。`;

    const userPrompt = `请基于以下运行快照生成 Hermes 复盘结果：

${JSON.stringify(compactInput, null, 2)}

补充要求：
- 若发现“阶段识别到了能力，但后续规划/编码未覆盖”，要把它提炼为跨阶段经验。
- 若发现“模型空响应 / 重复读写 / 收敛保护 / QA 选错环境 / 反复重试”这类系统性信号，要明确指出触发阶段与改进建议。
- lessons 中的 lesson / promptPatch / checklist 必须短、硬、可直接复用。

${lessons}`;

    return this.callLLM(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      onThought,
      [],
      8,
    );
  }
}
