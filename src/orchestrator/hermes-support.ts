import {
  ApiArtifact,
  PlanArtifact,
  VerifyArtifact,
} from "../phase-artifacts";
import {
  summarizeText,
} from "../harness-logger";
import { HermesEvolutionInput } from "../agents";
import {
  DebugRunSnapshot,
  ReplayStageName,
} from "../debug-run-store";
import {
  HermesEvolutionReport,
  LessonQuery,
  LessonStage,
} from "../harness/lesson-rag";

function normalizeHermesGrade(
  status: "success" | "error" | "aborted",
  value?: unknown,
): "S" | "A" | "F" {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "S" || normalized === "A" || normalized === "F") return normalized;
  if (status === "success") return "S";
  if (status === "aborted") return "A";
  return "F";
}

function normalizeHermesStage(value: unknown): LessonStage {
  const normalized = String(value || "").trim().toUpperCase() as LessonStage;
  return ["INTENT", "PRD", "API", "PLAN", "CODING", "VERIFY", "SYSTEM"].includes(normalized)
    ? normalized
    : "SYSTEM";
}

function normalizeHermesStages(value: unknown): LessonStage[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => normalizeHermesStage(item))
        .filter(Boolean),
    ),
  );
}

function normalizeHermesSeverity(value: unknown, grade: "S" | "A" | "F"): "low" | "medium" | "high" {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
  if (grade === "F") return "high";
  if (grade === "A") return "medium";
  return "low";
}

/**
 * 汇总各阶段摘要，作为 Hermes 赛后复盘的主要输入。
 */
export function buildHermesPhaseSummaries(params: {
  debugSnapshot: DebugRunSnapshot | null;
  artifactSummaryByStage: Partial<Record<ReplayStageName, string>>;
  getLatestStageError: (stage: ReplayStageName) => string;
}): HermesEvolutionInput["phaseSummaries"] {
  const phases: ReplayStageName[] = ["INTENT", "PRD", "API", "PLAN", "CODING", "VERIFY"];
  return phases
    .map((stage) => {
      const stageRecord = params.debugSnapshot?.stages?.[stage];
      const artifactSummary = params.artifactSummaryByStage[stage] || "";
      const humanSummary = stageRecord?.human_summary || artifactSummary || "";
      const error = params.getLatestStageError(stage);
      if (!stageRecord && !artifactSummary && !error) return null;
      return {
        stage,
        summary: artifactSummary || humanSummary,
        humanSummary,
        error: error || undefined,
      };
    })
    .filter(Boolean) as HermesEvolutionInput["phaseSummaries"];
}

/**
 * 从 workflow 日志、验证产物和计划覆盖情况里抽取系统级异常信号。
 *
 * 这一步相当于给 Hermes 一个“现成的侦察报告”，
 * 让它不用从整份原始日志里自己猜哪里出了问题。
 */
export function buildHermesSignalSummary(params: {
  workflowEntries: Array<Record<string, unknown>>;
  debugSnapshot: DebugRunSnapshot | null;
  finalMessage?: string;
  apiCoverageGaps: string[];
  verifyArtifact?: VerifyArtifact | null;
  getLatestStageError: (stage: ReplayStageName) => string;
}): HermesEvolutionInput["signals"] {
  const progressEntries = params.workflowEntries.filter((entry) => String(entry.type || "") === "step_progress");
  const phaseCount = (matcher: (preview: string) => boolean) => {
    const counts = new Map<string, number>();
    for (const entry of progressEntries) {
      const phase = String(entry.phase || "").trim();
      const preview = String(entry.preview || "").trim();
      if (!phase || !preview || !matcher(preview)) continue;
      counts.set(phase, (counts.get(phase) || 0) + 1);
    }
    return counts;
  };

  const emptyResponseStages = Array.from(
    new Set(
      progressEntries
        .filter((entry) => String(entry.preview || "").includes("空响应"))
        .map((entry) => String(entry.phase || "").trim())
        .filter(Boolean),
    ),
  );

  const repeatedReadStages = Array.from(phaseCount((preview) => preview.includes("正在读取")).entries())
    .filter(([, count]) => count >= 4)
    .map(([stage, count]) => `${stage}(${count}次读取)`);

  const repeatedWriteStages = Array.from(
    phaseCount((preview) => preview.includes("结构化编辑方式更新") || preview.includes("写入")).entries(),
  )
    .filter(([, count]) => count >= 4)
    .map(([stage, count]) => `${stage}(${count}次写入)`);

  const stageRetries = Object.entries(params.debugSnapshot?.stages || {})
    .map(([stage, record]) => {
      const attempts = Array.isArray(record?.attempts) ? record.attempts.length : 0;
      return attempts > 1 ? `${stage}(${attempts}轮)` : "";
    })
    .filter(Boolean);

  const qaWarnings = params.verifyArtifact
    ? [
        ...(Array.isArray(params.verifyArtifact.static_validation) ? params.verifyArtifact.static_validation.slice(0, 4) : []),
        ...(Array.isArray(params.verifyArtifact.qa_results)
          ? params.verifyArtifact.qa_results
              .filter((item) => item.status === "failed" && item.evidence)
              .map((item) => String(item.evidence || ""))
              .slice(0, 3)
          : []),
      ]
    : [];

  const latestError = String(params.finalMessage || "").trim()
    || (["VERIFY", "CODING", "PLAN", "API", "PRD", "INTENT"] as ReplayStageName[])
      .map((stage) => params.getLatestStageError(stage))
      .find(Boolean)
    || "";

  return {
    latestError,
    emptyResponseStages,
    repeatedReadStages,
    repeatedWriteStages,
    apiCoverageGaps: params.apiCoverageGaps,
    qaWarnings,
    stageRetries,
  };
}

