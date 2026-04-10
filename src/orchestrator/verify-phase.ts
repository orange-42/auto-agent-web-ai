import { cloneForDebug } from "../debug-run-store";
import {
  buildArtifactEnvelope,
  CodeArtifact,
  normalizeCodeArtifact,
  normalizeVerifyArtifact,
  PlanArtifact,
} from "../phase-artifacts";
import { summarizeText } from "../harness-logger";
import {
  CodingExecutionInput,
  ProjectRuntimeOption,
  RuntimeDiscoveryResult,
  ValidationReport,
} from "./loop-manager-types";

export interface ExecuteVerifyPhaseParams {
  originalPrompt: string;
  llmQaConfig?: {
    envPreference?: string;
    baseUrl?: string;
    autoBoot?: boolean;
  };
  taskObjective: string;
  targetRoute: string;
  targetComponentPath: string;
  runtimeDiscovery: RuntimeDiscoveryResult | null;
  codingInput: CodingExecutionInput;
  codingRes: any;
  planRes: any;
  planArtifact: PlanArtifact;
  codeArtifact: CodeArtifact;
  sharedLessons: string;
  projectSnapshotArtifact?: unknown;
  projectPath: string;
  trace: (type: string, payload: Record<string, unknown>) => void;
  emitStepStart: (phase: string, title: string, index: number) => void;
  emitStepProgress: (data: { phase: string; content?: string; thought?: string; index: number }) => void;
  emitStepComplete: (phase: string, status: string, index: number) => void;
  collectQaCases: (codingRes: any, planRes: any) => string[];
  hasChromeDevtoolsTools: () => Promise<boolean>;
  discoverExplicitQaBaseUrl: (prompt: string) => Promise<string>;
  discoverReachableQaBaseUrl: (portHints?: number[]) => Promise<string>;
  tryAutoBootQaRuntime: (
    selected: ProjectRuntimeOption,
    packageManager: "yarn" | "pnpm" | "npm",
  ) => Promise<{ baseUrl: string; launchLabel: string }>;
  emitQaCasePreview: (cases: string[], qaBaseUrl: string, hasBrowserTools: boolean, structuredCases?: any[]) => void;
  buildQaFallbackResult: (
    overallStatus: "passed" | "failed" | "skipped",
    summary: string,
    cases: string[],
    extras?: { blockedReasons?: string[]; testedUrl?: string },
  ) => any;
  runCodingValidationRepairLoop: (params: {
    initialResult: any;
    baseInput: CodingExecutionInput;
    planArtifact: any;
    sharedLessons: string;
    progressPhase: "CODING" | "VERIFY";
    progressIndex: number;
    attemptLabelPrefix: string;
  }) => Promise<{ result: any; validationReport: ValidationReport }>;
  setPhaseArtifact: (phase: "CODING" | "VERIFY", envelope: any) => void;
  buildHumanSummaryFromResult: (label: string, result: any) => string;
  finalizeDebugStage: (
    stage: "CODING" | "VERIFY",
    payload: {
      replayInput?: unknown;
      output?: unknown;
      artifact?: unknown;
      humanSummary?: string;
      meta?: Record<string, unknown>;
    },
  ) => void;
  getArtifactSummary: (phase: "CODING" | "VERIFY") => string;
  summarizeResult: (label: string, result: any) => void;
  extractPlanFilePaths: (plan: any, field: "files_to_modify" | "files_to_create") => string[];
  appendDebugStageAttempt: (
    stage: "VERIFY",
    label: string,
    input?: unknown,
    output?: unknown,
    error?: string,
  ) => void;
  qaAgentExecute: (
    input: any,
    lessons: string,
    onThought: (message: string) => void,
  ) => Promise<any>;
  forwardAgentProgress: (phase: string, index: number) => (message: string) => void;
  selectRuntimeOption: (
    discovery: RuntimeDiscoveryResult | null,
    options: {
      prompt: string;
      configuredPreference?: string;
      taskObjective?: string;
      targetRoute?: string;
      targetComponentPath?: string;
    },
  ) => ProjectRuntimeOption | null;
}

