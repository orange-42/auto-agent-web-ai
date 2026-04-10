import {
  ApiArtifact,
  buildArtifactEnvelope,
  CodeArtifact,
  deriveStructuredTestCases,
  normalizeApiArtifact,
  normalizeCodeArtifact,
  normalizeIntentArtifact,
  normalizePlanArtifact,
  normalizePrdArtifact,
  normalizeVerifyArtifact,
  PhaseArtifactEnvelope,
  PlanArtifact,
  PrdArtifact,
  TestCaseArtifact,
  VerifyArtifact,
} from "../phase-artifacts";
import { DebugRunSnapshot, ReplayStageName } from "../debug-run-store";
import { CodingExecutionInput, ValidationReport } from "./loop-manager-types";

type ArtifactPhase = "INTENT" | "PRD" | "API" | "PLAN" | "CODING" | "VERIFY";

type ReplayDescriptor = {
  title: string;
  index: number;
};

type SetPhaseArtifact = (
  phase: ArtifactPhase,
  envelope:
    | PhaseArtifactEnvelope<any>
    | PhaseArtifactEnvelope<PrdArtifact>
    | PhaseArtifactEnvelope<ApiArtifact>
    | PhaseArtifactEnvelope<PlanArtifact>
    | PhaseArtifactEnvelope<CodeArtifact>
    | PhaseArtifactEnvelope<VerifyArtifact>,
) => void;

/**
 * executeStageReplay 负责“真正执行某个 replay 阶段”的细节。
 *
 * 这里故意把大段 `if (stage === "...")` 逻辑从 orchestrator 主文件中抽离出来，
 * 让 loop-manager 只保留：
 * 1. 读取快照
 * 2. 准备 replay 输入
 * 3. 初始化 agent / lessons / debug 状态
 * 4. 调用这里执行阶段
 * 5. 成功或失败后统一收口
 *
 * 这样主 orchestrator 会更接近“纯骨架调度器”，而不是又做调度、又做每个阶段的业务细节。
 */
