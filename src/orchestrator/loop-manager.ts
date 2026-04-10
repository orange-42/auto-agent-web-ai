import { BaseAgent, LLMConfig, IntentAgent, PRDAgent, APIAgent, PlannerAgent, CoderAgent, QAAgent } from "../agents";
import { MCPHub } from "../mcp-hub";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { ChildProcess, spawn } from "child_process";
import { LarkPrefetcher } from "../lark-prefetcher";
import { appendHarnessJsonl, appendHarnessLog, summarizeText } from "../harness-logger";
import { EvalHarness, LessonQuery, LessonStage } from "../harness/lesson-rag";
import { FEATURE_FLAGS, getFeatureFlagSnapshot, isFeatureEnabled } from "../feature-flags";
import {
  ApiArtifact,
  buildArtifactEnvelope,
  CodeArtifact,
  deriveStructuredTestCases,
  IntentArtifact,
  normalizeApiArtifact,
  normalizeCodeArtifact,
  normalizeIntentArtifact,
  normalizePlanArtifact,
  normalizeProjectSnapshotArtifact,
  PhaseArtifactEnvelope,
  PlanArtifact,
  PrdArtifact,
  ProjectSnapshotArtifact,
  TestCaseArtifact,
  VerifyArtifact,
} from "../phase-artifacts";
import {
  cloneForDebug,
  DebugRunSnapshot,
  readDebugRunSnapshot,
  ReplayStageName,
  writeDebugRunSnapshot,
} from "../debug-run-store";
import {
  CodingExecutionInput,
  ProjectRuntimeOption,
  RuntimeDiscoveryResult,
  ValidationIssue,
  ValidationReport,
} from "./loop-manager-types";
import {
  buildQaProbeUrls,
  discoverProjectRuntimeOptions,
  getRuntimeLaunchCandidates,
  selectRuntimeOption,
} from "./runtime-discovery";
import {
  buildConsistencyReviewPrompt,
  buildValidationFixPrompt,
  buildValidationReport,
  isCodeImportTarget,
  resolveImportTarget,
  shouldRunConsistencyReview,
} from "./coding-validation";
import {
  buildProjectSnapshotArtifact as buildProjectSnapshotArtifactFromContext,
  buildStyleContext as buildStyleContextFromContext,
  buildTargetComponentContext as buildTargetComponentContextFromContext,
  detectPreferredExtensionForDirectory as detectPreferredExtensionForDirectoryFromContext,
  extractPlanFilePaths as extractPlanFilePathsFromContext,
  getApiStyleContract as getApiStyleContractFromContext,
  normalizePlanToProjectStyle as normalizePlanToProjectStyleFromContext,
} from "./project-context";
import {
  buildSyntheticCodingReplayInput as buildSyntheticCodingReplayInputFromDebugReplay,
  createDebugSnapshot,
  deriveRuntimeStateFromSnapshot,
  getReplayStageDescriptor,
  withAppendedDebugStageAttempt,
  withDebugSnapshotStatus,
  withFinalizedDebugStage,
  withMergedDebugContext,
  withSyncedDebugArtifacts,
} from "./debug-replay";
import {
  backfillPrdResultWithLocalEvidence as backfillPrdResultWithLocalEvidenceFromPrdContext,
  buildExecutionBrief as buildExecutionBriefFromPrdContext,
  buildFocusedDocumentContent as buildFocusedDocumentContentFromPrdContext,
  buildPrdEvidenceContext as buildPrdEvidenceContextFromPrdContext,
  buildPrdFocusContext as buildPrdFocusContextFromPrdContext,
  extractTaskObjective as extractTaskObjectiveFromPrdContext,
} from "./prd-context";
import {
  buildQaCasePreviewPayload,
  buildQaFallbackResult as buildQaFallbackResultFromQaSupport,
  collectQaCases as collectQaCasesFromQaSupport,
  discoverExplicitQaBaseUrl as discoverExplicitQaBaseUrlFromQaSupport,
  discoverReachableQaBaseUrl as discoverReachableQaBaseUrlFromQaSupport,
  extractQaUrlCandidates as extractQaUrlCandidatesFromQaSupport,
  isReachableUrl as isReachableUrlFromQaSupport,
} from "./qa-support";
import {
  buildHumanSummaryFromResult as buildHumanSummaryFromPhaseSummary,
  buildPhaseSummary as buildPhaseSummaryFromModule,
} from "./phase-summary";
import { executeVerifyPhase } from "./verify-phase";
import { executeApiPhase, executePrdPhase } from "./document-phases";
import { executeCodingPhase, executePlanPhase } from "./plan-coding-phases";
import { executeStageReplay } from "./stage-replay";
import { buildHermesCheckpointLessons, runHermesEvolutionFlow } from "./hermes-runtime";
import { mergeCheckpointLessons, preparePipelineRunContext } from "./pipeline-context";
import { finalizeWorkflowAbort, finalizeWorkflowError, finalizeWorkflowSuccess } from "./workflow-outcome";

/**
 * V2Orchestrator 是整条流水线的总控器。
 *
 * 它承担四类职责：
 * 1. 组织阶段顺序：INTENT -> PRD -> API -> PLAN -> CODING -> VERIFY
 * 2. 维护跨阶段共享上下文：projectPath、targetComponent、phaseArtifacts
 * 3. 负责本地校验、修复循环、QA runtime 发现与自动启动
 * 4. 落调试快照，支持 stage replay
 *
 * 可以把它理解为“带状态的工作流引擎”，而不是单纯的函数编排器。
 */
export class V2Orchestrator extends EventEmitter {
  private abortController: AbortController;
  private prdAgent?: PRDAgent;
  private apiAgent?: APIAgent;
  private plannerAgent?: PlannerAgent;
  private coderAgent?: CoderAgent;
  private qaAgent?: QAAgent;
  private projectPath: string = "";
  private targetRoute: string = "";
  private targetComponentPath: string = "";
  private taskObjective: string = "";
  private evalHarness = new EvalHarness(process.cwd());
  private qaRuntimeProc: ChildProcess | null = null;
  private debugSnapshot: DebugRunSnapshot | null = null;
  private phaseArtifacts: Partial<{
    INTENT: PhaseArtifactEnvelope<IntentArtifact>;
    PRD: PhaseArtifactEnvelope<PrdArtifact>;
    API: PhaseArtifactEnvelope<ApiArtifact>;
    PROJECT_SNAPSHOT: PhaseArtifactEnvelope<ProjectSnapshotArtifact>;
    PLAN: PhaseArtifactEnvelope<PlanArtifact>;
    CODING: PhaseArtifactEnvelope<CodeArtifact>;
    VERIFY: PhaseArtifactEnvelope<VerifyArtifact>;
  }> = {};

  private larkPrefetcher = new LarkPrefetcher((tool, dur, ok, det) => {
    this.log(`[Prefetch Telemetry] ${tool} - ${dur}ms - ${ok} - ${det || ""}`);
  });

  constructor(
    private llmConfig: LLMConfig,
    private mcpHub: MCPHub
  ) {
    super();
    this.abortController = new AbortController();
  }

  /** 把 orchestrator 自己的运行日志写进 harness。 */
  private log(content: string) {
    appendHarnessLog("orchestrator.log", `🚀 [runId=${this.runId}] ${content}`);
  }

  /** 当前 orchestrator 对应的 runId。 */
  private get runId() {
    return this.llmConfig.runId || "run_unknown";
  }

  /** 记录结构化 workflow 埋点，供时间线和 replay 复用。 */
  private trace(type: string, payload: Record<string, unknown>) {
    appendHarnessJsonl("workflow_steps.jsonl", {
      runId: this.runId,
      type,
      ...payload,
    });
  }

  /** 广播某个阶段的开始事件。 */
  private emitStepStart(phase: string, title: string, index: number) {
    this.log(`[STEP_START] phase=${phase} index=${index} title=${title}`);
    this.trace("step_start", { phase, title, index });
    this.emit("step-start", { phase, title, index });
  }

  /** 广播阶段中的实时进度，支持系统提示和模型思考流两种内容。 */
  private emitStepProgress(data: { phase: string; index: number; thought?: string; content?: string }) {
    this.trace("step_progress", {
      phase: data.phase,
      index: data.index,
      thoughtLen: data.thought?.length || 0,
      contentLen: data.content?.length || 0,
      preview: summarizeText(data.content || data.thought || ""),
    });
    this.emit("step-progress", data);
  }

  /** 广播某个阶段的完成事件。 */
  private emitStepComplete(phase: string, status: string, index: number) {
    this.log(`[STEP_COMPLETE] phase=${phase} index=${index} status=${status}`);
    this.trace("step_complete", { phase, status, index });
    this.emit("step-complete", { phase, status, index });
  }

  /** 广播阶段摘要，给前端展示“这一阶段产出了什么”。 */
  private emitPhaseSummary(data: {
    phase: string;
    index: number;
    title: string;
    summary: string;
    highlights: string[];
    stats: string[];
  }) {
    this.trace("phase_summary", {
      phase: data.phase,
      index: data.index,
      title: data.title,
      summary: data.summary,
      highlights: data.highlights,
      stats: data.stats,
    });
    this.emit("phase-summary", data);
  }

  /** 广播整个工作流结束。 */
  private emitWorkflowComplete(status: string, message?: string) {
    this.log(`[WORKFLOW_COMPLETE] status=${status}${message ? ` message=${message}` : ""}`);
    this.trace("workflow_complete", { status, message: message || "" });
    this.emit("workflow-complete", { status, message });
  }

  /** 保存某个阶段的 artifact，并同步写回 debug snapshot。 */
  private setPhaseArtifact<K extends keyof V2Orchestrator["phaseArtifacts"]>(
    phase: K,
    envelope: NonNullable<V2Orchestrator["phaseArtifacts"][K]>,
  ) {
    this.phaseArtifacts[phase] = envelope;
    this.trace("phase_artifact", {
      phase,
      humanSummary: envelope.human_summary,
      artifactKeys: envelope.artifact && typeof envelope.artifact === "object"
        ? Object.keys(envelope.artifact as unknown as Record<string, unknown>)
        : [],
    });
    this.syncDebugArtifacts();
  }

  /** 读取某个阶段的人类可读摘要。 */
  private getArtifactSummary(phase: keyof V2Orchestrator["phaseArtifacts"]): string {
    return this.phaseArtifacts[phase]?.human_summary || "";
  }

  /** 打包当前所有阶段 artifact，供后续阶段继续复用。 */
  private getPipelineArtifacts() {
    return {
      intent: this.phaseArtifacts.INTENT?.artifact,
      prd: this.phaseArtifacts.PRD?.artifact,
      api: this.phaseArtifacts.API?.artifact,
      projectSnapshot: this.phaseArtifacts.PROJECT_SNAPSHOT?.artifact,
      plan: this.phaseArtifacts.PLAN?.artifact,
      code: this.phaseArtifacts.CODING?.artifact,
      verify: this.phaseArtifacts.VERIFY?.artifact,
    };
  }

  /** 初始化本次 run 的 debug snapshot 外壳。 */
  private initializeDebugSnapshot(
    prompt: string,
    options?: {
      mode?: "full" | "replay";
      replayOf?: { runId: string; stage: ReplayStageName } | null;
    },
  ) {
    this.debugSnapshot = createDebugSnapshot({
      runId: this.runId,
      prompt,
      modelConfig: {
        type: (this.llmConfig as any)?.type || "",
        baseUrl: this.llmConfig.baseUrl || "",
        model: this.llmConfig.model || "",
        modelId: this.llmConfig.modelId || "",
        hasApiKey: Boolean(this.llmConfig.apiKey),
        qaConfig: cloneForDebug(this.llmConfig.qaConfig || {}),
      },
      context: {
        projectPath: this.projectPath,
        targetRoute: this.targetRoute,
        targetComponentPath: this.targetComponentPath,
        taskObjective: this.taskObjective,
      },
      options,
    });
    this.persistDebugSnapshot();
  }