/**
 * 构造 HermesAgent 的标准输入。
 */
export function buildHermesEvolutionInput(params: {
  workflowStatus: "success" | "error" | "aborted";
  finalMessage?: string;
  runId: string;
  debugSnapshot: DebugRunSnapshot | null;
  model: string;
  baseUrl: string;
  projectPath: string;
  targetRoute: string;
  targetComponentPath: string;
  taskObjective: string;
  phaseSummaries: HermesEvolutionInput["phaseSummaries"];
  signals: HermesEvolutionInput["signals"];
}): HermesEvolutionInput {
  return {
    workflowStatus: params.workflowStatus,
    finalMessage: params.finalMessage,
    snapshot: {
      runId: params.runId,
      mode: params.debugSnapshot?.mode || "full",
      status: params.debugSnapshot?.status || params.workflowStatus,
      originalPrompt: String(params.debugSnapshot?.originalPrompt || ""),
      model: params.model,
      baseUrl: params.baseUrl,
      projectPath: params.projectPath,
      targetRoute: params.targetRoute,
      targetComponentPath: params.targetComponentPath,
      taskObjective: params.taskObjective,
    },
    phaseSummaries: params.phaseSummaries,
    signals: params.signals,
  };
}

/**
 * 当 Hermes 模型不可用时，基于本地信号生成一份启发式复盘报告。
 */
