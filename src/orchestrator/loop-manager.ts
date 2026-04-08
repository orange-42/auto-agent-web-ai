import axios from "axios";
import { BaseAgent, LLMConfig, IntentAgent, PRDAgent, APIAgent, PlannerAgent, CoderAgent, QAAgent } from "../agents";
import { MCPHub } from "../mcp-hub";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { ChildProcess, spawn } from "child_process";
import { LarkPrefetcher } from "../lark-prefetcher";
import { appendHarnessJsonl, appendHarnessLog, summarizeText } from "../harness-logger";
import { EvalHarness } from "../harness/lesson-rag";
import { analyzeCodeFile } from "../code-analysis";
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
  normalizePrdArtifact,
  normalizeProjectSnapshotArtifact,
  normalizeVerifyArtifact,
  PhaseArtifactEnvelope,
  PlanArtifact,
  PrdArtifact,
  ProjectSnapshotArtifact,
  TestCaseArtifact,
  VerifyArtifact,
} from "../phase-artifacts";

interface ValidationIssue {
  severity: "error" | "warning";
  file: string;
  message: string;
  suggestion?: string;
  kind?: string;
}

interface ValidationReport {
  checkedFiles: string[];
  issues: ValidationIssue[];
  hasBlockingIssues: boolean;
  summary: string;
  highlights: string[];
  stats: string[];
}

interface QAResultCase {
  name?: string;
  status?: "passed" | "failed" | "skipped";
  evidence?: string;
}

interface ProjectRuntimeOption {
  scriptName: string;
  mode: string;
  commandPreview: string;
  portHints: number[];
  envFiles: string[];
  score: number;
}