  /** 把当前 snapshot 落盘到 debug-run-store。 */
  private persistDebugSnapshot() {
    if (!this.debugSnapshot) return;
    this.debugSnapshot.updatedAt = new Date().toISOString();
    writeDebugRunSnapshot(this.debugSnapshot);
  }

  /** 更新 snapshot 的整体状态，例如 running / success / error。 */
  private updateDebugSnapshotStatus(status: string) {
    if (!this.debugSnapshot) return;
    this.debugSnapshot = withDebugSnapshotStatus(this.debugSnapshot, status);
    this.persistDebugSnapshot();
  }

  /** 增量更新 snapshot.context，避免每次都重建整份上下文。 */
  private updateDebugContext(patch: Record<string, unknown>) {
    if (!this.debugSnapshot) return;
    this.debugSnapshot = withMergedDebugContext(this.debugSnapshot, patch);
    this.persistDebugSnapshot();
  }

  /** 把内存中的 artifacts 镜像到 snapshot.artifacts。 */
  private syncDebugArtifacts() {
    if (!this.debugSnapshot) return;
    this.debugSnapshot = withSyncedDebugArtifacts(
      this.debugSnapshot,
      this.phaseArtifacts as unknown as Record<string, unknown>,
    );
    this.persistDebugSnapshot();
  }

  /** 记录某个阶段的一次具体尝试，供后续 replay 和排障查看。 */
  private appendDebugStageAttempt(
    stage: ReplayStageName,
    label: string,
    input?: unknown,
    output?: unknown,
    error?: string,
    meta?: Record<string, unknown>,
  ) {
    if (!this.debugSnapshot) return;
    this.debugSnapshot = withAppendedDebugStageAttempt(
      this.debugSnapshot,
      stage,
      label,
      input,
      output,
      error,
      meta,
    );
    this.persistDebugSnapshot();
  }

  /** 收口某个阶段当前最终对外可见的输入/输出/摘要。 */
  private finalizeDebugStage(
    stage: ReplayStageName,
    payload: {
      replayInput?: unknown;
      output?: unknown;
      artifact?: unknown;
      humanSummary?: string;
      meta?: Record<string, unknown>;
    },
  ) {
    if (!this.debugSnapshot) return;
    this.debugSnapshot = withFinalizedDebugStage(this.debugSnapshot, stage, payload);
    this.syncDebugArtifacts();
  }

  /** 用历史 snapshot 回填 orchestrator 现场，主要给 replay 使用。 */
  private hydrateFromDebugSnapshot(snapshot: DebugRunSnapshot) {
    const runtimeState = deriveRuntimeStateFromSnapshot(snapshot);
    this.projectPath = runtimeState.projectPath;
    this.targetRoute = runtimeState.targetRoute;
    this.targetComponentPath = runtimeState.targetComponentPath;
    this.taskObjective = runtimeState.taskObjective;
    this.llmConfig.projectPath = this.projectPath;
    this.phaseArtifacts = runtimeState.phaseArtifacts as V2Orchestrator["phaseArtifacts"];
  }

  /** 返回某个阶段在 UI 时间线中的标题和索引。 */
  private getStageDescriptor(stage: ReplayStageName) {
    return getReplayStageDescriptor(stage);
  }

  /** 在 projectPath 已知后，统一初始化所有阶段 agent。 */
  private initializePhaseAgents(signal: AbortSignal) {
    this.prdAgent = new PRDAgent(this.llmConfig, this.mcpHub, signal);
    this.apiAgent = new APIAgent(this.llmConfig, this.mcpHub, signal);
    this.plannerAgent = new PlannerAgent(this.llmConfig, this.mcpHub, signal);
    this.coderAgent = new CoderAgent(this.llmConfig, this.mcpHub, signal);
    this.qaAgent = new QAAgent(this.llmConfig, this.mcpHub, signal);
  }

  /** 组装 Hermes 经验检索条件，让 lessons 尽量与当前任务相关。 */
  private buildLessonQuery(originalPrompt: string, stage?: LessonStage, extra?: Partial<LessonQuery>): LessonQuery {
    return {
      originalPrompt,
      projectPath: this.projectPath,
      targetRoute: this.targetRoute,
      targetComponentPath: this.targetComponentPath,
      taskObjective: this.taskObjective,
      stage,
      ...extra,
    };
  }