export function buildHeuristicHermesReport(params: {
  workflowStatus: "success" | "error" | "aborted";
  input: HermesEvolutionInput;
  runId: string;
  debugSnapshot: DebugRunSnapshot | null;
  buildLessonQuery: (originalPrompt: string) => LessonQuery;
}): HermesEvolutionReport {
  const grade = normalizeHermesGrade(params.workflowStatus);
  const lessons: HermesEvolutionReport["lessons"] = [];
  const input = params.input;

  if (input.signals.apiCoverageGaps?.length) {
    lessons.push({
      title: "实施方案必须显式覆盖全部接口映射",
      stage: "PLAN",
      applicable_stages: ["PLAN", "CODING"],
      severity: "high",
      tags: ["api_coverage", "plan_gap"],
      context: `API 阶段识别了接口，但 PLAN 未完整覆盖：${input.signals.apiCoverageGaps.join("；")}`,
      lesson: "凡是 API 阶段识别出的接口，实施方案都必须逐项给出 implement/defer 决策，再进入编码。",
      errorLog: input.signals.latestError,
      rootCause: "接口识别结果没有被稳定传递到实施方案，导致编码阶段自然漏功能。",
      promptPatch: "在 PLAN 阶段把每条 api_mapping 转成 api_coverage，并同步落到 files_to_modify / operations_outline / verification_points。",
      checklist: [
        "先核对 api_mappings 与 api_coverage 数量是否一致",
        "若 decision=implement，必须有目标文件与验证点",
      ],
    });
  }

  if (input.signals.emptyResponseStages?.length) {
    lessons.push({
      title: "空响应阶段需要快速恢复并保留诊断信号",
      stage: "SYSTEM",
      applicable_stages: normalizeHermesStages(input.signals.emptyResponseStages),
      severity: params.workflowStatus === "success" ? "medium" : "high",
      tags: ["empty_response", "recovery"],
      context: `本次 run 在这些阶段出现空响应：${input.signals.emptyResponseStages.join("、")}`,
      lesson: "遇到空响应时先压缩输出契约，再按阶段切换恢复模式，不要把前置阶段和编码阶段混用同一策略。",
      errorLog: input.signals.latestError,
      rootCause: "模型返回了 role-only/finish_reason=stop 的空 completion，若阈值与恢复提示不分阶段，会误伤正常流程。",
      promptPatch: "前置阶段只要求立即输出合法 JSON；编码阶段才允许进入强制出招和快速熔断。",
      checklist: [
        "记录 finish_reason / role_only_chunks / tool_count",
        "区分纯 JSON 阶段与编码阶段的空响应阈值",
      ],
    });
  }

  if (input.signals.repeatedReadStages?.length || input.signals.repeatedWriteStages?.length) {
    lessons.push({
      title: "收敛保护命中后必须停止继续扫读和重复写入",
      stage: "CODING",
      applicable_stages: ["CODING", "VERIFY"],
      severity: "high",
      tags: ["convergence", "repeated_read", "repeated_write"],
      context: [
        input.signals.repeatedReadStages?.length ? `重复读取：${input.signals.repeatedReadStages.join("；")}` : "",
        input.signals.repeatedWriteStages?.length ? `重复写入：${input.signals.repeatedWriteStages.join("；")}` : "",
      ].filter(Boolean).join(" | "),
      lesson: "一旦收敛保护触发，下一轮必须直接完成目标文件写入或结束，不要再次大范围扫文件。",
      errorLog: input.signals.latestError,
      rootCause: "模型在已拿到足够上下文后仍继续读写，造成卡住、空转或需要人工中止。",
      promptPatch: "命中收敛保护后收窄工具集，只保留必要写入或结论输出路径。",
      checklist: [
        "累计读取热点片段达到阈值后禁止继续顺扫",
        "若目标文件已写完且验证点已齐，立即结束编码阶段",
      ],
    });
  }

  if (lessons.length === 0) {
    lessons.push({
      title: params.workflowStatus === "success" ? "成功路径可直接复用" : "保留最小可复盘经验",
      stage: params.workflowStatus === "success" ? "SYSTEM" : "VERIFY",
      applicable_stages: params.workflowStatus === "success" ? ["INTENT", "PRD", "API", "PLAN", "CODING", "VERIFY"] : ["SYSTEM"],
      severity: params.workflowStatus === "success" ? "low" : "medium",
      tags: params.workflowStatus === "success" ? ["success_pattern"] : ["fallback_lesson"],
      context: input.snapshot.taskObjective || input.snapshot.originalPrompt || "通用工作流场景",
      lesson: params.workflowStatus === "success"
        ? "优先复用已锁定的项目路径、目标组件和实施方案结构，再围绕核心文件做最小写入。"
        : "本轮未形成足够强的结构化失败模式，但应优先回看 run snapshot 与关键阶段重放。",
      errorLog: input.signals.latestError,
      rootCause: params.workflowStatus === "success"
        ? "上下文锁定、文档解析和实施规划形成了稳定闭环。"
        : "当前更多是局部波动或人工中止，需要结合单阶段重放继续定位。",
      promptPatch: params.workflowStatus === "success"
        ? "先锁定核心组件、接口覆盖和验证点，再进入编码。"
        : "优先重放最脆弱阶段，而不是再次全链路重跑。",
      checklist: params.workflowStatus === "success"
        ? ["保留本次 runId 快照以便复用", "下次先对照 PLAN 的 api_coverage 与验证点"]
        : ["使用 /api/debug/replay-stage 重放问题阶段"],
    });
  }

  const runSummary = params.workflowStatus === "success"
    ? "本次 run 已完成主链路，可提炼为稳定执行路径。"
    : input.signals.latestError
      ? `本次 run 主要受阻于：${summarizeText(input.signals.latestError)}`
      : "本次 run 结束时出现了可复盘的中断或波动。";

  return {
    runId: params.runId,
    workflowStatus: params.workflowStatus,
    mode: (params.debugSnapshot?.mode || "full") as "full" | "replay",
    overallGrade: grade,
    runSummary,
    reasoning: "使用本地信号兜底生成 Hermes 复盘结果。",
    operatorNotes: params.workflowStatus === "success"
      ? ["可直接基于 run snapshot 做单阶段重放和提示词微调。"]
      : ["建议优先重放最脆弱阶段，而不是继续整链路重跑。"],
    context: params.buildLessonQuery(String(params.debugSnapshot?.originalPrompt || "")),
    lessons,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 把 Hermes 模型返回值清洗成系统内部稳定可消费的结构。
 */
export function normalizeHermesReport(params: {
  raw: any;
  workflowStatus: "success" | "error" | "aborted";
  input: HermesEvolutionInput;
  runId: string;
  debugSnapshot: DebugRunSnapshot | null;
  buildLessonQuery: (originalPrompt: string) => LessonQuery;
}): HermesEvolutionReport {
  const grade = normalizeHermesGrade(params.workflowStatus, params.raw?.overall_grade);
  const rawLessons = Array.isArray(params.raw?.lessons) ? params.raw.lessons : [];
  const lessons = rawLessons
    .map((item: any) => {
      if (!item || typeof item !== "object") return null;
      const context = String(item.context || "").trim();
      const lesson = String(item.lesson || "").trim();
      if (!context || !lesson) return null;
      return {
        title: String(item.title || "").trim() || undefined,
        stage: normalizeHermesStage(item.stage),
        applicable_stages: normalizeHermesStages(item.applicable_stages),
        severity: normalizeHermesSeverity(item.severity, grade),
        tags: Array.isArray(item.tags)
          ? item.tags.map((tag: any) => String(tag || "").trim()).filter(Boolean).slice(0, 8)
          : [],
        context,
        lesson,
        errorLog: String(item.errorLog || "").trim() || undefined,
        rootCause: String(item.rootCause || "").trim() || undefined,
        promptPatch: String(item.promptPatch || "").trim() || undefined,
        checklist: Array.isArray(item.checklist)
          ? item.checklist.map((entry: any) => String(entry || "").trim()).filter(Boolean).slice(0, 4)
          : [],
      };
    })
    .filter(Boolean) as HermesEvolutionReport["lessons"];

  if (lessons.length === 0) {
    return buildHeuristicHermesReport({
      workflowStatus: params.workflowStatus,
      input: params.input,
      runId: params.runId,
      debugSnapshot: params.debugSnapshot,
      buildLessonQuery: params.buildLessonQuery,
    });
  }

  const heuristic = buildHeuristicHermesReport({
    workflowStatus: params.workflowStatus,
    input: params.input,
    runId: params.runId,
    debugSnapshot: params.debugSnapshot,
    buildLessonQuery: params.buildLessonQuery,
  });

  return {
    runId: params.runId,
    workflowStatus: params.workflowStatus,
    mode: (params.debugSnapshot?.mode || "full") as "full" | "replay",
    overallGrade: grade,
    runSummary: String(params.raw?.run_summary || "").trim() || heuristic.runSummary,
    reasoning: String(params.raw?.reasoning || "").trim() || undefined,
    operatorNotes: Array.isArray(params.raw?.operator_notes)
      ? params.raw.operator_notes.map((item: any) => String(item || "").trim()).filter(Boolean).slice(0, 6)
      : [],
    context: params.buildLessonQuery(String(params.debugSnapshot?.originalPrompt || "")),
    lessons: lessons.slice(0, 4),
    createdAt: new Date().toISOString(),
  };
}

/**
 * 预先计算 Hermes 相关的 API 覆盖缺口。
 *
 * 这个小 helper 只是把“是否有 API/PLAN 工件”与“怎么求 coverage gaps”
 * 做了一次空值防御，避免主编排器里到处写三元表达式。
 */
export function deriveApiCoverageGaps(params: {
  apiArtifact?: ApiArtifact | null;
  planArtifact?: PlanArtifact | null;
  findPlanApiCoverageGaps: (planArtifact: PlanArtifact, apiArtifact: ApiArtifact) => string[];
}): string[] {
  return params.apiArtifact && params.planArtifact
    ? params.findPlanApiCoverageGaps(params.planArtifact, params.apiArtifact)
    : [];
}
