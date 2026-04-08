import axios from "axios";
import { LLMMessage } from "../types";
import { MCPHub } from "../mcp-hub";
import * as fs from "fs";
import * as path from "path";
import { appendHarnessJsonl, appendHarnessLog, summarizeText } from "../harness-logger";
import { ContextManager } from "../context-manager";
import { ToolGatekeeper } from "../tool-gatekeeper";
import { DISPLAY_PHASES } from "../prompt-engine";

export interface LLMConfig {
  baseUrl: string;
  model?: string;
  modelId?: string;
  apiKey: string;
  projectPath?: string;
  runId?: string;
}

export abstract class BaseAgent {
  protected logPath: string;
  protected rawTrafficLogPath: string;
  protected mcpHub: MCPHub;
  protected signal?: AbortSignal;
  protected contextManager: ContextManager;
  protected toolGatekeeper: ToolGatekeeper;
  protected requiredWriteTargets: string[] = [];

  constructor(
    protected config: LLMConfig,
    mcpHub?: MCPHub,
    signal?: AbortSignal
  ) {
    this.mcpHub = mcpHub!;
    this.signal = signal;
    this.contextManager = new ContextManager();
    this.toolGatekeeper = new ToolGatekeeper();
    const harnessDir = path.join(process.cwd(), ".harness");
    if (!fs.existsSync(harnessDir))
      fs.mkdirSync(harnessDir, { recursive: true });
    this.logPath = path.join(harnessDir, "llm_debug.log");
    this.rawTrafficLogPath = path.join(harnessDir, "llm_raw_traffic.log");
  }

  public setSignal(signal: AbortSignal) {
    this.signal = signal;
  }

  protected get runId(): string {
    return this.config.runId || "run_unknown";
  }

  protected log(content: string) {
    appendHarnessLog("llm_debug.log", `🤖 [runId=${this.runId}] [${this.constructor.name}] ${content}`);
  }

  protected rawLog(chunk: string) {
    fs.appendFileSync(this.rawTrafficLogPath, chunk);
  }

  protected traceRound(payload: Record<string, unknown>) {
    appendHarnessJsonl("agent_rounds.jsonl", {
      runId: this.runId,
      agent: this.constructor.name,
      ...payload,
    });
  }

  protected hasChinese(text: string): boolean {
    return /[\u4e00-\u9fff]/.test(text);
  }

  protected countChinese(text: string): number {
    return (text.match(/[\u4e00-\u9fff]/g) || []).length;
  }

  protected countLatin(text: string): number {
    return (text.match(/[A-Za-z]/g) || []).length;
  }

  protected stripPseudoToolMarkup(text: string): string {
    return text
      .replace(/<\/?tool_call>/gi, "")
      .replace(/<function=[^>\n]+>/gi, "")
      .replace(/<parameter=[^>\n]+>/gi, "")
      .replace(/<\/parameter>/gi, "")
      .replace(/\n{3,}/g, "\n\n");
  }

