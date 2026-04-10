import { summarizeText } from "../harness-logger";
import { buildArtifactEnvelope, normalizeApiArtifact, normalizePrdArtifact, PrdArtifact } from "../phase-artifacts";

interface StepProgressEmitter {
  (data: { phase: string; content?: string; thought?: string; index: number }): void;
}

/**
 * PRD 阶段输入。
 *
 * 这个执行器的职责很聚焦：
 * 1. 预抓取 PRD 来源
 * 2. 压缩成证据优先视图
 * 3. 交给 PRDAgent 提炼
 * 4. 必要时做 gate 重试与本地 fallback
 */
export interface ExecutePrdPhaseParams {
  signal: AbortSignal;
  prdUrl: string;
  originalPrompt: string;
  taskObjective: string;
  targetRoute: string;
  targetComponentPath: string;
  executionBrief: string;
  sharedLessons: string;
  phaseArtifactsEnabled: boolean;
  larkPrefetcher: {
    extractLarkUrls: (source: string) => string[];
    prefetchSource: (url: string, signal: AbortSignal) => Promise<{
      status: string;
      content: string;
      diagnostics?: string[];
    }>;
  };
  emitStepStart: (phase: string, title: string, index: number) => void;
  emitStepProgress: StepProgressEmitter;
  emitStepComplete: (phase: string, status: string, index: number) => void;
  trace: (type: string, payload: Record<string, unknown>) => void;
  prdAgentExecute: (
    input: { query: string; rawContent?: string; focusContext?: string; gateFeedback?: string },
    lessons: string,
    onThought: (message: string) => void,
  ) => Promise<any>;
  forwardAgentProgress: (phase: string, index: number) => (message: string) => void;
  buildPrdEvidenceContext: (rawContent: string) => string;
  buildFocusedDocumentContent: (rawContent: string, phase: "PRD" | "API", seedTexts?: string[]) => string;
  buildPrdFocusContext: (prd: any) => string;
  ensurePrdArtifactGate: (prdArtifact: PrdArtifact) => void;
  backfillPrdResultWithLocalEvidence: (prdRes: any, rawContent: string, evidenceContext: string) => {
    result: any;
    artifact: PrdArtifact;
  };
  setPhaseArtifact: (phase: "PRD", envelope: any) => void;
  buildHumanSummaryFromResult: (label: string, result: any) => string;
  updateDebugContext: (patch: Record<string, unknown>) => void;
  summarizeResult: (label: string, result: any) => void;
  finalizeDebugStage: (
    stage: "PRD",
    payload: { replayInput?: unknown; output?: unknown; artifact?: unknown; humanSummary?: string },
  ) => void;
  getArtifactSummary: (phase: "PRD") => string;
  appendDebugStageAttempt: (
    stage: "PRD",
    label: string,
    input?: unknown,
    output?: unknown,
    error?: string,
  ) => void;
  phaseArtifacts: {
    PRD?: unknown;
  };
}

export interface ExecutePrdPhaseResult {
  prdRes: any;
  prdArtifact: PrdArtifact;
  prdFocusContext: string;
  prdEvidenceContext: string;
  focusedPrdContent: string;
}

/**
 * API 阶段输入。
 *
 * 这段执行器负责把“PRD 诉求”翻译成“可调用的接口能力图”。
 * 与 PRD 阶段一样，它也有自己的 gate 与 retry，但不再做本地 fallback。
 */
