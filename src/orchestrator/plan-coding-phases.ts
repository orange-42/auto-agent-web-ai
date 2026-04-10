import {
  buildArtifactEnvelope,
  CodeArtifact,
  normalizeCodeArtifact,
  normalizePlanArtifact,
  PlanArtifact,
} from "../phase-artifacts";
import { appendHarnessJsonl } from "../harness-logger";
import { CodingExecutionInput, RuntimeDiscoveryResult } from "./loop-manager-types";

/**
 * PLAN 阶段执行器的输入。
 *
 * 这一层把“计划生成 + gate/retry + fallback + 风格快照更新”整块收拢起来，
 * 让主 orchestrator 不再直接关心这些实现细节。
 */
export interface ExecutePlanPhaseParams {
  signal: AbortSignal;
  projectPath: string;
  targetRoute: string;
  targetComponentPath: string;
  executionBrief: string;
  sharedLessons: string;
  targetComponentContext: string;
  prdFocusContext: string;
  styleContext: string;
  runtimeDiscovery: RuntimeDiscoveryResult | null;
  prdRes: any;
  prdArtifact: any;
  apiRes: any;
  apiArtifact: any;
  phaseArtifactsEnabled: boolean;
  emitStepStart: (phase: string, title: string, index: number) => void;
  emitStepProgress: (data: { phase: string; content?: string; thought?: string; index: number }) => void;
  emitStepComplete: (phase: string, status: string, index: number) => void;
  trace: (type: string, payload: Record<string, unknown>) => void;
  updateDebugContext: (patch: Record<string, unknown>) => void;
  plannerAgentExecute: (input: any, lessons: string, onThought: (message: string) => void) => Promise<any>;
  forwardAgentProgress: (phase: string, index: number) => (message: string) => void;
  appendDebugStageAttempt: (
    stage: "PLAN",
    label: string,
    input?: unknown,
    output?: unknown,
    error?: string,
  ) => void;
  getPipelineArtifacts: () => any;
  buildProjectTree: () => Promise<string>;
  isUsablePlan: (plan: any) => boolean;
  buildFallbackPlan: (prdRes: any, apiRes: any, targetComponentContext: string) => any;
  enrichPlanWithApiCoverage: (plan: any, apiArtifact: any) => any;
  normalizePlanToProjectStyle: (plan: any) => any;
  ensurePlanArtifactGate: (planArtifact: PlanArtifact, apiArtifact?: any) => void;
  setPhaseArtifact: (phase: "PLAN" | "PROJECT_SNAPSHOT", envelope: any) => void;
  buildHumanSummaryFromResult: (label: string, result: any) => string;
  buildStyleContext: (plan: any) => string;
  buildProjectSnapshotArtifact: (
    targetComponentContext: string,
    styleContext: string,
    runtimeDiscovery: RuntimeDiscoveryResult | null,
  ) => any;
  summarizeResult: (label: string, result: any) => void;
  finalizeDebugStage: (
    stage: "PLAN",
    payload: { replayInput?: unknown; output?: unknown; artifact?: unknown; humanSummary?: string },
  ) => void;
  getArtifactSummary: (phase: "PLAN") => string;
  phaseArtifacts: {
    PLAN?: unknown;
  };
}

export interface ExecutePlanPhaseResult {
  planRes: any;
  planArtifact: PlanArtifact;
  planStyleContext: string;
  projectSnapshotArtifact: any;
  projectTree: string;
}

/**
 * CODING 阶段执行器的输入。
 *
 * 它只负责把“已经做好的计划”交给 CoderAgent 落盘，
 * 不承担后续的 validation repair 和 QA；那部分交给 VERIFY 阶段执行器。
 */