interface RuntimeDiscoveryResult {
  packageManager: "yarn" | "pnpm" | "npm";
  envFiles: string[];
  options: ProjectRuntimeOption[];
}

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

  private log(content: string) {
    appendHarnessLog("orchestrator.log", `🚀 [runId=${this.runId}] ${content}`);
  }

  private get runId() {
    return this.llmConfig.runId || "run_unknown";
  }

  private trace(type: string, payload: Record<string, unknown>) {
    appendHarnessJsonl("workflow_steps.jsonl", {
      runId: this.runId,
      type,
      ...payload,
    });
  }

  private emitStepStart(phase: string, title: string, index: number) {
    this.log(`[STEP_START] phase=${phase} index=${index} title=${title}`);
    this.trace("step_start", { phase, title, index });
    this.emit("step-start", { phase, title, index });
  }

  private emitStepProgress(data: { phase: string; index: number; thought?: string; content?: string }) {
    this.trace("step_progress", {
      phase: data.phase,
      index: data.index,
      thoughtLen: data.thought?.length || 0,
      contentLen: data.content?.length || 0,
      preview: summarizeText(data.content || data.thought || "", 140),
    });
    this.emit("step-progress", data);
  }

  private emitStepComplete(phase: string, status: string, index: number) {
    this.log(`[STEP_COMPLETE] phase=${phase} index=${index} status=${status}`);
    this.trace("step_complete", { phase, status, index });
    this.emit("step-complete", { phase, status, index });
  }

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

  private emitWorkflowComplete(status: string, message?: string) {
    this.log(`[WORKFLOW_COMPLETE] status=${status}${message ? ` message=${message}` : ""}`);
    this.trace("workflow_complete", { status, message: message || "" });
    this.emit("workflow-complete", { status, message });
  }

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
  }

  private getArtifactSummary(phase: keyof V2Orchestrator["phaseArtifacts"]): string {
    return this.phaseArtifacts[phase]?.human_summary || "";
  }

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

  private buildHumanSummaryFromResult(label: string, result: any): string {
    const phaseSummary = this.buildPhaseSummary(label, result);
    if (phaseSummary) {
      return `${phaseSummary.title}：${phaseSummary.summary}`;
    }
    if (typeof result?.summary === "string" && result.summary.trim()) return result.summary.trim();
    if (typeof result?.reasoning === "string" && result.reasoning.trim()) {
      return summarizeText(result.reasoning, 200);
    }
    return `${label} 阶段已完成。`;
  }

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

  private ensureApiArtifactGate(apiArtifact: ApiArtifact) {
    if (apiArtifact.api_mappings.length === 0) {
      throw new Error("API 阶段未产出 api_mappings，已阻止继续进入后续步骤。");
    }
    if (apiArtifact.evidence_refs.length === 0) {
      throw new Error("API 阶段未保留 evidence_refs，已阻止继续进入后续步骤。");
    }
  }

  private ensurePlanArtifactGate(planArtifact: PlanArtifact) {
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
  }

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
      reasoningPreview: summarizeText(result?.reasoning || "", 160),
    };
    this.trace("phase_output", summary);
    this.log(`[PHASE_OUTPUT] ${label} ${JSON.stringify(summary)}`);
    const phaseSummary = this.buildPhaseSummary(label, result);
    if (phaseSummary) {
      this.emitPhaseSummary(phaseSummary);
    }
  }

  private toReadablePhaseSummary(value: unknown): string {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim();
  }

  private buildPhaseSummary(label: string, result: any) {
    const phaseIndexMap: Record<string, number> = {
      INTENT: 0,
      PRD: 1,
      API: 2,
      PLAN: 3,
      CODING: 4,
      VERIFY: 5,
    };
    const index = phaseIndexMap[label];
    const highlights: string[] = [];
    const stats: string[] = [];
    let title = "";
    let summary = "";

    if (label === "PRD") {
      title = "需求摘要已生成";
      summary = this.toReadablePhaseSummary(result?.content_verified || result?.reasoning || "");
      if (Array.isArray(result?.modules)) {
        stats.push(`模块 ${result.modules.length}`);
        highlights.push(
          ...result.modules.slice(0, 3).map((module: any) =>
            `模块：${module?.name || "未命名"}${module?.desc ? ` · ${module.desc}` : ""}`,
          ),
        );
      }
      if (Array.isArray(result?.logic_rules)) {
        stats.push(`规则 ${result.logic_rules.length}`);
        highlights.push(...result.logic_rules.slice(0, 3).map((rule: string) => `规则：${rule}`));
      }
      if (Array.isArray(result?.placement_hints) && result.placement_hints.length > 0) {
        stats.push(`落点 ${result.placement_hints.length}`);
        highlights.push(...result.placement_hints.slice(0, 2).map((item: string) => `落点：${item}`));
      }
      if (Array.isArray(result?.dependency_checks) && result.dependency_checks.length > 0) {
        highlights.push(...result.dependency_checks.slice(0, 2).map((item: string) => `依赖：${item}`));
      }
    } else if (label === "API") {
      title = "接口映射已收敛";
      summary = this.toReadablePhaseSummary(result?.reasoning || "");
      if (Array.isArray(result?.api_mappings)) {
        stats.push(`接口 ${result.api_mappings.length}`);
        highlights.push(
          ...result.api_mappings.slice(0, 3).map((mapping: any) =>
            `接口：${mapping?.method || ""} ${mapping?.endpoint || ""}${mapping?.purpose ? ` · ${mapping.purpose}` : ""}`.trim(),
          ),
        );
      }
      if (Array.isArray(result?.component_impact) && result.component_impact.length > 0) {
        stats.push(`影响组件 ${result.component_impact.length}`);
        highlights.push(...result.component_impact.slice(0, 2).map((item: string) => `组件：${item}`));
      }
    } else if (label === "PLAN") {
      title = "实施方案已确定";
      summary = this.toReadablePhaseSummary(result?.reasoning || "");
      if (Array.isArray(result?.files_to_modify)) {
        stats.push(`修改文件 ${result.files_to_modify.length}`);
        highlights.push(
          ...result.files_to_modify.slice(0, 3).map((item: any) =>
            `修改：${item?.path || item?.file || "未标明文件"}${item?.description ? ` · ${item.description}` : ""}`,
          ),
        );
      }
      if (Array.isArray(result?.files_to_create) && result.files_to_create.length > 0) {
        stats.push(`新增文件 ${result.files_to_create.length}`);
        highlights.push(
          ...result.files_to_create.slice(0, 2).map((item: any) => `新增：${item?.path || item?.file || "未标明文件"}`),
        );
      }
      if (Array.isArray(result?.verification_points) && result.verification_points.length > 0) {
        stats.push(`验证点 ${result.verification_points.length}`);
        highlights.push(...result.verification_points.slice(0, 2).map((item: string) => `验证：${item}`));
      }
      if (Array.isArray(result?.test_cases) && result.test_cases.length > 0) {
        stats.push(`测试用例 ${result.test_cases.length}`);
        highlights.push(
          ...result.test_cases.slice(0, 2).map((item: any) =>
            `用例：${item?.name || item?.goal || "未命名"}${item?.goal ? ` · ${item.goal}` : ""}`,
          ),
        );
      }
    } else if (label === "CODING") {
      title = "代码集成已执行";
      summary = this.toReadablePhaseSummary(
        result?.reasoning || result?.raw_content || JSON.stringify(result || {}),
      );
      if (Array.isArray(result?.files_to_modify) && result.files_to_modify.length > 0) {
        stats.push(`修改文件 ${result.files_to_modify.length}`);
      }
      if (Array.isArray(result?.files_to_create) && result.files_to_create.length > 0) {
        stats.push(`新增文件 ${result.files_to_create.length}`);
      }
      if (Array.isArray(result?.verification_points) && result.verification_points.length > 0) {
        highlights.push(...result.verification_points.slice(0, 3).map((item: string) => `验证：${item}`));
      }
    } else if (label === "VERIFY") {
      title = result?.overall_status === "failed"
        ? "自动化 QA 未通过"
        : result?.overall_status === "skipped"
          ? "自动化 QA 已跳过"
          : "自动化 QA 已完成";
      summary = this.toReadablePhaseSummary(result?.qa_summary || result?.reasoning || "");
      if (Array.isArray(result?.cases)) {
        const cases = result.cases as QAResultCase[];
        const passed = cases.filter((item) => item?.status === "passed").length;
        const failed = cases.filter((item) => item?.status === "failed").length;
        const skipped = cases.filter((item) => item?.status === "skipped").length;
        stats.push(`用例 ${cases.length}`);
        stats.push(`通过 ${passed}`);
        if (failed > 0) stats.push(`失败 ${failed}`);
        if (skipped > 0) stats.push(`跳过 ${skipped}`);
        highlights.push(
          ...cases.slice(0, 3).map((item) =>
            `用例：${item?.name || "未命名"} · ${item?.status || "unknown"}${item?.evidence ? ` · ${item.evidence}` : ""}`,
          ),
        );
      }
      if (Array.isArray(result?.blocked_reasons) && result.blocked_reasons.length > 0) {
        highlights.push(...result.blocked_reasons.slice(0, 2).map((item: string) => `受阻：${item}`));
      }
    } else {
      return null;
    }

    return {
      phase: label,
      index,
      title,
      summary: summary || "该阶段已完成。",
      highlights: highlights.filter(Boolean).slice(0, 5),
      stats: stats.filter(Boolean).slice(0, 4),
    };
  }

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

  private extractTaskObjective(prompt: string): string {
    const headingMatch = prompt.match(/##\s*4\.\s*任务目标\s*([\s\S]*?)(?:\n##\s|\n#\s|$)/);
    if (headingMatch?.[1]) {
      return headingMatch[1].replace(/[-*]/g, " ").replace(/\s+/g, " ").trim();
    }

    const lineMatch = prompt.match(/任务目标[:：]\s*(.+)/);
    if (lineMatch?.[1]) {
      return lineMatch[1].trim();
    }

    return summarizeText(prompt.replace(/\s+/g, " ").trim(), 120);
  }

  private buildExecutionBrief(): string {
    return [
      `任务目标：${this.taskObjective || "根据需求文档与接口文档完成指定迭代开发"}`,
      this.projectPath ? `项目路径：${this.projectPath}` : "",
      this.targetRoute ? `目标路由：${this.targetRoute}` : "",
      this.targetComponentPath ? `核心组件：${this.targetComponentPath}` : "",
      "要求：先理解 PRD 与接口，再围绕目标组件高效收敛并落地写码。",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private extractEvidenceKeywords(seedTexts: string[]): string[] {
    const tokens = new Set<string>();
    for (const text of seedTexts) {
      const normalized = String(text || "").trim();
      if (!normalized) continue;

      const chineseTokens = normalized.match(/[\u4e00-\u9fff]{2,10}/g) || [];
      for (const token of chineseTokens) {
        if (token.length >= 2) tokens.add(token);
        if (tokens.size >= 12) break;
      }

      const asciiTokens = normalized.match(/[A-Za-z][A-Za-z0-9_-]{2,30}/g) || [];
      for (const token of asciiTokens) {
        const lower = token.toLowerCase();
        if (["users", "views", "components", "pages", "project", "target"].includes(lower)) continue;
        tokens.add(token);
        if (tokens.size >= 12) break;
      }

      if (tokens.size >= 12) break;
    }

    return Array.from(tokens).slice(0, 12);
  }

  private buildFocusedDocumentContent(
    rawContent: string,
    phase: "PRD" | "API",
    seedTexts: string[] = [],
  ): string {
    const normalized = String(rawContent || "").trim();
    if (!normalized) return "";
    if (normalized.length <= 24000) return normalized;

    const lines = normalized
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (lines.length <= 120) return normalized;

    const keywordPatterns = this.extractEvidenceKeywords(seedTexts)
      .map((token) => new RegExp(this.escapeRegex(token), "i"));

    const phasePatterns =
      phase === "PRD"
        ? [/功能详述/u, /原型/u, /截图/u, /按钮/u, /入口/u, /位置/u, /文案/u, /状态/u, /页面/u, /锁定/u, /解锁/u, /退款/u]
        : [/GET\b/i, /POST\b/i, /PUT\b/i, /DELETE\b/i, /接口/u, /endpoint/i, /path/i, /params/i, /body/i, /响应/u, /返回/u, /状态码/u, /lock/i, /unlock/i];

    const selectedIndexes = new Set<number>();
    for (let i = 0; i < Math.min(lines.length, 36); i++) {
      selectedIndexes.add(i);
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const matched =
        phasePatterns.some((pattern) => pattern.test(line)) ||
        keywordPatterns.some((pattern) => pattern.test(line));
      if (!matched) continue;

      for (let offset = -1; offset <= 2; offset++) {
        const index = i + offset;
        if (index >= 0 && index < lines.length) selectedIndexes.add(index);
      }
    }

    const selectedLines = Array.from(selectedIndexes)
      .sort((a, b) => a - b)
      .map((index) => lines[index]);

    const header =
      phase === "PRD"
        ? "[文档已按证据优先压缩：保留概览、功能详述、原型/截图、按钮/落点/状态相关片段]"
        : "[文档已按证据优先压缩：保留概览、接口定义、字段/约束、状态码与调用规则相关片段]";
    const focused = [header, ...selectedLines].join("\n");
    return focused.length <= 28000 ? focused : `${focused.slice(0, 28000)}\n...[高相关文档片段已截断]`;
  }

  private collectDocumentEvidenceSnippets(rawContent: string, patterns: RegExp[], limit: number = 10): string[] {
    if (!rawContent.trim()) return [];

    const lines = rawContent
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const snippets: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!patterns.some((pattern) => pattern.test(line))) continue;

      const windowLines = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2));
      const snippet = windowLines.join(" | ").trim();
      if (!snippet) continue;
      snippets.push(summarizeText(snippet, 220));
      if (snippets.length >= limit) break;
    }

    return Array.from(new Set(snippets));
  }

  private buildPrdEvidenceContext(rawContent: string): string {
    const evidence = this.collectDocumentEvidenceSnippets(
      rawContent,
      [/功能详述/u, /原型/u, /截图/u, /页面/u, /按钮/u, /入口/u, /位置/u, /文案/u, /状态/u, /锁定/u, /解锁/u, /退款/u],
      10,
    );
    if (evidence.length === 0) return "";
    return ["[PRD 原型/落点证据锚点]", ...evidence.map((item) => `- ${item}`)].join("\n");
  }

  private buildPrdFocusContext(prd: any): string {
    const lines: string[] = [];

    if (prd?.content_verified) {
      lines.push(`- 核心摘要：${String(prd.content_verified).trim()}`);
    }

    if (Array.isArray(prd?.logic_rules)) {
      lines.push(...prd.logic_rules.slice(0, 4).map((item: string) => `- 业务规则：${item}`));
    }

    if (Array.isArray(prd?.ui_requirements)) {
      lines.push(...prd.ui_requirements.slice(0, 4).map((item: string) => `- UI要求：${item}`));
    }

    if (Array.isArray(prd?.placement_hints)) {
      lines.push(...prd.placement_hints.slice(0, 4).map((item: string) => `- 页面落点：${item}`));
    }

    if (Array.isArray(prd?.dependency_checks)) {
      lines.push(...prd.dependency_checks.slice(0, 4).map((item: string) => `- 依赖检查：${item}`));
    }

    if (Array.isArray(prd?.evidence_refs)) {
      lines.push(...prd.evidence_refs.slice(0, 4).map((item: string) => `- 证据锚点：${item}`));
    }

    const deduped = Array.from(new Set(lines.map((item) => item.trim()).filter(Boolean))).slice(0, 12);
    if (deduped.length === 0) return "";

    return ["[PRD 细节锚点]", ...deduped].join("\n");
  }

  private sanitizePrdTextLine(line: string): string {
    return String(line || "")
      .replace(/^\[.*?\]\s*/g, "")
      .replace(/^[-*]\s*/g, "")
      .replace(/^#+\s*/g, "")
      .replace(/[`*_>]/g, "")
      .replace(/\s*\|\s*/g, "；")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractPrdBlockLines(block: string, limit: number = 8): string[] {
    if (!block.trim()) return [];
    return Array.from(
      new Set(
        block
          .split(/\r?\n/)
          .map((line) => this.sanitizePrdTextLine(line))
          .filter((line) => line && !/^SOURCE:/i.test(line)),
      ),
    ).slice(0, limit);
  }

  private collectPrdFallbackLines(rawContent: string, patterns: RegExp[], limit: number = 6): string[] {
    if (!rawContent.trim()) return [];

    const lines = rawContent
      .split(/\r?\n/)
      .map((line) => this.sanitizePrdTextLine(line))
      .filter(Boolean);

    const picked: string[] = [];
    for (const line of lines) {
      if (!patterns.some((pattern) => pattern.test(line))) continue;
      if (/^(预读|指令|高优先级证据锚点)$/u.test(line)) continue;
      if (line.length < 4) continue;
      picked.push(summarizeText(line, 120));
      if (picked.length >= limit) break;
    }

    return Array.from(new Set(picked));
  }

  private isPlaceholderPrdText(text: unknown): boolean {
    const normalized = String(text || "").replace(/\s+/g, "").trim();
    if (!normalized) return true;
    return /暂无.*(内容|文档)|等待文档解析|文档内容.*为空|预读部分为空|暂无文档内容可验证|无法访问外部链接|无法读取文档|fetch_doc|获取文档的Markdown内容|先执行(读取|抓取)操作/u.test(
      normalized,
    );
  }

  private extractFeatureNameFromObjective(): string {
    const objective = String(this.taskObjective || "").trim();
    if (!objective) return "";

    const quoted = objective.match(/[“"]([^”"]{2,24})[”"]/u);
    if (quoted?.[1]) return quoted[1].trim();

    const integrationMatch = objective.match(/集成[“"]?([^”"。；，]{2,24})/u);
    if (integrationMatch?.[1]) {
      return integrationMatch[1].replace(/功能$/u, "").trim();
    }

    return "";
  }

  private buildPrdFallbackModules(featureName: string, componentLabel: string, sourceText: string) {
    const modules: Array<{ name: string; desc: string }> = [];

    if (/退款|资损/u.test(sourceText)) {
      modules.push({
        name: "业务风控约束",
        desc: `围绕 ${featureName || "目标功能"} 约束退款相关流程中的风险操作与状态判断。`,
      });
    }

    modules.push({
      name: "页面集成落点",
      desc: `在 ${componentLabel} 内承接状态展示、入口交互与接口联动。`,
    });

    return modules.slice(0, 3);
  }

  private buildLocalPrdFallback(rawContent: string, evidenceContext: string) {
    const featureName = this.extractFeatureNameFromObjective() || "目标功能";
    const routeLabel = this.targetRoute || "目标页面";
    const componentPath = this.targetComponentPath || "";
    const componentLabel = componentPath ? path.basename(componentPath) : "目标组件";
    const sourceText = [rawContent, evidenceContext, this.taskObjective, routeLabel, componentPath]
      .filter(Boolean)
      .join("\n");

    const evidenceRefs = Array.from(
      new Set([
        ...this.extractPrdBlockLines(evidenceContext, 8),
        ...this.collectDocumentEvidenceSnippets(
          rawContent,
          [/功能详述/u, /原型/u, /截图/u, /页面/u, /按钮/u, /入口/u, /位置/u, /文案/u, /状态/u, /锁定/u, /解锁/u, /退款/u],
          6,
        ).map((item) => this.sanitizePrdTextLine(item)),
        ...this.collectPrdFallbackLines(
          rawContent,
          [/退款/u, /资损/u, /锁定/u, /解锁/u, /照片/u, /下载/u, /入口/u, /按钮/u, /页面/u, /组件/u],
          6,
        ),
      ].filter(Boolean)),
    ).slice(0, 10);

    const logicRules = this.collectPrdFallbackLines(
      rawContent,
      [/必须/u, /需要/u, /需/u, /应/u, /如果/u, /当/u, /只有/u, /避免/u, /锁定/u, /解锁/u, /退款/u, /下载/u, /状态/u, /校验/u, /资损/u],
      6,
    );
    if (logicRules.length === 0) {
      if (/退款|资损/u.test(sourceText) && /照片|锁定|解锁/u.test(sourceText)) {
        logicRules.push("退款相关流程中需结合照片锁定状态控制操作时机，避免因下载时机不当造成资损。");
      }
      if (/锁定|解锁|状态/u.test(sourceText)) {
        logicRules.push("页面需根据当前锁定状态决定展示内容与可执行动作，避免重复锁定或错误解锁。");
      }
      if (componentPath) {
        logicRules.push(`功能应优先收敛到 ${componentPath}，并与当前订单详情数据联动。`);
      } else {
        logicRules.push(`需围绕 ${featureName} 在目标页面落实核心业务控制和状态展示。`);
      }
    }

    const placementHints = this.collectPrdFallbackLines(
      rawContent,
      [/页面/u, /入口/u, /位置/u, /按钮/u, /模块/u, /卡片/u, /组件/u, /订单详情/u],
      4,
    ).filter((item) => !/按钮状态/u.test(item));
    if (placementHints.length === 0) {
      placementHints.push(`功能入口应落在 ${routeLabel} 对应页面的 ${componentLabel} 内。`);
    } else if (componentPath) {
      placementHints.unshift(`优先在 ${componentPath} 对应的 ${componentLabel} 内承接入口与状态展示。`);
    }

    const uiRequirements = this.collectPrdFallbackLines(
      rawContent,
      [/按钮/u, /文案/u, /状态/u, /展示/u, /提示/u, /弹窗/u, /交互/u, /入口/u, /锁定/u, /解锁/u],
      4,
    );
    if (uiRequirements.length === 0) {
      uiRequirements.push(`在 ${componentLabel} 区域展示 ${featureName} 相关状态、入口或结果反馈。`);
    }

    const dependencyChecks = this.collectPrdFallbackLines(
      rawContent,
      [/权限/u, /配置/u, /枚举/u, /字段/u, /接口/u, /错误/u, /校验/u, /依赖/u],
      5,
    );
    if (dependencyChecks.length === 0) {
      dependencyChecks.push("需要确认前端所依赖的状态字段、接口能力、权限项与错误文案映射。");
    }

    const contentSummaryCandidates = [
      ...this.collectPrdFallbackLines(
        rawContent,
        [/用户故事/u, /功能详述/u, /退款/u, /资损/u, /锁定/u, /解锁/u, /照片/u, /下载/u, /订单详情/u],
        3,
      ),
      ...this.extractPrdBlockLines(evidenceContext, 2),
    ];
    const contentVerified = contentSummaryCandidates.length > 0
      ? summarizeText(contentSummaryCandidates.join("；"), 180)
      : `${featureName} 需集成到 ${routeLabel} 的 ${componentLabel}，并围绕当前业务流程补齐状态查询、交互入口与风险控制。`;

    const artifact: PrdArtifact = {
      content_verified: contentVerified,
      logic_rules: Array.from(new Set(logicRules)).slice(0, 6),
      ui_requirements: Array.from(new Set(uiRequirements)).slice(0, 6),
      placement_hints: Array.from(new Set(placementHints)).slice(0, 4),
      dependency_checks: Array.from(new Set(dependencyChecks)).slice(0, 6),
      evidence_refs: evidenceRefs.length > 0
        ? evidenceRefs
        : [`任务目标：${this.taskObjective || `${routeLabel} / ${componentLabel}`}`],
    };

    const result = {
      reasoning: contentVerified,
      modules: this.buildPrdFallbackModules(featureName, componentLabel, sourceText),
      ...artifact,
      fallback_generated: true,
    };

    return { artifact, result };
  }

  private backfillPrdResultWithLocalEvidence(prdRes: any, rawContent: string, evidenceContext: string) {
    const fallback = this.buildLocalPrdFallback(rawContent, evidenceContext);
    const merged = prdRes && typeof prdRes === "object" ? { ...prdRes } : {};

    if (this.isPlaceholderPrdText(merged.reasoning)) {
      merged.reasoning = fallback.result.reasoning;
    }
    if (this.isPlaceholderPrdText(merged.content_verified)) {
      merged.content_verified = fallback.artifact.content_verified;
    }
    if (!Array.isArray(merged.logic_rules) || merged.logic_rules.length === 0) {
      merged.logic_rules = fallback.artifact.logic_rules;
    }
    if (!Array.isArray(merged.ui_requirements) || merged.ui_requirements.length === 0) {
      merged.ui_requirements = fallback.artifact.ui_requirements;
    }
    if (!Array.isArray(merged.placement_hints) || merged.placement_hints.length === 0) {
      merged.placement_hints = fallback.artifact.placement_hints;
    }
    if (!Array.isArray(merged.dependency_checks) || merged.dependency_checks.length === 0) {
      merged.dependency_checks = fallback.artifact.dependency_checks;
    }
    if (!Array.isArray(merged.evidence_refs) || merged.evidence_refs.length === 0) {
      merged.evidence_refs = fallback.artifact.evidence_refs;
    }
    if (!Array.isArray(merged.modules) || merged.modules.length === 0) {
      merged.modules = fallback.result.modules;
    }
    merged.fallback_generated = true;

    return {
      result: merged,
      artifact: normalizePrdArtifact(merged),
    };
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private buildTargetContextKeywordRules(): RegExp[] {
    const stopwords = new Set([
      "根据",
      "需求",
      "文档",
      "接口",
      "开发",
      "迭代",
      "功能",
      "页面",
      "组件",
      "项目",
      "目标",
      "核心",
      "完成",
      "相关",
      "逻辑",
      "业务",
      "集成",
      "开发迭代指令",
    ]);

    const rawTokens: string[] = [];
    const collectTokens = (source: string) => {
      if (!source) return;
      rawTokens.push(...(source.match(/[\u4e00-\u9fa5]{2,8}/g) || []));
      rawTokens.push(...(source.match(/[A-Za-z][A-Za-z0-9_-]{2,30}/g) || []));
    };

    collectTokens(this.taskObjective || "");
    collectTokens(this.targetRoute || "");
    collectTokens(path.basename(this.targetComponentPath || "", path.extname(this.targetComponentPath || "")));

    const routeSegments = (this.targetRoute || "")
      .split(/[\/:_-]+/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    rawTokens.push(...routeSegments);

    const derivedRules = Array.from(new Set(rawTokens))
      .filter((token) => token.length >= 2 && !stopwords.has(token))
      .slice(0, 14)
      .map((token) => new RegExp(this.escapeRegex(token), /[A-Za-z]/.test(token) ? "i" : ""));

    const genericRules = [
      /api/i,
      /status/i,
      /state/i,
      /dialog/i,
      /button/i,
      /submit/i,
      /save/i,
      /fetch/i,
      /load/i,
      /mounted/i,
      /created/i,
      /methods/i,
    ];

    return [...derivedRules, ...genericRules];
  }

  private buildTargetComponentContext(): string {
    if (!this.projectPath || !this.targetComponentPath) return "";

    const absolutePath = path.resolve(this.projectPath, this.targetComponentPath);
    if (!fs.existsSync(absolutePath)) return "";

    try {
      const raw = fs.readFileSync(absolutePath, "utf-8");
      const lines = raw.split(/\r?\n/);
      const snippets: string[] = [];
      const seenWindows = new Set<string>();
      const keywordRules = this.buildTargetContextKeywordRules();
      const hitLines: number[] = [];

      lines.forEach((line, index) => {
        if (keywordRules.some((rule) => rule.test(line))) {
          hitLines.push(index + 1);
        }
      });

      const addWindow = (startLine: number, endLine: number, title: string) => {
        const start = Math.max(1, startLine);
        const end = Math.min(lines.length, endLine);
        const key = `${start}-${end}`;
        if (seenWindows.has(key)) return;
        seenWindows.add(key);
        const snippet = lines
          .slice(start - 1, end)
          .map((line, offset) => `${start + offset} | ${line}`)
          .join("\n");
        snippets.push(`[${title}] ${start}-${end}\n${snippet}`);
      };

      addWindow(1, Math.min(lines.length, 80), "组件头部与模板入口");

      const scriptStartLine = lines.findIndex((line) => /<script>/.test(line));
      if (scriptStartLine >= 0) {
        addWindow(scriptStartLine + 1, scriptStartLine + 60, "脚本导入区");
      }

      const dataStartLine = lines.findIndex((line) => /^\s*data\s*\(\)\s*\{/.test(line));
      if (dataStartLine >= 0) {
        addWindow(dataStartLine + 1, dataStartLine + 90, "组件状态区");
      }

      const methodsStartLine = lines.findIndex((line) => /^\s*methods:\s*\{/.test(line));
      if (methodsStartLine >= 0) {
        addWindow(methodsStartLine + 1, methodsStartLine + 120, "方法区入口");
      }

      let keptHits = 0;
      let lastHit = -999;
      for (const lineNo of hitLines) {
        if (keptHits >= 6) break;
        if (lineNo - lastHit < 24) continue;
        addWindow(lineNo - 8, lineNo + 12, `关键热点 ${keptHits + 1}`);
        keptHits++;
        lastHit = lineNo;
      }

      const result = [
        `[目标组件快照]`,
        `文件：${this.targetComponentPath}`,
        `总行数：${lines.length}`,
        snippets.join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n");

      return result.slice(0, 12000);
    } catch (error: any) {
      this.log(`Target component context prefetch failed: ${error.message}`);
      return "";
    }
  }

  private extractPlanFilePaths(plan: any, field: "files_to_modify" | "files_to_create"): string[] {
    const source = Array.isArray(plan?.[field]) ? plan[field] : [];
    return source
      .map((item: any) => item?.path || item?.file || item?.target_file || "")
      .filter((item: string) => typeof item === "string" && item.trim().length > 0);
  }

  private tokenizeForSimilarity(text: string): string[] {
    return Array.from(
      new Set(
        (text || "")
          .toLowerCase()
          .split(/[^a-z0-9\u4e00-\u9fa5]+/)
          .map((item) => item.trim())
          .filter((item) => item.length >= 2),
      ),
    );
  }

  private scoreReferenceCandidate(targetRelativePath: string, candidateRelativePath: string): number {
    const targetTokens = this.tokenizeForSimilarity(targetRelativePath);
    const candidateTokens = this.tokenizeForSimilarity(candidateRelativePath);
    const targetSet = new Set(targetTokens);
    let score = 0;

    for (const token of candidateTokens) {
      if (targetSet.has(token)) score += 3;
    }

    if (path.dirname(targetRelativePath) === path.dirname(candidateRelativePath)) score += 2;
    if (path.extname(targetRelativePath) === path.extname(candidateRelativePath)) score += 1;

    return score;
  }

  private pickReferenceFiles(targetRelativePath: string, limit: number = 2): string[] {
    if (!this.projectPath || !targetRelativePath) return [];

    const absoluteTarget = path.resolve(this.projectPath, targetRelativePath);
    const targetDir = path.dirname(absoluteTarget);
    if (!fs.existsSync(targetDir)) return [];

    const candidates = fs
      .readdirSync(targetDir)
      .filter((entry) => /\.(js|ts|tsx|vue)$/.test(entry))
      .map((entry) => path.join(targetDir, entry))
      .filter((absolutePath) => absolutePath !== absoluteTarget)
      .map((absolutePath) => ({
        absolutePath,
        relativePath: path.relative(this.projectPath, absolutePath),
        score: this.scoreReferenceCandidate(targetRelativePath, path.relative(this.projectPath, absolutePath)),
      }))
      .sort((a, b) => (b.score - a.score) || a.relativePath.localeCompare(b.relativePath));

    return candidates.slice(0, limit).map((item) => item.relativePath);
  }

  private summarizeComponentStyle(relativePath: string): string[] {
    if (!relativePath || !this.projectPath) return [];

    const absolutePath = path.resolve(this.projectPath, relativePath);
    if (!fs.existsSync(absolutePath)) return [];

    try {
      const content = fs.readFileSync(absolutePath, "utf-8");
      const hints: string[] = [];

      if (/<script>/.test(content) && /export\s+default\s*\{/.test(content)) {
        hints.push("目标组件是 Vue 单文件组件，当前以 Options API 结构为主。");
      }
      if (/^\s*data\s*\(\)\s*\{/m.test(content)) {
        hints.push("组件已有 data() 状态区，新增状态优先并入现有 data() 返回值。");
      }
      if (/^\s*methods:\s*\{/m.test(content)) {
        hints.push("组件已有 methods 区域，新增交互和接口方法应收敛到现有 methods 中。");
      }
      if (/props:\s*\{/.test(content)) {
        hints.push("组件依赖 props 传入上下文，新增逻辑前优先复用已有入参和订单数据。");
      }
      if (/import\s+.*from\s+['"]@\//.test(content)) {
        hints.push("组件内部允许使用 @/ 别名，但新增依赖前仍需先确认目标路径真实存在。");
      }

      return hints.slice(0, 4);
    } catch (error: any) {
      this.log(`Component style summary failed: ${error.message}`);
      return [];
    }
  }

  private summarizeApiModuleStyle(referenceFiles: string[]): string[] {
    if (!this.projectPath || referenceFiles.length === 0) return [];

    const importPatternCounts = new Map<string, number>();
    const extensionCounts = new Map<string, number>();
    let getWithParamsCount = 0;
    let postWithDataCount = 0;

    for (const relativePath of referenceFiles) {
      const absolutePath = path.resolve(this.projectPath, relativePath);
      if (!fs.existsSync(absolutePath)) continue;
      const ext = path.extname(relativePath);
      if (ext) extensionCounts.set(ext, (extensionCounts.get(ext) || 0) + 1);

      try {
        const content = fs.readFileSync(absolutePath, "utf-8");
        for (const match of content.matchAll(/import\s+\w+\s+from\s+['"]([^'"]+)['"]/g)) {
          const specifier = match[1];
          if (specifier.startsWith("./")) {
            importPatternCounts.set(specifier, (importPatternCounts.get(specifier) || 0) + 1);
          }
        }
        if (/\.get\([^,]+,\s*\{\s*params\s*\}\s*\)/.test(content)) getWithParamsCount++;
        if (/\.post\([^,]+,\s*data[\s,)]/.test(content)) postWithDataCount++;
      } catch (error: any) {
        this.log(`API style summary failed for ${relativePath}: ${error.message}`);
      }
    }

    const hints: string[] = [];
    const dominantExt = Array.from(extensionCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (dominantExt) {
      hints.push(`同目录 API 文件以 \`${dominantExt}\` 为主，新文件扩展名应保持一致。`);
      if (dominantExt === ".js") {
        hints.push("同目录 API 模块以普通 JavaScript 为主，避免写入 TypeScript 类型标注或 TS 扩展名。");
      }
    }
    const dominantImport = Array.from(importPatternCounts.entries()).sort((a, b) => b[1] - a[1])[0];
    if (dominantImport) {
      hints.push(`同目录 API 模块常见请求封装为 \`${dominantImport[0]}\`，新建 API 文件应直接复用该封装；不要改写成其它 request/axios/http 模块。`);
    }
    if (getWithParamsCount > 0) {
      hints.push("GET 接口通常写成 `axios.get(url, { params })` 这类形式。");
    }
    if (postWithDataCount > 0) {
      hints.push("POST 接口通常写成 `axios.post(url, data)` 这类形式。");
    }
    if (referenceFiles.length > 0) {
      hints.push(`参考文件：${referenceFiles.join("、")}`);
    }

    return hints.slice(0, 4);
  }

  private getApiStyleContract(targetRelativePath: string, limit: number = 2): {
    referenceFiles: string[];
    dominantImport: string;
    preferredExt: string;
  } {
    const referenceFiles = this.pickReferenceFiles(targetRelativePath, limit);
    const importPatternCounts = new Map<string, number>();
    const extensionCounts = new Map<string, number>();

    for (const relativePath of referenceFiles) {
      const absolutePath = path.resolve(this.projectPath, relativePath);
      if (!fs.existsSync(absolutePath)) continue;
      const ext = path.extname(relativePath);
      if (ext) extensionCounts.set(ext, (extensionCounts.get(ext) || 0) + 1);

      try {
        const content = fs.readFileSync(absolutePath, "utf-8");
        for (const match of content.matchAll(/import\s+\w+\s+from\s+['"]([^'"]+)['"]/g)) {
          const specifier = match[1];
          if (specifier.startsWith("./")) {
            importPatternCounts.set(specifier, (importPatternCounts.get(specifier) || 0) + 1);
          }
        }
      } catch (error: any) {
        this.log(`API style contract failed for ${relativePath}: ${error.message}`);
      }
    }

    const dominantImport =
      Array.from(importPatternCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const preferredExt =
      Array.from(extensionCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ||
      this.detectPreferredExtensionForDirectory(targetRelativePath);

    return {
      referenceFiles,
      dominantImport,
      preferredExt,
    };
  }

  private detectPreferredExtensionForDirectory(relativePath: string): string {
    if (!this.projectPath || !relativePath) return path.extname(relativePath);

    const absoluteDir = path.resolve(this.projectPath, path.dirname(relativePath));
    if (!fs.existsSync(absoluteDir)) return path.extname(relativePath);

    const counts = new Map<string, number>();
    for (const entry of fs.readdirSync(absoluteDir)) {
      const ext = path.extname(entry);
      if (![".js", ".ts", ".tsx", ".jsx"].includes(ext)) continue;
      counts.set(ext, (counts.get(ext) || 0) + 1);
    }

    const dominant = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
    return dominant || path.extname(relativePath);
  }

  private normalizeRelativePathToProjectStyle(relativePath: string): string {
    const normalized = String(relativePath || "").trim();
    if (!normalized) return normalized;
    if (!/^src\/api\//.test(normalized)) return normalized;

    const preferredExt = this.detectPreferredExtensionForDirectory(normalized);
    if (!preferredExt || ![".js", ".ts", ".tsx", ".jsx"].includes(preferredExt)) return normalized;

    const currentExt = path.extname(normalized);
    if (!currentExt) return `${normalized}${preferredExt}`;
    if ([".js", ".ts", ".tsx", ".jsx"].includes(currentExt) && currentExt !== preferredExt) {
      return `${normalized.slice(0, -currentExt.length)}${preferredExt}`;
    }
    return normalized;
  }

  private normalizePlanToProjectStyle(plan: any): any {
    if (!plan || typeof plan !== "object") return plan;

    const clone = JSON.parse(JSON.stringify(plan));
    const normalizeEntries = (field: "files_to_modify" | "files_to_create") => {
      if (!Array.isArray(clone[field])) return;
      clone[field] = clone[field].map((item: any) => {
        if (!item || typeof item !== "object") return item;
        const next = { ...item };
        for (const key of ["path", "file", "target_file"]) {
          if (typeof next[key] === "string" && next[key].trim()) {
            next[key] = this.normalizeRelativePathToProjectStyle(next[key]);
          }
        }
        return next;
      });
    };

    normalizeEntries("files_to_modify");
    normalizeEntries("files_to_create");
    return clone;
  }

  private buildStyleContext(plan: any): string {
    const hints: string[] = [];
    const targetFiles = Array.from(
      new Set([
        this.targetComponentPath,
        ...this.extractPlanFilePaths(plan, "files_to_modify"),
        ...this.extractPlanFilePaths(plan, "files_to_create"),
      ].filter(Boolean)),
    );

    hints.push(...this.summarizeComponentStyle(this.targetComponentPath));

    const apiTargets = targetFiles.filter((item) => /^src\/api\//.test(item));
    for (const relativePath of apiTargets.slice(0, 2)) {
      const references = this.pickReferenceFiles(relativePath, 2);
      hints.push(...this.summarizeApiModuleStyle(references));
    }

    const dedupedHints = Array.from(new Set(hints)).filter(Boolean).slice(0, 8);
    if (dedupedHints.length === 0) return "";

    return [
      "[目标项目风格快照]",
      ...dedupedHints.map((item) => `- ${item}`),
    ].join("\n");
  }

  private buildPermissionIndex(targetComponentContext: string): string[] {
    const tokens = new Set<string>();
    const sources = [targetComponentContext, this.taskObjective, this.targetComponentPath];
    const patterns = [
      /\$compPermission\(\s*['"`]([A-Z][A-Z0-9_:-]{2,})['"`]\s*\)/g,
      /\b([A-Z][A-Z0-9_:-]{3,})\b/g,
    ];

    for (const source of sources) {
      if (!source) continue;
      for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source)) !== null) {
          if (match[1] && /[A-Z_]{4,}/.test(match[1])) {
            tokens.add(match[1]);
          }
        }
      }
    }

    return Array.from(tokens).slice(0, 12);
  }

  private buildConfigIndex(): string[] {
    if (!this.projectPath || !fs.existsSync(this.projectPath)) return [];
    const candidates: string[] = [];
    const roots = ["src", "config", "src/config", "src/constants", "src/enums", "src/permission"];

    for (const root of roots) {
      const absoluteRoot = path.resolve(this.projectPath, root);
      if (!fs.existsSync(absoluteRoot)) continue;
      if (fs.statSync(absoluteRoot).isFile()) {
        candidates.push(path.relative(this.projectPath, absoluteRoot));
        continue;
      }

      for (const entry of fs.readdirSync(absoluteRoot)) {
        const absolutePath = path.join(absoluteRoot, entry);
        if (!fs.statSync(absolutePath).isFile()) continue;
        if (!/\.(js|ts|json|vue)$/i.test(entry)) continue;
        candidates.push(path.relative(this.projectPath, absolutePath));
        if (candidates.length >= 12) return candidates;
      }
    }

    return candidates.slice(0, 12);
  }

  private summarizeRuntimeOptions(discovery: RuntimeDiscoveryResult | null): string[] {
    if (!discovery) return [];
    return discovery.options
      .slice(0, 4)
      .map((option) => `${option.scriptName} [${option.mode}] -> ${option.commandPreview}`);
  }

  private buildProjectSnapshotArtifact(
    targetComponentContext: string,
    styleContext: string,
    runtimeDiscovery: RuntimeDiscoveryResult | null,
  ): ProjectSnapshotArtifact {
    const permissionIndex = this.buildPermissionIndex(targetComponentContext);
    const configIndex = this.buildConfigIndex();
    const runtimeOptions = this.summarizeRuntimeOptions(runtimeDiscovery);
    const evidenceRefs = [
      this.targetComponentPath ? `核心组件：${this.targetComponentPath}` : "",
      this.targetRoute ? `目标路由：${this.targetRoute}` : "",
      targetComponentContext ? "已预取目标组件热点片段" : "",
      styleContext ? "已生成目标项目风格快照" : "",
      permissionIndex.length > 0 ? `权限索引：${permissionIndex.join("、")}` : "",
      configIndex.length > 0 ? `配置候选：${configIndex.slice(0, 4).join("、")}` : "",
      runtimeOptions.length > 0 ? `运行脚本：${runtimeOptions.slice(0, 2).join("；")}` : "",
    ].filter(Boolean);

    return normalizeProjectSnapshotArtifact({
      target_component_context: targetComponentContext,
      style_context: styleContext,
      permission_index: permissionIndex,
      config_index: configIndex,
      runtime_options: runtimeOptions,
      evidence_refs: evidenceRefs,
    });
  }

  private collectChangedFiles(result: any, plan: any): { created: string[]; modified: string[] } {
    const created = this.extractPlanFilePaths(result, "files_to_create");
    const modified = this.extractPlanFilePaths(result, "files_to_modify");

    return {
      created: created.length > 0 ? created : this.extractPlanFilePaths(plan, "files_to_create"),
      modified: modified.length > 0 ? modified : this.extractPlanFilePaths(plan, "files_to_modify"),
    };
  }

  private resolveImportCandidates(sourceRelativePath: string, specifier: string): string[] {
    const candidates: string[] = [];
    const basePaths = specifier.startsWith("@/")
      ? [
          path.resolve(this.projectPath, "src", specifier.slice(2)),
          path.resolve(this.projectPath, specifier.slice(2)),
        ]
      : this.isLikelyProjectAlias(specifier)
        ? [
            path.resolve(this.projectPath, "src", specifier),
            path.resolve(this.projectPath, specifier),
          ]
        : [path.resolve(path.dirname(path.resolve(this.projectPath, sourceRelativePath)), specifier)];

    for (const basePath of basePaths) {
      candidates.push(basePath);
      [".js", ".ts", ".tsx", ".vue", ".json"].forEach((ext) => candidates.push(`${basePath}${ext}`));
      ["index.js", "index.ts", "index.tsx", "index.vue", "index.json"].forEach((entry) =>
        candidates.push(path.join(basePath, entry)),
      );
    }

    return Array.from(new Set(candidates));
  }

  private resolveImportTarget(sourceRelativePath: string, specifier: string): string | null {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !this.isLikelyProjectAlias(specifier)) return null;
    const candidates = this.resolveImportCandidates(sourceRelativePath, specifier);
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  }

  private isLikelyProjectAlias(specifier: string): boolean {
    if (!this.projectPath || !specifier) return false;
    if (specifier.startsWith(".") || specifier.startsWith("@/")) return false;
    if (specifier.startsWith("@")) return false;

    const firstSegment = specifier.split("/")[0] || "";
    if (!firstSegment) return false;
    if (firstSegment === "src") return true;

    const rootCandidate = path.resolve(this.projectPath, firstSegment);
    const srcCandidate = path.resolve(this.projectPath, "src", firstSegment);
    return fs.existsSync(rootCandidate) || fs.existsSync(srcCandidate);
  }

  private parseImportClause(clause: string): { defaultImport?: string; namedImports: string[] } {
    const trimmed = clause.trim();
    if (!trimmed || trimmed.startsWith("* as ")) {
      return { namedImports: [] };
    }

    const result: { defaultImport?: string; namedImports: string[] } = { namedImports: [] };
    const namedMatch = trimmed.match(/\{([\s\S]+)\}/);
    if (namedMatch?.[1]) {
      result.namedImports = namedMatch[1]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.replace(/^type\s+/, ""))
        .map((item) => item.split(/\s+as\s+/i)[0]?.trim())
        .filter(Boolean);
    }

    const defaultPart = trimmed.split(",")[0]?.trim();
    if (defaultPart && !defaultPart.startsWith("{") && !defaultPart.startsWith("* as ")) {
      result.defaultImport = defaultPart;
    }

    return result;
  }

  private hasNamedExport(targetContent: string, exportName: string): boolean {
    const escaped = this.escapeRegex(exportName);
    const patterns = [
      new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|class|const|let|var)\\s+${escaped}\\b`),
      new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b(?:\\s+as\\s+\\w+)?[^}]*\\}`),
      new RegExp(`\\bexport\\s+type\\s+\\{[^}]*\\b${escaped}\\b[^}]*\\}`),
      new RegExp(`\\bexport\\s+interface\\s+${escaped}\\b`),
      new RegExp(`\\bexport\\s+enum\\s+${escaped}\\b`),
    ];

    return patterns.some((pattern) => pattern.test(targetContent));
  }

  private hasDefaultExport(targetContent: string): boolean {
    return /\bexport\s+default\b/.test(targetContent);
  }

  private extractPermissionTokens(content: string): string[] {
    const patterns = [
      /\$compPermission\(\s*['"`]([A-Z][A-Z0-9_:-]{2,})['"`]\s*\)/g,
      /\b(?:hasPermission|checkPermission|permissionCheck)\(\s*['"`]([A-Z][A-Z0-9_:-]{2,})['"`]\s*\)/g,
      /\bv-permission\s*=\s*['"`]([A-Z][A-Z0-9_:-]{2,})['"`]/g,
      /\bpermission(?:Code|Key|Id)?\s*[:=]\s*['"`]([A-Z][A-Z0-9_:-]{2,})['"`]/g,
    ];

    const tokens = new Set<string>();
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1]) tokens.add(match[1]);
      }
    }
    return Array.from(tokens);
  }

  private walkProjectFiles(dirPath: string, acc: string[] = []): string[] {
    const skipDirs = new Set(["node_modules", ".git", "dist", "build", "coverage", ".idea", ".next", ".nuxt"]);
    let entries: fs.Dirent[] = [];

    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return acc;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        this.walkProjectFiles(path.join(dirPath, entry.name), acc);
        continue;
      }

      if (/\.(vue|js|ts|tsx|jsx|json)$/i.test(entry.name)) {
        acc.push(path.join(dirPath, entry.name));
      }
    }

    return acc;
  }

  private countProjectTokenOccurrences(token: string): number {
    if (!this.projectPath || !token) return 0;
    const pattern = new RegExp(this.escapeRegex(token), "g");
    let total = 0;

    for (const absolutePath of this.walkProjectFiles(this.projectPath)) {
      try {
        const content = fs.readFileSync(absolutePath, "utf-8");
        total += content.match(pattern)?.length || 0;
        if (total > 24) return total;
      } catch {
        // noop
      }
    }

    return total;
  }

  private buildValidationReport(result: any, plan: any): ValidationReport {
    const changed = this.collectChangedFiles(result, plan);
    const checkedFiles = Array.from(new Set([...changed.created, ...changed.modified])).filter(Boolean);
    const issues: ValidationIssue[] = [];
    const useAstGate = isFeatureEnabled("ENABLE_AST_GATE");

    for (const relativePath of checkedFiles) {
      const absolutePath = path.resolve(this.projectPath, relativePath);
      if (!fs.existsSync(absolutePath)) {
        issues.push({
          severity: "error",
          file: relativePath,
          message: "工作流声称已修改该文件，但项目中未找到实际文件。",
          suggestion: "请确认写入路径是否落在目标项目根目录内。",
        });
        continue;
      }

      let content = "";
      try {
        content = fs.readFileSync(absolutePath, "utf-8");
      } catch (error: any) {
        issues.push({
          severity: "error",
          file: relativePath,
          message: `读取文件失败：${error.message}`,
        });
        continue;
      }

      const analysis = analyzeCodeFile(relativePath, content);
      if (useAstGate && analysis.diagnostics.length > 0) {
        const brief = analysis.diagnostics
          .slice(0, 2)
          .map((item) => `第 ${item.line} 行 ${item.message}`)
          .join("；");
        issues.push({
          severity: "error",
          file: relativePath,
          message: `AST/语法解析失败：${brief}`,
          suggestion: "请修复明显的语法问题、类型标注误用或 script 内容结构错误后再继续。",
          kind: "syntax_invalid",
        });
      }

      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        const match = line.match(/^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/);
        if (!match) return;

        const clause = match[1];
        const specifier = match[2];
        const resolved = this.resolveImportTarget(relativePath, specifier);
        const shouldResolve =
          specifier.startsWith(".") ||
          specifier.startsWith("@/") ||
          this.isLikelyProjectAlias(specifier);
        if (shouldResolve && !resolved) {
          issues.push({
            severity: "error",
            file: relativePath,
            message: `第 ${index + 1} 行导入无法解析：\`${specifier}\`。`,
            suggestion: "请优先复用目标项目中已存在的相对路径、别名路径或请求封装文件。",
            kind: "import_unresolved",
          });
          return;
        }

	        if (useAstGate && resolved) {
	          try {
	            const targetContent = fs.readFileSync(resolved, "utf-8");
              const targetAnalysis = analyzeCodeFile(resolved, targetContent);
	            const importInfo = this.parseImportClause(clause);

	            if (importInfo.defaultImport && !(targetAnalysis.hasDefaultExport || this.hasDefaultExport(targetContent))) {
	              issues.push({
	                severity: "warning",
	                file: relativePath,
                message: `第 ${index + 1} 行默认导入 \`${importInfo.defaultImport}\`，但目标模块未发现明显的 default export。`,
                suggestion: "请确认目标模块是否确实默认导出，或改为与项目现状一致的导入方式。",
                kind: "default_export_unverified",
              });
            }

	            for (const exportName of importInfo.namedImports) {
	              if (!(targetAnalysis.namedExports.includes(exportName) || this.hasNamedExport(targetContent, exportName))) {
	                issues.push({
	                  severity: "error",
	                  file: relativePath,
                  message: `第 ${index + 1} 行命名导入 \`${exportName}\`，但目标模块中未发现对应导出。`,
                  suggestion: "请确认目标模块已导出该标识符，或修正导入名称与导出名称的一致性。",
                  kind: "named_export_missing",
                });
              }
            }
          } catch {
            // noop
          }
        }
      });

      const permissionTokens = this.extractPermissionTokens(content);
      for (const token of permissionTokens) {
        const occurrenceCount = this.countProjectTokenOccurrences(token);
        if (occurrenceCount <= 1) {
          issues.push({
            severity: "error",
            file: relativePath,
            message: `发现新增或孤立的权限/能力标识 \`${token}\`，项目内未检索到其它明显引用。`,
            suggestion: "请确认是否还需要补充权限声明、按钮权限映射、菜单/路由配置或后端权限码同步；若无法证实，请不要臆造新的权限标识。",
            kind: "permission_token_unverified",
          });
        }
      }

      if (changed.created.includes(relativePath) && /^src\/api\/.+\.(js|ts)$/.test(relativePath)) {
        const apiStyleContract = this.getApiStyleContract(relativePath, 2);
        const preferredExt = apiStyleContract.preferredExt || this.detectPreferredExtensionForDirectory(relativePath);
        const currentExt = path.extname(relativePath);
        if (preferredExt && currentExt && preferredExt !== currentExt) {
          issues.push({
            severity: "error",
            file: relativePath,
            message: `该新建 API 文件扩展名为 \`${currentExt}\`，但同目录主流扩展名为 \`${preferredExt}\`。`,
            suggestion: "请与同目录现有 API 模块保持一致，避免在 JS 目录中单独创建 TS 文件。",
            kind: "api_extension_mismatch",
          });
        }

        const dominant = apiStyleContract.dominantImport;
        const requestLikeImports = analysis.importSpecifiers.filter((item) => /(request|axios|http|service)/i.test(item));
        const usesDominantImport = dominant
          ? analysis.importSpecifiers.includes(dominant)
          : false;
        if (dominant && requestLikeImports.length > 0 && !usesDominantImport) {
          issues.push({
            severity: "error",
            file: relativePath,
            message: `该新建 API 文件使用了 \`${requestLikeImports.join("、")}\`，但同目录参考文件主流请求封装为 \`${dominant}\`。`,
            suggestion: "请直接复用同目录现有请求封装与调用形式，不要无中生有切换到其它 request/axios/http 模块。",
            kind: "api_style_drift",
          });
        } else if (
          dominant &&
          dominant.startsWith("./") &&
          analysis.importSpecifiers.some((item) => item.startsWith("@/utils/") || item.startsWith("utils/"))
        ) {
          issues.push({
            severity: "error",
            file: relativePath,
            message: `该新建 API 文件引入了与同目录风格不一致的工具路径，但参考文件主流请求封装为 \`${dominant}\`。`,
            suggestion: "请优先使用同目录相对封装，不要跨目录臆造 utils/request 一类基础模块。",
            kind: "api_style_drift",
          });
        }
      }
    }

    const errorCount = issues.filter((item) => item.severity === "error").length;
    const warningCount = issues.filter((item) => item.severity === "warning").length;
    const summary =
      errorCount > 0
        ? `本地静态校验发现 ${errorCount} 个阻断问题，已阻止直接宣告成功。`
        : warningCount > 0
          ? `本地静态校验通过，但发现 ${warningCount} 个风格或一致性提醒。`
          : "本地静态校验已通过，未发现阻断性的路径或导入问题。";

    const highlights = issues
      .slice(0, 5)
      .map((item) => `${item.severity === "error" ? "问题" : "提醒"}：${item.file} · ${item.message}`);

    const stats = [
      `校验文件 ${checkedFiles.length}`,
      `阻断问题 ${errorCount}`,
      `提醒 ${warningCount}`,
    ];

    return {
      checkedFiles,
      issues,
      hasBlockingIssues: errorCount > 0,
      summary,
      highlights,
      stats,
    };
  }

  private buildValidationFixPrompt(report: ValidationReport): string {
    const blockingIssues = report.issues.filter((item) => item.severity === "error");
    return [
      "本地静态校验发现以下阻断问题，请只修复这些具体问题，不要扩散改动：",
      ...blockingIssues.map((item, index) =>
        `${index + 1}. 文件 ${item.file}：${item.message}${item.suggestion ? ` 建议：${item.suggestion}` : ""}`,
      ),
      "要求：优先复用目标项目已存在的导入路径、请求封装和代码风格；禁止臆造不存在的工具包或别名模块。",
      "修复完成后立即输出最终 JSON 交付结果。",
    ].join("\n");
  }

  private shouldRunConsistencyReview(report: ValidationReport): boolean {
    return report.issues.some((item) =>
      item.severity === "warning" &&
      ["permission_token_unverified", "default_export_unverified", "api_style_drift"].includes(item.kind || ""),
    );
  }

  private buildConsistencyReviewPrompt(report: ValidationReport): string {
    const warningIssues = report.issues
      .filter((item) =>
        item.severity === "warning" &&
        ["permission_token_unverified", "default_export_unverified", "api_style_drift"].includes(item.kind || ""),
      )
      .slice(0, 3);

    return [
      "本地静态校验发现以下高价值一致性提醒，请做一次轻量反思与必要补齐：",
      ...warningIssues.map((item, index) =>
        `${index + 1}. 文件 ${item.file}：${item.message}${item.suggestion ? ` 建议：${item.suggestion}` : ""}`,
      ),
      "要求：只修复最可能导致功能缺胳膊少腿的点，不要扩散到无关文件。",
      "重点关注：权限码/配置项是否需要声明，导入方式是否与目标模块导出一致，API 文件是否复用同目录已有请求封装。",
      "修复完成后立即输出最终 JSON 交付结果。",
    ].join("\n");
  }

  private collectQaCases(codingRes: any, planRes: any): string[] {
    const structuredCases = deriveStructuredTestCases(planRes?.test_cases, 4);
    const sources = [
      ...structuredCases.map((item) => item.goal || item.name),
      ...(Array.isArray(codingRes?.verification_points) ? codingRes.verification_points : []),
      ...(Array.isArray(planRes?.verification_points) ? planRes.verification_points : []),
    ];

    return Array.from(new Set(sources.map((item) => String(item || "").trim()).filter(Boolean))).slice(0, 4);
  }

  private async hasChromeDevtoolsTools(): Promise<boolean> {
    try {
      const tools = await this.mcpHub.getAllTools();
      return tools.some((tool) => tool?.serverName === "chrome-devtools");
    } catch (error: any) {
      this.log(`Chrome DevTools availability probe failed: ${error.message}`);
      return false;
    }
  }

  private extractQaUrlCandidates(prompt: string): string[] {
    const matches = prompt.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^\s`'"））]*)?/g) || [];
    const origins = matches
      .map((item) => {
        try {
          const url = new URL(item);
          return url.origin;
        } catch {
          return "";
        }
      })
      .filter(Boolean);

    return Array.from(new Set(origins));
  }

  private async isReachableUrl(url: string): Promise<boolean> {
    try {
      const response = await axios.get(url, {
        timeout: 1500,
        validateStatus: () => true,
      });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  private async discoverQaBaseUrl(prompt: string): Promise<string> {
    const overrideCandidate = (this.llmConfig.qaConfig?.baseUrl || "").trim();
    const envCandidates = [process.env.HARNESS_QA_BASE_URL, process.env.QA_BASE_URL]
      .map((item) => item?.trim() || "")
      .filter(Boolean);
    const promptCandidates = this.extractQaUrlCandidates(prompt);
    const commonCandidates = [
      "http://127.0.0.1:5173",
      "http://127.0.0.1:5174",
      "http://127.0.0.1:4173",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:8080",
      "http://127.0.0.1:8000",
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:4173",
      "http://localhost:3000",
      "http://localhost:8080",
      "http://localhost:8000",
    ];

    for (const candidate of Array.from(new Set([overrideCandidate, ...envCandidates, ...promptCandidates, ...commonCandidates])).filter(Boolean)) {
      if (await this.isReachableUrl(candidate)) {
        return candidate.replace(/\/+$/, "");
      }
    }

    return "";
  }

  private detectPackageManager(): "yarn" | "pnpm" | "npm" {
    if (fs.existsSync(path.join(this.projectPath, "yarn.lock"))) return "yarn";
    if (fs.existsSync(path.join(this.projectPath, "pnpm-lock.yaml"))) return "pnpm";
    return "npm";
  }

  private listProjectEnvFiles(): string[] {
    if (!this.projectPath || !fs.existsSync(this.projectPath)) return [];

    try {
      return fs.readdirSync(this.projectPath)
        .filter((name) => /^\.?env(\..+)?$/i.test(name) || /^env\..+$/i.test(name))
        .sort();
    } catch {
      return [];
    }
  }

  private extractPortHintsFromText(text: string): number[] {
    const hits = new Set<number>();
    if (!text) return [];

    const patterns = [
      /--port(?:=|\s+)(\d{2,5})/gi,
      /\b(?:PORT|VITE_PORT|DEV_PORT|APP_PORT|SERVER_PORT)\s*=\s*(\d{2,5})/gi,
      /localhost:(\d{2,5})/gi,
      /127\.0\.0\.1:(\d{2,5})/gi,
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const port = Number(match[1]);
        if (port >= 1000 && port <= 65535) hits.add(port);
      }
    }

    return Array.from(hits);
  }

  private detectRuntimeMode(scriptName: string, command: string): string {
    const lower = `${scriptName} ${command}`.toLowerCase();
    if (/(?:^|[-_:])local(?:$|[-_:])|--mode\s*=?\s*local/.test(lower)) return "local";
    if (/(?:^|[-_:])pre(?:$|[-_:])|--mode\s*=?\s*pre/.test(lower)) return "pre";
    if (/(?:^|[-_:])release(?:$|[-_:])|--mode\s*=?\s*release/.test(lower)) return "release";
    if (/(?:^|[-_:])production(?:$|[-_:])|(?:^|[-_:])prod(?:$|[-_:])|(?:^|[-_:])pro(?:$|[-_:])|--mode\s*=?\s*production/.test(lower)) return "production";
    if (/(?:^|[-_:])dev(?:$|[-_:])|--mode\s*=?\s*dev/.test(lower)) return "dev";
    if (/(?:^|[-_:])start(?:$|[-_:])/.test(lower)) return "start";
    if (/(?:^|[-_:])preview(?:$|[-_:])/.test(lower)) return "preview";
    return "auto";
  }

  private getRuntimeOptionScore(mode: string, scriptName: string): number {
    const lowerScript = scriptName.toLowerCase();
    const baseScores: Record<string, number> = {
      local: 100,
      dev: 90,
      auto: 80,
      start: 70,
      preview: 60,
      pre: 55,
      release: 50,
      production: 45,
    };

    let score = baseScores[mode] ?? 40;
    if (lowerScript === "serve" || lowerScript === "dev" || lowerScript === "start") score += 6;
    if (lowerScript.includes("mock")) score -= 10;
    return score;
  }

  private isRuntimeScript(scriptName: string, command: string): boolean {
    const lower = `${scriptName} ${command}`.toLowerCase();
    return /(vue-cli-service serve|vite(?:\s|$)|webpack-dev-server|react-scripts start|next dev|nuxt|umi dev|(?:^|[\s:._-])serve(?:$|[\s:._-])|(?:^|[\s:._-])dev(?:$|[\s:._-])|(?:^|[\s:._-])start(?:$|[\s:._-])|(?:^|[\s:._-])preview(?:$|[\s:._-]))/.test(lower);
  }

  private discoverProjectRuntimeOptions(): RuntimeDiscoveryResult | null {
    if (!this.projectPath) return null;

    const packageJsonPath = path.join(this.projectPath, "package.json");
    if (!fs.existsSync(packageJsonPath)) return null;

    let pkg: any;
    try {
      pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    } catch {
      return null;
    }

    const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const envFiles = this.listProjectEnvFiles();
    const envPortHints = envFiles.flatMap((file) => {
      try {
        const content = fs.readFileSync(path.join(this.projectPath, file), "utf-8");
        return this.extractPortHintsFromText(content);
      } catch {
        return [];
      }
    });

    const options = Object.entries(scripts)
      .filter(([scriptName, command]) => typeof command === "string" && this.isRuntimeScript(scriptName, command))
      .map(([scriptName, command]) => {
        const mode = this.detectRuntimeMode(scriptName, command as string);
        const portHints = Array.from(new Set([
          ...this.extractPortHintsFromText(command as string),
          ...envPortHints,
          5173,
          5174,
          4173,
          3000,
          8080,
          8000,
        ]));

        return {
          scriptName,
          mode,
          commandPreview: String(command),
          portHints,
          envFiles,
          score: this.getRuntimeOptionScore(mode, scriptName),
        };
      })
      .sort((a, b) => b.score - a.score);

    return {
      packageManager: this.detectPackageManager(),
      envFiles,
      options,
    };
  }

  private selectRuntimeOption(discovery: RuntimeDiscoveryResult | null): ProjectRuntimeOption | null {
    if (!discovery || discovery.options.length === 0) return null;

    const preferred = (this.llmConfig.qaConfig?.envPreference || "auto").trim().toLowerCase();
    if (preferred && preferred !== "auto") {
      const exact = discovery.options.find((option) => option.mode === preferred);
      if (exact) return exact;

      const fuzzy = discovery.options.find((option) => option.scriptName.toLowerCase().includes(preferred));
      if (fuzzy) return fuzzy;
    }

    return discovery.options[0] || null;
  }

  private buildQaProbeUrls(portHints: number[]): string[] {
    const urls: string[] = [];
    for (const port of portHints) {
      urls.push(`http://127.0.0.1:${port}`);
      urls.push(`http://localhost:${port}`);
    }
    return Array.from(new Set(urls));
  }

  private getRuntimeLaunchCommand(scriptName: string, packageManager: "yarn" | "pnpm" | "npm") {
    if (packageManager === "yarn") {
      return { bin: "yarn", args: [scriptName], label: `yarn ${scriptName}` };
    }
    if (packageManager === "pnpm") {
      return { bin: "pnpm", args: [scriptName], label: `pnpm ${scriptName}` };
    }
    return { bin: "npm", args: ["run", scriptName], label: `npm run ${scriptName}` };
  }

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

  private stopQaRuntimeProcess() {
    if (!this.qaRuntimeProc) return;
    try {
      this.qaRuntimeProc.kill("SIGTERM");
    } catch {
      // noop
    }
    this.qaRuntimeProc = null;
  }

  private async tryAutoBootQaRuntime(selected: ProjectRuntimeOption, packageManager: "yarn" | "pnpm" | "npm"): Promise<{ baseUrl: string; launchLabel: string }> {
    this.stopQaRuntimeProcess();
    const { bin, args, label } = this.getRuntimeLaunchCommand(selected.scriptName, packageManager);

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
      appendHarnessLog("qa_runtime.log", `[stdout] ${summarizeText(String(chunk || ""), 300)}`);
    });
    proc.stderr?.on("data", (chunk) => {
      appendHarnessLog("qa_runtime.log", `[stderr] ${summarizeText(String(chunk || ""), 300)}`);
    });
    proc.on("exit", (code, signal) => {
      appendHarnessLog("qa_runtime.log", `🛑 [runId=${this.runId}] runtime exited code=${code} signal=${signal || ""}`);
    });

    const baseUrl = await this.waitForQaRuntimeUrl(this.buildQaProbeUrls(selected.portHints), proc);
    return { baseUrl, launchLabel: label };
  }

  private buildQaFallbackResult(
    overallStatus: "passed" | "failed" | "skipped",
    summary: string,
    cases: string[],
    extras?: { blockedReasons?: string[]; testedUrl?: string },
  ) {
    return {
      reasoning: summary,
      overall_status: overallStatus,
      tested_url: extras?.testedUrl || "",
      cases: cases.map((item) => ({
        name: item,
        status: overallStatus === "passed" ? "passed" : "skipped",
        evidence: overallStatus === "passed" ? "本轮未执行浏览器自动化，结果来自系统默认通过。" : summary,
      })),
      blocked_reasons: extras?.blockedReasons || [],
      qa_summary: summary,
    };
  }

  private emitQaCasePreview(cases: string[], qaBaseUrl: string, hasBrowserTools: boolean, structuredCases: TestCaseArtifact[] = []) {
    const preferredCases = structuredCases.length > 0
      ? structuredCases.slice(0, 5).map((item, index) => `用例 ${index + 1}：${item.name} · ${item.goal}`)
      : cases.slice(0, 5).map((item, index) => `用例 ${index + 1}：${item}`);
    const stats = [
      `用例 ${structuredCases.length || cases.length}`,
      hasBrowserTools ? "浏览器工具已就绪" : "浏览器工具未就绪",
      qaBaseUrl ? `站点 ${qaBaseUrl}` : "站点待探测",
    ];

    this.emitPhaseSummary({
      phase: "VERIFY",
      index: 5,
      title: "测试用例清单已生成",
      summary: cases.length > 0
        ? "已基于规划与代码产出的验证点生成自动化 QA 用例，准备开始浏览器验证。"
        : "当前未收集到可执行测试用例，本轮将按条件决定是否跳过自动化 QA。",
      highlights: preferredCases,
      stats,
    });
  }

  private isUsablePlan(plan: any): boolean {
    if (!plan || typeof plan !== "object") return false;
    if (!plan.reasoning || typeof plan.reasoning !== "string") return false;
    if (Array.isArray(plan.files_to_modify) && plan.files_to_modify.length > 0) return true;
    if (Array.isArray(plan.files_to_create) && plan.files_to_create.length > 0) return true;
    return false;
  }

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

  public async runFullPipeline(prompt: string) {
    if (this.abortController.signal.aborted) return;
    const signal = this.abortController.signal;
    this.log(`[WORKFLOW_START] promptChars=${prompt.length}`);
    this.trace("workflow_start", {
      promptChars: prompt.length,
      promptPreview: summarizeText(prompt, 200),
      featureFlags: getFeatureFlagSnapshot(),
    });

    // 🔍 阶段 0: 深度意图解析 (不依赖任何外部传入路径，模型自主发现)
    this.emitStepStart("INTENT", "🤖 正在深度解析意图...", 0);
    
    // 初始化 IntentAgent 时，它的 config.projectPath 是未定义的，这是正常的
    const intentAgent = new IntentAgent({ ...this.llmConfig }, this.mcpHub, signal);
    const intentResult = await intentAgent.execute(
      { prompt }, 
      "", 
      (t: string) => this.emitStepProgress({ phase: "INTENT", thought: t, index: 0 })
    );

    const config = intentResult.parsed; 
    this.trace("intent_result", {
      parsedKeys: config && typeof config === "object" ? Object.keys(config) : [],
      projectPath: config?.projectPath || "",
      prdUrl: config?.prdUrl || "",
      apiUrl: config?.apiUrl || "",
      targetRoute: config?.targetRoute || "",
      targetComponentPath: config?.targetComponentPath || "",
      taskObjective: config?.taskObjective || "",
      reasoningPreview: summarizeText(config?.reasoning || "", 160),
    });
    
    // 💡 只有模型真的带回来了验证过的路径，我们才继续
    if (config && config.projectPath) {
      this.projectPath = config.projectPath;
      this.targetRoute = config.targetRoute || "";
      this.targetComponentPath = config.targetComponentPath || "";
      this.taskObjective = config.taskObjective || this.extractTaskObjective(prompt);
      this.llmConfig.projectPath = this.projectPath; // 💉 注入到全局配置
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
    } else {
      this.emitStepComplete("INTENT", "error", 0);
      this.emitWorkflowComplete("error", "未能从长文中解析到有效项目路径，请确保文档中包含绝对路径并能被 list_dir 访问。");
      return;
    }

    if (signal.aborted) return;
    this.emitStepComplete("INTENT", "success", 0);

    const originalPrompt = prompt; // 💡 记录原始长文意图，作为后续所有 Agent 的“最高纲领”

    // 🚀 到这里，我们已经拿齐了所有的武器 (projectPath, prdUrl, apiUrl)，启动主流程
    return this.run(config.prdUrl || prompt, config.apiUrl || "", signal, originalPrompt);
  }

  private async run(prdUrl: string, apiUrl: string, signal: AbortSignal, originalPrompt: string) {
    try {
      // 核心：在拿到正确 projectPath 后再创建这些 Agent，让它们“从一开始就看到正确的路”
      this.prdAgent = new PRDAgent(this.llmConfig, this.mcpHub, signal);
      this.apiAgent = new APIAgent(this.llmConfig, this.mcpHub, signal);
      this.plannerAgent = new PlannerAgent(this.llmConfig, this.mcpHub, signal);
      this.coderAgent = new CoderAgent(this.llmConfig, this.mcpHub, signal);
      this.qaAgent = new QAAgent(this.llmConfig, this.mcpHub, signal);
      const sharedLessons = this.evalHarness.getRelevantLessons(
        `${originalPrompt}\n${this.targetComponentPath}\n${this.targetRoute}`,
      );
      const executionBrief = this.buildExecutionBrief();
      const targetComponentContext = this.buildTargetComponentContext();
      const styleContext = this.buildStyleContext({});
      const runtimeDiscovery = this.discoverProjectRuntimeOptions();
      const baseProjectSnapshotArtifact = this.buildProjectSnapshotArtifact(
        targetComponentContext,
        styleContext,
        runtimeDiscovery,
      );
      if (isFeatureEnabled("ENABLE_PHASE_ARTIFACTS")) {
        this.setPhaseArtifact(
          "PROJECT_SNAPSHOT",
          buildArtifactEnvelope("PLAN", "已生成基础项目快照，供规划与编码阶段复用。", baseProjectSnapshotArtifact),
        );
      }
      this.trace("lessons_loaded", {
        chars: sharedLessons.length,
        preview: summarizeText(sharedLessons, 180),
      });
      this.trace("target_component_context", {
        path: this.targetComponentPath,
        chars: targetComponentContext.length,
        preview: summarizeText(targetComponentContext, 200),
      });
      this.trace("style_context", {
        chars: styleContext.length,
        preview: summarizeText(styleContext, 200),
      });

      if (signal.aborted) return;

      // PHASE 1: PRD
      this.emitStepStart("PRD", "📄 正在解析需求文档...", 1);
      this.emitStepProgress({
        phase: "PRD",
        content: "[系统] 正在抽取需求模块、业务规则和核心约束。",
        index: 1,
      });
      let prdContent = "";
      const urls = this.larkPrefetcher.extractLarkUrls(prdUrl);
      this.trace("prd_prefetch_start", { sourceUrl: prdUrl, urlCount: urls.length, urls });
      
      for (const url of urls) {
        if (signal.aborted) throw new Error("AbortError");
        const res = await this.larkPrefetcher.prefetchSource(url, signal);
        if (res.status === "success") {
          prdContent += `\n--- SOURCE: ${url} ---\n${res.content}\n`;
        }
        this.trace("prd_prefetch_result", {
          url,
          status: res.status,
          contentLen: res.content?.length || 0,
          diagnostics: res.diagnostics?.slice(0, 5) || [],
        });
      }
      const prdEvidenceContext = this.buildPrdEvidenceContext(prdContent);
      const focusedPrdContent = this.buildFocusedDocumentContent(
        prdContent,
        "PRD",
        [this.taskObjective, this.targetRoute, this.targetComponentPath, originalPrompt],
      );
      this.trace("prd_content_focus", {
        rawChars: prdContent.length,
        focusedChars: focusedPrdContent.length,
        evidenceChars: prdEvidenceContext.length,
      });
      if (focusedPrdContent && focusedPrdContent.length < prdContent.length) {
        this.emitStepProgress({
          phase: "PRD",
          content: "[系统] 已将 PRD 文档压缩为证据优先视图，优先保留功能详述、原型/截图与页面落点片段。",
          index: 1,
        });
      }

      let prdRes = await this.prdAgent.execute(
        { query: executionBrief, rawContent: focusedPrdContent, focusContext: prdEvidenceContext },
        sharedLessons,
        this.forwardAgentProgress("PRD", 1)
      );
      let prdArtifact = normalizePrdArtifact(prdRes);
      if (isFeatureEnabled("ENABLE_PHASE_ARTIFACTS")) {
        try {
          this.ensurePrdArtifactGate(prdArtifact);
        } catch (error: any) {
          this.emitStepProgress({
            phase: "PRD",
            content: "[系统] PRD 证据提取存在缺口，正在基于原型/截图/表格锚点执行一次补强重试。",
            index: 1,
          });
          prdRes = await this.prdAgent.execute(
            {
              query: executionBrief,
              rawContent: focusedPrdContent,
              focusContext: prdEvidenceContext,
              gateFeedback: error?.message || "需要补齐 placement_hints 与 evidence_refs",
            },
            sharedLessons,
            this.forwardAgentProgress("PRD", 1),
          );
          prdArtifact = normalizePrdArtifact(prdRes);
          try {
            this.ensurePrdArtifactGate(prdArtifact);
          } catch (retryError: any) {
            const fallbackPrd = this.backfillPrdResultWithLocalEvidence(
              prdRes,
              focusedPrdContent || prdContent,
              prdEvidenceContext,
            );
            try {
              this.ensurePrdArtifactGate(fallbackPrd.artifact);
              prdRes = fallbackPrd.result;
              prdArtifact = fallbackPrd.artifact;
              this.trace("prd_fallback_applied", {
                reason: retryError?.message || error?.message || "",
                contentPreview: summarizeText(prdArtifact.content_verified, 160),
                logicRules: prdArtifact.logic_rules.length,
                placementHints: prdArtifact.placement_hints.length,
                evidenceRefs: prdArtifact.evidence_refs.length,
              });
              this.emitStepProgress({
                phase: "PRD",
                content: "[系统] PRD 结构化结果仍存在缺口，已基于预读证据与任务目标执行本地兜底补全。",
                index: 1,
              });
            } catch {
              throw retryError;
            }
          }
        }
        this.setPhaseArtifact(
          "PRD",
          buildArtifactEnvelope("PRD", this.buildHumanSummaryFromResult("PRD", prdRes), prdArtifact),
        );
      }
      const prdFocusContext = this.buildPrdFocusContext(prdArtifact);
      this.trace("prd_focus_context", {
        chars: prdFocusContext.length,
        preview: summarizeText(prdFocusContext, 200),
      });
      this.summarizeResult("PRD", prdRes);
      this.emitStepComplete("PRD", "success", 1);

      // PHASE 2: API
      if (signal.aborted) throw new Error("AbortError");
      this.emitStepStart("API", "🔌 正在对接 API 接口...", 2);
      this.emitStepProgress({
        phase: "API",
        content: "[系统] 正在对齐接口前缀、能力边界和组件影响面。",
        index: 2,
      });
      let apiContent = "";
      const apiUrls = apiUrl ? [apiUrl] : this.larkPrefetcher.extractLarkUrls(prdUrl).filter(u => u.includes('wiki/Vs30w'));
      this.trace("api_prefetch_start", { sourceUrl: apiUrl || prdUrl, urlCount: apiUrls.length, urls: apiUrls });
      
      const targetApiUrl = apiUrls[0] || apiUrl;
      if (targetApiUrl) {
        const res = await this.larkPrefetcher.prefetchSource(targetApiUrl, signal);
        if (res.status === "success") apiContent = res.content;
        this.trace("api_prefetch_result", {
          url: targetApiUrl,
          status: res.status,
          contentLen: res.content?.length || 0,
          diagnostics: res.diagnostics?.slice(0, 5) || [],
        });
      }
      const focusedApiContent = this.buildFocusedDocumentContent(
        apiContent,
        "API",
        [
          this.taskObjective,
          this.targetRoute,
          this.targetComponentPath,
          ...prdArtifact.logic_rules,
          ...prdArtifact.placement_hints,
          ...prdArtifact.evidence_refs,
        ],
      );
      this.trace("api_content_focus", {
        rawChars: apiContent.length,
        focusedChars: focusedApiContent.length,
      });
      if (focusedApiContent && focusedApiContent.length < apiContent.length) {
        this.emitStepProgress({
          phase: "API",
          content: "[系统] 已将 API 文档压缩为证据优先视图，优先保留接口定义、字段约束与调用规则片段。",
          index: 2,
        });
      }
      
      let apiRes = await this.apiAgent.execute(
        { prd: prdArtifact, rawContent: focusedApiContent, query: executionBrief, prdFocusContext },
        sharedLessons,
        this.forwardAgentProgress("API", 2)
      );
      let apiArtifact = normalizeApiArtifact(apiRes);
      if (isFeatureEnabled("ENABLE_PHASE_ARTIFACTS")) {
        try {
          this.ensureApiArtifactGate(apiArtifact);
        } catch (error: any) {
          this.emitStepProgress({
            phase: "API",
            content: "[系统] API 结构化结果存在缺口，正在基于 PRD 证据锚点执行一次补强重试。",
            index: 2,
          });
          apiRes = await this.apiAgent.execute(
            {
              prd: prdArtifact,
              rawContent: focusedApiContent,
              query: executionBrief,
              prdFocusContext,
              gateFeedback: error?.message || "需要补齐 api_mappings 与 evidence_refs",
            },
            sharedLessons,
            this.forwardAgentProgress("API", 2),
          );
          apiArtifact = normalizeApiArtifact(apiRes);
          this.ensureApiArtifactGate(apiArtifact);
        }
        this.setPhaseArtifact(
          "API",
          buildArtifactEnvelope("API", this.buildHumanSummaryFromResult("API", apiRes), apiArtifact),
        );
      }
      this.summarizeResult("API", apiRes);
      this.emitStepComplete("API", "success", 2);

      // PHASE 3: PLAN
      if (signal.aborted) throw new Error("AbortError");
      const projectTree = await this.buildProjectTree();
      this.trace("project_tree_ready", {
        projectPath: this.projectPath,
        treeChars: projectTree.length,
        treePreview: summarizeText(projectTree, 200),
      });
      this.emitStepStart("PLAN", "🗺️ 正在制定开发方案...", 3);
      if (projectTree) {
        this.emitStepProgress({
          phase: "PLAN",
          content: "[系统] 已预取项目目录树，规划阶段将优先依据目录结构收敛。",
          index: 3,
        });
      }
      if (targetComponentContext) {
        this.emitStepProgress({
          phase: "PLAN",
          content: "[系统] 已预取核心组件关键片段，规划阶段将优先围绕热点代码收敛。",
          index: 3,
        });
      }
      let planRes: any;
      try {
        planRes = await this.plannerAgent.execute(
          {
            prd: prdArtifact,
            api: apiArtifact,
            projectPath: this.projectPath,
            projectTree,
            targetComponentContext,
            prdFocusContext,
            query: executionBrief,
            targetComponentPath: this.targetComponentPath,
            targetRoute: this.targetRoute,
            artifacts: this.getPipelineArtifacts(),
          },
          sharedLessons,
          this.forwardAgentProgress("PLAN", 3)
        );
        planRes = this.normalizePlanToProjectStyle(planRes);
      } catch (error: any) {
        this.trace("plan_primary_failed", {
          message: error?.message || "unknown",
        });
        this.emitStepProgress({
          phase: "PLAN",
          content: "[系统] 规划阶段主流程未收敛，正在基于现有证据生成兜底实施方案。",
          index: 3,
        });
      }

      if (!this.isUsablePlan(planRes)) {
        planRes = this.buildFallbackPlan(prdRes, apiRes, targetComponentContext);
        this.trace("plan_fallback_built", {
          filesToModify: Array.isArray(planRes?.files_to_modify) ? planRes.files_to_modify.length : 0,
          filesToCreate: Array.isArray(planRes?.files_to_create) ? planRes.files_to_create.length : 0,
          verificationPoints: Array.isArray(planRes?.verification_points) ? planRes.verification_points.length : 0,
        });
        this.emitStepProgress({
          phase: "PLAN",
          content: "[系统] 已切换为规划兜底方案，继续进入代码系统集成。",
          index: 3,
        });
      }
      planRes = this.normalizePlanToProjectStyle(planRes);
      let planArtifact = normalizePlanArtifact(planRes);
      if (isFeatureEnabled("ENABLE_PHASE_ARTIFACTS")) {
        try {
          this.ensurePlanArtifactGate(planArtifact);
        } catch (error: any) {
          this.emitStepProgress({
            phase: "PLAN",
            content: "[系统] 规划结果缺少关键结构字段，正在基于现有工件执行一次补强重试。",
            index: 3,
          });
          planRes = await this.plannerAgent.execute(
            {
              prd: prdArtifact,
              api: apiArtifact,
              projectPath: this.projectPath,
              projectTree,
              targetComponentContext,
              prdFocusContext,
              query: executionBrief,
              targetComponentPath: this.targetComponentPath,
              targetRoute: this.targetRoute,
              artifacts: this.getPipelineArtifacts(),
              gateFeedback: error?.message || "需要补齐 files、operations_outline、test_cases",
            },
            sharedLessons,
            this.forwardAgentProgress("PLAN", 3),
          );
          planRes = this.normalizePlanToProjectStyle(planRes);
          planArtifact = normalizePlanArtifact(planRes);
          this.ensurePlanArtifactGate(planArtifact);
        }
        this.setPhaseArtifact(
          "PLAN",
          buildArtifactEnvelope("PLAN", this.buildHumanSummaryFromResult("PLAN", planRes), planArtifact),
        );
      }
      const planStyleContext = this.buildStyleContext(planRes);
      const projectSnapshotArtifact = this.buildProjectSnapshotArtifact(
        targetComponentContext,
        planStyleContext || styleContext,
        runtimeDiscovery,
      );
      if (isFeatureEnabled("ENABLE_PHASE_ARTIFACTS")) {
        this.setPhaseArtifact(
          "PROJECT_SNAPSHOT",
          buildArtifactEnvelope("PLAN", "已生成项目快照，用于后续编码与验证收敛。", projectSnapshotArtifact),
        );
      }
      this.trace("plan_style_context", {
        chars: planStyleContext.length,
        preview: summarizeText(planStyleContext, 200),
      });
      this.summarizeResult("PLAN", planRes);
      this.emitStepComplete("PLAN", "success", 3);

      // PHASE 4: CODING
      if (signal.aborted) throw new Error("AbortError");
      this.emitStepStart("CODING", "🛠️ 正在执行系统集成...", 4);
      this.emitStepProgress({
        phase: "CODING",
        content: "[系统] 将优先围绕核心组件执行真实代码写入。",
        index: 4,
      });
      let codingRes = await this.coderAgent.execute(
        {
          prd: prdArtifact,
          api: apiArtifact,
          plan: planArtifact,
          projectPath: this.projectPath,
          query: executionBrief,
          targetComponentContext,
          styleContext: planStyleContext || styleContext,
          prdFocusContext,
          targetComponentPath: this.targetComponentPath,
          targetRoute: this.targetRoute,
          artifacts: this.getPipelineArtifacts(),
        },
        sharedLessons,
        this.forwardAgentProgress("CODING", 4)
      );
      let codeArtifact = normalizeCodeArtifact(codingRes);
      if (isFeatureEnabled("ENABLE_PHASE_ARTIFACTS")) {
        this.setPhaseArtifact(
          "CODING",
          buildArtifactEnvelope("CODING", this.buildHumanSummaryFromResult("CODING", codingRes), codeArtifact),
        );
      }
      this.summarizeResult("CODING", codingRes);
      this.emitStepComplete("CODING", "success", 4);

      if (signal.aborted) throw new Error("AbortError");
      this.emitStepStart("VERIFY", "🧪 正在执行自动化 QA...", 5);
      this.emitStepProgress({
        phase: "VERIFY",
        content: "[系统] 正在执行本地静态校验与自动化 QA 预检。",
        index: 5,
      });

      let validationReport = this.buildValidationReport(codingRes, planRes);
      this.trace("validation_report", {
        checkedFiles: validationReport.checkedFiles,
        issueCount: validationReport.issues.length,
        errorCount: validationReport.issues.filter((item) => item.severity === "error").length,
        warningCount: validationReport.issues.filter((item) => item.severity === "warning").length,
        highlights: validationReport.highlights,
      });

      if (validationReport.hasBlockingIssues) {
        this.emitStepProgress({
          phase: "VERIFY",
          content: "[系统] 本地校验发现阻断问题，正在执行一次轻量修复。",
          index: 5,
        });
        const refreshedTargetComponentContext = this.buildTargetComponentContext();
        const refreshedStyleContext = this.buildStyleContext(planRes);
        codingRes = await this.coderAgent.execute(
          {
            prd: prdArtifact,
            api: apiArtifact,
            plan: planArtifact,
            projectPath: this.projectPath,
            query: executionBrief,
            error: this.buildValidationFixPrompt(validationReport),
            targetComponentContext: refreshedTargetComponentContext,
            styleContext: refreshedStyleContext || planStyleContext || styleContext,
            prdFocusContext,
            targetComponentPath: this.targetComponentPath,
            targetRoute: this.targetRoute,
            artifacts: this.getPipelineArtifacts(),
          },
          sharedLessons,
          this.forwardAgentProgress("VERIFY", 5)
        );

        validationReport = this.buildValidationReport(codingRes, planRes);
        this.trace("validation_recheck", {
          checkedFiles: validationReport.checkedFiles,
          issueCount: validationReport.issues.length,
          errorCount: validationReport.issues.filter((item) => item.severity === "error").length,
          warningCount: validationReport.issues.filter((item) => item.severity === "warning").length,
          highlights: validationReport.highlights,
        });
      }

      if (validationReport.hasBlockingIssues) {
        this.emitStepComplete("VERIFY", "error", 5);
        throw new Error(validationReport.summary);
      }

      if (this.shouldRunConsistencyReview(validationReport)) {
        this.emitStepProgress({
          phase: "VERIFY",
          content: "[系统] 本地校验发现高价值一致性提醒，正在执行一次轻量反思修复。",
          index: 5,
        });
        const reviewedTargetComponentContext = this.buildTargetComponentContext();
        const reviewedStyleContext = this.buildStyleContext(planRes);
        codingRes = await this.coderAgent.execute(
          {
            prd: prdArtifact,
            api: apiArtifact,
            plan: planArtifact,
            projectPath: this.projectPath,
            query: executionBrief,
            error: this.buildConsistencyReviewPrompt(validationReport),
            targetComponentContext: reviewedTargetComponentContext,
            styleContext: reviewedStyleContext || planStyleContext || styleContext,
            prdFocusContext,
            targetComponentPath: this.targetComponentPath,
            targetRoute: this.targetRoute,
            artifacts: this.getPipelineArtifacts(),
          },
          sharedLessons,
          this.forwardAgentProgress("VERIFY", 5)
        );

        validationReport = this.buildValidationReport(codingRes, planRes);
        this.trace("validation_consistency_recheck", {
          checkedFiles: validationReport.checkedFiles,
          issueCount: validationReport.issues.length,
          errorCount: validationReport.issues.filter((item) => item.severity === "error").length,
          warningCount: validationReport.issues.filter((item) => item.severity === "warning").length,
          highlights: validationReport.highlights,
        });

        if (validationReport.hasBlockingIssues) {
          this.emitStepComplete("VERIFY", "error", 5);
          throw new Error(validationReport.summary);
        }
      }

      codeArtifact = normalizeCodeArtifact(codingRes, [
        validationReport.summary,
        ...validationReport.highlights,
      ]);
      if (isFeatureEnabled("ENABLE_PHASE_ARTIFACTS")) {
        this.setPhaseArtifact(
          "CODING",
          buildArtifactEnvelope("CODING", this.buildHumanSummaryFromResult("CODING", codingRes), codeArtifact),
        );
      }

      this.emitStepProgress({
        phase: "VERIFY",
        content: "[系统] 本地静态校验已通过，准备执行浏览器自动化验证。",
        index: 5,
      });

      const qaCases = this.collectQaCases(codingRes, planRes);
      const selectedRuntime = this.selectRuntimeOption(runtimeDiscovery);
      if (runtimeDiscovery?.options.length) {
        this.emitStepProgress({
          phase: "VERIFY",
          content: `[系统] 已识别本地启动脚本：${runtimeDiscovery.options.slice(0, 4).map((item) => item.scriptName).join("、")}`,
          index: 5,
        });
      }
      if (runtimeDiscovery?.envFiles?.length) {
        this.emitStepProgress({
          phase: "VERIFY",
          content: `[系统] 已识别环境文件：${runtimeDiscovery.envFiles.slice(0, 4).join("、")}`,
          index: 5,
        });
      }

      let qaBaseUrl = await this.discoverQaBaseUrl(originalPrompt);
      let qaBootError = "";
      let qaLaunchLabel = "";
      const shouldAutoBoot = this.llmConfig.qaConfig?.autoBoot !== false;

      if (!qaBaseUrl && shouldAutoBoot && runtimeDiscovery && selectedRuntime) {
        this.emitStepProgress({
          phase: "VERIFY",
          content: `[系统] 未探测到现成本地站点，正在尝试自动启动 ${selectedRuntime.scriptName} 环境。`,
          index: 5,
        });
        try {
          const bootRes = await this.tryAutoBootQaRuntime(selectedRuntime, runtimeDiscovery.packageManager);
          qaBaseUrl = bootRes.baseUrl;
          qaLaunchLabel = bootRes.launchLabel;
          this.emitStepProgress({
            phase: "VERIFY",
            content: `[系统] 已自动启动测试环境：${bootRes.launchLabel} -> ${bootRes.baseUrl}`,
            index: 5,
          });
        } catch (error: any) {
          qaBootError = error?.message || "本地测试环境启动失败";
          this.emitStepProgress({
            phase: "VERIFY",
            content: `[系统] 本地启动尝试失败：${qaBootError}`,
            index: 5,
          });
        }
      }

      const hasBrowserTools = await this.hasChromeDevtoolsTools();
      this.trace("qa_precheck", {
        caseCount: qaCases.length,
        qaBaseUrl,
        hasBrowserTools,
        qaAutoBoot: shouldAutoBoot,
        selectedRuntimeScript: selectedRuntime?.scriptName || "",
        selectedRuntimeMode: selectedRuntime?.mode || "",
        qaLaunchLabel,
        qaBootError,
      });
      this.emitQaCasePreview(qaCases, qaBaseUrl, hasBrowserTools, planArtifact.test_cases);
      if (qaCases.length > 0) {
        this.emitStepProgress({
          phase: "VERIFY",
          content: "[系统] 测试用例清单已生成，开始准备自动化 QA。",
          index: 5,
        });
      }

      let qaRes: any;
      if (qaCases.length === 0) {
        qaRes = this.buildQaFallbackResult(
          "skipped",
          "当前阶段未产出明确验证点，已跳过浏览器自动化 QA。",
          [],
          { blockedReasons: ["缺少可执行的验证点"] },
        );
      } else if (!hasBrowserTools) {
        qaRes = this.buildQaFallbackResult(
          "skipped",
          "当前环境未连接 chrome-devtools MCP，已跳过浏览器自动化 QA。",
          qaCases,
          { blockedReasons: ["chrome-devtools MCP 未就绪"] },
        );
      } else if (!qaBaseUrl) {
        qaRes = this.buildQaFallbackResult(
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
        this.emitStepProgress({
          phase: "VERIFY",
          content: `[系统] 已锁定 QA 测试站点：${qaBaseUrl}`,
          index: 5,
        });
        try {
          qaRes = await this.qaAgent!.execute(
            {
              baseUrl: qaBaseUrl,
              targetRoute: this.targetRoute,
              verificationPoints: qaCases,
              testCases: planArtifact.test_cases,
              changedFiles: Array.from(new Set([
                ...this.extractPlanFilePaths(codingRes, "files_to_create"),
                ...this.extractPlanFilePaths(codingRes, "files_to_modify"),
              ])),
              codingSummary: summarizeText(
                codingRes?.completion_summary || codingRes?.reasoning || JSON.stringify(codingRes || {}),
                300,
              ),
              targetComponentPath: this.targetComponentPath,
              artifacts: {
                code: codeArtifact,
                plan: planArtifact,
                projectSnapshot: this.phaseArtifacts.PROJECT_SNAPSHOT?.artifact,
              },
            },
            sharedLessons,
            this.forwardAgentProgress("VERIFY", 5),
          );
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
        planArtifact.test_cases,
        [validationReport.summary, ...validationReport.highlights],
      );
      if (isFeatureEnabled("ENABLE_PHASE_ARTIFACTS")) {
        this.setPhaseArtifact(
          "VERIFY",
          buildArtifactEnvelope("VERIFY", this.buildHumanSummaryFromResult("VERIFY", qaRes), verifyArtifact),
        );
      }

      this.summarizeResult("VERIFY", qaRes);
      if (qaRes?.overall_status === "failed") {
        this.emitStepComplete("VERIFY", "error", 5);
        throw new Error(qaRes?.qa_summary || "自动化 QA 未通过。");
      }

      this.emitStepComplete("VERIFY", "success", 5);

      this.emitWorkflowComplete("success");
    } catch (err: any) {
      if (signal.aborted || err.message === "AbortError") {
          this.emitWorkflowComplete("error", "Workflow Aborted");
      } else {
          this.trace("workflow_error", { message: err.message, stack: summarizeText(err.stack || "", 400) });
          this.emitWorkflowComplete("error", err.message);
          throw err;
      }
    } finally {
      this.stopQaRuntimeProcess();
    }
  }

  public stopWorkflow() {
    this.abortController.abort();
    this.stopQaRuntimeProcess();
    this.log("Workflow stop signal received.");
  }
}