export interface ExecuteApiPhaseParams {
  signal: AbortSignal;
  prdUrl: string;
  apiUrl: string;
  taskObjective: string;
  targetRoute: string;
  targetComponentPath: string;
  executionBrief: string;
  sharedLessons: string;
  prdArtifact: PrdArtifact;
  prdFocusContext: string;
  phaseArtifactsEnabled: boolean;
  larkPrefetcher: {
    extractLarkUrls: (source: string) => string[];
    prefetchSource: (url: string, signal: AbortSignal) => Promise<{
      status: string;
      content: string;
      diagnostics?: string[];
    }>;
  };
  emitStepStart: (phase: string, title: string, index: number) => void;
  emitStepProgress: StepProgressEmitter;
  emitStepComplete: (phase: string, status: string, index: number) => void;
  trace: (type: string, payload: Record<string, unknown>) => void;
  apiAgentExecute: (
    input: {
      prd: any;
      query?: string;
      apiUrl?: string;
      rawContent?: string;
      prdFocusContext?: string;
      gateFeedback?: string;
    },
    lessons: string,
    onThought: (message: string) => void,
  ) => Promise<any>;
  forwardAgentProgress: (phase: string, index: number) => (message: string) => void;
  buildFocusedDocumentContent: (rawContent: string, phase: "PRD" | "API", seedTexts?: string[]) => string;
  ensureApiArtifactGate: (apiArtifact: any) => void;
  setPhaseArtifact: (phase: "API", envelope: any) => void;
  buildHumanSummaryFromResult: (label: string, result: any) => string;
  updateDebugContext: (patch: Record<string, unknown>) => void;
  summarizeResult: (label: string, result: any) => void;
  finalizeDebugStage: (
    stage: "API",
    payload: { replayInput?: unknown; output?: unknown; artifact?: unknown; humanSummary?: string },
  ) => void;
  getArtifactSummary: (phase: "API") => string;
  appendDebugStageAttempt: (
    stage: "API",
    label: string,
    input?: unknown,
    output?: unknown,
    error?: string,
  ) => void;
  phaseArtifacts: {
    API?: unknown;
  };
}

export interface ExecuteApiPhaseResult {
  apiRes: any;
  apiArtifact: any;
  focusedApiContent: string;
}

/**
 * 执行 PRD 阶段。
 *
 * 这个 helper 把“抓文档 -> 压缩 -> 提炼 -> gate/retry/fallback -> 落盘摘要”
 * 全部收敛在一起，主 orchestrator 只需要消费结果，不用再看中间细节。
 */