export interface ExecuteVerifyPhaseResult {
  codingRes: any;
  codeArtifact: CodeArtifact;
  validationReport: ValidationReport;
  qaRes: any;
  verifyMeta: Record<string, unknown>;
}

/**
 * 执行 VERIFY 阶段的完整小闭环。
 *
 * 这段逻辑之所以值得单独成模块，是因为它本身已经像一个小工作流：
 * 1. 先跑本地静态校验 / repair loop
 * 2. 再决定 QA 站点从哪里来
 * 3. 最后才决定是跑浏览器自动化，还是输出结构化 skipped/fallback
 */
export async function executeVerifyPhase(params: ExecuteVerifyPhaseParams): Promise<ExecuteVerifyPhaseResult> {
  params.emitStepStart("VERIFY", "🧪 正在执行自动化 QA...", 5);
  params.emitStepProgress({
    phase: "VERIFY",
    content: "[系统] 正在执行本地静态校验与自动化 QA 预检。",
    index: 5,
  });

  const codingValidation = await params.runCodingValidationRepairLoop({
    initialResult: params.codingRes,
    baseInput: params.codingInput,
    planArtifact: params.planRes,
    sharedLessons: params.sharedLessons,
    progressPhase: "VERIFY",
    progressIndex: 5,
    attemptLabelPrefix: "verify",
  });

  let codingRes = codingValidation.result;
  const validationReport = codingValidation.validationReport;
  if (validationReport.hasBlockingIssues) {
    params.emitStepComplete("VERIFY", "error", 5);
    throw new Error(validationReport.summary);
  }

  let codeArtifact = normalizeCodeArtifact(codingRes, [
    validationReport.summary,
    ...validationReport.highlights,
  ]);
  params.setPhaseArtifact(
    "CODING",
    buildArtifactEnvelope("CODING", params.buildHumanSummaryFromResult("CODING", codingRes), codeArtifact),
  );
  params.finalizeDebugStage("CODING", {
    output: codingRes,
    artifact: undefined,
    humanSummary: params.getArtifactSummary("CODING"),
    meta: {
      persistedBeforeVerify: true,
      validationSummary: validationReport.summary,
    },
  });

  params.emitStepProgress({
    phase: "VERIFY",
    content: "[系统] 本地静态校验已通过，准备执行浏览器自动化验证。",
    index: 5,
  });

  const qaCases = params.collectQaCases(codingRes, params.planRes);
  const selectedRuntime = params.selectRuntimeOption(params.runtimeDiscovery, {
    prompt: params.originalPrompt,
    configuredPreference: params.llmQaConfig?.envPreference,
    taskObjective: params.taskObjective,
    targetRoute: params.targetRoute,
    targetComponentPath: params.targetComponentPath,
  });

  if (params.runtimeDiscovery?.options.length) {
    params.emitStepProgress({
      phase: "VERIFY",
      content: `[系统] 已识别本地启动脚本：${params.runtimeDiscovery.options.slice(0, 4).map((item) => item.scriptName).join("、")}`,
      index: 5,
    });
  }
  if (params.runtimeDiscovery?.envFiles?.length) {
    params.emitStepProgress({
      phase: "VERIFY",
      content: `[系统] 已识别环境文件：${params.runtimeDiscovery.envFiles.slice(0, 4).join("、")}`,
      index: 5,
    });
  }

  let qaBaseUrl = await params.discoverExplicitQaBaseUrl(params.originalPrompt);
  let qaBaseUrlSource = qaBaseUrl ? "explicit" : "";
  let qaBootError = "";
  let qaLaunchLabel = "";
  const shouldAutoBoot = params.llmQaConfig?.autoBoot !== false;

  if (!qaBaseUrl && shouldAutoBoot && params.runtimeDiscovery && selectedRuntime) {
    params.emitStepProgress({
      phase: "VERIFY",
      content: `[系统] 未探测到现成本地站点，正在尝试自动启动 ${selectedRuntime.scriptName} 环境。`,
      index: 5,
    });
    try {
      const bootRes = await params.tryAutoBootQaRuntime(selectedRuntime, params.runtimeDiscovery.packageManager);
      qaBaseUrl = bootRes.baseUrl;
      qaBaseUrlSource = "auto_boot";
      qaLaunchLabel = bootRes.launchLabel;
      params.emitStepProgress({
        phase: "VERIFY",
        content: `[系统] 已自动启动测试环境：${bootRes.launchLabel} -> ${bootRes.baseUrl}`,
        index: 5,
      });
    } catch (error: any) {
      qaBootError = error?.message || "本地测试环境启动失败";
      params.emitStepProgress({
        phase: "VERIFY",
        content: `[系统] 本地启动尝试失败：${qaBootError}`,
        index: 5,
      });
    }
  }

  if (!qaBaseUrl) {
    qaBaseUrl = await params.discoverReachableQaBaseUrl(selectedRuntime?.portHints || []);
    if (qaBaseUrl) {
      qaBaseUrlSource = selectedRuntime ? "probe_fallback" : "probe";
    }
  }

  const hasBrowserTools = await params.hasChromeDevtoolsTools();
  const verifyMeta: Record<string, unknown> = {
    validationReport: cloneForDebug(validationReport),
  };
  params.trace("qa_precheck", {
    caseCount: qaCases.length,
    qaBaseUrl,
    qaBaseUrlSource,
    hasBrowserTools,
    qaAutoBoot: shouldAutoBoot,
    selectedRuntimeScript: selectedRuntime?.scriptName || "",
    selectedRuntimeMode: selectedRuntime?.mode || "",
    qaLaunchLabel,
    qaBootError,
  });
  verifyMeta.qa_precheck = {
    caseCount: qaCases.length,
    qaBaseUrl,
    qaBaseUrlSource,
    hasBrowserTools,
    qaAutoBoot: shouldAutoBoot,
    selectedRuntimeScript: selectedRuntime?.scriptName || "",
    selectedRuntimeMode: selectedRuntime?.mode || "",
    qaLaunchLabel,
    qaBootError,
  };
  params.emitQaCasePreview(qaCases, qaBaseUrl, hasBrowserTools, params.planArtifact.test_cases);
  if (qaCases.length > 0) {
    params.emitStepProgress({
      phase: "VERIFY",
      content: "[系统] 测试用例清单已生成，开始准备自动化 QA。",
      index: 5,
    });
  }

  let qaRes: any;
  if (qaCases.length === 0) {
    qaRes = params.buildQaFallbackResult(
      "skipped",
      "当前阶段未产出明确验证点，已跳过浏览器自动化 QA。",
      [],
      { blockedReasons: ["缺少可执行的验证点"] },
    );
  } else if (!hasBrowserTools) {
    qaRes = params.buildQaFallbackResult(
      "skipped",
      "当前环境未连接 chrome-devtools MCP，已跳过浏览器自动化 QA。",
      qaCases,
      { blockedReasons: ["chrome-devtools MCP 未就绪"] },
    );
  } else if (!qaBaseUrl) {
    qaRes = params.buildQaFallbackResult(
      "skipped",
      "未探测到可访问的本地测试站点，已跳过浏览器自动化 QA。",
      qaCases,
      {
        blockedReasons: [
          qaBootError || "",
          !shouldAutoBoot ? "未发现可访问站点，且已关闭自动启动测试环境。" : "",
          selectedRuntime ? `已识别候选脚本：${selectedRuntime.scriptName}` : "未发现可用于启动本地站点的脚本。",
          "未发现可访问的 localhost/127.0.0.1 测试地址",
        ].filter(Boolean),
      },
    );
  } else {
    params.emitStepProgress({
      phase: "VERIFY",
      content: `[系统] 已锁定 QA 测试站点：${qaBaseUrl}`,
      index: 5,
    });
    const qaReplayInput = {
      baseUrl: qaBaseUrl,
      targetRoute: params.targetRoute,
      verificationPoints: qaCases,
      testCases: params.planArtifact.test_cases,
      changedFiles: Array.from(new Set([
        ...params.extractPlanFilePaths(codingRes, "files_to_create"),
        ...params.extractPlanFilePaths(codingRes, "files_to_modify"),
      ])),
      codingSummary: summarizeText(
        codingRes?.completion_summary || codingRes?.reasoning || JSON.stringify(codingRes || {}),
      ),
      targetComponentPath: params.targetComponentPath,
      artifacts: {
        code: codeArtifact,
        plan: params.planArtifact,
        projectSnapshot: params.projectSnapshotArtifact,
      },
    };

    try {
      qaRes = await params.qaAgentExecute(
        qaReplayInput,
        params.sharedLessons,
        params.forwardAgentProgress("VERIFY", 5),
      );
      params.appendDebugStageAttempt("VERIFY", "qa_agent", qaReplayInput, qaRes);
      params.finalizeDebugStage("VERIFY", {
        replayInput: qaReplayInput,
        meta: verifyMeta,
      });
    } catch (error: any) {
      qaRes = {
        reasoning: `自动化 QA 执行过程中发生错误：${error?.message || "unknown"}`,
        overall_status: "failed",
        tested_url: qaBaseUrl,
        cases: qaCases.map((item) => ({
          name: item,
          status: "failed",
          evidence: error?.message || "自动化 QA 执行失败",
        })),
        blocked_reasons: [error?.message || "自动化 QA 执行失败"],
        qa_summary: `自动化 QA 执行失败：${error?.message || "unknown"}`,
      };
      params.appendDebugStageAttempt("VERIFY", "qa_agent_failed", qaReplayInput, qaRes, error?.message || "unknown");
      params.finalizeDebugStage("VERIFY", {
        replayInput: qaReplayInput,
        meta: verifyMeta,
      });
    }
  }

  const validationWarnings = validationReport.issues.filter((item) => item.severity === "warning");
  if (validationWarnings.length > 0) {
    qaRes.blocked_reasons = Array.from(
      new Set([
        ...(Array.isArray(qaRes.blocked_reasons) ? qaRes.blocked_reasons : []),
        ...validationWarnings.slice(0, 2).map((item) => `静态提醒：${item.file} · ${item.message}`),
      ]),
    );
  }

  const verifyArtifact = normalizeVerifyArtifact(
    qaRes,
    params.planArtifact.test_cases,
    [validationReport.summary, ...validationReport.highlights],
  );
  params.setPhaseArtifact(
    "VERIFY",
    buildArtifactEnvelope("VERIFY", params.buildHumanSummaryFromResult("VERIFY", qaRes), verifyArtifact),
  );

  params.summarizeResult("VERIFY", qaRes);
  params.finalizeDebugStage("CODING", {
    replayInput: params.codingInput,
    output: codingRes,
    artifact: undefined,
    humanSummary: params.getArtifactSummary("CODING"),
  });
  params.finalizeDebugStage("VERIFY", {
    output: qaRes,
    artifact: undefined,
    humanSummary: params.getArtifactSummary("VERIFY"),
    meta: verifyMeta,
  });
  if (qaRes?.overall_status === "failed") {
    params.emitStepComplete("VERIFY", "error", 5);
    throw new Error(qaRes?.qa_summary || "自动化 QA 未通过。");
  }

  params.emitStepComplete("VERIFY", "success", 5);
  return {
    codingRes,
    codeArtifact,
    validationReport,
    qaRes,
    verifyMeta,
  };
}