export async function executeStageReplay(params: {
  stage: ReplayStageName;
  snapshot: DebugRunSnapshot;
  replayInput: any;
  sharedLessons: string;
  descriptor: ReplayDescriptor;
  intentExecute: (input: { prompt: string }, lessons: string, onThought?: (thought: string) => void) => Promise<any>;
  prdExecute: (
    input: { query: string; rawContent?: string; focusContext?: string; gateFeedback?: string },
    lessons: string,
    onThought?: (thought: string) => void,
  ) => Promise<any>;
  apiExecute: (
    input: {
      prd: any;
      query?: string;
      apiUrl?: string;
      rawContent?: string;
      prdFocusContext?: string;
      gateFeedback?: string;
    },
    lessons: string,
    onThought?: (thought: string) => void,
  ) => Promise<any>;
  planExecute: (
    input: {
      prd: any;
      api: any;
      query?: string;
      projectPath?: string;
      projectTree?: string;
      targetComponentPath?: string;
      targetRoute?: string;
      targetComponentContext?: string;
      prdFocusContext?: string;
      artifacts?: any;
      gateFeedback?: string;
    },
    lessons: string,
    onThought?: (thought: string) => void,
  ) => Promise<any>;
  codingExecute: (
    input: {
      prd: any;
      api: any;
      plan: any;
      error?: string;
      projectPath: string;
      query?: string;
      targetComponentPath?: string;
      targetRoute?: string;
      targetComponentContext?: string;
      styleContext?: string;
      prdFocusContext?: string;
      artifacts?: any;
    },
    lessons: string,
    onThought?: (thought: string) => void,
  ) => Promise<any>;
  verifyExecute: (
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
  ) => Promise<any>;
  forwardAgentProgress: (phase: string, index: number) => (thought: string) => void;
  appendDebugStageAttempt: (
    stage: ReplayStageName,
    label: string,
    input?: any,
    output?: any,
    error?: string,
    meta?: Record<string, unknown>,
  ) => void;
  setPhaseArtifact: SetPhaseArtifact;
  buildHumanSummaryFromResult: (label: string, result: any) => string;
  normalizePlanToProjectStyle: (plan: any) => any;
  enrichPlanWithApiCoverage: (plan: any, apiArtifact: ApiArtifact) => any;
  runCodingValidationRepairLoop: (params: {
    initialResult: any;
    baseInput: CodingExecutionInput;
    planArtifact: any;
    sharedLessons: string;
    progressPhase: "CODING" | "VERIFY";
    progressIndex: number;
    attemptLabelPrefix: string;
    sourceRunId?: string;
  }) => Promise<{ result: any; validationReport: ValidationReport }>;
}): Promise<any> {
  const {
    stage,
    snapshot,
    replayInput,
    sharedLessons,
    descriptor,
    intentExecute,
    prdExecute,
    apiExecute,
    planExecute,
    codingExecute,
    verifyExecute,
    forwardAgentProgress,
    appendDebugStageAttempt,
    setPhaseArtifact,
    buildHumanSummaryFromResult,
    normalizePlanToProjectStyle,
    enrichPlanWithApiCoverage,
    runCodingValidationRepairLoop,
  } = params;

  if (stage === "INTENT") {
    const result = await intentExecute(
      replayInput as { prompt: string },
      "",
      forwardAgentProgress("INTENT", descriptor.index),
    );
    appendDebugStageAttempt("INTENT", "replay", replayInput, result, undefined, { sourceRunId: snapshot.runId });
    const config = result?.parsed || {};
    if (config && config.projectPath) {
      const intentArtifact = normalizeIntentArtifact(config);
      setPhaseArtifact(
        "INTENT",
        buildArtifactEnvelope("INTENT", "已完成意图解析并锁定项目上下文。", intentArtifact),
      );
    }
    return result;
  }

  if (stage === "PRD") {
    const result = await prdExecute(
      replayInput as { query: string; rawContent?: string; focusContext?: string; gateFeedback?: string },
      sharedLessons,
      forwardAgentProgress("PRD", descriptor.index),
    );
    appendDebugStageAttempt("PRD", "replay", replayInput, result, undefined, { sourceRunId: snapshot.runId });
    const artifact = normalizePrdArtifact(result);
    setPhaseArtifact(
      "PRD",
      buildArtifactEnvelope("PRD", buildHumanSummaryFromResult("PRD", result), artifact),
    );
    return result;
  }

  if (stage === "API") {
    const result = await apiExecute(
      replayInput as {
        prd: any;
        query?: string;
        apiUrl?: string;
        rawContent?: string;
        prdFocusContext?: string;
        gateFeedback?: string;
      },
      sharedLessons,
      forwardAgentProgress("API", descriptor.index),
    );
    appendDebugStageAttempt("API", "replay", replayInput, result, undefined, { sourceRunId: snapshot.runId });
    const artifact = normalizeApiArtifact(result);
    setPhaseArtifact(
      "API",
      buildArtifactEnvelope("API", buildHumanSummaryFromResult("API", result), artifact),
    );
    return result;
  }

  if (stage === "PLAN") {
    let result = await planExecute(
      replayInput as {
        prd: any;
        api: any;
        query?: string;
        projectPath?: string;
        projectTree?: string;
        targetComponentPath?: string;
        targetRoute?: string;
        targetComponentContext?: string;
        prdFocusContext?: string;
        artifacts?: any;
        gateFeedback?: string;
      },
      sharedLessons,
      forwardAgentProgress("PLAN", descriptor.index),
    );
    appendDebugStageAttempt("PLAN", "replay", replayInput, result, undefined, { sourceRunId: snapshot.runId });
    result = enrichPlanWithApiCoverage(
      normalizePlanToProjectStyle(result),
      normalizeApiArtifact((replayInput as any)?.api || (snapshot.artifacts as any)?.API?.artifact || {}),
    );
    const artifact = normalizePlanArtifact(result);
    setPhaseArtifact(
      "PLAN",
      buildArtifactEnvelope("PLAN", buildHumanSummaryFromResult("PLAN", result), artifact),
    );
    return result;
  }

  if (stage === "CODING") {
    let result = await codingExecute(
      replayInput as {
        prd: any;
        api: any;
        plan: any;
        error?: string;
        projectPath: string;
        query?: string;
        targetComponentPath?: string;
        targetRoute?: string;
        targetComponentContext?: string;
        styleContext?: string;
        prdFocusContext?: string;
        artifacts?: any;
      },
      sharedLessons,
      forwardAgentProgress("CODING", descriptor.index),
    );
    appendDebugStageAttempt("CODING", "replay", replayInput, result, undefined, { sourceRunId: snapshot.runId });
    setPhaseArtifact(
      "CODING",
      buildArtifactEnvelope("CODING", buildHumanSummaryFromResult("CODING", result), normalizeCodeArtifact(result)),
    );

    const replayPlan = (replayInput as any)?.plan || (snapshot.artifacts as any)?.PLAN?.artifact || {};
    const replayCodingValidation = await runCodingValidationRepairLoop({
      initialResult: result,
      baseInput: replayInput as CodingExecutionInput,
      planArtifact: replayPlan,
      sharedLessons,
      progressPhase: "CODING",
      progressIndex: descriptor.index,
      attemptLabelPrefix: "replay",
      sourceRunId: snapshot.runId,
    });
    result = replayCodingValidation.result;
    const validationReport = replayCodingValidation.validationReport;

    setPhaseArtifact(
      "CODING",
      buildArtifactEnvelope(
        "CODING",
        buildHumanSummaryFromResult("CODING", result),
        normalizeCodeArtifact(result, [validationReport.summary, ...validationReport.highlights]),
      ),
    );

    if (validationReport.hasBlockingIssues) {
      const topIssue = validationReport.highlights[0] || validationReport.summary;
      throw new Error(`CODING replay 未通过本地校验：${topIssue}`);
    }

    return result;
  }

  if (stage === "VERIFY") {
    const result = await verifyExecute(
      replayInput as {
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
      sharedLessons,
      forwardAgentProgress("VERIFY", descriptor.index),
    );
    appendDebugStageAttempt("VERIFY", "replay", replayInput, result, undefined, { sourceRunId: snapshot.runId });
    const artifact = normalizeVerifyArtifact(
      result,
      deriveStructuredTestCases((replayInput as any)?.testCases, 4),
      [],
    );
    setPhaseArtifact(
      "VERIFY",
      buildArtifactEnvelope("VERIFY", buildHumanSummaryFromResult("VERIFY", result), artifact),
    );
    return result;
  }

  throw new Error(`不支持的 replay 阶段：${stage}`);
}