export async function executePrdPhase(params: ExecutePrdPhaseParams): Promise<ExecutePrdPhaseResult> {
  params.emitStepStart("PRD", "📄 正在解析需求文档...", 1);
  params.emitStepProgress({
    phase: "PRD",
    content: "[系统] 正在抽取需求模块、业务规则和核心约束。",
    index: 1,
  });

  let prdContent = "";
  const urls = params.larkPrefetcher.extractLarkUrls(params.prdUrl);
  params.trace("prd_prefetch_start", { sourceUrl: params.prdUrl, urlCount: urls.length, urls });

  for (const url of urls) {
    if (params.signal.aborted) throw new Error("AbortError");
    const res = await params.larkPrefetcher.prefetchSource(url, params.signal);
    if (res.status === "success") {
      prdContent += `\n--- SOURCE: ${url} ---\n${res.content}\n`;
    }
    params.trace("prd_prefetch_result", {
      url,
      status: res.status,
      contentLen: res.content?.length || 0,
      diagnostics: res.diagnostics?.slice(0, 5) || [],
    });
  }

  const prdEvidenceContext = params.buildPrdEvidenceContext(prdContent);
  const focusedPrdContent = params.buildFocusedDocumentContent(
    prdContent,
    "PRD",
    [params.taskObjective, params.targetRoute, params.targetComponentPath, params.originalPrompt],
  );
  params.trace("prd_content_focus", {
    rawChars: prdContent.length,
    focusedChars: focusedPrdContent.length,
    evidenceChars: prdEvidenceContext.length,
  });
  if (focusedPrdContent && focusedPrdContent.length < prdContent.length) {
    params.emitStepProgress({
      phase: "PRD",
      content: "[系统] 已将 PRD 文档压缩为证据优先视图，优先保留功能详述、原型/截图与页面落点片段。",
      index: 1,
    });
  }

  const prdInput = { query: params.executionBrief, rawContent: focusedPrdContent, focusContext: prdEvidenceContext };
  let prdReplayInput: any = prdInput;
  let prdRes = await params.prdAgentExecute(
    prdInput,
    params.sharedLessons,
    params.forwardAgentProgress("PRD", 1),
  );
  params.appendDebugStageAttempt("PRD", "primary", prdInput, prdRes);

  let prdArtifact = normalizePrdArtifact(prdRes);
  if (params.phaseArtifactsEnabled) {
    try {
      params.ensurePrdArtifactGate(prdArtifact);
    } catch (error: any) {
      params.emitStepProgress({
        phase: "PRD",
        content: "[系统] PRD 证据提取存在缺口，正在基于原型/截图/表格锚点执行一次补强重试。",
        index: 1,
      });
      const prdRetryInput = {
        query: params.executionBrief,
        rawContent: focusedPrdContent,
        focusContext: prdEvidenceContext,
        gateFeedback: error?.message || "需要补齐 placement_hints 与 evidence_refs",
      };
      prdReplayInput = prdRetryInput;
      prdRes = await params.prdAgentExecute(
        prdRetryInput,
        params.sharedLessons,
        params.forwardAgentProgress("PRD", 1),
      );
      params.appendDebugStageAttempt("PRD", "retry_gate_fix", prdRetryInput, prdRes);
      prdArtifact = normalizePrdArtifact(prdRes);
      try {
        params.ensurePrdArtifactGate(prdArtifact);
      } catch (retryError: any) {
        const fallbackPrd = params.backfillPrdResultWithLocalEvidence(
          prdRes,
          focusedPrdContent || prdContent,
          prdEvidenceContext,
        );
        params.ensurePrdArtifactGate(fallbackPrd.artifact);
        prdRes = fallbackPrd.result;
        prdArtifact = fallbackPrd.artifact;
        params.trace("prd_fallback_applied", {
          reason: retryError?.message || error?.message || "",
          contentPreview: summarizeText(prdArtifact.content_verified),
          logicRules: prdArtifact.logic_rules.length,
          placementHints: prdArtifact.placement_hints.length,
          evidenceRefs: prdArtifact.evidence_refs.length,
        });
        params.emitStepProgress({
          phase: "PRD",
          content: "[系统] PRD 结构化结果仍存在缺口，已基于预读证据与任务目标执行本地兜底补全。",
          index: 1,
        });
      }
    }
    params.setPhaseArtifact(
      "PRD",
      buildArtifactEnvelope("PRD", params.buildHumanSummaryFromResult("PRD", prdRes), prdArtifact),
    );
  }

  const prdFocusContext = params.buildPrdFocusContext(prdArtifact);
  params.trace("prd_focus_context", {
    chars: prdFocusContext.length,
    preview: summarizeText(prdFocusContext),
  });
  params.updateDebugContext({
    prdEvidenceContext,
    focusedPrdContent,
    prdFocusContext,
  });
  params.summarizeResult("PRD", prdRes);
  params.finalizeDebugStage("PRD", {
    replayInput: prdReplayInput,
    output: prdRes,
    artifact: params.phaseArtifacts.PRD,
    humanSummary: params.getArtifactSummary("PRD"),
  });
  params.emitStepComplete("PRD", "success", 1);

  return {
    prdRes,
    prdArtifact,
    prdFocusContext,
    prdEvidenceContext,
    focusedPrdContent,
  };
}

/**
 * 执行 API 阶段。
 *
 * 与 PRD 不同，这里更强调“接口映射完整性”，
 * 因为后面的 PLAN / CODING 都依赖这份接口能力图。
 */