  protected sanitizeReasoningChunk(text: string): string {
    return this.stripPseudoToolMarkup(text)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  protected isNoisyReasoningChunk(chunk: string): boolean {
    const compact = chunk.replace(/\s+/g, "");
    if (!compact) return true;

    if (/(?:\*\*:\*\*|`\/-|`\/\/:|<parameter=|<function=|<\/?tool_call>)/i.test(chunk)) {
      return true;
    }

    const chineseCount = this.countChinese(compact);
    const latinCount = this.countLatin(compact);
    const digitCount = (compact.match(/\d/g) || []).length;
    const symbolCount = compact.length - chineseCount - latinCount - digitCount;

    if (chineseCount === 0 && latinCount === 0 && symbolCount >= 6) return true;
    if (compact.length >= 12 && chineseCount <= 4 && symbolCount >= chineseCount * 2) return true;
    if (chineseCount > 0 && symbolCount > chineseCount * 1.6 && latinCount < chineseCount) return true;

    return false;
  }

  protected shouldStreamRawReasoning(): boolean {
    return false;
  }

  protected shouldSurfaceReasoning(chunk: string): boolean {
    const sanitized = this.sanitizeReasoningChunk(chunk);
    const compact = sanitized.replace(/\s+/g, "");
    if (!compact) return false;
    if (this.isNoisyReasoningChunk(sanitized)) return false;

    const chineseCount = this.countChinese(compact);
    const latinCount = this.countLatin(compact);

    if (chineseCount === 0 && latinCount > 0) return false;
    if (chineseCount > 0 && latinCount > chineseCount * 4) return false;

    return chineseCount > 0 || latinCount === 0;
  }

  protected shouldFlushThoughtBuffer(buffer: string, latestChunk: string, force: boolean = false): boolean {
    if (force) return buffer.trim().length > 0;
    return /[\n。！？；：!?]/.test(latestChunk) || buffer.length >= 96;
  }

  protected normalizeLoopSignature(text: string): string {
    return text
      .replace(/\s+/g, "")
      .replace(/[`"'*#>\-_:|.,!?()[\]{}]/g, "")
      .slice(0, 240);
  }

  protected formatToolProgress(toolName: string, args: any): string | null {
    const basename = typeof args?.path === "string" ? path.basename(args.path) : "目标文件";
    const startLine = args?.start_line || args?.StartLine;
    const endLine = args?.end_line || args?.EndLine;

    if (toolName.includes("get_file_outline")) {
      return `[系统] 正在获取 ${basename} 的结构轮廓。`;
    }

    if (toolName.includes("read_file_lines")) {
      const range =
        typeof startLine === "number" && typeof endLine === "number"
          ? `第 ${startLine}-${endLine} 行`
          : "关键代码片段";
      return `[系统] 正在读取 ${basename} 的${range}，定位业务逻辑。`;
    }

    if (toolName.includes("read_text_file")) {
      return `[系统] 正在加载 ${basename} 的完整上下文。`;
    }

    if (toolName.includes("grep_search") || toolName.includes("search_files")) {
      return "[系统] 正在搜索与本次需求最相关的代码位置。";
    }

    if (toolName.includes("internal_surgical_edit") || toolName.includes("surgical_edit")) {
      return `[系统] 正在写入 ${basename}，落地代码变更。`;
    }

    return null;
  }

  protected formatToolResultProgress(toolName: string, args: any, toolRes: string): string | null {
    const basename = typeof args?.path === "string" ? path.basename(args.path) : "目标文件";

    if (
      toolRes.includes("系统级频率拦截器") ||
      toolRes.includes("系统级探索预算拦截") ||
      toolRes.includes("系统级死循环拦截器")
    ) {
      return this.constructor.name === "CoderAgent"
        ? "[系统] 已触发收敛保护，下一轮将停止继续扫文件，直接完成目标文件写入。"
        : "[系统] 已触发收敛保护，下一轮将停止继续扫文件，直接输出最终方案。";
    }

    if (
      (toolName.includes("internal_surgical_edit") || toolName.includes("surgical_edit")) &&
      toolRes.startsWith("✅")
    ) {
      return `[系统] 已完成代码写入：${basename}。`;
    }

    return null;
  }

  protected extractVisibleReasoning(payload: any): string {
    if (payload && typeof payload.reasoning === "string") {
      return payload.reasoning.trim();
    }
    return "";
  }

  protected needsChineseReasoningRewrite(payload: any): boolean {
    const reasoning = this.extractVisibleReasoning(payload);
    if (!reasoning) return false;
    return !this.hasChinese(reasoning) && /[a-zA-Z]{5,}/.test(reasoning);
  }

  protected getPhaseIndex(): number {
    const name = this.constructor.name;
    if (name === "IntentAgent") return DISPLAY_PHASES.indexOf("意图解析");
    if (name === "PRDAgent") return DISPLAY_PHASES.indexOf("读取 PRD");
    if (name === "APIAgent") return DISPLAY_PHASES.indexOf("读取 API 文档");
    if (name === "PlannerAgent") return DISPLAY_PHASES.indexOf("规划实施方案");
    if (name === "CoderAgent") return DISPLAY_PHASES.indexOf("编写代码");
    return 0;
  }

  protected getExplorationBudget(): number | null {
    if (this.constructor.name === "PlannerAgent") return 6;
    if (this.constructor.name === "CoderAgent") return 6;
    return null;
  }

  protected requiresWriteBeforeFinish(): boolean {
    return this.constructor.name === "CoderAgent";
  }

  protected getMissingRequiredWriteTargets(successfulWritePaths: Set<string>): string[] {
    if (!this.requiresWriteBeforeFinish()) return [];

    const normalizedRequired = this.requiredWriteTargets
      .filter(Boolean)
      .map((item) => this.resolveProjectFilePath(item));

    if (normalizedRequired.length === 0) {
      return successfulWritePaths.size > 0 ? [] : ["至少一个目标文件"];
    }

    return normalizedRequired.filter((item) => !successfulWritePaths.has(item));
  }

  protected resolveProjectFilePath(rawPath: string): string {
    const projectRoot = path.resolve(this.config.projectPath || process.cwd());
    const candidate = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(projectRoot, rawPath);

    if (candidate !== projectRoot && !candidate.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`安全风险拦截：禁止写入项目目录之外的路径 (${rawPath})。`);
    }

    return candidate;
  }

  protected extractVerificationPoints(text: string, limit: number = 5): string[] {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) =>
        /^[-*]\s+/.test(line) ||
        /^\d+\.\s+/.test(line) ||
        /^验证[:：]/.test(line) ||
        /^需要验证[:：]/.test(line),
      )
      .map((line) =>
        line
          .replace(/^[-*]\s+/, "")
          .replace(/^\d+\.\s+/, "")
          .replace(/^验证[:：]\s*/, "")
          .replace(/^需要验证[:：]\s*/, "")
          .replace(/[`*_#]/g, "")
          .trim(),
      )
      .filter(Boolean)
      .slice(0, limit);
  }

  protected buildSyntheticCompletionResult(
    fullContent: string,
    fullReasoning: string,
    successfulCreatePaths: Set<string>,
    successfulModifyPaths: Set<string>,
  ): any | null {
    if (!this.requiresWriteBeforeFinish()) return null;

    const successfulWritePaths = new Set([
      ...successfulCreatePaths,
      ...successfulModifyPaths,
    ]);
    const missingWriteTargets = this.getMissingRequiredWriteTargets(successfulWritePaths);
    if (missingWriteTargets.length > 0) return null;

    const source = (fullContent || fullReasoning || "").trim();
    if (source.length < 80) return null;

    const projectRoot = path.resolve(this.config.projectPath || process.cwd());
    const cleaned = source
      .replace(/^\(注：Agent 正在思考中\.\.\.\)\s*/, "")
      .replace(/```[\s\S]*?```/g, "")
      .trim();

    const toRelativeEntry = (absPath: string, descriptionKey: "content" | "description") => ({
      path: path.relative(projectRoot, absPath) || path.basename(absPath),
      [descriptionKey]:
        descriptionKey === "content"
          ? "本轮已完成该文件创建，最终内容以真实写入文件为准。"
          : "本轮已完成该文件修改，最终结果以真实写入文件为准。",
    });

    return {
      reasoning: summarizeText(cleaned, 1200),
      files_to_create: Array.from(successfulCreatePaths).map((item) => toRelativeEntry(item, "content")),
      files_to_modify: Array.from(successfulModifyPaths).map((item) => toRelativeEntry(item, "description")),
      verification_points: this.extractVerificationPoints(source),
      completion_summary: summarizeText(cleaned, 200),
      synthesized_from_summary: true,
    };
  }

  protected normalizeToolAlias(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/[<>\s`'"]/g, "")
      .replace(/:/g, "__")
      .replace(/-/g, "_");
  }

  protected resolveToolSchemaName(rawName: string, availableTools: any[] = []): string {
    const normalizedRaw = this.normalizeToolAlias(rawName);
    for (const tool of availableTools) {
      const schemaName = tool?.function?.name;
      if (!schemaName) continue;
      const aliases = [
        schemaName,
        schemaName.replace("__", ":"),
        schemaName.replace("__", "_"),
      ].map((alias) => this.normalizeToolAlias(alias));
      if (aliases.includes(normalizedRaw)) {
        return schemaName;
      }
    }

    if (rawName.includes(":")) return rawName.replace(":", "__");
    if (rawName.startsWith("filesystem_")) return rawName.replace("filesystem_", "filesystem__");
    if (rawName.startsWith("code_surgeon_")) return rawName.replace("code_surgeon_", "code-surgeon__");
    if (rawName.startsWith("code-surgeon_")) return rawName.replace("code-surgeon_", "code-surgeon__");
    return rawName;
  }

  protected coercePseudoToolArg(key: string, rawValue: string): any {
    const trimmed = rawValue
      .replace(/<\/tool_call>/gi, "")
      .replace(/<\/parameter>/gi, "")
      .trim();

    if (!trimmed) return "";
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null") return null;

    if (/path|file|directory/i.test(key)) {
      const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim()) || trimmed;
      const pathLikePrefix = firstLine.match(/^([~/A-Za-z0-9._:@-]+(?:\/[A-Za-z0-9._:@-]+)+)/);
      if (pathLikePrefix?.[1]) {
        return pathLikePrefix[1];
      }
    }

    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch (e) {}
    }

    return trimmed;
  }

  protected extractPseudoToolCalls(source: string, availableTools: any[] = [], round: number = 0): any[] {
    if (!source || !/<function=|<tool_call>/i.test(source)) return [];

    const allowedToolNames = new Set(
      (availableTools || [])
        .map((tool) => tool?.function?.name)
        .filter(Boolean),
    );
    const blocks = Array.from(source.matchAll(/<tool_call>([\s\S]*?)(?=<tool_call>|$)/gi)).map((match) =>
      match[1].replace(/<\/tool_call>/gi, ""),
    );
    const candidates = blocks.length > 0 ? blocks : [source];
    const parsedCalls: any[] = [];

    candidates.forEach((block, index) => {
      const fnMatch = block.match(/<function=([^>\n]+)>/i);
      if (!fnMatch) return;

      const functionName = this.resolveToolSchemaName(fnMatch[1].trim(), availableTools);
      if (allowedToolNames.size > 0 && !allowedToolNames.has(functionName)) return;
      const args: Record<string, any> = {};
      for (const match of block.matchAll(/<parameter=([^>\n]+)>\s*([\s\S]*?)(?=<parameter=|<\/tool_call>|$)/gi)) {
        const key = match[1].trim();
        const value = this.coercePseudoToolArg(key, match[2]);
        args[key] = value;
      }

      parsedCalls.push({
        id: `heuristic_tool_${round}_${index}`,
        type: "function",
        function: {
          name: functionName,
          arguments: JSON.stringify(args),
        },
      });
    });

    return parsedCalls;
  }

  public async callLLM(
    messages: LLMMessage[],
    onThought?: (thought: string) => void,
    toolPattern: string[] = [],
    maxRounds: number = 50,
  ): Promise<any> {
    let currentMessages = [...messages];
    this.toolGatekeeper.reset();
    this.log(`--- [Agent Start] model=${this.config.model || this.config.modelId || "unknown"} ---`);
    this.rawLog(`\n\n===== [${new Date().toISOString()}] runId=${this.runId} agent=${this.constructor.name} =====\n`);

    const internalTools = [
      {
        name: "internal_surgical_edit",
        description:
          "高级外科手术式代码修改工具。请务必使用中文进行 Reasoning (思考)。这是保存你所有工作的唯一正式途径。它直接实时操作文件系统。",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "待修改文件的相对路径（例如 src/views/Home.vue）",
            },
            search: {
              type: "string",
              description:
                "源文件中需要被替换的精确代码片段。如果是新建文件，请保留为空字符串。",
            },
            replace: { type: "string", description: "替换后的新代码内容。" },
          },
          required: ["path", "search", "replace"],
        },
      },
    ];

    // 🚀 强制汉化指令增强 (Systemic Hardening)
    if (currentMessages[0] && currentMessages[0].role === 'system') {
      currentMessages[0].content += "\n\n**重要语言要求**: 请始终使用中文进行 Reasoning (思考) 和最终回复。";
    }

    let tools: any[] | undefined = undefined;
    const shouldIncludeInternal =
      toolPattern.includes("*") ||
      toolPattern.includes("internal_surgical_edit");
    const formattedInternalTools = shouldIncludeInternal
      ? internalTools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        }))
      : [];

    if (this.mcpHub) {
      const allTools = await this.mcpHub.getAllTools();
      const filtered = allTools.filter(
        (t) =>
          toolPattern.includes("*") ||
          toolPattern.some((p) => t.fullName.includes(p)),
      );
      const mcpTools = filtered.map((t) => ({
        type: "function",
        function: {
          name: t.fullName.replace(":", "__"),
          description: t.description || "",
          parameters: t.inputSchema || { type: "object", properties: {} },
        },
      }));
      tools = [...formattedInternalTools, ...mcpTools];
    } else {
      tools = formattedInternalTools;
    }

    const getEffectiveTools = (
      currentTools: any[] | undefined,
      failureCount: number,
    ) => {
      if (!currentTools || currentTools.length === 0) return undefined;
      if (failureCount > 0) {
        const coreTools = currentTools.filter(
          (t) =>
            t.function.name === "internal_surgical_edit" ||
            t.function.name.includes("grep_search") ||
            t.function.name.includes("get_file_outline") ||
            t.function.name.includes("read_file_lines") ||
            t.function.name.includes("read_text_file"),
        );
        if (coreTools.length > 0) return coreTools;
      }
      return currentTools;
    };

    const roundLimit = maxRounds;
    const executedActionCounts = new Map<string, number>();
    let explorationCount = 0;
    let consecutiveFailureCount = 0;
    let consecutiveReasoningOnlyCount = 0;
    let lastReasoningOnlySignature = "";
    let chineseReasoningRewriteAttempts = 0;
    let successfulWriteCount = 0;
    const successfulWritePaths = new Set<string>();
    const successfulCreatePaths = new Set<string>();
    const successfulModifyPaths = new Set<string>();
    let forceConclusionMode = false;
    let forceConclusionReason = "";
    let forceWriteMode = false;
    let forceWriteReason = "";
    let forceWriteRecoveryReads = 0;

    for (let round = 0; round < roundLimit; round++) {
      if (this.signal?.aborted) throw new Error("AbortError: 任务已手动停止");
      this.log(`Round ${round}: Calling streaming API...`);
      let fullContent = "";
      let fullReasoning = "";
      const toolCalls: any[] = [];
      let thoughtBuffer = "";
      let didStreamThought = false;

      const flushThoughtBuffer = (force: boolean = false) => {
        if (!onThought || !this.shouldFlushThoughtBuffer(thoughtBuffer, thoughtBuffer.slice(-1), force)) return;
        onThought(thoughtBuffer);
        didStreamThought = true;
        thoughtBuffer = "";
      };

      try {
        let effectiveTools = forceConclusionMode
          ? undefined
          : forceWriteMode
            ? (getEffectiveTools(tools, consecutiveFailureCount) || []).filter(
                (t) =>
                  t.function.name === "internal_surgical_edit" ||
                  t.function.name.includes("read_file_lines"),
              )
            : getEffectiveTools(tools, consecutiveFailureCount);
        currentMessages = this.contextManager.compressMessages(
          currentMessages,
          round,
          this.getPhaseIndex(),
          DISPLAY_PHASES,
        );
        const totalPromptLen = currentMessages.reduce(
          (sum, m) => sum + (m.content?.length || 0),
          0,
        );
        this.traceRound({
          type: "round_start",
          round,
          promptChars: totalPromptLen,
          messageCount: currentMessages.length,
          toolCount: effectiveTools?.length || 0,
          failureCount: consecutiveFailureCount,
          forceConclusionMode,
          forceWriteMode,
        });

        const payload = {
          model: this.config.model,
          messages: currentMessages,
          tools: effectiveTools && effectiveTools.length > 0 ? effectiveTools : undefined,
          stream: true,
          temperature: 0.1,
        };

        const response = await axios.post(
          `${this.config.baseUrl}/chat/completions`,
          payload,
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.config.apiKey}`,
            },
            responseType: "stream",
            timeout: 480000,
            signal: this.signal,
          },
        );

        const decoder = new TextDecoder("utf-8");
        let chunkBuffer = "";
        for await (const chunk of response.data) {
          const chunkStr = decoder.decode(chunk, { stream: true });
          this.rawLog(chunkStr);
          chunkBuffer += chunkStr;
          let lines = chunkBuffer.split("\n");
          chunkBuffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            try {
              let rawData = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
              if (rawData === "[DONE]") break;
              const data = JSON.parse(rawData);
              if (data.error) {
                throw new Error(`【模型提供商报错】: ${data.error.message || JSON.stringify(data.error)}`);
              }
              const delta = data.choices?.[0]?.delta || data.choices?.[0]?.message || data;
              const r = delta.reasoning_content || delta.reasoning || delta.thought || "";
              const c = delta.content || delta.text || "";

              if (r) {
                const visibleReasoningChunk = this.sanitizeReasoningChunk(r);
                if (
                  this.shouldStreamRawReasoning() &&
                  onThought &&
                  this.shouldSurfaceReasoning(visibleReasoningChunk)
                ) {
                  thoughtBuffer += /[\n。！？；!?]$/.test(visibleReasoningChunk)
                    ? visibleReasoningChunk
                    : `${visibleReasoningChunk} `;
                  flushThoughtBuffer();
                }
                fullReasoning += r;
              }

              if (c) {
                fullContent += c;
              }

              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (tc.index === undefined) continue;
                  if (!toolCalls[tc.index]) {
                    toolCalls[tc.index] = {
                      id: tc.id,
                      type: "function",
                      function: { name: "", arguments: "" },
                    };
                  }
                  if (tc.id) toolCalls[tc.index].id = tc.id;
                  if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                  if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                }
              }
            } catch (e) {}
          }
        }
        flushThoughtBuffer(true);


        if (!forceConclusionMode && toolCalls.length === 0) {
          const heuristicToolCalls = this.extractPseudoToolCalls(
            fullContent || fullReasoning,
            effectiveTools,
            round,
          );
          if (heuristicToolCalls.length > 0) {
            toolCalls.push(...heuristicToolCalls);
            this.traceRound({
              type: "heuristic_tool_calls",
              round,
              toolCallNames: heuristicToolCalls.map((call) => call?.function?.name || "").filter(Boolean),
              reasoningPreview: summarizeText(this.stripPseudoToolMarkup(fullReasoning), 180),
            });
          }
        }

        const hasTools = toolCalls.length > 0;
        const cleanJsonStr = this.cleanJson(fullContent);
        // 🚀 判定优化：只要能够提取出合格 JSON，就视为 hasJson
        const hasJson = cleanJsonStr.trim().length > 0 && cleanJsonStr.trim().startsWith("{");
        const hasReasoning = fullReasoning.trim().length > 0 || fullContent.trim().length > 0;
        const toolCallNames = toolCalls.map(call => call?.function?.name || "").filter(Boolean);

        if (hasTools) {
          consecutiveFailureCount = 0;
          consecutiveReasoningOnlyCount = 0;
          lastReasoningOnlySignature = "";
          this.traceRound({
            type: "round_result",
            round,
            decision: "tool_calls",
            reasoningChars: fullReasoning.length,
            contentChars: fullContent.length,
            thoughtStreamed: didStreamThought,
            toolCallNames,
          });
          currentMessages.push({
            role: "assistant",
            content: fullContent,
            tool_calls: toolCalls,
          });

          let triggeredForceConclusionThisRound = false;
          let triggeredForceWriteThisRound = false;

          for (const call of toolCalls) {
            let fullName = call.function.name.replace("__", ":");
            fullName = fullName.replace("filesystem_", "filesystem:").replace("code-surgeon_", "code-surgeon:");

            let args: any = {};
            try {
              args = JSON.parse(call.function.arguments);
            } catch (e) {
              const match = call.function.arguments.match(/\{[\s\S]*\}/);
              if (match) try { args = JSON.parse(match[0]); } catch (e2) {}
            }

            if (this.config.projectPath) {
              const pathKeys = ["path", "directory_path", "directory", "file", "root_path", "TargetFile"];
              for (const key of pathKeys) {
                if (args[key] && typeof args[key] === "string" && !path.isAbsolute(args[key])) {
                  args[key] = path.resolve(this.config.projectPath, args[key]);
                }
              }
            } else if (round > 0) {
              // 🚨 错误信息汉化，防止干扰模型语言倾向
              throw new Error("【系统严重错误】: 项目根路径 (projectPath) 未定义。已处于安全拦截状态，请在指令中明确给出项目根目录。");
            }

            const actionKey = `${fullName}:${JSON.stringify(args)}`;
            const callCount = (executedActionCounts.get(actionKey) || 0) + 1;
            executedActionCounts.set(actionKey, callCount);
            const readLoopNotice = this.toolGatekeeper.checkReadLoop(fullName, args);
            const explorationBudget = this.getExplorationBudget();
            const isExplorationTool = this.toolGatekeeper.isExplorationTool(fullName);
            if (isExplorationTool) {
              explorationCount++;
            }
            this.traceRound({
              type: "tool_dispatch",
              round,
              tool: fullName,
              callCount,
              argKeys: Object.keys(args || {}),
              pathPreview: typeof args?.path === "string" ? args.path : "",
              explorationCount,
            });

            const toolProgress = this.formatToolProgress(fullName, args);
            if (toolProgress && onThought) {
              onThought(toolProgress);
            }

            let toolRes = "";
            let writeKind: "create" | "modify" | null = null;
            if (
              forceWriteMode &&
              !(fullName === "internal_surgical_edit" || fullName === "surgical_edit" || fullName.includes("read_file_lines"))
            ) {
              toolRes = "❌ 错误: 已进入编码强制收敛模式。禁止继续使用该工具，只允许一次精确补读后立即执行 internal_surgical_edit。";
            } else if (
              forceWriteMode &&
              fullName.includes("read_file_lines") &&
              ++forceWriteRecoveryReads > 1
            ) {
              toolRes = "❌ 错误: 编码强制收敛模式下，补读次数已达上限。禁止继续读取，请立即调用 internal_surgical_edit 写入目标文件。";
            } else if (callCount > 3) {
              toolRes = "❌ 错误: 发现死循环迹象。同一参数的操作已尝试 3 次以上，请更换策略，不要重复尝试。";
            } else if (readLoopNotice) {
              toolRes = readLoopNotice;
              if (this.constructor.name === "PlannerAgent") {
                forceConclusionMode = true;
                forceConclusionReason = "已触发同文件高频读取拦截，现有证据已经足够，需要直接输出实施方案。";
                triggeredForceConclusionThisRound = true;
              } else if (this.constructor.name === "CoderAgent") {
                forceWriteMode = true;
                forceWriteReason = "编码阶段已对同一核心文件进行高频读取，必须停止扫描并直接完成写入。";
                forceWriteRecoveryReads = 0;
                triggeredForceWriteThisRound = true;
              }
            } else if (
              explorationBudget !== null &&
              isExplorationTool &&
              explorationCount > explorationBudget
            ) {
              toolRes = `⚠️ [系统级探索预算拦截] 你在当前阶段已经执行了 ${explorationCount} 次探索型工具，超过预算 ${explorationBudget}。
你已经拥有足够证据，下一轮必须直接输出最终 JSON 方案。
禁止继续调用 search/read/outline/list/directory_tree 类工具。`;
              if (this.constructor.name === "PlannerAgent") {
                forceConclusionMode = true;
                forceConclusionReason = `规划阶段探索次数已超过预算 ${explorationBudget}，必须基于当前证据直接收敛。`;
                triggeredForceConclusionThisRound = true;
              } else if (this.constructor.name === "CoderAgent") {
                forceWriteMode = true;
                forceWriteReason = `编码阶段探索次数已超过预算 ${explorationBudget}，必须停止继续扫描并直接写入。`;
                forceWriteRecoveryReads = 0;
                triggeredForceWriteThisRound = true;
              }
            } else if (fullName === "internal_surgical_edit" || fullName === "surgical_edit") {
              try {
                if (onThought) onThought(`⚙️ 正在对 ${path.basename(args.path)} 执行修改手术...`);
                const rawTargetPath = String(args.path || "");
                const targetPath = this.resolveProjectFilePath(rawTargetPath);
                const search = args.search || "";
                const replace = args.replace || "";

                if (!fs.existsSync(targetPath)) {
                  if (search === "") {
                    const dir = path.dirname(targetPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(targetPath, replace, "utf-8");
                    toolRes = `✅ 文件创建成功: ${path.relative(this.config.projectPath!, targetPath)}`;
                    writeKind = "create";
                  } else {
                    toolRes = `❌ 错误: 目标文件不存在。如果是要新建文件，请将 search 参数设为空字符串。`;
                  }
                } else {
                  const content = fs.readFileSync(targetPath, "utf8");
                  if (content.includes(search)) {
                    fs.writeFileSync(targetPath, content.replace(search, replace), "utf-8");
                    toolRes = `✅ 代码修改成功: ${path.relative(this.config.projectPath!, targetPath)}`;
                    writeKind = "modify";
                  } else {
                    toolRes = `❌ 错误: 无法在文件中匹配到指定的 SEARCH 块。请检查代码缩进、空格或换行符是否与原文件完全一致。建议先使用 read_file_lines 查看原文。`;
                  }
                }
              } catch (err: any) {
                toolRes = `❌ 执行失败: ${err.message}`;
              }
              if (
                this.constructor.name === "CoderAgent" &&
                toolRes.includes("SEARCH 块")
              ) {
                forceWriteMode = true;
                forceWriteReason = "目标文件写入时 SEARCH 块未命中，需要基于刚读取的精确片段立刻重试，不能再回到大范围扫描。";
                forceWriteRecoveryReads = 0;
                triggeredForceWriteThisRound = true;
              }
            } else {
              try {
                const res = await this.mcpHub.callTool(fullName, args);
                const __res = res as any;
                if (__res && __res.content && Array.isArray(__res.content)) {
                  toolRes = __res.content.map((c: any) => c.text || JSON.stringify(c)).join("\n");
                } else {
                  toolRes = typeof res === "string" ? res : JSON.stringify(res);
                }
                toolRes = this.contextManager.protectToolResult(fullName, toolRes);
              } catch (err: any) {
                toolRes = `❌ 工具报错: ${err.message}`;
              }
            }
            this.traceRound({
              type: "tool_result",
              round,
              tool: fullName,
              success: !toolRes.startsWith("❌"),
              responseChars: toolRes.length,
              responsePreview: summarizeText(toolRes, 180),
            });
            if (
              !toolRes.startsWith("❌") &&
              (fullName === "internal_surgical_edit" || fullName === "surgical_edit")
            ) {
              const resolvedPath = this.resolveProjectFilePath(String(args.path || ""));
              successfulWriteCount++;
              successfulWritePaths.add(resolvedPath);
              if (writeKind === "create") successfulCreatePaths.add(resolvedPath);
              if (writeKind === "modify") successfulModifyPaths.add(resolvedPath);
            }
            const toolResultProgress = this.formatToolResultProgress(fullName, args, toolRes);
            if (toolResultProgress && onThought) {
              onThought(toolResultProgress);
            }
            currentMessages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolRes });
          }
          if (triggeredForceConclusionThisRound) {
            this.traceRound({
              type: "forced_conclusion",
              round,
              reason: forceConclusionReason,
            });
            currentMessages.push({
              role: "user",
              content:
                `你已经拥有足够证据，禁止继续调用任何工具。请直接基于已有的 PRD、API、项目目录树、目标组件片段与已读取代码，输出最终 JSON 实施方案。\n` +
                `要求：必须包含 reasoning、files_to_modify、files_to_create、verification_points；如证据不足，请在 reasoning 中说明风险，但依然要给出当前最佳方案。\n` +
                `触发原因：${forceConclusionReason}`,
            });
          }
          if (triggeredForceWriteThisRound) {
            this.traceRound({
              type: "forced_write",
              round,
              reason: forceWriteReason,
            });
            currentMessages.push({
              role: "user",
              content:
                `你已经进入编码强制收敛模式。禁止继续使用 filesystem:read_text_file、filesystem:list_directory、code-surgeon:get_file_outline 等扫描工具。\n` +
                `只允许两种行为：\n1. 最多一次 code-surgeon:read_file_lines 精确补读目标块\n2. 立即 internal_surgical_edit 写入目标组件\n` +
                `要求：必须写中核心组件，不允许只修改辅助文件就结束。完成真实写入后，必须立即输出最终 JSON 交付结果，不要再输出自由格式总结。\n` +
                `触发原因：${forceWriteReason}`,
            });
          }
          continue;
        }

        const hasSearchReplace = fullContent.includes("<<<<<<< SEARCH");
        // 使用外部作用域已计算好的 hasJson 和 hasReasoning
        
        if (hasSearchReplace || hasJson) {
          consecutiveReasoningOnlyCount = 0;
          lastReasoningOnlySignature = "";
          if (hasJson) {
            const parsedJson = JSON.parse(cleanJsonStr);
            const missingWriteTargets = this.getMissingRequiredWriteTargets(successfulWritePaths);
            if (this.requiresWriteBeforeFinish() && missingWriteTargets.length > 0) {
              forceWriteMode = true;
              forceWriteReason = `编码阶段尚未真正写入关键目标：${missingWriteTargets.join("、")}`;
              forceWriteRecoveryReads = 0;
              this.traceRound({
                type: "missing_write_guard",
                round,
                jsonKeys: Object.keys(parsedJson || {}),
                missingWriteTargets,
              });
              currentMessages.push({ role: "assistant", content: cleanJsonStr });
              currentMessages.push({
                role: "user",
                content:
                  `编码阶段尚未真正写入关键目标文件：${missingWriteTargets.join("、")}。禁止直接结束。\n` +
                  "你必须优先完成这些文件的真实写入；如果 SEARCH 块失败，只允许一次精确补读，然后立即再次 internal_surgical_edit。",
              });
              continue;
            }
            this.traceRound({
              type: "round_result",
              round,
              decision: "json",
              reasoningChars: fullReasoning.length,
              contentChars: fullContent.length,
              thoughtStreamed: didStreamThought,
              jsonKeys: Object.keys(parsedJson || {}),
              reasoningPreview: summarizeText(this.extractVisibleReasoning(parsedJson), 140),
            });
            if (this.needsChineseReasoningRewrite(parsedJson) && chineseReasoningRewriteAttempts < 1) {
              chineseReasoningRewriteAttempts++;
              this.traceRound({
                type: "reasoning_rewrite",
                round,
                reason: "english_reasoning_detected",
                reasoningPreview: summarizeText(this.extractVisibleReasoning(parsedJson), 140),
              });
              currentMessages.push({ role: "assistant", content: cleanJsonStr });
              currentMessages.push({
                role: "user",
                content:
                  "你上一条输出的 JSON 中，reasoning 字段仍是英文。请保持除 reasoning 外的所有字段和语义不变，只把 reasoning 改写为中文，并重新输出完整 JSON。禁止附加解释、禁止输出 Markdown。",
              });
              continue;
            }
            return parsedJson;
          }
          return { raw_content: fullContent, type: "search_replace" };
        }

        const synthesizedCompletion = this.buildSyntheticCompletionResult(
          fullContent,
          fullReasoning,
          successfulCreatePaths,
          successfulModifyPaths,
        );
        if (synthesizedCompletion) {
          this.traceRound({
            type: "round_result",
            round,
            decision: "synthetic_completion",
            reasoningChars: fullReasoning.length,
            contentChars: fullContent.length,
            thoughtStreamed: didStreamThought,
            jsonKeys: Object.keys(synthesizedCompletion || {}),
            reasoningPreview: summarizeText(synthesizedCompletion?.reasoning || "", 140),
          });
          return synthesizedCompletion;
        }

        // 🚀 循环保护：如果内容为空或者与上一轮几乎一致，报错退出，防止死循环
        if (hasReasoning && !hasTools) {
          consecutiveReasoningOnlyCount++;
          const progressSignature = this.normalizeLoopSignature(fullContent.trim() || fullReasoning.trim());
          const visibleReasoning = this.sanitizeReasoningChunk(fullContent.trim() || fullReasoning.trim());
          const compactReasoning = this.isNoisyReasoningChunk(visibleReasoning)
            ? ""
            : summarizeText(visibleReasoning, 140);
          const contentToPush = compactReasoning
            ? `(注：Agent 正在思考中...)\n${compactReasoning}`
            : "(注：Agent 正在思考中...)";
          
          // 检查语言倾向：如果输出包含大量英文，注入强力警告
          const reasoningSample = fullContent || fullReasoning;
          const englishCheck = /[a-zA-Z]{5,}/.test(reasoningSample) && !/[\u4e00-\u9fa5]/.test(reasoningSample);
          const langNudge = englishCheck ? "\n⚠️ 注意：请务必使用【中文】进行后续所有思考和回复！" : "";

          if (progressSignature && progressSignature === lastReasoningOnlySignature) {
            throw new Error("【原地踏步拦截】: 检测到模型重复输出相同推理片段，且未产出 JSON 或工具调用。");
          }

          lastReasoningOnlySignature = progressSignature;

          if (consecutiveReasoningOnlyCount >= 2) {
            throw new Error("【收敛失败拦截】: 模型连续 2 轮只输出推理，未调用工具也未给出最终 JSON。");
          }

          this.traceRound({
            type: "round_result",
            round,
            decision: "reasoning_only",
            reasoningChars: fullReasoning.length,
            contentChars: fullContent.length,
            thoughtStreamed: didStreamThought,
            englishOnly: englishCheck,
            continuationCount: consecutiveReasoningOnlyCount,
            reasoningPreview: summarizeText(contentToPush, 180),
          });

          currentMessages.push({ role: "assistant", content: contentToPush });
          currentMessages.push({
            role: "user",
            content: forceConclusionMode
              ? `请不要继续解释，也不要再调用任何工具。立即输出最终 JSON 实施方案。${langNudge}\n\n要求：必须包含 reasoning、files_to_modify、files_to_create、verification_points；不要重复前面的扫描过程。`
              : this.requiresWriteBeforeFinish() && this.getMissingRequiredWriteTargets(successfulWritePaths).length === 0
                ? `请不要继续写完成报告。立即输出最终 JSON 交付结果。${langNudge}\n\n要求：必须包含 reasoning、files_to_modify、files_to_create、verification_points、completion_summary；不要使用 Markdown 章节。`
                : `请继续。${langNudge}\n\n指令请求：请基于前文思考给出最终的 JSON 方案，或者执行工具调用。不要重复前面的话。`,
          });
          continue;
        }
        this.traceRound({
          type: "round_result",
          round,
          decision: "silent_or_invalid",
          reasoningChars: fullReasoning.length,
          contentChars: fullContent.length,
        });
        throw new Error("Silent output or invalid format.");
      } catch (err: any) {
        consecutiveFailureCount++;
        this.traceRound({
          type: "round_error",
          round,
          failureCount: consecutiveFailureCount,
          message: err.message,
        });
        if (consecutiveFailureCount >= 5) throw new Error(`Circuit Breaker: ${err.message}`);
        currentMessages.push({ role: "user", content: `❌ Error: ${err.message}.` });
      }
    }
    throw new Error("Max rounds reached.");
  }

  protected cleanJson(text: string): string {
    if (!text) return "";
    let cleaned = text.replace(/```json\n?|```/g, "").trim();

    try {
      JSON.parse(cleaned);
      return cleaned;
    } catch (e) {}

    // 🚀 策略：寻找所有合法的 {...} 候选块
    const firstStart = text.indexOf("{");
    const lastEnd = text.lastIndexOf("}");

    if (firstStart !== -1 && lastEnd !== -1 && lastEnd > firstStart) {
      const candidate = text.slice(firstStart, lastEnd + 1).trim();
      try {
        JSON.parse(candidate);
        return candidate;
      } catch (e) {}
    }

    // 备选策略：从后往前找最接近结尾的块（防止大块干扰）
    const lastStart = text.lastIndexOf("{");
    if (lastStart !== -1 && lastEnd !== -1 && lastEnd > lastStart) {
      const candidate = text.slice(lastStart, lastEnd + 1).trim();
      try {
        JSON.parse(candidate);
        return candidate;
      } catch (e) {}
    }

    return cleaned;
  }

  public abstract execute(
    input: any,
    lessons: string,
    onThought?: (thought: string) => void,
  ): Promise<any>;
}
