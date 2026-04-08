import { BaseAgent, LLMConfig, IntentAgent, PRDAgent, APIAgent, PlannerAgent, CoderAgent } from "../agents";
import { MCPHub } from "../mcp-hub";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { LarkPrefetcher } from "../lark-prefetcher";
import { appendHarnessJsonl, appendHarnessLog, summarizeText } from "../harness-logger";
import { EvalHarness } from "../harness/lesson-rag";

export class V2Orchestrator extends EventEmitter {
  private abortController: AbortController;
  private prdAgent?: PRDAgent;
  private apiAgent?: APIAgent;
  private plannerAgent?: PlannerAgent;
  private coderAgent?: CoderAgent;
  private projectPath: string = "";
  private targetRoute: string = "";
  private targetComponentPath: string = "";
  private taskObjective: string = "";
  private evalHarness = new EvalHarness(process.cwd());

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

  private buildPhaseSummary(label: string, result: any) {
    const phaseIndexMap: Record<string, number> = {
      INTENT: 0,
      PRD: 1,
      API: 2,
      PLAN: 3,
      CODING: 4,
    };
    const index = phaseIndexMap[label];
    const highlights: string[] = [];
    const stats: string[] = [];
    let title = "";
    let summary = "";

    if (label === "PRD") {
      title = "需求摘要已生成";
      summary = result?.content_verified || summarizeText(result?.reasoning || "", 150);
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
    } else if (label === "API") {
      title = "接口映射已收敛";
      summary = summarizeText(result?.reasoning || "", 150);
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
      summary = summarizeText(result?.reasoning || "", 150);
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
    } else if (label === "CODING") {
      title = "代码集成已执行";
      summary = summarizeText(
        result?.reasoning || result?.raw_content || JSON.stringify(result || {}),
        150,
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
    } else {
      return null;
    }

    return {
      phase: label,
      index,
      title,
      summary,
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
      apiPurposeSummary ? `接口侧已识别的关键能力包括：${apiPurposeSummary}。` : "",
      targetComponentContext
        ? "系统已预取目标组件热点代码片段，当前证据足以直接制定实施方案，无需继续顺序扫描大文件。"
        : "当前可基于已有证据直接收敛方案。",
    ].filter(Boolean);

    return {
      reasoning: reasoningParts.join(""),
      files_to_create: filesToCreate,
      files_to_modify: filesToModify,
      external_libs: [],
      verification_points: Array.from(new Set(verificationPoints)),
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
      const sharedLessons = this.evalHarness.getRelevantLessons(
        `${originalPrompt}\n${this.targetComponentPath}\n${this.targetRoute}`,
      );
      const executionBrief = this.buildExecutionBrief();
      const targetComponentContext = this.buildTargetComponentContext();
      this.trace("lessons_loaded", {
        chars: sharedLessons.length,
        preview: summarizeText(sharedLessons, 180),
      });
      this.trace("target_component_context", {
        path: this.targetComponentPath,
        chars: targetComponentContext.length,
        preview: summarizeText(targetComponentContext, 200),
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

      const prdRes = await this.prdAgent.execute(
        { query: executionBrief, rawContent: prdContent },
        sharedLessons,
        this.forwardAgentProgress("PRD", 1)
      );
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
      
      const apiRes = await this.apiAgent.execute(
        { prd: prdRes, rawContent: apiContent, query: executionBrief },
        sharedLessons,
        this.forwardAgentProgress("API", 2)
      );
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
            prd: prdRes,
            api: apiRes,
            projectPath: this.projectPath,
            projectTree,
            targetComponentContext,
            query: executionBrief,
            targetComponentPath: this.targetComponentPath,
            targetRoute: this.targetRoute,
          },
          sharedLessons,
          this.forwardAgentProgress("PLAN", 3)
        );
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
      const codingRes = await this.coderAgent.execute(
        {
          prd: prdRes,
          api: apiRes,
          plan: planRes,
          projectPath: this.projectPath,
          query: executionBrief,
          targetComponentContext,
          targetComponentPath: this.targetComponentPath,
          targetRoute: this.targetRoute,
        },
        sharedLessons,
        this.forwardAgentProgress("CODING", 4)
      );
      this.summarizeResult("CODING", codingRes);
      this.emitStepComplete("CODING", "success", 4);

      this.emitWorkflowComplete("success");
    } catch (err: any) {
      if (signal.aborted || err.message === "AbortError") {
          this.emitWorkflowComplete("error", "Workflow Aborted");
      } else {
          this.trace("workflow_error", { message: err.message, stack: summarizeText(err.stack || "", 400) });
          this.emitWorkflowComplete("error", err.message);
          throw err;
      }
    }
  }

  public stopWorkflow() {
    this.abortController.abort();
    this.log("Workflow stop signal received.");
  }
}