  /** 读取某个 harness jsonl 文件里属于当前 run 的记录。 */
  private readHarnessJsonlForRun(fileName: string): Array<Record<string, unknown>> {
    const filePath = path.join(process.cwd(), ".harness", fileName);
    if (!fs.existsSync(filePath)) return [];

    try {
      const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean).slice(-4000);
      return lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry) => entry && String(entry.runId || "") === this.runId) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  }

  /** 取某个阶段最近一次失败的 error 文本。 */
  private getLatestStageError(stage: ReplayStageName): string {
    const attempts = this.debugSnapshot?.stages?.[stage]?.attempts || [];
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      const error = String(attempts[index]?.error || "").trim();
      if (error) return error;
    }
    return "";
  }

  private async runHermesEvolution(
    workflowStatus: "success" | "error" | "aborted",
    finalMessage?: string,
    options?: { allowLLM?: boolean },
  ) {
    await runHermesEvolutionFlow({
      runId: this.runId,
      llmConfig: this.llmConfig,
      mcpHub: this.mcpHub,
      evalHarness: this.evalHarness,
      debugSnapshot: this.debugSnapshot,
      projectPath: this.projectPath,
      targetRoute: this.targetRoute,
      targetComponentPath: this.targetComponentPath,
      taskObjective: this.taskObjective,
      workflowStatus,
      finalMessage,
      allowLLM: options?.allowLLM,
      signalAborted: this.abortController.signal.aborted,
      artifactSummaryByStage: {
        INTENT: this.getArtifactSummary("INTENT"),
        PRD: this.getArtifactSummary("PRD"),
        API: this.getArtifactSummary("API"),
        PLAN: this.getArtifactSummary("PLAN"),
        CODING: this.getArtifactSummary("CODING"),
        VERIFY: this.getArtifactSummary("VERIFY"),
      },
      apiArtifact: (this.phaseArtifacts.API?.artifact || null) as ApiArtifact | null,
      planArtifact: (this.phaseArtifacts.PLAN?.artifact || null) as PlanArtifact | null,
      verifyArtifact: (this.phaseArtifacts.VERIFY?.artifact || null) as VerifyArtifact | null,
      buildLessonQuery: (originalPrompt, stage, extra) => this.buildLessonQuery(originalPrompt, stage, extra),
      getLatestStageError: (stage) => this.getLatestStageError(stage),
      findPlanApiCoverageGaps: (plan, api) => this.findPlanApiCoverageGaps(plan, api),
      readWorkflowEntries: () => this.readHarnessJsonlForRun("workflow_steps.jsonl"),
      trace: (type, payload) => this.trace(type, payload),
      updateDebugContext: (patch) => this.updateDebugContext(patch),
    });
  }

  /** 生成当前阶段的 Hermes 在线 checkpoint，并返回可注入给后续阶段的 lessons 文本。 */
  private runHermesCheckpoint(
    triggerStage: ReplayStageName | "SYSTEM",
    workflowStatus: "success" | "error" | "aborted",
    finalMessage?: string,
  ): string {
    return buildHermesCheckpointLessons({
      runId: this.runId,
      llmConfig: this.llmConfig,
      mcpHub: this.mcpHub,
      evalHarness: this.evalHarness,
      debugSnapshot: this.debugSnapshot,
      projectPath: this.projectPath,
      targetRoute: this.targetRoute,
      targetComponentPath: this.targetComponentPath,
      taskObjective: this.taskObjective,
      triggerStage,
      workflowStatus,
      finalMessage,
      artifactSummaryByStage: {
        INTENT: this.getArtifactSummary("INTENT"),
        PRD: this.getArtifactSummary("PRD"),
        API: this.getArtifactSummary("API"),
        PLAN: this.getArtifactSummary("PLAN"),
        CODING: this.getArtifactSummary("CODING"),
        VERIFY: this.getArtifactSummary("VERIFY"),
      },
      apiArtifact: (this.phaseArtifacts.API?.artifact || null) as ApiArtifact | null,
      planArtifact: (this.phaseArtifacts.PLAN?.artifact || null) as PlanArtifact | null,
      verifyArtifact: (this.phaseArtifacts.VERIFY?.artifact || null) as VerifyArtifact | null,
      buildLessonQuery: (originalPrompt, stage, extra) => this.buildLessonQuery(originalPrompt, stage, extra),
      getLatestStageError: (stage) => this.getLatestStageError(stage),
      findPlanApiCoverageGaps: (plan, api) => this.findPlanApiCoverageGaps(plan, api),
      readWorkflowEntries: () => this.readHarnessJsonlForRun("workflow_steps.jsonl"),
      trace: (type, payload) => this.trace(type, payload),
      updateDebugContext: (patch) => this.updateDebugContext(patch),
    });
  }

  /**
   * 从阶段原始结果里提取一句“人类可读摘要”。
   *
   * 这句摘要会被重复用于：
   * - phase artifact 的 human summary
   * - debug snapshot 的阶段摘要
   * - replay 面板里对该阶段的简述
   *
   * 设计目标不是“信息最全”，而是“快速告诉人：这一阶段做成了什么”。
   */
  private buildHumanSummaryFromResult(label: string, result: any): string {
    return buildHumanSummaryFromPhaseSummary(label, result);
  }

  /** 校验 PRD 阶段是否满足进入 API/PLAN 的最低门槛。 */
  private ensurePrdArtifactGate(prdArtifact: PrdArtifact) {
    if (prdArtifact.logic_rules.length === 0) {
      throw new Error("PRD 阶段未产出 logic_rules，已阻止继续进入后续步骤。");
    }

    const expectsPlacement = /表格|功能详述|截图|原型|页面位置|入口/.test(
      [prdArtifact.content_verified, ...prdArtifact.evidence_refs].join("\n"),
    );
    if (expectsPlacement && prdArtifact.placement_hints.length === 0) {
      throw new Error("PRD 阶段识别到功能详述/页面落点证据，但未产出 placement_hints。");
    }
    if (expectsPlacement && prdArtifact.evidence_refs.length === 0) {
      throw new Error("PRD 阶段识别到原型/截图/表格类证据，但未保留 evidence_refs。");
    }
  }

  /** 校验 API 阶段是否给出了接口映射和证据锚点。 */
  private ensureApiArtifactGate(apiArtifact: ApiArtifact) {
    if (apiArtifact.api_mappings.length === 0) {
      throw new Error("API 阶段未产出 api_mappings，已阻止继续进入后续步骤。");
    }
    if (apiArtifact.evidence_refs.length === 0) {
      throw new Error("API 阶段未保留 evidence_refs，已阻止继续进入后续步骤。");
    }
  }

  /** 统一把覆盖语料归一化，便于后续做包含匹配。 */
  private normalizePlanCoverageText(text: string): string {
    return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  /** 把单条 API 映射拼成可读文本。 */
  private describeApiMapping(mapping: { endpoint?: string; method?: string; purpose?: string }): string {
    const method = String(mapping?.method || "").trim().toUpperCase();
    const endpoint = String(mapping?.endpoint || "").trim();
    const purpose = String(mapping?.purpose || "").trim();
    return `${method} ${endpoint}${purpose ? `（${purpose}）` : ""}`.trim();
  }

  /** 从 endpoint/purpose 中提取若干可用于覆盖判断的关键词。 */
  private extractApiCoverageKeywords(mapping: { endpoint?: string; method?: string; purpose?: string }): string[] {
    const endpoint = String(mapping?.endpoint || "").trim().toLowerCase();
    const purpose = String(mapping?.purpose || "").trim();
    const purposeLower = purpose.toLowerCase();
    const keywords = new Set<string>();

    if (endpoint) {
      keywords.add(endpoint);
      keywords.add(`${String(mapping?.method || "").trim().toLowerCase()} ${endpoint}`.trim());
      endpoint
        .split("/")
        .map((item) => item.trim())
        .filter((item) => item.length >= 3)
        .slice(-3)
        .forEach((item) => keywords.add(item.toLowerCase()));
    }

    if (purpose) {
      keywords.add(purpose);
      keywords.add(purposeLower);
    }

    const combined = `${endpoint} ${purposeLower}`;
    if (/(?:^|\/)(?:info|detail|query|get|list|state|status)(?:$|\/)|查询|获取|列表|详情|状态/.test(combined)) {
      ["info", "detail", "query", "get", "list", "state", "status", "查询", "获取", "列表", "详情", "状态同步"].forEach((item) =>
        keywords.add(item.toLowerCase()),
      );
    }
    if (/(?:^|\/)(?:create|add|submit|open|start|enable|apply)(?:$|\/)|创建|新增|提交|开启|启动|启用|申请/.test(combined)) {
      ["create", "add", "submit", "open", "start", "enable", "apply", "创建", "新增", "提交", "开启", "启动", "启用", "申请"].forEach(
        (item) => keywords.add(item.toLowerCase()),
      );
    }
    if (/(?:^|\/)(?:update|edit|save|confirm|approve|bind|sync)(?:$|\/)|更新|编辑|保存|确认|审批|绑定|同步/.test(combined)) {
      ["update", "edit", "save", "confirm", "approve", "bind", "sync", "更新", "编辑", "保存", "确认", "审批", "绑定", "同步"].forEach(
        (item) => keywords.add(item.toLowerCase()),
      );
    }
    if (/(?:^|\/)(?:delete|remove|cancel|reject|close|disable|stop)(?:$|\/)|删除|移除|取消|拒绝|关闭|停用|停止/.test(combined)) {
      ["delete", "remove", "cancel", "reject", "close", "disable", "stop", "删除", "移除", "取消", "拒绝", "关闭", "停用", "停止"].forEach(
        (item) => keywords.add(item.toLowerCase()),
      );
    }

    return Array.from(keywords).filter(Boolean);
  }

  /** 把整个计划压成一段文本语料，用于判断是否已经覆盖某条 API。 */
  private buildPlanCoverageCorpus(planArtifact: PlanArtifact): string {
    const blocks = [
      planArtifact.reasoning,
      ...planArtifact.files_to_modify.map((item) => `${item.path} ${item.description || ""}`),
      ...planArtifact.files_to_create.map((item) => `${item.path} ${item.content || item.description || ""}`),
      ...planArtifact.operations_outline.map((item) => `${item.target} ${item.kind} ${item.intent}`),
      ...planArtifact.verification_points,
      ...planArtifact.test_cases.flatMap((item) => [item.name, item.goal, ...item.preconditions, ...item.steps, ...item.expected]),
      ...planArtifact.risk_flags,
      ...planArtifact.api_coverage.flatMap((item) => [
        item.method,
        item.endpoint,
        item.purpose,
        item.decision,
        item.reason,
        ...item.target_files,
      ]),
    ];

    return this.normalizePlanCoverageText(blocks.filter(Boolean).join("\n"));
  }

  /** 判断计划正文、文件列表、验证点中是否已经提到某条 API。 */
  private planMentionsApiMapping(planArtifact: PlanArtifact, mapping: { endpoint?: string; method?: string; purpose?: string }): boolean {
    const corpus = this.buildPlanCoverageCorpus(planArtifact);
    if (!corpus) return false;

    const endpoint = this.normalizePlanCoverageText(String(mapping?.endpoint || ""));
    if (endpoint && corpus.includes(endpoint)) return true;

    const keywords = this.extractApiCoverageKeywords(mapping).map((item) => this.normalizePlanCoverageText(item));
    const keywordHits = keywords.filter((item) => item && corpus.includes(item));
    if (keywordHits.length >= 2) return true;

    const purpose = this.normalizePlanCoverageText(String(mapping?.purpose || ""));
    return Boolean(purpose && corpus.includes(purpose));
  }

  /** 当计划漏掉某条 API 时，给它自动补一个默认 implement 理由。 */
  private buildApiCoverageDecision(mapping: { endpoint?: string; method?: string; purpose?: string }): string {
    const combined = `${mapping?.endpoint || ""} ${mapping?.purpose || ""}`;
    if (/(?:^|\/)(?:info|detail|query|get|list|state|status)(?:$|\/)|查询|获取|列表|详情|状态/.test(combined)) {
      return "补齐查询或初始化接入，确保页面或流程能够拿到最新数据与状态。";
    }
    if (/(?:^|\/)(?:create|add|submit|open|start|enable|apply|update|edit|save|confirm|approve|bind|sync|delete|remove|cancel|reject|close|disable|stop)(?:$|\/)|创建|新增|提交|开启|启动|启用|申请|更新|编辑|保存|确认|审批|绑定|同步|删除|移除|取消|拒绝|关闭|停用|停止/.test(combined)) {
      return "补齐动作接口接入，并明确触发入口、参数组织、结果回流与后续状态同步。";
    }
    return "补齐该接口在当前页面或相关流程中的承接方式，并同步明确验证点。";
  }

  /** 为某条 API 自动生成一条验证点。 */
  private buildApiVerificationPoint(mapping: { endpoint?: string; method?: string; purpose?: string }): string {
    const endpoint = String(mapping?.endpoint || "").trim();
    const combined = `${mapping?.endpoint || ""} ${mapping?.purpose || ""}`;
    if (/(?:^|\/)(?:info|detail|query|get|list|state|status)(?:$|\/)|查询|获取|列表|详情|状态/.test(combined)) {
      return `${endpoint || "查询接口"} 应在合适的初始化时机被调用，并驱动页面或流程中的数据/状态同步。`;
    }
    if (/(?:^|\/)(?:create|add|submit|open|start|enable|apply|update|edit|save|confirm|approve|bind|sync|delete|remove|cancel|reject|close|disable|stop)(?:$|\/)|创建|新增|提交|开启|启动|启用|申请|更新|编辑|保存|确认|审批|绑定|同步|删除|移除|取消|拒绝|关闭|停用|停止/.test(combined)) {
      return `${endpoint || "动作接口"} 被触发后，应完成预期交互、状态回流或结果提示，并在需要时刷新相关数据。`;
    }
    return `${endpoint || "目标接口"} 应在本轮实现中具备清晰的调用入口、结果反馈和验证方式。`;
  }

  /** 把 API 识别结果强制灌回计划，避免 PLAN 静默漏掉接口。 */
  private enrichPlanWithApiCoverage(plan: any, apiArtifact: ApiArtifact): any {
    if (!plan || typeof plan !== "object") return plan;
    if (!Array.isArray(apiArtifact?.api_mappings) || apiArtifact.api_mappings.length === 0) return plan;

    const clone = JSON.parse(JSON.stringify(plan));
    const planArtifact = normalizePlanArtifact(clone);
    const existingCoverage = Array.isArray(clone.api_coverage) ? clone.api_coverage : [];
    const existingModifyFiles = Array.isArray(clone.files_to_modify) ? clone.files_to_modify : [];
    const existingCreateFiles = Array.isArray(clone.files_to_create) ? clone.files_to_create : [];
    const targetFiles = Array.from(new Set([
      this.targetComponentPath,
      ...existingModifyFiles.map((item: any) => item?.path || item?.file || item?.target_file || ""),
      ...existingCreateFiles.map((item: any) => item?.path || item?.file || item?.target_file || ""),
    ].filter(Boolean))).slice(0, 4);

    for (const mapping of apiArtifact.api_mappings.slice(0, 6)) {
      const mappingEndpoint = this.normalizePlanCoverageText(mapping.endpoint);
      const mappingMethod = this.normalizePlanCoverageText(mapping.method);
      const hasExplicitCoverage = existingCoverage.some((item: any) => {
        const endpoint = this.normalizePlanCoverageText(String(item?.endpoint || ""));
        const method = this.normalizePlanCoverageText(String(item?.method || ""));
        return Boolean(endpoint && endpoint === mappingEndpoint && (!mappingMethod || !method || method === mappingMethod));
      });

      if (!hasExplicitCoverage) {
        existingCoverage.push({
          method: mapping.method,
          endpoint: mapping.endpoint,
          purpose: mapping.purpose,
          decision: "implement",
          reason: this.planMentionsApiMapping(planArtifact, mapping)
            ? "规划正文已体现该接口的接入方向，已补齐结构化接口决策记录。"
            : `API 阶段已识别该接口，本轮方案需显式覆盖，已自动补齐为：${this.buildApiCoverageDecision(mapping)}。`,
          target_files: targetFiles,
        });
      }
    }

    const verificationPoints = Array.isArray(clone.verification_points) ? clone.verification_points.slice() : [];
    for (const mapping of apiArtifact.api_mappings.slice(0, 6)) {
      const candidate = this.buildApiVerificationPoint(mapping);
      const normalizedCandidate = this.normalizePlanCoverageText(candidate);
      const exists = verificationPoints.some((item: string) => {
        const current = this.normalizePlanCoverageText(item);
        return current.includes(this.normalizePlanCoverageText(mapping.endpoint))
          || current === normalizedCandidate
          || (mapping.purpose && current.includes(this.normalizePlanCoverageText(mapping.purpose)));
      });
      if (!exists) verificationPoints.push(candidate);
    }

    clone.api_coverage = existingCoverage;
    clone.verification_points = Array.from(new Set(verificationPoints)).slice(0, 8);
    if (!Array.isArray(clone.risk_flags)) clone.risk_flags = [];

    const autoCoverageRisk = "接口映射已自动补齐到实施方案，请在编码阶段核对每个接口的触发时机、入口归属、参数来源和结果回流是否与真实业务一致。";
    if (!clone.risk_flags.includes(autoCoverageRisk) && existingCoverage.length > 0) {
      clone.risk_flags = [...clone.risk_flags, autoCoverageRisk].slice(0, 8);
    }

    return clone;
  }

  /** 找出计划里仍未显式覆盖的 API。 */
  private findPlanApiCoverageGaps(planArtifact: PlanArtifact, apiArtifact: ApiArtifact): string[] {
    if (!Array.isArray(apiArtifact?.api_mappings) || apiArtifact.api_mappings.length === 0) return [];

    return apiArtifact.api_mappings
      .slice(0, 6)
      .filter((mapping) => {
        const endpoint = this.normalizePlanCoverageText(mapping.endpoint);
        const method = this.normalizePlanCoverageText(mapping.method);
        const hasExplicitCoverage = planArtifact.api_coverage.some((item) => {
          const coverageEndpoint = this.normalizePlanCoverageText(item.endpoint);
          const coverageMethod = this.normalizePlanCoverageText(item.method);
          return Boolean(
            coverageEndpoint &&
            coverageEndpoint === endpoint &&
            (!method || !coverageMethod || coverageMethod === method),
          );
        });
        return !hasExplicitCoverage && !this.planMentionsApiMapping(planArtifact, mapping);
      })
      .map((mapping) => this.describeApiMapping(mapping));
  }

  /** 校验 PLAN 阶段是否已经具备进入编码的必要结构。 */
  private ensurePlanArtifactGate(planArtifact: PlanArtifact, apiArtifact?: ApiArtifact) {
    const hasFiles =
      planArtifact.files_to_modify.length > 0 || planArtifact.files_to_create.length > 0;
    if (!hasFiles) {
      throw new Error("PLAN 阶段未产出 files_to_modify/files_to_create，已阻止继续进入编码。");
    }
    if (planArtifact.operations_outline.length === 0) {
      throw new Error("PLAN 阶段未产出 operations_outline，已阻止继续进入编码。");
    }
    if (isFeatureEnabled("ENABLE_TEST_CASES_V2") && planArtifact.test_cases.length === 0) {
      throw new Error("PLAN 阶段未产出 test_cases，已阻止继续进入验证环节。");
    }
    if (apiArtifact?.api_mappings?.length) {
      const coverageGaps = this.findPlanApiCoverageGaps(planArtifact, apiArtifact);
      if (coverageGaps.length > 0) {
        throw new Error(
          `PLAN 阶段未显式覆盖以下 API 映射：${coverageGaps.slice(0, 4).join("；")}。请在 api_coverage 中逐项说明 implement/defer 决策，并同步体现到 files_to_modify、operations_outline 或 verification_points。`,
        );
      }
    }
  }

  /** 把阶段原始输出转成前端摘要卡片和日志摘要。 */
  private summarizeResult(label: string, result: any) {
    const summary = {
      label,
      keys: result && typeof result === "object" ? Object.keys(result) : [],
      modules: Array.isArray(result?.modules) ? result.modules.length : undefined,
      logicRules: Array.isArray(result?.logic_rules) ? result.logic_rules.length : undefined,
      apiMappings: Array.isArray(result?.api_mappings) ? result.api_mappings.length : undefined,
      componentImpact: Array.isArray(result?.component_impact) ? result.component_impact.length : undefined,
      filesToCreate: Array.isArray(result?.files_to_create) ? result.files_to_create.length : undefined,
      filesToModify: Array.isArray(result?.files_to_modify) ? result.files_to_modify.length : undefined,
      verificationPoints: Array.isArray(result?.verification_points) ? result.verification_points.length : undefined,
      reasoningPreview: summarizeText(result?.reasoning || ""),
    };
    this.trace("phase_output", summary);
    this.log(`[PHASE_OUTPUT] ${label} ${JSON.stringify(summary)}`);
    const phaseSummary = this.buildPhaseSummary(label, result);
    if (phaseSummary) {
      this.emitPhaseSummary(phaseSummary);
    }
  }

  /**
   * 按阶段类型把原始结果翻译成时间线卡片数据。
   *
   * 这里是“结构化结果 -> 前端展示模型”的转换层：
   * - title / summary 负责一句话讲清结果
   * - highlights 负责列出最值得用户看的要点
   * - stats 负责展示量化信息，例如修改文件数、接口数、测试数
   */
  private buildPhaseSummary(label: string, result: any) {
    return buildPhaseSummaryFromModule(label, result);
  }

  /** 尽量从工具返回值里提取人可读文本，屏蔽掉 MCP 包装差异。 */
  private extractToolText(result: any): string {
    if (!result) return "";
    if (typeof result === "string") return result;

    if (Array.isArray(result.content)) {
      return result.content
        .map((item: any) => (typeof item?.text === "string" ? item.text : JSON.stringify(item)))
        .join("\n");
    }

    if (typeof result?.structuredContent?.content === "string") {
      return result.structuredContent.content;
    }

    return JSON.stringify(result);
  }

  /** 预抓取项目目录树；失败时退化成根目录 listing。 */
  private async buildProjectTree(): Promise<string> {
    if (!this.projectPath) return "";

    try {
      const treeResult = await this.mcpHub.callTool("filesystem:directory_tree", {
        path: this.projectPath,
      });
      const treeText = this.extractToolText(treeResult).trim();
      if (treeText) return treeText.slice(0, 12000);
    } catch (error: any) {
      this.log(`Project tree prefetch failed, fallback to list_directory: ${error.message}`);
    }

    try {
      const listingResult = await this.mcpHub.callTool("filesystem:list_directory", {
        path: this.projectPath,
      });
      const listingText = this.extractToolText(listingResult).trim();
      if (listingText) return `[根目录概览]\n${listingText}`.slice(0, 12000);
    } catch (error: any) {
      this.log(`Project root listing fallback failed: ${error.message}`);
    }

    return "";
  }

  /** 从用户原始长提示中提炼一句简短任务目标。 */
  private extractTaskObjective(prompt: string): string {
    return extractTaskObjectiveFromPrdContext(prompt);
  }

  /** 生成贯穿 PRD/API/PLAN/CODING 的统一执行摘要。 */
  private buildExecutionBrief(): string {
    return buildExecutionBriefFromPrdContext({
      taskObjective: this.taskObjective,
      projectPath: this.projectPath,
      targetRoute: this.targetRoute,
      targetComponentPath: this.targetComponentPath,
    });
  }

  /** 把超长 PRD/API 文档压缩成证据优先视图，减少模型阅读噪音。 */
  private buildFocusedDocumentContent(
    rawContent: string,
    phase: "PRD" | "API",
    seedTexts: string[] = [],
  ): string {
    return buildFocusedDocumentContentFromPrdContext(rawContent, phase, seedTexts);
  }

  /** 构造 PRD 的原型/截图/按钮/落点证据卡片。 */
  private buildPrdEvidenceContext(rawContent: string): string {
    return buildPrdEvidenceContextFromPrdContext(rawContent);
  }

  /** 把结构化 PRD 结果再压成一段短上下文，给后续阶段继续引用。 */
  private buildPrdFocusContext(prd: any): string {
    return buildPrdFocusContextFromPrdContext(prd);
  }

  /** 用本地兜底 PRD 结果回填模型输出，尽量保住后续阶段继续执行。 */
  private backfillPrdResultWithLocalEvidence(prdRes: any, rawContent: string, evidenceContext: string) {
    return backfillPrdResultWithLocalEvidenceFromPrdContext(prdRes, rawContent, evidenceContext, {
      taskObjective: this.taskObjective,
      targetRoute: this.targetRoute,
      targetComponentPath: this.targetComponentPath,
    });
  }

  /** 统一调用外提后的目标组件热点快照构建器。 */
  private buildTargetComponentContext(): string {
    return buildTargetComponentContextFromContext({
      projectPath: this.projectPath,
      taskObjective: this.taskObjective,
      targetRoute: this.targetRoute,
      targetComponentPath: this.targetComponentPath,
      log: (message) => this.log(message),
    });
  }

  /** 从计划或结果里提取标准化文件路径列表。 */
  private extractPlanFilePaths(plan: any, field: "files_to_modify" | "files_to_create"): string[] {
    return extractPlanFilePathsFromContext(plan, field);
  }

  /** 统一读取目标 API 所在目录的风格契约。 */
  private getApiStyleContract(targetRelativePath: string, limit: number = 2): {
    referenceFiles: string[];
    dominantImport: string;
    preferredExt: string;
  } {
    return getApiStyleContractFromContext({
      projectPath: this.projectPath,
      taskObjective: this.taskObjective,
      targetRoute: this.targetRoute,
      targetComponentPath: this.targetComponentPath,
      log: (message) => this.log(message),
    }, targetRelativePath, limit);
  }

  /** 检测某个目录里主流使用的脚本扩展名。 */
  private detectPreferredExtensionForDirectory(relativePath: string): string {
    return detectPreferredExtensionForDirectoryFromContext({
      projectPath: this.projectPath,
    }, relativePath);
  }

  /** 把 PLAN 结果里的文件路径修正到项目真实风格。 */
  private normalizePlanToProjectStyle(plan: any): any {
    return normalizePlanToProjectStyleFromContext({
      projectPath: this.projectPath,
    }, plan);
  }

  /** 汇总组件风格和 API 风格，生成给 CoderAgent 的风格快照。 */
  private buildStyleContext(plan: any): string {
    return buildStyleContextFromContext({
      projectPath: this.projectPath,
      taskObjective: this.taskObjective,
      targetRoute: this.targetRoute,
      targetComponentPath: this.targetComponentPath,
      log: (message) => this.log(message),
    }, plan);
  }

  /** 构造 PROJECT_SNAPSHOT artifact，沉淀给 PLAN/CODING/VERIFY 复用。 */
  private buildProjectSnapshotArtifact(
    targetComponentContext: string,
    styleContext: string,
    runtimeDiscovery: RuntimeDiscoveryResult | null,
  ): ProjectSnapshotArtifact {
    return buildProjectSnapshotArtifactFromContext({
      projectPath: this.projectPath,
      taskObjective: this.taskObjective,
      targetRoute: this.targetRoute,
      targetComponentPath: this.targetComponentPath,
      log: (message) => this.log(message),
    }, targetComponentContext, styleContext, runtimeDiscovery);
  }

  /**
   * 统一调用外提后的本地静态校验模块。
   *
   * 这样 `loop-manager` 只保留“何时校验、校验失败后怎么处理”的控制流，
   * 而把具体规则细节放到独立模块里维护。
   */
  private runLocalCodingValidation(result: any, plan: any): ValidationReport {
    return buildValidationReport({
      result,
      plan,
      projectPath: this.projectPath,
      targetComponentPath: this.targetComponentPath,
      targetRoute: this.targetRoute,
      taskObjective: this.taskObjective,
      phaseArtifacts: {
        PRD: this.phaseArtifacts.PRD,
        API: this.phaseArtifacts.API,
      },
      useAstGate: isFeatureEnabled("ENABLE_AST_GATE"),
      getApiStyleContract: this.getApiStyleContract.bind(this),
      detectPreferredExtensionForDirectory: this.detectPreferredExtensionForDirectory.bind(this),
    });
  }

  /** 把 validation report 的核心统计写入 trace，方便后续排障和 replay 对比。 */
  private traceValidationReport(traceKey: string, report: ValidationReport) {
    this.trace(traceKey, {
      checkedFiles: report.checkedFiles,
      issueCount: report.issues.length,
      errorCount: report.issues.filter((item) => item.severity === "error").length,
      warningCount: report.issues.filter((item) => item.severity === "warning").length,
      highlights: report.highlights,
    });
  }

  /**
   * 当编码结果被修复或重跑后，同步刷新内存中的 CODING artifact。
   *
   * 这样 VERIFY、replay 和 debug snapshot 看到的永远是“当前最新代码结果”，
   * 而不是第一次生成的旧版本。
   */
  private syncCodingArtifactIfAvailable(result: any, validationSummary: string[] = []) {
    if (!this.phaseArtifacts.CODING && !isFeatureEnabled("ENABLE_PHASE_ARTIFACTS")) {
      return;
    }

    const artifact = normalizeCodeArtifact(result, validationSummary);
    this.setPhaseArtifact(
      "CODING",
      buildArtifactEnvelope("CODING", this.buildHumanSummaryFromResult("CODING", result), artifact),
    );
  }

  /**
   * 为“修复轮”重建一份更新后的 coding 输入。
   *
   * 原因是 blocking fix 往往发生在已经写过一轮代码之后，
   * 此时目标组件上下文、风格快照、artifact 可能都变了；
   * 如果还拿旧输入继续修，模型容易修在过期上下文上。
   */
  private buildRefreshedCodingInput(
    baseInput: CodingExecutionInput,
    planArtifact: any,
    error: string,
  ): CodingExecutionInput {
    const refreshedTargetComponentContext = this.buildTargetComponentContext();
    const refreshedStyleContext = this.buildStyleContext(planArtifact);

    return {
      ...baseInput,
      error,
      projectPath: this.projectPath || baseInput.projectPath,
      targetComponentPath: this.targetComponentPath || baseInput.targetComponentPath,
      targetRoute: this.targetRoute || baseInput.targetRoute,
      targetComponentContext: refreshedTargetComponentContext || baseInput.targetComponentContext,
      styleContext: refreshedStyleContext || baseInput.styleContext,
      artifacts: this.getPipelineArtifacts(),
    };
  }

  /** 给每次 repair attempt 生成稳定标签，便于 debug snapshot 和日志回看。 */
  private buildRepairAttemptLabel(
    prefix: string,
    kind: "blocking_fix" | "consistency_fix",
    round: number,
  ): string {
    const base = `${prefix}_${kind}`;
    return round > 1 ? `${base}_${round}` : base;
  }

  /**
   * 编码后本地校验修复循环。
   *
   * 这一步是“模型说自己写完了”到“系统确认真的能放行”之间的关键保险丝：
   * - 先对 coding result 做本地 validation
   * - 若有阻断问题，构造更聚焦的 repair prompt 再调一次 CoderAgent
   * - 阻断问题清空后，再做一次一致性反思修复
   *
   * 这样可以显著降低“summary 写得很好看，但代码其实没闭环”的概率。
   */
  private async runCodingValidationRepairLoop(params: {
    initialResult: any;
    baseInput: CodingExecutionInput;
    planArtifact: any;
    sharedLessons: string;
    progressPhase: "CODING" | "VERIFY";
    progressIndex: number;
    attemptLabelPrefix: string;
    sourceRunId?: string;
    maxBlockingFixRounds?: number;
  }): Promise<{ result: any; validationReport: ValidationReport }> {
    let result = params.initialResult;
    let validationReport = this.runLocalCodingValidation(result, params.planArtifact);
    this.traceValidationReport(`${params.attemptLabelPrefix}_validation_report`, validationReport);

    const maxBlockingFixRounds = Math.max(1, params.maxBlockingFixRounds ?? 2);
    let blockingFixRound = 0;

    const runBlockingFixes = async (roundBudget: number, isFollowUp: boolean = false) => {
      while (validationReport.hasBlockingIssues && blockingFixRound < roundBudget) {
        blockingFixRound += 1;
        this.emitStepProgress({
          phase: params.progressPhase,
          content: isFollowUp && blockingFixRound > 1
            ? "[系统] 反思修复后仍存在阻断问题，正在执行一次兜底补救。"
            : blockingFixRound === 1
              ? "[系统] 本地校验发现阻断问题，正在执行一次轻量修复。"
              : `[系统] 本地校验第 ${blockingFixRound} 轮仍有阻断问题，继续执行一次更聚焦的修复。`,
          index: params.progressIndex,
        });

        const repairInput = this.buildRefreshedCodingInput(
          params.baseInput,
          params.planArtifact,
          buildValidationFixPrompt(validationReport),
        );
        result = await this.coderAgent!.execute(
          repairInput,
          params.sharedLessons,
          this.forwardAgentProgress(params.progressPhase, params.progressIndex),
        );
        this.appendDebugStageAttempt(
          "CODING",
          this.buildRepairAttemptLabel(params.attemptLabelPrefix, "blocking_fix", blockingFixRound),
          repairInput,
          result,
          undefined,
          params.sourceRunId ? { sourceRunId: params.sourceRunId } : undefined,
        );
        this.syncCodingArtifactIfAvailable(result);

        validationReport = this.runLocalCodingValidation(result, params.planArtifact);
        this.traceValidationReport(
          `${params.attemptLabelPrefix}_validation_recheck_${blockingFixRound}`,
          validationReport,
        );
      }
    };

    await runBlockingFixes(maxBlockingFixRounds);

    if (!validationReport.hasBlockingIssues && shouldRunConsistencyReview(validationReport)) {
      this.emitStepProgress({
        phase: params.progressPhase,
        content: "[系统] 本地校验发现高价值一致性提醒，正在执行一次轻量反思修复。",
        index: params.progressIndex,
      });
      const reviewInput = this.buildRefreshedCodingInput(
        params.baseInput,
        params.planArtifact,
        buildConsistencyReviewPrompt(validationReport),
      );
      result = await this.coderAgent!.execute(
        reviewInput,
        params.sharedLessons,
        this.forwardAgentProgress(params.progressPhase, params.progressIndex),
      );
      this.appendDebugStageAttempt(
        "CODING",
        this.buildRepairAttemptLabel(params.attemptLabelPrefix, "consistency_fix", 1),
        reviewInput,
        result,
        undefined,
        params.sourceRunId ? { sourceRunId: params.sourceRunId } : undefined,
      );
      this.syncCodingArtifactIfAvailable(result);

      validationReport = this.runLocalCodingValidation(result, params.planArtifact);
      this.traceValidationReport(`${params.attemptLabelPrefix}_validation_consistency_recheck`, validationReport);

      if (validationReport.hasBlockingIssues) {
        await runBlockingFixes(blockingFixRound + 1, true);
      }
    }

    return { result, validationReport };
  }

  /**
   * 汇总 VERIFY 阶段要跑的测试点。
   *
   * 优先级是：
   * 1. 结构化 test_cases
   * 2. coding 阶段给出的 verification_points
   * 3. plan 阶段给出的 verification_points
   *
   * 最终只保留少量高价值 case，避免 QA prompt 过长。
   */
  private collectQaCases(codingRes: any, planRes: any): string[] {
    return collectQaCasesFromQaSupport(codingRes, planRes);
  }

  /** 探测当前 MCP 环境里是否真的挂上了 chrome-devtools，用来决定能否执行浏览器 QA。 */
  private async hasChromeDevtoolsTools(): Promise<boolean> {
    try {
      const tools = await this.mcpHub.getAllTools();
      return tools.some((tool) => tool?.serverName === "chrome-devtools");
    } catch (error: any) {
      this.log(`Chrome DevTools availability probe failed: ${error.message}`);
      return false;
    }
  }

  /** 从用户提示词中抽取显式写出来的 localhost/127.0.0.1 地址。 */
  private extractQaUrlCandidates(prompt: string): string[] {
    return extractQaUrlCandidatesFromQaSupport(prompt);
  }

  /** 用一个轻量 HTTP 探测判断某个站点当前是否可访问。 */
  private async isReachableUrl(url: string): Promise<boolean> {
    return isReachableUrlFromQaSupport(url);
  }

  /**
   * 按“显式优先”顺序寻找 QA baseUrl。
   *
   * 来源依次包括：
   * - llmConfig.qaConfig.baseUrl
   * - 环境变量
   * - 用户 prompt 里直接写出的 localhost 地址
   *
   * 只有真实可访问的候选才会被采用。
   */
  private async discoverExplicitQaBaseUrl(prompt: string): Promise<string> {
    return discoverExplicitQaBaseUrlFromQaSupport(prompt, {
      configuredBaseUrl: this.llmConfig.qaConfig?.baseUrl || "",
      envBaseUrls: [process.env.HARNESS_QA_BASE_URL, process.env.QA_BASE_URL].filter(Boolean) as string[],
    });
  }

  /**
   * 当没有显式站点地址时，基于端口提示做一次本地探测。
   *
   * 这一步不负责启动项目，只负责“扫一遍可能已经运行着的站点”。
   */
  private async discoverReachableQaBaseUrl(portHints: number[] = []): Promise<string> {
    return discoverReachableQaBaseUrlFromQaSupport(portHints);
  }

  /**
   * 在启动本地站点后持续轮询，直到某个候选 URL 可访问。
   *
   * 同时也会监听子进程是否提前退出，避免傻等超时。
   */
  private async waitForQaRuntimeUrl(urls: string[], proc: ChildProcess | null, timeoutMs: number = 60_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (proc && proc.exitCode !== null) {
        throw new Error(`本地测试服务启动失败，进程已退出 (exit=${proc.exitCode})。`);
      }

      for (const candidate of urls) {
        if (await this.isReachableUrl(candidate)) {
          return candidate.replace(/\/+$/, "");
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    throw new Error("等待本地测试服务启动超时，未探测到可访问站点。");
  }

  /** 停掉上一轮自动拉起的 QA runtime，避免重复启动造成端口冲突。 */
  private stopQaRuntimeProcess() {
    if (!this.qaRuntimeProc) return;
    try {
      this.qaRuntimeProc.kill("SIGTERM");
    } catch {
      // noop
    }
    this.qaRuntimeProc = null;
  }

  /**
   * 尝试自动拉起本地前端站点，并返回最终探测到的 baseUrl。
   *
   * 这里会按候选命令依次重试，并把 stdout/stderr 写入 `qa_runtime.log`，
   * 方便排查为什么某个脚本没能拉起来。
   */
  private async tryAutoBootQaRuntime(selected: ProjectRuntimeOption, packageManager: "yarn" | "pnpm" | "npm"): Promise<{ baseUrl: string; launchLabel: string }> {
    this.stopQaRuntimeProcess();
    const launchCandidates = getRuntimeLaunchCandidates(selected.scriptName, packageManager);
    if (launchCandidates.length === 0) {
      throw new Error("未找到可用的本地包管理器命令（yarn/pnpm/npm），无法自动启动 QA 运行时。");
    }

    const launchErrors: string[] = [];
    for (const { bin, args, label } of launchCandidates) {
      appendHarnessLog("qa_runtime.log", `🚀 [runId=${this.runId}] launching ${label} @ ${this.projectPath}`);
      const proc = spawn(bin, args, {
        cwd: this.projectPath,
        env: {
          ...process.env,
          BROWSER: "none",
          CI: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.qaRuntimeProc = proc;

      proc.stdout?.on("data", (chunk) => {
        appendHarnessLog("qa_runtime.log", `[stdout] ${summarizeText(String(chunk || ""))}`);
      });
      proc.stderr?.on("data", (chunk) => {
        appendHarnessLog("qa_runtime.log", `[stderr] ${summarizeText(String(chunk || ""))}`);
      });
      proc.on("exit", (code, signal) => {
        appendHarnessLog("qa_runtime.log", `🛑 [runId=${this.runId}] runtime exited code=${code} signal=${signal || ""}`);
      });

      try {
        const baseUrl = await Promise.race([
          this.waitForQaRuntimeUrl(buildQaProbeUrls(selected.portHints), proc),
          new Promise<string>((_, reject) => {
            proc.once("error", (error) => {
              reject(new Error(`启动命令 ${label} 失败：${error.message}`));
            });
          }),
        ]);
        return { baseUrl, launchLabel: label };
      } catch (error: any) {
        launchErrors.push(String(error?.message || `${label} 启动失败`));
        appendHarnessLog("qa_runtime.log", `❌ [runId=${this.runId}] ${label} failed: ${String(error?.message || "unknown")}`);
        this.stopQaRuntimeProcess();
      }
    }

    throw new Error(`自动启动 QA 运行时失败：${launchErrors.join("；")}`);
  }

  /**
   * 当浏览器 QA 不能执行时，构造一份结构兼容的 fallback 结果。
   *
   * 这样前端和 debug snapshot 仍能拿到统一格式，而不会因为“没跑 QA”
   * 就出现 result shape 不一致的问题。
   */
  private buildQaFallbackResult(
    overallStatus: "passed" | "failed" | "skipped",
    summary: string,
    cases: string[],
    extras?: { blockedReasons?: string[]; testedUrl?: string },
  ) {
    return buildQaFallbackResultFromQaSupport(overallStatus, summary, cases, extras);
  }

  /** 在真正进入 QA 前，先把用例概览广播到时间线，方便用户知道接下来要测什么。 */
  private emitQaCasePreview(cases: string[], qaBaseUrl: string, hasBrowserTools: boolean, structuredCases: TestCaseArtifact[] = []) {
    this.emitPhaseSummary(
      buildQaCasePreviewPayload(cases, qaBaseUrl, hasBrowserTools, structuredCases),
    );
  }

  /** 判断一个 plan 结果是否已经达到“至少能继续编码”的最低可用标准。 */
  private isUsablePlan(plan: any): boolean {
    if (!plan || typeof plan !== "object") return false;
    if (!plan.reasoning || typeof plan.reasoning !== "string") return false;
    if (Array.isArray(plan.files_to_modify) && plan.files_to_modify.length > 0) return true;
    if (Array.isArray(plan.files_to_create) && plan.files_to_create.length > 0) return true;
    return false;
  }

  /**
   * 当 PlannerAgent 结果不可用时，本地启发式生成一份最小可执行计划。
   *
   * 它不是理想方案，而是为了避免整条流水线因为 PLAN 一步失真就彻底停摆。
   */
  private buildFallbackPlan(prdRes: any, apiRes: any, targetComponentContext: string): any {
    const filesToModify: Array<{ path: string; description: string }> = [];
    const filesToCreate: Array<{ path: string; content: string }> = [];
    const verificationPoints: string[] = [];
    const componentPath = this.targetComponentPath || "";
    const route = this.targetRoute || "目标页面";
    const prdRules = Array.isArray(prdRes?.logic_rules) ? prdRes.logic_rules : [];
    const prdPlacements = Array.isArray(prdRes?.placement_hints) ? prdRes.placement_hints : [];
    const prdDependencyChecks = Array.isArray(prdRes?.dependency_checks) ? prdRes.dependency_checks : [];
    const apiMappings = Array.isArray(apiRes?.api_mappings) ? apiRes.api_mappings : [];

    if (componentPath) {
      const apiCapabilitySummary = apiMappings
        .slice(0, 3)
        .map((item: any) => item?.purpose || `${item?.method || ""} ${item?.endpoint || ""}`.trim())
        .filter(Boolean)
        .join("；");
      filesToModify.push({
        path: componentPath,
        description:
          `在目标组件中落地本次需求需要的状态管理、接口接入、交互入口、界面反馈与异常处理逻辑${apiCapabilitySummary ? `，重点覆盖：${apiCapabilitySummary}` : ""}。`,
      });
    }

    const apiPurposeSummary = apiMappings
      .slice(0, 3)
      .map((item: any) => `${item?.method || ""} ${item?.endpoint || ""} ${item?.purpose || ""}`.trim())
      .filter(Boolean)
      .join("；");

    verificationPoints.push(
      "进入目标页面后，应按需求正确初始化关键状态、接口数据与界面展示。",
      "涉及交互提交或状态切换的操作，应在成功、失败、加载中给出明确反馈。",
      "PRD 中列出的核心业务约束，应体现在入口显隐、字段映射、提交校验或流程控制中。",
    );

    if (apiMappings.length > 0) {
      verificationPoints.push("接口返回字段变化后，前端状态与展示应保持同步刷新。");
    }

    const reasoningParts = [
      this.taskObjective || "本次目标是基于 PRD 与接口文档完成指定迭代开发。",
      componentPath ? `当前已锁定核心组件 ${componentPath}，规划应优先围绕该文件落地。` : "",
      route ? `目标页面为 ${route}。` : "",
      prdRules.length > 0
        ? `PRD 已明确业务约束，核心规则包括：${prdRules.slice(0, 3).join("；")}。`
        : "PRD 已给出本次迭代的核心业务约束。",
      prdPlacements.length > 0
        ? `文档中的具体页面落点包括：${prdPlacements.slice(0, 3).join("；")}。`
        : "",
      prdDependencyChecks.length > 0
        ? `实施前后需确认的依赖项包括：${prdDependencyChecks.slice(0, 3).join("；")}。`
        : "",
      apiPurposeSummary ? `接口侧已识别的关键能力包括：${apiPurposeSummary}。` : "",
      targetComponentContext
        ? "系统已预取目标组件热点代码片段，当前证据足以直接制定实施方案，无需继续顺序扫描大文件。"
        : "当前可基于已有证据直接收敛方案。",
    ].filter(Boolean);

    return {
      reasoning: reasoningParts.join(""),
      files_to_create: filesToCreate,
      files_to_modify: filesToModify,
      operations_outline: [
        ...filesToModify.map((item) => ({
          target: item.path,
          kind: "modify",
          intent: item.description,
        })),
        ...filesToCreate.map((item) => ({
          target: item.path,
          kind: "create",
          intent: item.content,
        })),
      ],
      external_libs: [],
      verification_points: Array.from(new Set(verificationPoints)),
      test_cases: deriveStructuredTestCases(verificationPoints, 4),
      risk_flags: prdDependencyChecks.slice(0, 3),
      fallback_generated: true,
    };
  }

  /**
   * 把各个 agent 的 thought/progress 回调统一转发到 orchestrator 时间线。
   *
   * 这样 UI 看到的就是一条连续的阶段进度流，而不是每个 agent 各说各话。
   */
  private forwardAgentProgress(phase: string, index: number) {
    return (message: string) => {
      if (!message) return;
      if (message.startsWith("[系统]")) {
        this.emitStepProgress({ phase, content: message, index });
        return;
      }
      this.emitStepProgress({ phase, thought: message, index });
    };
  }

  /**
   * 完整工作流入口。
   *
   * runFullPipeline 只做第一层驱动：
   * - 初始化 debug snapshot
   * - 先跑 INTENT 锁定项目上下文
   * - 再把控制权交给 run() 进入主阶段链路
   */
  public async runFullPipeline(prompt: string) {
    if (this.abortController.signal.aborted) return;
    const signal = this.abortController.signal;

    // --- A. 初始化一次全新的 workflow 现场 ---
    // 这里会创建 debug snapshot、写入起始日志，并记录本轮 feature flag。
    // 可以把它理解成“为这次 run 开一个新的黑匣子”。
    this.initializeDebugSnapshot(prompt, { mode: "full" });
    this.log(`[WORKFLOW_START] promptChars=${prompt.length}`);
    this.trace("workflow_start", {
      promptChars: prompt.length,
      promptPreview: summarizeText(prompt),
      featureFlags: getFeatureFlagSnapshot(),
    });

    // 阶段 0 是整个系统的地基：如果 projectPath 锁错，后面所有阶段都没有意义。
    this.emitStepStart("INTENT", "🤖 正在深度解析意图...", 0);
    
    // 初始化 IntentAgent 时，它的 config.projectPath 是未定义的，这是正常的
    const intentAgent = new IntentAgent({ ...this.llmConfig }, this.mcpHub, signal);
    const intentInput = { prompt };
    const intentResult = await intentAgent.execute(
      intentInput, 
      "", 
      (t: string) => this.emitStepProgress({ phase: "INTENT", thought: t, index: 0 })
    );
    this.appendDebugStageAttempt("INTENT", "primary", intentInput, intentResult);

    const config = intentResult.parsed; 
    this.trace("intent_result", {
      parsedKeys: config && typeof config === "object" ? Object.keys(config) : [],
      projectPath: config?.projectPath || "",
      prdUrl: config?.prdUrl || "",
      apiUrl: config?.apiUrl || "",
      targetRoute: config?.targetRoute || "",
      targetComponentPath: config?.targetComponentPath || "",
      taskObjective: config?.taskObjective || "",
      reasoningPreview: summarizeText(config?.reasoning || ""),
    });
    
    // 只有模型真的带回了“已验证”的路径，我们才允许后续阶段继续。
    if (config && config.projectPath) {
      this.projectPath = config.projectPath;
      this.targetRoute = config.targetRoute || "";
      this.targetComponentPath = config.targetComponentPath || "";
      this.taskObjective = config.taskObjective || this.extractTaskObjective(prompt);
      this.llmConfig.projectPath = this.projectPath; // 💉 注入到全局配置
      this.updateDebugContext({
        projectPath: this.projectPath,
        targetRoute: this.targetRoute,
        targetComponentPath: this.targetComponentPath,
        taskObjective: this.taskObjective,
        prdUrl: config?.prdUrl || "",
        apiUrl: config?.apiUrl || "",
      });
      this.log(`Success: Intent settled at ${this.projectPath}`);
      this.emitStepProgress({ phase: "INTENT", content: `✅ 意图已解析！锁定路径: ${this.projectPath}`, index: 0 });
      this.emitPhaseSummary({
        phase: "INTENT",
        index: 0,
        title: "意图已锁定",
        summary: `已确定项目路径，并准备进入文档解析阶段。`,
        highlights: [
          this.taskObjective ? `目标：${this.taskObjective}` : "",
          `项目：${this.projectPath}`,
          this.targetRoute ? `路由：${this.targetRoute}` : "",
          this.targetComponentPath ? `组件：${this.targetComponentPath}` : "",
          config?.prdUrl ? `PRD：${config.prdUrl}` : "",
          config?.apiUrl ? `API：${config.apiUrl}` : "",
        ].filter(Boolean),
        stats: [
          config?.prdUrl ? "PRD 已提取" : "",
          config?.apiUrl ? "API 已提取" : "",
          this.targetComponentPath ? "核心组件已识别" : "",
        ].filter(Boolean),
      });
      if (this.targetComponentPath) {
        const absoluteComponentPath = path.resolve(this.projectPath, this.targetComponentPath);
        const componentExists = fs.existsSync(absoluteComponentPath);
        this.trace("target_component_probe", {
          targetComponentPath: this.targetComponentPath,
          absoluteComponentPath,
          exists: componentExists,
        });
        this.emitStepProgress({
          phase: "INTENT",
          content: componentExists
            ? `✅ 核心组件已确认存在: ${this.targetComponentPath}`
            : `⚠️ 核心组件路径未命中: ${this.targetComponentPath}，后续将回退到目录搜索`,
          index: 0,
        });
      }
      if (isFeatureEnabled("ENABLE_PHASE_ARTIFACTS")) {
        const intentArtifact = normalizeIntentArtifact({
          ...config,
          taskObjective: this.taskObjective,
        });
        this.setPhaseArtifact(
          "INTENT",
          buildArtifactEnvelope("INTENT", "已完成意图解析并锁定项目上下文。", intentArtifact),
        );
      }
      this.finalizeDebugStage("INTENT", {
        replayInput: intentInput,
        output: intentResult,
        artifact: this.phaseArtifacts.INTENT,
        humanSummary: this.getArtifactSummary("INTENT") || "已完成意图解析并锁定项目上下文。",
      });
    } else {
      this.emitStepComplete("INTENT", "error", 0);
      this.updateDebugSnapshotStatus("error");
      this.emitWorkflowComplete("error", "未能从长文中解析到有效项目路径，请确保文档中包含绝对路径并能被 list_dir 访问。");
      return;
    }

    if (signal.aborted) return;
    this.emitStepComplete("INTENT", "success", 0);

    const originalPrompt = prompt; // 💡 记录原始长文意图，作为后续所有 Agent 的“最高纲领”

    // 到这里，项目上下文已经锁定，可以安全创建后续所有 phase agent。
    return this.run(config.prdUrl || prompt, config.apiUrl || "", signal, originalPrompt);
  }

  /**
   * 主阶段编排函数。
   *
   * 这里串起 PRD / API / PLAN / CODING / VERIFY，并在每个阶段之间做三件事：
   * - 预抓取与上下文压缩
   * - artifact gate / fallback / repair
   * - debug snapshot 持久化
   */
  private async run(prdUrl: string, apiUrl: string, signal: AbortSignal, originalPrompt: string) {
    try {
      // Agent 必须在 projectPath 锁定后再初始化，否则很多路径型约束会失效。
      this.initializePhaseAgents(signal);

      // --- B. 先准备全局共享上下文 ---
      // 这些内容会被 PRD / API / PLAN / CODING / VERIFY 多阶段复用：
      // - Hermes lessons
      // - 执行摘要 executionBrief
      // - 目标组件热点片段
      // - 风格快照
      // - 本地 runtime 候选
      const pipelineContext = preparePipelineRunContext({
        originalPrompt,
        projectPath: this.projectPath,
        targetRoute: this.targetRoute,
        targetComponentPath: this.targetComponentPath,
        phaseArtifactsEnabled: isFeatureEnabled("ENABLE_PHASE_ARTIFACTS"),
        getRelevantLessons: (query) => this.evalHarness.getRelevantLessons(query),
        buildLessonQuery: (nextOriginalPrompt, stage, extra) => this.buildLessonQuery(nextOriginalPrompt, stage, extra),
        buildExecutionBrief: () => this.buildExecutionBrief(),
        buildTargetComponentContext: () => this.buildTargetComponentContext(),
        buildStyleContext: (plan) => this.buildStyleContext(plan),
        buildProjectSnapshotArtifact: (nextTargetComponentContext, nextStyleContext, nextRuntimeDiscovery) =>
          this.buildProjectSnapshotArtifact(nextTargetComponentContext, nextStyleContext, nextRuntimeDiscovery),
        setPhaseArtifact: (phase, envelope) => this.setPhaseArtifact(phase, envelope),
        trace: (type, payload) => this.trace(type, payload),
        updateDebugContext: (patch) => this.updateDebugContext({ ...patch, prdUrl, apiUrl }),
      });
      let sharedLessons = pipelineContext.sharedLessons;
      const {
        executionBrief: preparedExecutionBrief,
        targetComponentContext: preparedTargetComponentContext,
        styleContext: preparedStyleContext,
        runtimeDiscovery: preparedRuntimeDiscovery,
      } = pipelineContext;

      if (signal.aborted) return;

      const prdPhaseResult = await executePrdPhase({
        signal,
        prdUrl,
        originalPrompt,
        taskObjective: this.taskObjective,
        targetRoute: this.targetRoute,
        targetComponentPath: this.targetComponentPath,
        executionBrief: preparedExecutionBrief,
        sharedLessons,
        phaseArtifactsEnabled: isFeatureEnabled("ENABLE_PHASE_ARTIFACTS"),
        larkPrefetcher: this.larkPrefetcher,
        emitStepStart: (phase, title, index) => this.emitStepStart(phase, title, index),
        emitStepProgress: (data) => this.emitStepProgress(data),
        emitStepComplete: (phase, status, index) => this.emitStepComplete(phase, status, index),
        trace: (type, payload) => this.trace(type, payload),
        prdAgentExecute: (input, lessons, onThought) => this.prdAgent!.execute(input, lessons, onThought),
        forwardAgentProgress: (phase, index) => this.forwardAgentProgress(phase, index),
        buildPrdEvidenceContext: (rawContent) => this.buildPrdEvidenceContext(rawContent),
        buildFocusedDocumentContent: (rawContent, phase, seedTexts) => this.buildFocusedDocumentContent(rawContent, phase, seedTexts),
        buildPrdFocusContext: (prd) => this.buildPrdFocusContext(prd),
        ensurePrdArtifactGate: (prdArtifact) => this.ensurePrdArtifactGate(prdArtifact),
        backfillPrdResultWithLocalEvidence: (nextPrdRes, rawContent, evidenceContext) =>
          this.backfillPrdResultWithLocalEvidence(nextPrdRes, rawContent, evidenceContext),
        setPhaseArtifact: (phase, envelope) => this.setPhaseArtifact(phase, envelope),
        buildHumanSummaryFromResult: (label, result) => this.buildHumanSummaryFromResult(label, result),
        updateDebugContext: (patch) => this.updateDebugContext(patch),
        summarizeResult: (label, result) => this.summarizeResult(label, result),
        finalizeDebugStage: (stage, payload) => this.finalizeDebugStage(stage, payload),
        getArtifactSummary: (phase) => this.getArtifactSummary(phase),
        appendDebugStageAttempt: (stage, label, input, output, error) =>
          this.appendDebugStageAttempt(stage, label, input, output, error),
        phaseArtifacts: {
          PRD: this.phaseArtifacts.PRD,
        },
      });
      let prdRes = prdPhaseResult.prdRes;
      let prdArtifact = prdPhaseResult.prdArtifact;
      const prdFocusContext = prdPhaseResult.prdFocusContext;
      const prdHermesHints = this.runHermesCheckpoint("PRD", "success");
      sharedLessons = mergeCheckpointLessons(sharedLessons, prdHermesHints);

      const apiPhaseResult = await executeApiPhase({
        signal,
        prdUrl,
        apiUrl,
        taskObjective: this.taskObjective,
        targetRoute: this.targetRoute,
        targetComponentPath: this.targetComponentPath,
        executionBrief: preparedExecutionBrief,
        sharedLessons,
        prdArtifact,
        prdFocusContext,
        phaseArtifactsEnabled: isFeatureEnabled("ENABLE_PHASE_ARTIFACTS"),
        larkPrefetcher: this.larkPrefetcher,
        emitStepStart: (phase, title, index) => this.emitStepStart(phase, title, index),
        emitStepProgress: (data) => this.emitStepProgress(data),
        emitStepComplete: (phase, status, index) => this.emitStepComplete(phase, status, index),
        trace: (type, payload) => this.trace(type, payload),
        apiAgentExecute: (input, lessons, onThought) => this.apiAgent!.execute(input, lessons, onThought),
        forwardAgentProgress: (phase, index) => this.forwardAgentProgress(phase, index),
        buildFocusedDocumentContent: (rawContent, phase, seedTexts) => this.buildFocusedDocumentContent(rawContent, phase, seedTexts),
        ensureApiArtifactGate: (apiArtifact) => this.ensureApiArtifactGate(apiArtifact),
        setPhaseArtifact: (phase, envelope) => this.setPhaseArtifact(phase, envelope),
        buildHumanSummaryFromResult: (label, result) => this.buildHumanSummaryFromResult(label, result),
        updateDebugContext: (patch) => this.updateDebugContext(patch),
        summarizeResult: (label, result) => this.summarizeResult(label, result),
        finalizeDebugStage: (stage, payload) => this.finalizeDebugStage(stage, payload),
        getArtifactSummary: (phase) => this.getArtifactSummary(phase),
        appendDebugStageAttempt: (stage, label, input, output, error) =>
          this.appendDebugStageAttempt(stage, label, input, output, error),
        phaseArtifacts: {
          API: this.phaseArtifacts.API,
        },
      });
      let apiRes = apiPhaseResult.apiRes;
      let apiArtifact = apiPhaseResult.apiArtifact;
      const apiHermesHints = this.runHermesCheckpoint("API", "success");
      sharedLessons = mergeCheckpointLessons(sharedLessons, apiHermesHints);

      const planPhaseResult = await executePlanPhase({
        signal,
        projectPath: this.projectPath,
        targetRoute: this.targetRoute,
        targetComponentPath: this.targetComponentPath,
        executionBrief: preparedExecutionBrief,
        sharedLessons,
        targetComponentContext: preparedTargetComponentContext,
        prdFocusContext,
        styleContext: preparedStyleContext,
        runtimeDiscovery: preparedRuntimeDiscovery,
        prdRes,
        prdArtifact,
        apiRes,
        apiArtifact,
        phaseArtifactsEnabled: isFeatureEnabled("ENABLE_PHASE_ARTIFACTS"),
        emitStepStart: (phase, title, index) => this.emitStepStart(phase, title, index),
        emitStepProgress: (data) => this.emitStepProgress(data),
        emitStepComplete: (phase, status, index) => this.emitStepComplete(phase, status, index),
        trace: (type, payload) => this.trace(type, payload),
        updateDebugContext: (patch) => this.updateDebugContext(patch),
        plannerAgentExecute: (input, lessons, onThought) => this.plannerAgent!.execute(input, lessons, onThought),
        forwardAgentProgress: (phase, index) => this.forwardAgentProgress(phase, index),
        appendDebugStageAttempt: (stage, label, input, output, error) =>
          this.appendDebugStageAttempt(stage, label, input, output, error),
        getPipelineArtifacts: () => this.getPipelineArtifacts(),
        buildProjectTree: () => this.buildProjectTree(),
        isUsablePlan: (plan) => this.isUsablePlan(plan),
        buildFallbackPlan: (nextPrdRes, nextApiRes, nextTargetContext) =>
          this.buildFallbackPlan(nextPrdRes, nextApiRes, nextTargetContext),
        enrichPlanWithApiCoverage: (plan, nextApiArtifact) => this.enrichPlanWithApiCoverage(plan, nextApiArtifact),
        normalizePlanToProjectStyle: (plan) => this.normalizePlanToProjectStyle(plan),
        ensurePlanArtifactGate: (planArtifact, nextApiArtifact) => this.ensurePlanArtifactGate(planArtifact, nextApiArtifact),
        setPhaseArtifact: (phase, envelope) => this.setPhaseArtifact(phase, envelope),
        buildHumanSummaryFromResult: (label, result) => this.buildHumanSummaryFromResult(label, result),
        buildStyleContext: (plan) => this.buildStyleContext(plan),
        buildProjectSnapshotArtifact: (nextTargetContext, nextStyleContext, nextRuntimeDiscovery) =>
          this.buildProjectSnapshotArtifact(nextTargetContext, nextStyleContext, nextRuntimeDiscovery),
        summarizeResult: (label, result) => this.summarizeResult(label, result),
        finalizeDebugStage: (stage, payload) => this.finalizeDebugStage(stage, payload),
        getArtifactSummary: (phase) => this.getArtifactSummary(phase),
        phaseArtifacts: {
          PLAN: this.phaseArtifacts.PLAN,
        },
      });
      let planRes = planPhaseResult.planRes;
      let planArtifact = planPhaseResult.planArtifact;
      const planStyleContext = planPhaseResult.planStyleContext;
      const planHermesHints = this.runHermesCheckpoint("PLAN", "success");
      sharedLessons = mergeCheckpointLessons(sharedLessons, planHermesHints);

      const codingPhaseResult = await executeCodingPhase({
        signal,
        projectPath: this.projectPath,
        targetRoute: this.targetRoute,
        targetComponentPath: this.targetComponentPath,
        executionBrief: preparedExecutionBrief,
        sharedLessons,
        targetComponentContext: preparedTargetComponentContext,
        prdFocusContext,
        styleContext: planStyleContext || preparedStyleContext,
        prdArtifact,
        apiArtifact,
        planArtifact,
        emitStepStart: (phase, title, index) => this.emitStepStart(phase, title, index),
        emitStepProgress: (data) => this.emitStepProgress(data),
        emitStepComplete: (phase, status, index) => this.emitStepComplete(phase, status, index),
        trace: (type, payload) => this.trace(type, payload),
        coderAgentExecute: (input, lessons, onThought) => this.coderAgent!.execute(input, lessons, onThought),
        forwardAgentProgress: (phase, index) => this.forwardAgentProgress(phase, index),
        appendDebugStageAttempt: (stage, label, input, output, error) =>
          this.appendDebugStageAttempt(stage, label, input, output, error),
        getPipelineArtifacts: () => this.getPipelineArtifacts(),
        setPhaseArtifact: (phase, envelope) => this.setPhaseArtifact(phase, envelope),
        buildHumanSummaryFromResult: (label, result) => this.buildHumanSummaryFromResult(label, result),
        finalizeDebugStage: (stage, payload) => this.finalizeDebugStage(stage, payload),
        getArtifactSummary: (phase) => this.getArtifactSummary(phase),
        summarizeResult: (label, result) => this.summarizeResult(label, result),
        phaseArtifacts: {
          CODING: this.phaseArtifacts.CODING,
        },
      });
      const codingInput = codingPhaseResult.codingInput;
      let codingRes = codingPhaseResult.codingRes;
      let codeArtifact = codingPhaseResult.codeArtifact;
      const codingHermesHints = this.runHermesCheckpoint("CODING", "success");
      sharedLessons = mergeCheckpointLessons(sharedLessons, codingHermesHints);

      if (signal.aborted) throw new Error("AbortError");
      const verifyResult = await executeVerifyPhase({
        originalPrompt,
        llmQaConfig: this.llmConfig.qaConfig,
        taskObjective: this.taskObjective,
        targetRoute: this.targetRoute,
        targetComponentPath: this.targetComponentPath,
        runtimeDiscovery: preparedRuntimeDiscovery,
        codingInput: codingInput as CodingExecutionInput,
        codingRes,
        planRes,
        planArtifact,
        codeArtifact,
        sharedLessons,
        projectSnapshotArtifact: this.phaseArtifacts.PROJECT_SNAPSHOT?.artifact,
        projectPath: this.projectPath,
        trace: (type, payload) => this.trace(type, payload),
        emitStepStart: (phase, title, index) => this.emitStepStart(phase, title, index),
        emitStepProgress: (data) => this.emitStepProgress(data),
        emitStepComplete: (phase, status, index) => this.emitStepComplete(phase, status, index),
        collectQaCases: (nextCodingRes, nextPlanRes) => this.collectQaCases(nextCodingRes, nextPlanRes),
        hasChromeDevtoolsTools: () => this.hasChromeDevtoolsTools(),
        discoverExplicitQaBaseUrl: (prompt) => this.discoverExplicitQaBaseUrl(prompt),
        discoverReachableQaBaseUrl: (portHints) => this.discoverReachableQaBaseUrl(portHints),
        tryAutoBootQaRuntime: (selected, packageManager) => this.tryAutoBootQaRuntime(selected, packageManager),
        emitQaCasePreview: (cases, qaBaseUrl, hasBrowserTools, structuredCases) =>
          this.emitQaCasePreview(cases, qaBaseUrl, hasBrowserTools, structuredCases),
        buildQaFallbackResult: (overallStatus, summary, cases, extras) =>
          this.buildQaFallbackResult(overallStatus, summary, cases, extras),
        runCodingValidationRepairLoop: (params) => this.runCodingValidationRepairLoop(params),
        setPhaseArtifact: (phase, envelope) => this.setPhaseArtifact(phase, envelope),
        buildHumanSummaryFromResult: (label, result) => this.buildHumanSummaryFromResult(label, result),
        finalizeDebugStage: (stage, payload) => this.finalizeDebugStage(stage, payload),
        getArtifactSummary: (phase) => this.getArtifactSummary(phase),
        summarizeResult: (label, result) => this.summarizeResult(label, result),
        extractPlanFilePaths: (plan, field) => this.extractPlanFilePaths(plan, field),
        appendDebugStageAttempt: (stage, label, input, output, error) =>
          this.appendDebugStageAttempt(stage, label, input, output, error),
        qaAgentExecute: (input, lessons, onThought) => this.qaAgent!.execute(input, lessons, onThought),
        forwardAgentProgress: (phase, index) => this.forwardAgentProgress(phase, index),
        selectRuntimeOption: (discovery, options) => selectRuntimeOption(discovery, options),
      });
      codingRes = verifyResult.codingRes;
      codeArtifact = verifyResult.codeArtifact;

      // --- C. 工作流收口 ---
      // 所有阶段成功后，更新 snapshot、触发 Hermes 复盘，并广播 workflow complete。
      await finalizeWorkflowSuccess({
        runHermesEvolution: (workflowStatus, finalMessage) => this.runHermesEvolution(workflowStatus, finalMessage),
        updateDebugSnapshotStatus: (status) => this.updateDebugSnapshotStatus(status),
        emitWorkflowComplete: (status, message) => this.emitWorkflowComplete(status, message),
      });
    } catch (err: any) {
      if (signal.aborted || err.message === "AbortError") {
          await finalizeWorkflowAbort({
            runHermesEvolution: (workflowStatus, finalMessage, options) =>
              this.runHermesEvolution(workflowStatus, finalMessage, options),
            updateDebugSnapshotStatus: (status) => this.updateDebugSnapshotStatus(status),
            emitWorkflowComplete: (status, message) => this.emitWorkflowComplete(status, message),
          });
      } else {
          await finalizeWorkflowError({
            error: err,
            trace: (type, payload) => this.trace(type, payload),
            runHermesEvolution: (workflowStatus, finalMessage) => this.runHermesEvolution(workflowStatus, finalMessage),
            updateDebugSnapshotStatus: (status) => this.updateDebugSnapshotStatus(status),
            emitWorkflowComplete: (status, message) => this.emitWorkflowComplete(status, message),
          });
          throw err;
      }
    } finally {
      this.stopQaRuntimeProcess();
    }
  }

  /** 通过历史 runId 加载 debug snapshot，再转交给单阶段 replay 入口。 */
  public async replayStageFromSourceRun(sourceRunId: string, stage: ReplayStageName) {
    const snapshot = readDebugRunSnapshot(sourceRunId);
    if (!snapshot) {
      throw new Error(`未找到 runId=${sourceRunId} 的调试快照。`);
    }
    return this.replayStageFromSnapshot(snapshot, stage);
  }

  /**
   * 当历史快照里没有显式记录 CODING replay_input 时，
   * 这里会尝试基于 PLAN / PROJECT_SNAPSHOT / context 合成一份最小可重放输入。
   */
  private buildSyntheticCodingReplayInput(snapshot: DebugRunSnapshot): {
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
  } | null {
    return buildSyntheticCodingReplayInputFromDebugReplay(snapshot);
  }

  /**
   * 单阶段重放主入口。
   *
   * replay 的目标不是重放整条流水线，而是把某一阶段放回当时上下文中再跑一遍，
   * 方便聚焦排查“为什么是这个阶段坏了”。
   */
  public async replayStageFromSnapshot(snapshot: DebugRunSnapshot, stage: ReplayStageName) {
    const signal = this.abortController.signal;
    if (signal.aborted) return;

    // --- A. 先确认历史快照里是否具备可重放信息 ---
    // 大多数阶段直接复用 snapshot.stages[stage].replay_input；
    // 只有 CODING 支持在缺失时临时合成一份最小输入。
    const sourceStage = snapshot.stages?.[stage];
    const canSynthesizeCodingReplay = stage === "CODING" && Boolean(this.buildSyntheticCodingReplayInput(snapshot));
    if (!sourceStage && !canSynthesizeCodingReplay) {
      throw new Error(`调试快照中不存在 ${stage} 阶段记录。`);
    }

    let replayInput = cloneForDebug(sourceStage?.replay_input);
    let replayInputSynthesized = false;
    if (replayInput === undefined) {
      if (stage === "CODING") {
        replayInput = this.buildSyntheticCodingReplayInput(snapshot);
        replayInputSynthesized = replayInput !== null;
      }
      if (replayInput === undefined || replayInput === null) {
        throw new Error(`${stage} 阶段未记录可重放输入，当前只能查看快照，无法直接重放。`);
      }
    }

    const descriptor = this.getStageDescriptor(stage);
    this.initializeDebugSnapshot(String(snapshot.originalPrompt || snapshot.context?.originalPrompt || ""), {
      mode: "replay",
      replayOf: { runId: snapshot.runId, stage },
    });
    this.hydrateFromDebugSnapshot(snapshot);
    this.updateDebugContext({
      ...cloneForDebug(snapshot.context || {}),
      replaySourceRunId: snapshot.runId,
      replayStage: stage,
    });

    this.log(`[STAGE_REPLAY] sourceRunId=${snapshot.runId} stage=${stage}`);
    this.trace("stage_replay_start", {
      sourceRunId: snapshot.runId,
      stage,
    });

    this.emitStepStart(stage, descriptor.title, descriptor.index);
    this.emitStepProgress({
      phase: stage,
      index: descriptor.index,
      content: replayInputSynthesized
        ? `[系统] 未找到 ${stage} 原始 replay 输入，已基于 PLAN 阶段产物合成一份本地重放输入。`
        : `[系统] 正在基于 ${snapshot.runId} 的调试快照重放 ${stage} 阶段。`,
    });

    try {
      // --- B. replay 也会初始化完整 agent 集合 ---
      // 这样保证“正常流程”和“重放流程”尽量共用同一套 execute 逻辑。
      this.initializePhaseAgents(signal);
      const sharedLessons = String(snapshot.context?.sharedLessons || "")
        || this.evalHarness.getRelevantLessons(
          this.buildLessonQuery(
            String(snapshot.originalPrompt || snapshot.context?.originalPrompt || ""),
            stage,
            {
              runId: snapshot.runId,
              workflowStatus: String(snapshot.status || ""),
              extraText: String(snapshot.context?.targetComponentContext || ""),
            },
          ),
        );
      const result = await executeStageReplay({
        stage,
        snapshot,
        replayInput,
        sharedLessons,
        descriptor,
        intentExecute: (input, lessons, onThought) =>
          new IntentAgent({ ...this.llmConfig }, this.mcpHub, signal).execute(input, lessons, onThought),
        prdExecute: (input, lessons, onThought) => this.prdAgent!.execute(input, lessons, onThought),
        apiExecute: (input, lessons, onThought) => this.apiAgent!.execute(input, lessons, onThought),
        planExecute: (input, lessons, onThought) => this.plannerAgent!.execute(input, lessons, onThought),
        codingExecute: (input, lessons, onThought) => this.coderAgent!.execute(input, lessons, onThought),
        verifyExecute: (input, lessons, onThought) => this.qaAgent!.execute(input, lessons, onThought),
        forwardAgentProgress: (phase, index) => this.forwardAgentProgress(phase, index),
        appendDebugStageAttempt: (replayStage, label, input, output, error, meta) =>
          this.appendDebugStageAttempt(replayStage, label, input, output, error, meta),
        setPhaseArtifact: (phase, envelope) => this.setPhaseArtifact(phase as any, envelope as any),
        buildHumanSummaryFromResult: (label, nextResult) => this.buildHumanSummaryFromResult(label, nextResult),
        normalizePlanToProjectStyle: (plan) => this.normalizePlanToProjectStyle(plan),
        enrichPlanWithApiCoverage: (plan, apiArtifact) => this.enrichPlanWithApiCoverage(plan, apiArtifact),
        runCodingValidationRepairLoop: (params) => this.runCodingValidationRepairLoop(params),
      });

      this.summarizeResult(stage, result);
      this.finalizeDebugStage(stage, {
        replayInput,
        output: result,
        artifact: (this.phaseArtifacts as any)?.[stage],
        humanSummary: this.getArtifactSummary(stage as keyof V2Orchestrator["phaseArtifacts"]),
        meta: { sourceRunId: snapshot.runId, replayStage: stage, replayInputSynthesized },
      });
      this.emitStepComplete(stage, "success", descriptor.index);
      this.updateDebugSnapshotStatus("success");
      this.emitWorkflowComplete("success");
    } catch (err: any) {
      // replay 失败也会写回 debug snapshot，
      // 这样前端看到的不是“进程报错退出”，而是有结构化失败记录的一次 replay。
      if (signal.aborted || err?.message === "AbortError") {
        this.updateDebugSnapshotStatus("aborted");
        this.emitWorkflowComplete("error", "Workflow Aborted");
        return;
      }

      this.appendDebugStageAttempt(stage, "replay_failed", replayInput, undefined, err?.message || "unknown", {
        sourceRunId: snapshot.runId,
        replayInputSynthesized,
      });
      this.updateDebugSnapshotStatus("error");
      this.emitStepComplete(stage, "error", descriptor.index);
      this.emitWorkflowComplete("error", err?.message || "Stage Replay Failed");
      throw err;
    }
  }

  /**
   * 外部停止按钮的最终落点。
   *
   * 这里不仅中断 abort signal，也会顺手停掉可能还在跑的 QA runtime，
   * 并把 debug snapshot 标记为 aborted。
   */
  public stopWorkflow() {
    this.abortController.abort();
    this.stopQaRuntimeProcess();
    this.updateDebugSnapshotStatus("aborted");
    this.log("Workflow stop signal received.");
  }
}
