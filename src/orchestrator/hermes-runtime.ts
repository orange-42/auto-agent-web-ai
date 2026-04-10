import { HermesAgent, HermesEvolutionInput, LLMConfig } from "../agents";
import { MCPHub } from "../mcp-hub";
import { isFeatureEnabled } from "../feature-flags";
import { ApiArtifact, PlanArtifact, VerifyArtifact } from "../phase-artifacts";
import { DebugRunSnapshot, ReplayStageName } from "../debug-run-store";
import { EvalHarness, HermesEvolutionReport, LessonQuery } from "../harness/lesson-rag";
import {
  buildHermesEvolutionInput,
  buildHermesPhaseSummaries,
  buildHermesSignalSummary,
  buildHeuristicHermesReport,
  deriveApiCoverageGaps,
  normalizeHermesReport,
} from "./hermes-support";

type WorkflowStatus = "success" | "error" | "aborted";

interface HermesSharedParams {
  runId: string;
  llmConfig: LLMConfig;
  mcpHub: MCPHub;
  evalHarness: EvalHarness;
  debugSnapshot: DebugRunSnapshot | null;
  projectPath: string;
  targetRoute: string;
  targetComponentPath: string;
  taskObjective: string;
  artifactSummaryByStage: Partial<Record<ReplayStageName, string>>;
  apiArtifact: ApiArtifact | null;
  planArtifact: PlanArtifact | null;
  verifyArtifact: VerifyArtifact | null;
  buildLessonQuery: (originalPrompt: string, stage?: any, extra?: Partial<LessonQuery>) => LessonQuery;
  getLatestStageError: (stage: ReplayStageName) => string;
  findPlanApiCoverageGaps: (planArtifact: PlanArtifact, apiArtifact: ApiArtifact) => string[];
  readWorkflowEntries: () => Array<Record<string, unknown>>;
  trace: (type: string, payload: Record<string, unknown>) => void;
  updateDebugContext: (patch: Record<string, unknown>) => void;
}

function buildEvolutionInput(
  params: HermesSharedParams,
  workflowStatus: WorkflowStatus,
  finalMessage?: string,
): HermesEvolutionInput | null {
  if (!params.debugSnapshot || params.debugSnapshot.mode !== "full") return null;

  return buildHermesEvolutionInput({
    workflowStatus,
    finalMessage,
    runId: params.runId,
    debugSnapshot: params.debugSnapshot,
    model: params.llmConfig.model || params.llmConfig.modelId || "",
    baseUrl: params.llmConfig.baseUrl || "",
    projectPath: params.projectPath,
    targetRoute: params.targetRoute,
    targetComponentPath: params.targetComponentPath,
    taskObjective: params.taskObjective,
    phaseSummaries: buildHermesPhaseSummaries({
      debugSnapshot: params.debugSnapshot,
      artifactSummaryByStage: params.artifactSummaryByStage,
      getLatestStageError: params.getLatestStageError,
    }),
    signals: buildHermesSignalSummary({
      workflowEntries: params.readWorkflowEntries(),
      debugSnapshot: params.debugSnapshot,
      finalMessage,
      apiCoverageGaps: deriveApiCoverageGaps({
        apiArtifact: params.apiArtifact,
        planArtifact: params.planArtifact,
        findPlanApiCoverageGaps: params.findPlanApiCoverageGaps,
      }),
      verifyArtifact: params.verifyArtifact,
      getLatestStageError: params.getLatestStageError,
    }),
  });
}

/**
 * 生成在线 Hermes checkpoint 注入文本。
 *
 * 这一步只做轻量 heuristic 复盘，不调用大模型。
 * 它的目标不是产出正式 report，而是把“当前 run 到这一阶段已经暴露出来的问题”
 * 及时转成可注入给后续阶段的经验片段。
 */