export interface ExecuteCodingPhaseParams {
  signal: AbortSignal;
  projectPath: string;
  targetRoute: string;
  targetComponentPath: string;
  executionBrief: string;
  sharedLessons: string;
  targetComponentContext: string;
  prdFocusContext: string;
  styleContext: string;
  prdArtifact: any;
  apiArtifact: any;
  planArtifact: PlanArtifact;
  emitStepStart: (phase: string, title: string, index: number) => void;
  emitStepProgress: (data: { phase: string; content?: string; thought?: string; index: number }) => void;
  emitStepComplete: (phase: string, status: string, index: number) => void;
  trace: (type: string, payload: Record<string, unknown>) => void;
  coderAgentExecute: (input: CodingExecutionInput, lessons: string, onThought: (message: string) => void) => Promise<any>;
  forwardAgentProgress: (phase: string, index: number) => (message: string) => void;
  appendDebugStageAttempt: (
    stage: "CODING",
    label: string,
    input?: unknown,
    output?: unknown,
    error?: string,
  ) => void;
  getPipelineArtifacts: () => any;
  setPhaseArtifact: (phase: "CODING", envelope: any) => void;
  buildHumanSummaryFromResult: (label: string, result: any) => string;
  finalizeDebugStage: (
    stage: "CODING",
    payload: { replayInput?: unknown; output?: unknown; artifact?: unknown; humanSummary?: string; meta?: Record<string, unknown> },
  ) => void;
  getArtifactSummary: (phase: "CODING") => string;
  summarizeResult: (label: string, result: any) => void;
  phaseArtifacts: {
    CODING?: unknown;
  };
}

export interface ExecuteCodingPhaseResult {
  codingInput: CodingExecutionInput;
  codingRes: any;
  codeArtifact: CodeArtifact;
}

/**
 * 执行 PLAN 阶段。
 *
 * 这段逻辑负责把“PRD + API + 项目结构 + 组件热点”压成可执行作战图，
 * 同时处理 planner 失败时的 fallback plan 和 gate-fix 重试。
 */