export async function executeApiPhase(params: ExecuteApiPhaseParams): Promise<ExecuteApiPhaseResult> {
  if (params.signal.aborted) throw new Error("AbortError");
  params.emitStepStart("API", "🔌 正在对接 API 接口...", 2);
  params.emitStepProgress({
    phase: "API",
    content: "[系统] 正在对齐接口前缀、能力边界和组件影响面。",
    index: 2,
  });

  let apiContent = "";
  const apiUrls = params.apiUrl
    ? [params.apiUrl]
    : params.larkPrefetcher.extractLarkUrls(params.prdUrl).filter((u) => u.includes("wiki/Vs30w"));
  params.trace("api_prefetch_start", { sourceUrl: params.apiUrl || params.prdUrl, urlCount: apiUrls.length, urls: apiUrls });

  const targetApiUrl = apiUrls[0] || params.apiUrl;
  if (targetApiUrl) {
    const res = await params.larkPrefetcher.prefetchSource(targetApiUrl, params.signal);
    if (res.status === "success") apiContent = res.content;
    params.trace("api_prefetch_result", {
      url: targetApiUrl,
      status: res.status,
      contentLen: res.content?.length || 0,
      diagnostics: res.diagnostics?.slice(0, 5) || [],
    });
  }

  const focusedApiContent = params.buildFocusedDocumentContent(
    apiContent,
    "API",
    [
      params.taskObjective,
      params.targetRoute,
      params.targetComponentPath,
      ...params.prdArtifact.logic_rules,
      ...params.prdArtifact.placement_hints,
      ...params.prdArtifact.evidence_refs,
    ],
  );
  params.trace("api_content_focus", {
    rawChars: apiContent.length,
    focusedChars: focusedApiContent.length,
  });
  if (focusedApiContent && focusedApiContent.length < apiContent.length) {
    params.emitStepProgress({
      phase: "API",
      content: "[系统] 已将 API 文档压缩为证据优先视图，优先保留接口定义、字段约束与调用规则片段。",
      index: 2,
    });
  }

  const apiInput = {
    prd: params.prdArtifact,
    rawContent: focusedApiContent,
    query: params.executionBrief,
    prdFocusContext: params.prdFocusContext,
  };
  let apiReplayInput: any = apiInput;
  let apiRes = await params.apiAgentExecute(
    apiInput,
    params.sharedLessons,
    params.forwardAgentProgress("API", 2),
  );
  params.appendDebugStageAttempt("API", "primary", apiInput, apiRes);

  let apiArtifact = normalizeApiArtifact(apiRes);
  if (params.phaseArtifactsEnabled) {
    try {
      params.ensureApiArtifactGate(apiArtifact);
    } catch (error: any) {
      params.emitStepProgress({
        phase: "API",
        content: "[系统] API 结构化结果存在缺口，正在基于 PRD 证据锚点执行一次补强重试。",
        index: 2,
      });
      const apiRetryInput = {
        prd: params.prdArtifact,
        rawContent: focusedApiContent,
        query: params.executionBrief,
        prdFocusContext: params.prdFocusContext,
        gateFeedback: error?.message || "需要补齐 api_mappings 与 evidence_refs",
      };
      apiReplayInput = apiRetryInput;
      apiRes = await params.apiAgentExecute(
        apiRetryInput,
        params.sharedLessons,
        params.forwardAgentProgress("API", 2),
      );
      params.appendDebugStageAttempt("API", "retry_gate_fix", apiRetryInput, apiRes);
      apiArtifact = normalizeApiArtifact(apiRes);
      params.ensureApiArtifactGate(apiArtifact);
    }
    params.setPhaseArtifact(
      "API",
      buildArtifactEnvelope("API", params.buildHumanSummaryFromResult("API", apiRes), apiArtifact),
    );
  }

  params.summarizeResult("API", apiRes);
  params.updateDebugContext({
    focusedApiContent,
  });
  params.finalizeDebugStage("API", {
    replayInput: apiReplayInput,
    output: apiRes,
    artifact: params.phaseArtifacts.API,
    humanSummary: params.getArtifactSummary("API"),
  });
  params.emitStepComplete("API", "success", 2);

  return {
    apiRes,
    apiArtifact,
    focusedApiContent,
  };
}