export function buildHermesCheckpointLessons(
  params: HermesSharedParams & {
    triggerStage: ReplayStageName | "SYSTEM";
    workflowStatus: WorkflowStatus;
    finalMessage?: string;
  },
): string {
  if (!isFeatureEnabled("ENABLE_HERMES_EVOLUTION")) return "";

  const evolutionInput = buildEvolutionInput(params, params.workflowStatus, params.finalMessage);
  if (!evolutionInput) return "";

  const report = buildHeuristicHermesReport({
    workflowStatus: params.workflowStatus,
    input: evolutionInput,
    runId: params.runId,
    debugSnapshot: params.debugSnapshot,
    buildLessonQuery: (originalPrompt) => params.buildLessonQuery(originalPrompt),
  });
  const topLessons = Array.isArray(report.lessons) ? report.lessons.slice(0, 2) : [];
  if (topLessons.length === 0) return "";

  params.trace("hermes_checkpoint", {
    triggerStage: params.triggerStage,
    workflowStatus: params.workflowStatus,
    lessonCount: topLessons.length,
    runSummary: report.runSummary,
    operatorNotes: report.operatorNotes || [],
  });
  params.updateDebugContext({
    hermesCheckpoint: {
      triggerStage: params.triggerStage,
      workflowStatus: params.workflowStatus,
      runSummary: report.runSummary,
      operatorNotes: report.operatorNotes || [],
      lessons: topLessons,
    },
  });

  return [
    `### Hermes 在线复盘 (${params.triggerStage})`,
    ...topLessons.map((lesson, index) => {
      const checklist = Array.isArray(lesson.checklist) && lesson.checklist.length > 0
        ? `检查项：${lesson.checklist.slice(0, 3).join("；")}`
        : "";
      const patch = lesson.promptPatch ? `提示补丁：${lesson.promptPatch}` : "";
      return [
        `${index + 1}. ${lesson.title || lesson.lesson}`,
        `适用阶段：${Array.isArray(lesson.applicable_stages) && lesson.applicable_stages.length > 0 ? lesson.applicable_stages.join("、") : lesson.stage || "SYSTEM"}`,
        `经验：${lesson.lesson}`,
        patch,
        checklist,
      ].filter(Boolean).join("\n");
    }),
  ].join("\n");
}

/**
 * 执行最终 Hermes 复盘。
 *
 * 这是“正式版” Hermes：
 * - 尝试调用 HermesAgent 生成结构化复盘
 * - 若 LLM 不可用则降级为 heuristic report
 * - 持久化 report 和 lessons
 * - 把关键结果回写到 debug context
 */
export async function runHermesEvolutionFlow(
  params: HermesSharedParams & {
    workflowStatus: WorkflowStatus;
    finalMessage?: string;
    allowLLM?: boolean;
    signalAborted: boolean;
  },
): Promise<void> {
  if (!isFeatureEnabled("ENABLE_HERMES_EVOLUTION")) return;

  const evolutionInput = buildEvolutionInput(params, params.workflowStatus, params.finalMessage);
  if (!evolutionInput) return;

  const lessonsSeed = params.evalHarness.getRelevantLessons(
    params.buildLessonQuery(String(params.debugSnapshot?.originalPrompt || ""), "SYSTEM", {
      workflowStatus: params.workflowStatus,
      extraText: params.finalMessage,
    }),
    3,
  );

  let report: HermesEvolutionReport | null = null;
  const allowLLM = params.allowLLM !== false && !params.signalAborted;

  if (allowLLM) {
    try {
      const hermesAgent = new HermesAgent(
        { ...params.llmConfig, runId: `${params.runId}__hermes`, projectPath: params.projectPath },
        params.mcpHub,
      );
      const raw = await hermesAgent.execute(evolutionInput, lessonsSeed);
      report = normalizeHermesReport({
        raw,
        workflowStatus: params.workflowStatus,
        input: evolutionInput,
        runId: params.runId,
        debugSnapshot: params.debugSnapshot,
        buildLessonQuery: (originalPrompt) => params.buildLessonQuery(originalPrompt),
      });
    } catch (error: any) {
      params.trace("hermes_evolution_failed", {
        message: String(error?.message || "unknown"),
      });
    }
  }

  if (!report) {
    report = buildHeuristicHermesReport({
      workflowStatus: params.workflowStatus,
      input: evolutionInput,
      runId: params.runId,
      debugSnapshot: params.debugSnapshot,
      buildLessonQuery: (originalPrompt) => params.buildLessonQuery(originalPrompt),
    });
  }

  try {
    const savedLessons = await params.evalHarness.recordHermesReport(report);
    const reportPath = `.harness/hermes/${params.runId}.report.json`;
    params.trace("hermes_evolution", {
      overallGrade: report.overallGrade,
      lessonCount: savedLessons.length,
      runSummary: report.runSummary,
      reportPath,
    });
    params.updateDebugContext({
      hermesEvolution: {
        overallGrade: report.overallGrade,
        runSummary: report.runSummary,
        operatorNotes: report.operatorNotes || [],
        lessonCount: savedLessons.length,
        reportPath,
      },
    });
  } catch (error: any) {
    params.trace("hermes_evolution_persist_failed", {
      message: String(error?.message || "unknown"),
    });
  }
}