export async function executePlanPhase(params: ExecutePlanPhaseParams): Promise<ExecutePlanPhaseResult> {
  if (params.signal.aborted) throw new Error("AbortError");
  const projectTree = await params.buildProjectTree();
  params.trace("project_tree_ready", {
    projectPath: params.projectPath,
    treeChars: projectTree.length,
    treePreview: projectTree.slice(0, 200),
  });
  params.updateDebugContext({ projectTree });

  params.emitStepStart("PLAN", "🗺️ 正在制定开发方案...", 3);
  if (projectTree) {
    params.emitStepProgress({
      phase: "PLAN",
      content: "[系统] 已预取项目目录树，规划阶段将优先依据目录结构收敛。",
      index: 3,
    });
  }
  if (params.targetComponentContext) {
    params.emitStepProgress({
      phase: "PLAN",
      content: "[系统] 已预取核心组件关键片段，规划阶段将优先围绕热点代码收敛。",
      index: 3,
    });
  }

  let planRes: any;
  let planReplayInput: any = null;
  try {
    planReplayInput = {
      prd: params.prdArtifact,
      api: params.apiArtifact,
      projectPath: params.projectPath,
      projectTree,
      targetComponentContext: params.targetComponentContext,
      prdFocusContext: params.prdFocusContext,
      query: params.executionBrief,
      targetComponentPath: params.targetComponentPath,
      targetRoute: params.targetRoute,
      artifacts: params.getPipelineArtifacts(),
    };
    planRes = await params.plannerAgentExecute(
      planReplayInput,
      params.sharedLessons,
      params.forwardAgentProgress("PLAN", 3),
    );
    params.appendDebugStageAttempt("PLAN", "primary", planReplayInput, planRes);
    planRes = params.enrichPlanWithApiCoverage(params.normalizePlanToProjectStyle(planRes), params.apiArtifact);
  } catch (error: any) {
    params.trace("plan_primary_failed", {
      message: error?.message || "unknown",
    });
    params.appendDebugStageAttempt("PLAN", "primary_failed", planReplayInput, undefined, error?.message || "unknown");
    params.emitStepProgress({
      phase: "PLAN",
      content: "[系统] 规划阶段主流程未收敛，正在基于现有证据生成兜底实施方案。",
      index: 3,
    });
  }

  if (!params.isUsablePlan(planRes)) {
    planRes = params.buildFallbackPlan(params.prdRes, params.apiRes, params.targetComponentContext);
    planRes = params.enrichPlanWithApiCoverage(planRes, params.apiArtifact);
    params.trace("plan_fallback_built", {
      filesToModify: Array.isArray(planRes?.files_to_modify) ? planRes.files_to_modify.length : 0,
      filesToCreate: Array.isArray(planRes?.files_to_create) ? planRes.files_to_create.length : 0,
      verificationPoints: Array.isArray(planRes?.verification_points) ? planRes.verification_points.length : 0,
    });
    params.emitStepProgress({
      phase: "PLAN",
      content: "[系统] 已切换为规划兜底方案，继续进入代码系统集成。",
      index: 3,
    });
  }

  planRes = params.enrichPlanWithApiCoverage(params.normalizePlanToProjectStyle(planRes), params.apiArtifact);
  let planArtifact = normalizePlanArtifact(planRes);
  if (params.phaseArtifactsEnabled) {
    try {
      params.ensurePlanArtifactGate(planArtifact, params.apiArtifact);
    } catch (error: any) {
      params.emitStepProgress({
        phase: "PLAN",
        content: "[系统] 规划结果缺少关键结构字段，正在基于现有工件执行一次补强重试。",
        index: 3,
      });
      planReplayInput = {
        prd: params.prdArtifact,
        api: params.apiArtifact,
        projectPath: params.projectPath,
        projectTree,
        targetComponentContext: params.targetComponentContext,
        prdFocusContext: params.prdFocusContext,
        query: params.executionBrief,
        targetComponentPath: params.targetComponentPath,
        targetRoute: params.targetRoute,
        artifacts: params.getPipelineArtifacts(),
        gateFeedback: error?.message || "需要补齐 files、operations_outline、test_cases",
      };
      planRes = await params.plannerAgentExecute(
        planReplayInput,
        params.sharedLessons,
        params.forwardAgentProgress("PLAN", 3),
      );
      params.appendDebugStageAttempt("PLAN", "retry_gate_fix", planReplayInput, planRes);
      planRes = params.enrichPlanWithApiCoverage(params.normalizePlanToProjectStyle(planRes), params.apiArtifact);
      planArtifact = normalizePlanArtifact(planRes);
      params.ensurePlanArtifactGate(planArtifact, params.apiArtifact);
    }
    params.setPhaseArtifact(
      "PLAN",
      buildArtifactEnvelope("PLAN", params.buildHumanSummaryFromResult("PLAN", planRes), planArtifact),
    );
  }

  const planStyleContext = params.buildStyleContext(planRes);
  const projectSnapshotArtifact = params.buildProjectSnapshotArtifact(
    params.targetComponentContext,
    planStyleContext || params.styleContext,
    params.runtimeDiscovery,
  );
  if (params.phaseArtifactsEnabled) {
    params.setPhaseArtifact(
      "PROJECT_SNAPSHOT",
      buildArtifactEnvelope("PLAN", "已生成项目快照，用于后续编码与验证收敛。", projectSnapshotArtifact),
    );
  }
  params.trace("plan_style_context", {
    chars: planStyleContext.length,
    preview: planStyleContext.slice(0, 200),
  });
  params.summarizeResult("PLAN", planRes);
  params.updateDebugContext({
    planStyleContext,
  });
  params.finalizeDebugStage("PLAN", {
    replayInput: planReplayInput,
    output: planRes,
    artifact: params.phaseArtifacts.PLAN,
    humanSummary: params.getArtifactSummary("PLAN"),
  });
  params.emitStepComplete("PLAN", "success", 3);

  return {
    planRes,
    planArtifact,
    planStyleContext,
    projectSnapshotArtifact,
    projectTree,
  };
}

/**
 * 执行 CODING 阶段。
 *
 * 这个阶段的目标非常单纯：
 * 使用已经准备好的 `prd/api/plan/styleContext`
 * 调起 CoderAgent 做真实写入，并把首轮写入结果落进 artifact/debug snapshot。
 */
export async function executeCodingPhase(params: ExecuteCodingPhaseParams): Promise<ExecuteCodingPhaseResult> {
  if (params.signal.aborted) throw new Error("AbortError");
  params.emitStepStart("CODING", "🛠️ 正在执行系统集成...", 4);
  params.emitStepProgress({
    phase: "CODING",
    content: "[系统] 将优先围绕核心组件执行真实代码写入。",
    index: 4,
  });

  const codingInput: CodingExecutionInput = {
    prd: params.prdArtifact,
    api: params.apiArtifact,
    plan: params.planArtifact,
    projectPath: params.projectPath,
    query: params.executionBrief,
    targetComponentContext: params.targetComponentContext,
    styleContext: params.styleContext,
    prdFocusContext: params.prdFocusContext,
    targetComponentPath: params.targetComponentPath,
    targetRoute: params.targetRoute,
    artifacts: params.getPipelineArtifacts(),
  };

  params.trace("coding_input_built", {
    targetComponentPath: params.targetComponentPath,
    targetRoute: params.targetRoute,
    hasTargetComponentContext: Boolean(params.targetComponentContext),
    targetComponentContextChars: params.targetComponentContext.length,
    styleContextChars: params.styleContext.length,
    prdFocusContextChars: params.prdFocusContext.length,
    planFilesToModify: Array.isArray(params.planArtifact?.files_to_modify) ? params.planArtifact.files_to_modify.length : 0,
    planFilesToCreate: Array.isArray(params.planArtifact?.files_to_create) ? params.planArtifact.files_to_create.length : 0,
    planApiCoverage: Array.isArray(params.planArtifact?.api_coverage) ? params.planArtifact.api_coverage.length : 0,
  });
  appendHarnessJsonl("coding_evidence_flow.jsonl", {
    stage: "CODING",
    layer: "orchestrator_input",
    targetComponentPath: params.targetComponentPath,
    targetRoute: params.targetRoute,
    executionBrief: params.executionBrief,
    sharedLessons: params.sharedLessons,
    rawEvidence: {
      prdArtifact: params.prdArtifact,
      apiArtifact: params.apiArtifact,
      planArtifact: params.planArtifact,
      targetComponentContext: params.targetComponentContext,
      styleContext: params.styleContext,
      prdFocusContext: params.prdFocusContext,
      pipelineArtifacts: params.getPipelineArtifacts(),
    },
    codingInput,
  });

  const codingRes = await params.coderAgentExecute(
    codingInput,
    params.sharedLessons,
    params.forwardAgentProgress("CODING", 4),
  );
  params.appendDebugStageAttempt("CODING", "primary", codingInput, codingRes);

  const codeArtifact = normalizeCodeArtifact(codingRes);
  params.setPhaseArtifact(
    "CODING",
    buildArtifactEnvelope("CODING", params.buildHumanSummaryFromResult("CODING", codingRes), codeArtifact),
  );
  params.finalizeDebugStage("CODING", {
    replayInput: codingInput,
    output: codingRes,
    artifact: params.phaseArtifacts.CODING,
    humanSummary: params.getArtifactSummary("CODING"),
    meta: {
      persistedBeforeVerify: true,
    },
  });
  params.summarizeResult("CODING", codingRes);
  params.emitStepComplete("CODING", "success", 4);

  return {
    codingInput,
    codingRes,
    codeArtifact,
  };
}
