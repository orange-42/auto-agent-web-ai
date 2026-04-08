import axios from "axios";
import { LLMMessage } from "../types";
import { MCPHub } from "../mcp-hub";
import * as fs from "fs";
import * as path from "path";
import { appendHarnessJsonl, appendHarnessLog, summarizeText } from "../harness-logger";
import { ContextManager } from "../context-manager";
import { ToolGatekeeper } from "../tool-gatekeeper";
import { isFeatureEnabled } from "../feature-flags";
import { DISPLAY_PHASES } from "../prompt-engine";
import { analyzeCodeFile } from "../code-analysis";

export interface LLMConfig {
  baseUrl: string;
  model?: string;
  modelId?: string;
  apiKey: string;
  projectPath?: string;
  runId?: string;
  qaConfig?: {
    envPreference?: string;
    baseUrl?: string;
    autoBoot?: boolean;
  };
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

  protected escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

    if (toolName.includes("new_page")) {
      return "[系统] 正在创建 QA 浏览器页面。";
    }

    if (toolName.includes("navigate_page")) {
      return "[系统] 正在打开待验证页面。";
    }

    if (toolName.includes("take_snapshot")) {
      return "[系统] 正在采集页面快照，准备执行断言。";
    }

    if (toolName.includes("evaluate_script")) {
      return "[系统] 正在执行页面断言脚本。";
    }

    if (toolName.includes("wait_for")) {
      return "[系统] 正在等待页面状态稳定。";
    }

    if (toolName.includes("click")) {
      return "[系统] 正在执行页面交互操作。";
    }

    if (toolName.includes("grep_search") || toolName.includes("search_files")) {
      return "[系统] 正在搜索与本次需求最相关的代码位置。";
    }

    if (toolName.includes("internal_surgical_edit") || toolName.includes("surgical_edit")) {
      return `[系统] 正在写入 ${basename}，落地代码变更。`;
    }

    if (toolName.includes("internal_structured_edit")) {
      return `[系统] 正在以结构化编辑方式更新 ${basename}。`;
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
      (toolName.includes("internal_surgical_edit") || toolName.includes("surgical_edit") || toolName.includes("internal_structured_edit")) &&
      toolRes.startsWith("✅") &&
      !this.isNoopWriteMessage(toolRes)
    ) {
      return `[系统] 已完成代码写入：${basename}。`;
    }

    if (toolName.includes("navigate_page") && toolRes.startsWith("✅")) {
      return "[系统] 页面已打开，开始执行自动化验证。";
    }

    if (toolName.includes("evaluate_script") && toolRes.startsWith("✅")) {
      return "[系统] 页面断言脚本已执行完成。";
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
    if (name === "QAAgent") return DISPLAY_PHASES.indexOf("验证测试");
    return 0;
  }

  protected getExplorationBudget(): number | null {
    if (this.constructor.name === "PlannerAgent") return 6;
    if (this.constructor.name === "CoderAgent") return 6;
    if (this.constructor.name === "QAAgent") return 5;
    return null;
  }

  protected requiresWriteBeforeFinish(): boolean {
    return this.constructor.name === "CoderAgent";
  }

  protected getPromptCharacterBudget(): number | null {
    if (this.constructor.name === "CoderAgent") return 18000;
    if (this.constructor.name === "PlannerAgent") return 16000;
    if (this.constructor.name === "QAAgent") return 10000;
    if (this.constructor.name === "PRDAgent") return 24000;
    if (this.constructor.name === "APIAgent") return 24000;
    if (this.constructor.name === "IntentAgent") return 16000;
    return null;
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

  protected hasSatisfiedRequiredWrites(successfulWritePaths: Set<string>): boolean {
    return this.requiresWriteBeforeFinish() && this.getMissingRequiredWriteTargets(successfulWritePaths).length === 0;
  }

  protected isNoopWriteMessage(toolRes: string): boolean {
    return /无需重复创建|内容已存在|无需重复写入|无需重复插入|已存在，无需|已存在该字段|已存在该条目|导入已存在|导出语句已存在/u.test(
      String(toolRes || ""),
    );
  }

  protected buildFinalDeliveryInstruction(reason: string = ""): string {
    if (this.requiresWriteBeforeFinish()) {
      return (
        "关键目标文件已经完成真实写入。禁止继续读取文件、禁止重复修改、禁止继续输出中间过程。\n" +
        "你现在必须立即输出最终 JSON 交付结果。\n" +
        "要求：必须包含 reasoning、files_to_create、files_to_modify、operations_executed、verification_points、validation_summary、completion_summary。\n" +
        "不要输出 Markdown，不要继续调用任何工具。\n" +
        (reason ? `触发原因：${reason}` : "")
      ).trim();
    }

    return (
      "你已经拥有足够证据，禁止继续调用任何工具。请立即输出最终 JSON 结果。\n" +
      (reason ? `触发原因：${reason}` : "")
    ).trim();
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

  protected isLikelyProjectAlias(specifier: string): boolean {
    const projectRoot = path.resolve(this.config.projectPath || process.cwd());
    if (!specifier) return false;
    if (specifier.startsWith(".") || specifier.startsWith("@/")) return false;
    if (specifier.startsWith("@")) return false;

    const firstSegment = specifier.split("/")[0] || "";
    if (!firstSegment) return false;
    if (firstSegment === "src") return true;

    const rootCandidate = path.resolve(projectRoot, firstSegment);
    const srcCandidate = path.resolve(projectRoot, "src", firstSegment);
    return fs.existsSync(rootCandidate) || fs.existsSync(srcCandidate);
  }

  protected resolveImportCandidates(sourceRelativePath: string, specifier: string): string[] {
    const projectRoot = path.resolve(this.config.projectPath || process.cwd());
    const sourceAbsolutePath = this.resolveProjectFilePath(sourceRelativePath);
    const basePaths = specifier.startsWith("@/")
      ? [
          path.resolve(projectRoot, "src", specifier.slice(2)),
          path.resolve(projectRoot, specifier.slice(2)),
        ]
      : this.isLikelyProjectAlias(specifier)
        ? [
            path.resolve(projectRoot, "src", specifier),
            path.resolve(projectRoot, specifier),
          ]
        : [path.resolve(path.dirname(sourceAbsolutePath), specifier)];

    const candidates: string[] = [];
    for (const basePath of basePaths) {
      candidates.push(basePath);
      [".js", ".ts", ".tsx", ".vue", ".json"].forEach((ext) => candidates.push(`${basePath}${ext}`));
      ["index.js", "index.ts", "index.tsx", "index.vue", "index.json"].forEach((entry) =>
        candidates.push(path.join(basePath, entry)),
      );
    }

    return Array.from(new Set(candidates));
  }

  protected resolveImportTarget(sourceRelativePath: string, specifier: string): string | null {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !this.isLikelyProjectAlias(specifier)) {
      return null;
    }

    const candidates = this.resolveImportCandidates(sourceRelativePath, specifier);
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  }

  protected parseImportClause(clause: string): { defaultImport?: string; namedImports: string[] } {
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

  protected hasNamedExport(targetContent: string, exportName: string): boolean {
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

  protected hasDefaultExport(targetContent: string): boolean {
    return /\bexport\s+default\b/.test(targetContent);
  }

  protected validateImportStatementAgainstProject(
    sourceRelativePath: string,
    importStatement: string,
    options: { allowMissingRelative?: boolean } = {},
  ): string | null {
    const normalizedImport = importStatement.trim().replace(/;$/, "");
    if (!normalizedImport) return null;

    const match = normalizedImport.match(/^import\s+(.+?)\s+from\s+['"]([^'"]+)['"]$/);
    if (!match) return null;

    const clause = match[1];
    const specifier = match[2];
    const isProjectLocal =
      specifier.startsWith(".") || specifier.startsWith("@/") || this.isLikelyProjectAlias(specifier);
    if (!isProjectLocal) return null;

    const resolved = this.resolveImportTarget(sourceRelativePath, specifier);
    if (!resolved) {
      if (options.allowMissingRelative && specifier.startsWith(".")) return null;
      return `❌ 错误: 导入路径 \`${specifier}\` 在目标项目中无法解析。请优先复用真实存在的模块路径，不要臆造本地依赖。`;
    }

    try {
      const targetContent = fs.readFileSync(resolved, "utf-8");
      const analysis = analyzeCodeFile(resolved, targetContent);
      const importInfo = this.parseImportClause(clause);

      if (importInfo.defaultImport && !(analysis.hasDefaultExport || this.hasDefaultExport(targetContent))) {
        return `❌ 错误: 导入 \`${specifier}\` 时使用了默认导入 \`${importInfo.defaultImport}\`，但目标模块未发现明确的 default export。`;
      }

      for (const exportName of importInfo.namedImports) {
        if (!(analysis.namedExports.includes(exportName) || this.hasNamedExport(targetContent, exportName))) {
          return `❌ 错误: 导入 \`${specifier}\` 时引用了命名导出 \`${exportName}\`，但目标模块中未发现对应导出。`;
        }
      }
    } catch (error: any) {
      return `❌ 错误: 校验导入 \`${specifier}\` 时读取目标模块失败：${error.message}`;
    }

    return null;
  }

  protected getSiblingApiStyleContract(
    sourceRelativePath: string,
  ): { dominantImport: string; preferredExt: string; dominantLocalName: string } {
    const targetPath = this.resolveProjectFilePath(sourceRelativePath);
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      return { dominantImport: "", preferredExt: path.extname(sourceRelativePath), dominantLocalName: "" };
    }

    const importPatternCounts = new Map<string, number>();
    const importLocalNameCounts = new Map<string, Map<string, number>>();
    const extensionCounts = new Map<string, number>();
    const targetBasename = path.basename(sourceRelativePath);

    for (const entry of fs.readdirSync(targetDir)) {
      if (entry === targetBasename) continue;
      const ext = path.extname(entry);
      if (![".js", ".ts", ".tsx", ".jsx"].includes(ext)) continue;
      extensionCounts.set(ext, (extensionCounts.get(ext) || 0) + 1);

      try {
        const absolutePath = path.join(targetDir, entry);
        const content = fs.readFileSync(absolutePath, "utf-8");
        for (const match of content.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g)) {
          const localName = match[1];
          const specifier = match[2];
          if (specifier.startsWith("./")) {
            importPatternCounts.set(specifier, (importPatternCounts.get(specifier) || 0) + 1);
            const currentLocalNameCounts = importLocalNameCounts.get(specifier) || new Map<string, number>();
            currentLocalNameCounts.set(localName, (currentLocalNameCounts.get(localName) || 0) + 1);
            importLocalNameCounts.set(specifier, currentLocalNameCounts);
          }
        }
      } catch {
        // noop
      }
    }

    const dominantImport =
      Array.from(importPatternCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const dominantLocalName =
      Array.from(importLocalNameCounts.get(dominantImport)?.entries() || []).sort((a, b) => b[1] - a[1])[0]?.[0] ||
      "";
    const preferredExt =
      Array.from(extensionCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || path.extname(sourceRelativePath);

    return { dominantImport, preferredExt, dominantLocalName };
  }

  protected buildImportExample(specifier: string, localName: string): string {
    if (!specifier) return "";
    const effectiveLocalName = localName || "axios";
    return `例如 \`import ${effectiveLocalName} from '${specifier}'\``;
  }

  protected validateCreateFileAgainstProjectStyle(sourceRelativePath: string, content: string): string | null {
    const normalizedRelativePath = sourceRelativePath.replace(/\\/g, "/");
    const { dominantImport, preferredExt, dominantLocalName } = this.getSiblingApiStyleContract(normalizedRelativePath);
    const importExample = dominantImport ? this.buildImportExample(dominantImport, dominantLocalName) : "";
    const currentExt = path.extname(normalizedRelativePath);
    if (preferredExt && currentExt && preferredExt !== currentExt) {
      return `❌ 错误: 新建 API 文件扩展名为 \`${currentExt}\`，但同目录主流扩展名为 \`${preferredExt}\`。请保持与现有目录风格一致。`;
    }

    const importStatements = content.match(/^\s*import\s+.+?\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm) || [];
    for (const statement of importStatements) {
      const validationError = this.validateImportStatementAgainstProject(sourceRelativePath, statement, {
        allowMissingRelative: true,
      });
      if (validationError) {
        const importMatch = statement.trim().match(/^import\s+.+?\s+from\s+['"]([^'"]+)['"]\s*;?$/);
        const specifier = importMatch?.[1] || "";
        const isRequestLikeImport =
          /(request|axios|http|service)/i.test(specifier) || /(request|axios|http|service)/i.test(statement);
        if (dominantImport && /无法解析/.test(validationError) && isRequestLikeImport) {
          return `❌ 错误: 导入路径 \`${specifier}\` 在目标项目中无法解析。当前目录 API 主流请求封装为 \`${dominantImport}\`${importExample ? `，${importExample}` : ""}。请直接复用现有封装后重新 create_file，不要继续读取尚未创建的 ${path.basename(normalizedRelativePath)}。`;
        }
        return validationError;
      }
    }

    if (!/^src\/api\/.+\.(js|ts)$/.test(normalizedRelativePath)) return null;

    const analysis = analyzeCodeFile(normalizedRelativePath, content);
    const requestLikeImports = analysis.importSpecifiers.filter((item) => /(request|axios|http|service)/i.test(item));
    const usesDominantImport = dominantImport ? analysis.importSpecifiers.includes(dominantImport) : false;
    if (dominantImport && requestLikeImports.length > 0 && !usesDominantImport) {
      return `❌ 错误: 新建 API 文件使用了 \`${requestLikeImports.join("、")}\`，但同目录参考文件主流请求封装为 \`${dominantImport}\`${importExample ? `，${importExample}` : ""}。请直接复用现有封装，不要无中生有切换基础模块。`;
    }

    if (
      dominantImport &&
      dominantImport.startsWith("./") &&
      analysis.importSpecifiers.some((item) => item.startsWith("@/utils/") || item.startsWith("utils/"))
    ) {
      return `❌ 错误: 新建 API 文件引入了与同目录风格不一致的工具路径，但同目录主流请求封装为 \`${dominantImport}\`${importExample ? `，${importExample}` : ""}。请不要臆造 utils/request 一类基础模块。`;
    }

    return null;
  }

  protected shouldRunAstMutationGuard(rawPath: string): boolean {
    return /\.(vue|js|jsx|ts|tsx)$/i.test(String(rawPath || ""));
  }

  protected formatAstDiagnostics(rawPath: string, content: string): string {
    const analysis = analyzeCodeFile(rawPath, content);
    return analysis.diagnostics
      .slice(0, 2)
      .map((item) => `第 ${item.line} 行 ${item.message}`)
      .join("；");
  }

  protected validateMutationWithAstGuard(rawPath: string, beforeContent: string, afterContent: string): string | null {
    if (!isFeatureEnabled("ENABLE_AST_GATE")) return null;
    if (!this.shouldRunAstMutationGuard(rawPath)) return null;

    const before = analyzeCodeFile(rawPath, beforeContent);
    const after = analyzeCodeFile(rawPath, afterContent);
    if (after.diagnostics.length === 0) return null;
    if (before.diagnostics.length > 0 && after.diagnostics.length <= before.diagnostics.length) return null;

    return `❌ 错误: 本次写入会引入 AST/语法错误：${this.formatAstDiagnostics(rawPath, afterContent)}。请改用更小的结构化修改或修正逗号/括号/对象项边界后再重试。`;
  }

  protected validateNewContentWithAstGuard(rawPath: string, content: string): string | null {
    if (!isFeatureEnabled("ENABLE_AST_GATE")) return null;
    if (!this.shouldRunAstMutationGuard(rawPath)) return null;

    const analysis = analyzeCodeFile(rawPath, content);
    if (analysis.diagnostics.length === 0) return null;
    return `❌ 错误: 新内容未通过 AST/语法校验：${this.formatAstDiagnostics(rawPath, content)}。请修正代码结构后再写入。`;
  }

  protected trimBoundaryBlankLines(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && !lines[start].trim()) start++;
    while (end > start && !lines[end - 1].trim()) end--;
    return lines.slice(start, end);
  }

  protected normalizeCodeBlockLines(lines: string[]): string[] {
    const trimmedLines = this.trimBoundaryBlankLines(lines).map((line) => line.replace(/[ \t]+$/g, ""));
    const indents = trimmedLines
      .filter((line) => line.trim())
      .map((line) => (line.match(/^[\t ]*/) || [""])[0].replace(/\t/g, "  ").length);
    const minIndent = indents.length > 0 ? Math.min(...indents) : 0;

    return trimmedLines.map((line) => {
      if (!line.trim()) return "";
      let remaining = line;
      let removable = minIndent;
      while (removable > 0 && /^[\t ]/.test(remaining)) {
        const ch = remaining[0];
        remaining = remaining.slice(1);
        removable -= ch === "\t" ? 2 : 1;
      }
      return remaining;
    });
  }

  protected tryLooseSearchReplace(content: string, search: string, replace: string): string | null {
    if (!search.trim()) return null;

    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const rawContentLines = content.split(/\r?\n/);
    const rawSearchLines = search.split(/\r?\n/);
    const normalizedSearchLines = this.normalizeCodeBlockLines(rawSearchLines);
    const searchLineCount = normalizedSearchLines.length;
    if (searchLineCount === 0 || rawContentLines.length < searchLineCount) return null;

    const candidateIndexes: number[] = [];
    for (let i = 0; i <= rawContentLines.length - searchLineCount; i++) {
      const window = rawContentLines.slice(i, i + searchLineCount);
      const normalizedWindow = this.normalizeCodeBlockLines(window);
      if (normalizedWindow.length !== normalizedSearchLines.length) continue;
      if (normalizedWindow.every((line, idx) => line === normalizedSearchLines[idx])) {
        candidateIndexes.push(i);
        if (candidateIndexes.length > 1) return null;
      }
    }

    if (candidateIndexes.length !== 1) return null;

    const start = candidateIndexes[0];
    const replaceLines = replace.split(/\r?\n/);
    const nextLines = [
      ...rawContentLines.slice(0, start),
      ...replaceLines,
      ...rawContentLines.slice(start + searchLineCount),
    ];
    return nextLines.join(eol);
  }

  protected extractCodeSnippetFromToolResult(toolRes: string, maxChars: number = 2200): string {
    if (!toolRes || !/--- \[File:/.test(toolRes)) return "";
    const body = toolRes.replace(/^--- \[File:[\s\S]*?---\s*/m, "").trim();
    return summarizeText(body, maxChars);
  }

  protected buildSearchRetryInstruction(relativePath: string, snippet: string): string {
    const snippetBlock = snippet
      ? `\n以下是系统保留的最近精确代码片段，请从这里复制更小、更稳定、唯一的 SEARCH 锚点后立刻重试，不要再靠记忆拼接：\n\`\`\`\n${snippet}\n\`\`\`\n`
      : "\n系统当前没有新的精确代码片段可供参考，请改用更小、更唯一的 SEARCH 块，不要重复同一 patch。\n";

    return (
      `你已经进入编码强制收敛模式。禁止继续使用 filesystem:read_text_file、filesystem:list_directory、code-surgeon:get_file_outline 等扫描工具。\n` +
      `只允许两种行为：\n1. 最多一次 code-surgeon:read_file_lines 精确补读目标块\n2. 立即使用 internal_structured_edit 或 internal_surgical_edit 写入目标组件\n` +
      `当前问题文件：${relativePath}\n` +
      snippetBlock +
      "要求：必须写中核心组件，不允许只修改辅助文件就结束。完成真实写入后，必须立即输出最终 JSON 交付结果，不要再输出自由格式总结。"
    );
  }

  protected buildCreateFileRetryInstruction(relativePath: string, validationError: string): string {
    const normalizedError = validationError.replace(/^❌ 错误:\s*/, "").trim();
    return (
      `你已经进入新文件创建修复模式。目标文件 ${relativePath} 尚未创建成功，禁止继续对它调用 read_file_lines。\n` +
      `上一次 create_file 失败原因：${normalizedError}\n` +
      "下一步只允许两种行为：\n" +
      "1. 直接修正 content 后再次调用 internal_structured_edit(create_file)\n" +
      "2. 如必须改用 internal_surgical_edit，新建文件时必须将 search 设为空字符串\n" +
      "要求：不要重复提交相同 content；不要回读不存在的新文件；修复后立即完成真实写入。"
    );
  }

  protected buildEmptyResponseRecoveryInstruction(
    finishReasons: string[],
    effectiveToolNames: string[],
    missingWriteTargets: string[] = [],
  ): string {
    const finishLabel = finishReasons.length > 0 ? finishReasons.join(", ") : "unknown";
    const toolLabel = effectiveToolNames.length > 0 ? effectiveToolNames.join("、") : "无";
    const targetLabel = missingWriteTargets.length > 0
      ? missingWriteTargets.join("、")
      : this.requiredWriteTargets.length > 0
        ? this.requiredWriteTargets.join("、")
        : "当前核心目标";

    if (this.requiresWriteBeforeFinish()) {
      if (missingWriteTargets.length === 0) {
        return (
          `系统检测到你上一轮返回了空响应：没有 content、没有 reasoning、没有 tool_calls，finish_reason=${finishLabel}。\n` +
          `当前可用工具：${toolLabel}\n` +
          "关键目标文件已经完成真实写入。从这一轮开始，禁止再次沉默、禁止继续扫描文件、禁止继续发起重复修改。\n" +
          "你现在只允许输出最终 JSON 交付结果，必须包含 reasoning、files_to_create、files_to_modify、operations_executed、verification_points、validation_summary、completion_summary。"
        );
      }
      return (
        `系统检测到你上一轮返回了空响应：没有 content、没有 reasoning、没有 tool_calls，finish_reason=${finishLabel}。\n` +
        `当前可用工具：${toolLabel}\n` +
        `当前仍未完成真实写入的关键目标：${targetLabel}\n` +
        "从这一轮开始，禁止再次沉默、禁止直接 stop。\n" +
        "你现在只允许两种策略：\n" +
        "1. 如果现有上下文已经足够，立即调用 internal_structured_edit 或 internal_surgical_edit 写入目标文件。\n" +
        "2. 如果确实还差一个唯一锚点，只允许一次 code-surgeon:read_file_lines 精确补读 20-80 行局部片段，然后立刻写入。\n" +
        "注意：不要输出空白，不要只返回 role，不要重复道歉，必须产出真实动作。"
      );
    }

    return (
      `系统检测到你上一轮返回了空响应：没有 content、没有 reasoning、没有 tool_calls，finish_reason=${finishLabel}。\n` +
      `当前可用工具：${toolLabel}\n` +
      (effectiveToolNames.length === 0
        ? "当前阶段没有可用工具，从这一轮开始禁止再次沉默或直接 stop。你必须立即输出合法 JSON，不要输出空白，不要只返回 role。"
        : "从这一轮开始，禁止再次沉默或直接 stop。\n你必须二选一：\n1. 立即输出合法 JSON\n2. 立即发起真实工具调用\n注意：不要输出空白，不要只返回 role。")
    );
  }

  protected getEmptyResponseCircuitLimit(effectiveToolNames: string[] = []): number {
    if (this.requiresWriteBeforeFinish()) return 2;
    if (effectiveToolNames.length > 0) return 5;
    return 5;
  }

  protected getPreferredEol(content: string): string {
    return content.includes("\r\n") ? "\r\n" : "\n";
  }

  protected lineStartAt(content: string, index: number): number {
    const lineBreak = content.lastIndexOf("\n", Math.max(0, index - 1));
    return lineBreak === -1 ? 0 : lineBreak + 1;
  }

  protected lineIndentAt(content: string, index: number): string {
    const lineStart = this.lineStartAt(content, index);
    const linePrefix = content.slice(lineStart, index);
    return (linePrefix.match(/^[ \t]*/) || [""])[0];
  }

  protected indentBlock(content: string, indent: string): string {
    return this.trimBoundaryBlankLines(content.split(/\r?\n/))
      .map((line) => (line.trim() ? `${indent}${line.replace(/^[ \t]*/, "")}` : ""))
      .join("\n");
  }

  protected ensureCommaBeforeInsertion(content: string, insertAt: number): { content: string; insertAt: number } {
    let cursor = insertAt - 1;
    while (cursor >= 0 && /\s/.test(content[cursor])) cursor--;
    if (cursor < 0) return { content, insertAt };
    const prevChar = content[cursor];
    if (prevChar === "{" || prevChar === "[" || prevChar === ",") {
      return { content, insertAt };
    }
    const nextContent = `${content.slice(0, cursor + 1)},${content.slice(cursor + 1)}`;
    return {
      content: nextContent,
      insertAt: insertAt + 1,
    };
  }

  protected findMatchingBrace(source: string, openBraceIndex: number): number {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    for (let i = openBraceIndex; i < source.length; i++) {
      const ch = source[i];
      const next = source[i + 1];

      if (inLineComment) {
        if (ch === "\n") inLineComment = false;
        continue;
      }

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i++;
        }
        continue;
      }

      if (inSingle) {
        if (!escaped && ch === "'") inSingle = false;
        escaped = !escaped && ch === "\\";
        continue;
      }

      if (inDouble) {
        if (!escaped && ch === "\"") inDouble = false;
        escaped = !escaped && ch === "\\";
        continue;
      }

      if (inTemplate) {
        if (!escaped && ch === "`") inTemplate = false;
        escaped = !escaped && ch === "\\";
        continue;
      }

      if (ch === "/" && next === "/") {
        inLineComment = true;
        i++;
        continue;
      }

      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i++;
        continue;
      }

      if (ch === "'") {
        inSingle = true;
        escaped = false;
        continue;
      }

      if (ch === "\"") {
        inDouble = true;
        escaped = false;
        continue;
      }

      if (ch === "`") {
        inTemplate = true;
        escaped = false;
        continue;
      }

      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }

    return -1;
  }

  protected getScriptHost(content: string, rawPath: string): {
    host: string;
    offset: number;
    wrap: (nextHost: string) => string;
  } {
    if (!rawPath.endsWith(".vue")) {
      return {
        host: content,
        offset: 0,
        wrap: (nextHost: string) => nextHost,
      };
    }

    const scriptMatch = content.match(/<script\b[^>]*>/i);
    const endMatch = scriptMatch ? content.indexOf("</script>", (scriptMatch.index || 0) + scriptMatch[0].length) : -1;
    if (!scriptMatch || endMatch === -1) {
      return {
        host: content,
        offset: 0,
        wrap: (nextHost: string) => nextHost,
      };
    }

    const bodyStart = (scriptMatch.index || 0) + scriptMatch[0].length;
    const bodyEnd = endMatch;
    return {
      host: content.slice(bodyStart, bodyEnd),
      offset: bodyStart,
      wrap: (nextHost: string) => `${content.slice(0, bodyStart)}${nextHost}${content.slice(bodyEnd)}`,
    };
  }

  protected upsertImportStatement(content: string, rawPath: string, importStatement: string): { changed: boolean; content: string; message: string } {
    const normalizedImport = importStatement.trim().replace(/;$/, "");
    if (!normalizedImport) {
      return { changed: false, content, message: "❌ 错误: upsert_import 需要提供 import_statement。" };
    }
    const validationError = this.validateImportStatementAgainstProject(rawPath, normalizedImport);
    if (validationError) {
      return { changed: false, content, message: validationError };
    }

    const { host, wrap } = this.getScriptHost(content, rawPath);
    if (host.includes(normalizedImport)) {
      return { changed: false, content, message: "✅ 导入已存在，无需重复写入。" };
    }

    const eol = this.getPreferredEol(content);
    const lines = host.split(/\r?\n/);
    let lastImportLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*import\b/.test(lines[i])) lastImportLine = i;
    }

    let nextHost = host;
    if (lastImportLine >= 0) {
      lines.splice(lastImportLine + 1, 0, normalizedImport);
      nextHost = lines.join(eol);
    } else {
      nextHost = `${normalizedImport}${eol}${host.replace(/^\n+/, "")}`;
    }

    return {
      changed: true,
      content: wrap(nextHost),
      message: "✅ 结构化导入写入成功。",
    };
  }

  protected insertByAnchor(content: string, anchor: string, insertContent: string, mode: "before" | "after"): { changed: boolean; content: string; message: string } {
    const trimmedInsert = insertContent.trim();
    if (!anchor || !trimmedInsert) {
      return { changed: false, content, message: "❌ 错误: insert_*_anchor 需要同时提供 anchor 和 content。" };
    }
    const eol = this.getPreferredEol(content);
    const normalizedAnchor = anchor.replace(/\r?\n/g, eol);
    let normalizedInsert = trimmedInsert.includes("\n")
      ? trimmedInsert.replace(/\r?\n/g, eol)
      : trimmedInsert;
    if (mode === "after" && normalizedInsert.startsWith(normalizedAnchor)) {
      normalizedInsert = normalizedInsert.slice(normalizedAnchor.length);
      if (normalizedInsert.startsWith(eol)) normalizedInsert = normalizedInsert.slice(eol.length);
    }
    if (mode === "before" && normalizedInsert.endsWith(normalizedAnchor)) {
      normalizedInsert = normalizedInsert.slice(0, normalizedInsert.length - normalizedAnchor.length);
      if (normalizedInsert.endsWith(eol)) normalizedInsert = normalizedInsert.slice(0, -eol.length);
    }
    normalizedInsert = normalizedInsert.trim();
    if (!normalizedInsert) {
      return { changed: false, content, message: "✅ 结构化插入内容已被锚点去重，未检测到新增内容。" };
    }
    if (content.includes(normalizedInsert)) {
      return { changed: false, content, message: "✅ 目标内容已存在，无需重复插入。" };
    }

    const anchorIndex = content.indexOf(anchor);
    if (anchorIndex === -1) {
      return { changed: false, content, message: "❌ 错误: 未找到指定 anchor，无法执行结构化插入。" };
    }

    const insertAt = mode === "before" ? anchorIndex : anchorIndex + anchor.length;
    const prefix = content.slice(0, insertAt);
    const suffix = content.slice(insertAt);
    const needsLeadingBreak = prefix.length > 0 && !prefix.endsWith("\n");
    const needsTrailingBreak = suffix.length > 0 && !suffix.startsWith("\n");

    return {
      changed: true,
      content:
        `${prefix}${needsLeadingBreak ? eol : ""}${normalizedInsert}${needsTrailingBreak ? eol : ""}${suffix}`,
      message: "✅ 结构化锚点插入成功。",
    };
  }

  protected ensureVueOptionEntry(
    content: string,
    rawPath: string,
    section: string,
    entryKey: string,
    entryContent: string,
  ): { changed: boolean; content: string; message: string } {
    const trimmedEntry = entryContent.trim();
    if (!section || !entryKey || !trimmedEntry) {
      return { changed: false, content, message: "❌ 错误: ensure_vue_option_entry 需要提供 section、entry_key 和 content。" };
    }

    const { host, wrap } = this.getScriptHost(content, rawPath);
    const eol = this.getPreferredEol(content);

    if (section === "root") {
      const exportMatch = host.match(/export\s+default\s*\{/);
      if (!exportMatch || exportMatch.index === undefined) {
        return { changed: false, content, message: "❌ 错误: 未找到 export default 对象，无法写入根级选项。" };
      }
      const exportOpen = host.indexOf("{", exportMatch.index);
      const exportClose = this.findMatchingBrace(host, exportOpen);
      if (exportClose === -1) {
        return { changed: false, content, message: "❌ 错误: export default 结构异常，无法写入根级选项。" };
      }
      const exportBody = host.slice(exportOpen + 1, exportClose);
      const duplicatePattern = new RegExp(`\\b${this.escapeRegex(entryKey)}\\s*(\\(|:)`);
      if (duplicatePattern.test(exportBody)) {
        return { changed: false, content, message: `✅ 根级选项 ${entryKey} 已存在，无需重复写入。` };
      }

      const insertAt = this.lineStartAt(host, exportClose);
      const closingIndent = this.lineIndentAt(host, exportClose);
      const entryIndent = `${closingIndent}  `;
      const ensured = this.ensureCommaBeforeInsertion(host, insertAt);
      const nextHost =
        `${ensured.content.slice(0, ensured.insertAt)}${this.indentBlock(trimmedEntry, entryIndent).replace(/\n/g, eol)}${eol}${ensured.content.slice(ensured.insertAt)}`;
      return {
        changed: true,
        content: wrap(nextHost),
        message: `✅ 根级选项 ${entryKey} 写入成功。`,
      };
    }

    if (section === "data") {
      const dataMatch = host.match(/data\s*\(\)\s*\{/);
      if (!dataMatch || dataMatch.index === undefined) {
        return { changed: false, content, message: "❌ 错误: 未找到 data() 区域，无法插入数据项。" };
      }
      const dataOpen = host.indexOf("{", dataMatch.index);
      const dataClose = this.findMatchingBrace(host, dataOpen);
      if (dataClose === -1) {
        return { changed: false, content, message: "❌ 错误: data() 代码块结构异常，无法解析。" };
      }
      const dataBody = host.slice(dataOpen + 1, dataClose);
      const returnMatch = dataBody.match(/return\s*\{/);
      if (!returnMatch || returnMatch.index === undefined) {
        return { changed: false, content, message: "❌ 错误: data() 中未找到 return 对象，无法插入数据项。" };
      }
      const returnObjectOpen = host.indexOf("{", dataOpen + 1 + returnMatch.index);
      const returnObjectClose = this.findMatchingBrace(host, returnObjectOpen);
      if (returnObjectClose === -1) {
        return { changed: false, content, message: "❌ 错误: data() 返回对象结构异常，无法解析。" };
      }
      const returnObjectBody = host.slice(returnObjectOpen + 1, returnObjectClose);
      if (new RegExp(`\\b${entryKey}\\s*:`).test(returnObjectBody)) {
        return { changed: false, content, message: "✅ data() 中已存在该字段，无需重复写入。" };
      }

      const insertAt = this.lineStartAt(host, returnObjectClose);
      const closingIndent = this.lineIndentAt(host, returnObjectClose);
      const entryIndent = `${closingIndent}  `;
      let ensured = this.ensureCommaBeforeInsertion(host, insertAt);
      const nextHost =
        `${ensured.content.slice(0, ensured.insertAt)}${this.indentBlock(trimmedEntry, entryIndent).replace(/\n/g, eol)}${eol}${ensured.content.slice(ensured.insertAt)}`;
      return {
        changed: true,
        content: wrap(nextHost),
        message: "✅ data() 结构化字段写入成功。",
      };
    }

    const sectionRegex = new RegExp(`(^|\\n)([ \\t]*)${section}\\s*:\\s*\\{`, "m");
    const sectionMatch = sectionRegex.exec(host);
    const duplicatePattern =
      section === "methods" || section === "computed" || section === "watch"
        ? new RegExp(`\\b${entryKey}\\s*\\(`)
        : new RegExp(`\\b${entryKey}\\s*:`);

    if (sectionMatch && sectionMatch.index !== undefined) {
      const sectionOpen = host.indexOf("{", sectionMatch.index);
      const sectionClose = this.findMatchingBrace(host, sectionOpen);
      if (sectionClose === -1) {
        return { changed: false, content, message: "❌ 错误: 目标 option 区域结构异常，无法解析。" };
      }
      const sectionBody = host.slice(sectionOpen + 1, sectionClose);
      if (duplicatePattern.test(sectionBody)) {
        return { changed: false, content, message: `✅ ${section} 中已存在该条目，无需重复写入。` };
      }

      const insertAt = this.lineStartAt(host, sectionClose);
      const closingIndent = this.lineIndentAt(host, sectionClose);
      const entryIndent = `${closingIndent}  `;
      let ensured = this.ensureCommaBeforeInsertion(host, insertAt);
      const nextHost =
        `${ensured.content.slice(0, ensured.insertAt)}${this.indentBlock(trimmedEntry, entryIndent).replace(/\n/g, eol)}${eol}${ensured.content.slice(ensured.insertAt)}`;
      return {
        changed: true,
        content: wrap(nextHost),
        message: `✅ ${section} 结构化条目写入成功。`,
      };
    }

    const exportMatch = host.match(/export\s+default\s*\{/);
    if (!exportMatch || exportMatch.index === undefined) {
      return { changed: false, content, message: "❌ 错误: 未找到 export default 对象，无法创建目标 option 区域。" };
    }
    const exportOpen = host.indexOf("{", exportMatch.index);
    const exportClose = this.findMatchingBrace(host, exportOpen);
    if (exportClose === -1) {
      return { changed: false, content, message: "❌ 错误: export default 结构异常，无法创建目标 option 区域。" };
    }

    const insertAt = this.lineStartAt(host, exportClose);
    const closingIndent = this.lineIndentAt(host, exportClose);
    const sectionIndent = `${closingIndent}  `;
    const entryIndent = `${sectionIndent}  `;
    const sectionBlock = [
      `${sectionIndent}${section}: {`,
      this.indentBlock(trimmedEntry, entryIndent),
      `${sectionIndent}},`,
    ].join(eol);
    let ensured = this.ensureCommaBeforeInsertion(host, insertAt);
    const nextHost = `${ensured.content.slice(0, ensured.insertAt)}${sectionBlock}${eol}${ensured.content.slice(ensured.insertAt)}`;
    return {
      changed: true,
      content: wrap(nextHost),
      message: `✅ 已创建 ${section} 区域并写入条目。`,
    };
  }

  protected ensureExportStatement(
    content: string,
    rawPath: string,
    exportStatement: string,
  ): { changed: boolean; content: string; message: string } {
    const normalized = exportStatement.trim();
    if (!normalized) {
      return { changed: false, content, message: "❌ 错误: ensure_export 需要提供 content/export_statement。" };
    }

    const { host, wrap } = this.getScriptHost(content, rawPath);
    if (host.includes(normalized)) {
      return { changed: false, content, message: "✅ 导出语句已存在，无需重复写入。" };
    }

    const eol = this.getPreferredEol(content);
    const exportDefaultIndex = host.indexOf("export default");
    const insertAt = exportDefaultIndex >= 0 ? this.lineStartAt(host, exportDefaultIndex) : host.length;
    const prefix = host.slice(0, insertAt);
    const suffix = host.slice(insertAt);
    const needsLeadingBreak = prefix.length > 0 && !prefix.endsWith("\n");
    const needsTrailingBreak = suffix.length > 0 && !suffix.startsWith("\n");
    const nextHost = `${prefix}${needsLeadingBreak ? eol : ""}${normalized}${needsTrailingBreak ? eol : ""}${suffix}`;

    return {
      changed: true,
      content: wrap(nextHost),
      message: "✅ 导出语句写入成功。",
    };
  }

  protected replaceRangeByLines(
    content: string,
    startLine: number,
    endLine: number,
    replacement: string,
  ): { changed: boolean; content: string; message: string } {
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine <= 0 || endLine < startLine) {
      return { changed: false, content, message: "❌ 错误: replace_range_by_lines 需要合法的 start_line / end_line。" };
    }

    const eol = this.getPreferredEol(content);
    const lines = content.split(/\r?\n/);
    if (endLine > lines.length) {
      return { changed: false, content, message: "❌ 错误: replace_range_by_lines 超出文件总行数。" };
    }

    const replacementLines = replacement.replace(/\r?\n/g, eol).split(/\r?\n/);
    lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
    return {
      changed: true,
      content: lines.join(eol),
      message: "✅ 行区间替换成功。",
    };
  }

  protected updateObjectProperty(
    content: string,
    rawPath: string,
    objectName: string,
    propertyKey: string,
    propertyContent: string,
  ): { changed: boolean; content: string; message: string } {
    const trimmedObjectName = objectName.trim();
    const trimmedPropertyKey = propertyKey.trim();
    const trimmedContent = propertyContent.trim();
    if (!trimmedObjectName || !trimmedPropertyKey || !trimmedContent) {
      return { changed: false, content, message: "❌ 错误: update_object_property 需要 object_name、property_key 和 content。" };
    }

    const { host, wrap } = this.getScriptHost(content, rawPath);
    const objectPattern = new RegExp(`\\b${trimmedObjectName}\\s*:\\s*\\{`);
    const objectMatch = objectPattern.exec(host);
    if (!objectMatch || objectMatch.index === undefined) {
      return { changed: false, content, message: `❌ 错误: 未找到对象 ${trimmedObjectName}，无法更新属性。` };
    }

    const openIndex = host.indexOf("{", objectMatch.index);
    const closeIndex = this.findMatchingBrace(host, openIndex);
    if (closeIndex === -1) {
      return { changed: false, content, message: `❌ 错误: 对象 ${trimmedObjectName} 结构异常，无法解析。` };
    }

    const objectBody = host.slice(openIndex + 1, closeIndex);
    const propertyPattern = new RegExp(`(^|\\n)([ \\t]*)${this.escapeRegex(trimmedPropertyKey)}\\s*:`, "m");
    if (propertyPattern.test(objectBody)) {
      return { changed: false, content, message: `✅ ${trimmedObjectName}.${trimmedPropertyKey} 已存在，无需重复写入。` };
    }

    const insertAt = this.lineStartAt(host, closeIndex);
    const closingIndent = this.lineIndentAt(host, closeIndex);
    const entryIndent = `${closingIndent}  `;
    const ensured = this.ensureCommaBeforeInsertion(host, insertAt);
    const nextHost =
      `${ensured.content.slice(0, ensured.insertAt)}${this.indentBlock(trimmedContent, entryIndent).replace(/\n/g, this.getPreferredEol(content))}${this.getPreferredEol(content)}${ensured.content.slice(ensured.insertAt)}`;
    return {
      changed: true,
      content: wrap(nextHost),
      message: `✅ ${trimmedObjectName}.${trimmedPropertyKey} 写入成功。`,
    };
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

	    const internalTools: Array<{
      name: string;
      description: string;
      inputSchema: any;
    }> = [
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

    if (isFeatureEnabled("ENABLE_STRUCTURED_EDIT")) {
      internalTools.unshift({
        name: "internal_structured_edit",
        description:
          "结构化代码编辑工具。适合处理 create_file、导入补齐、按锚点插入、Vue data/methods/computed/watch/components 条目写入，能减少 SEARCH 精确匹配失败。",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "待修改文件的相对路径（例如 src/views/Home.vue）",
            },
            operation: {
              type: "string",
              enum: [
                "create_file",
                "upsert_import",
                "ensure_export",
                "insert_before_anchor",
                "insert_after_anchor",
                "ensure_vue_option_entry",
                "replace_range_by_lines",
                "update_object_property",
              ],
            },
            content: {
              type: "string",
              description: "要写入的内容或条目代码。",
            },
            anchor: {
              type: "string",
              description: "用于 before/after 插入的文本锚点。",
            },
            import_statement: {
              type: "string",
              description: "要补齐的 import 语句。",
            },
            export_statement: {
              type: "string",
              description: "要确保存在的 export 语句；未提供时回退使用 content。",
            },
            section: {
              type: "string",
              enum: ["data", "methods", "computed", "watch", "components", "root"],
            },
            entry_key: {
              type: "string",
              description: "Vue option 条目的唯一键，用于去重。",
            },
            start_line: {
              type: "integer",
              description: "用于 replace_range_by_lines 的起始行号（1-based）。",
            },
            end_line: {
              type: "integer",
              description: "用于 replace_range_by_lines 的结束行号（1-based）。",
            },
            object_name: {
              type: "string",
              description: "用于 update_object_property 的对象名，例如 filters、permissions、config。",
            },
            property_key: {
              type: "string",
              description: "用于 update_object_property 的属性键名。",
            },
          },
          required: ["path", "operation"],
        },
      });
    }

    // 🚀 强制汉化指令增强 (Systemic Hardening)
    if (currentMessages[0] && currentMessages[0].role === 'system') {
      currentMessages[0].content += "\n\n**重要语言要求**: 请始终使用中文进行 Reasoning (思考) 和最终回复。";
    }

    let tools: any[] | undefined = undefined;
	        const shouldIncludeInternal =
	      toolPattern.includes("*") ||
	      toolPattern.includes("internal_surgical_edit") ||
        toolPattern.includes("internal_structured_edit");
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
	            t.function.name === "internal_structured_edit" ||
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
    let consecutiveEmptyResponseCount = 0;
    let consecutiveReasoningOnlyCount = 0;
    let lastReasoningOnlySignature = "";
    let chineseReasoningRewriteAttempts = 0;
    let successfulWriteCount = 0;
    const successfulWritePaths = new Set<string>();
    const successfulCreatePaths = new Set<string>();
    const successfulModifyPaths = new Set<string>();
    const pendingCreateFailures = new Map<string, string>();
    let forceConclusionMode = false;
    let forceConclusionReason = "";
    let forceWriteMode = false;
    let forceWriteReason = "";
    let forceEditOnlyMode = false;
    let forceWriteRecoveryReads = 0;
    const recentExactReadSnippets = new Map<string, string>();
    const searchMissCounts = new Map<string, number>();

    for (let round = 0; round < roundLimit; round++) {
      if (this.signal?.aborted) throw new Error("AbortError: 任务已手动停止");
      this.log(`Round ${round}: Calling streaming API...`);
      let fullContent = "";
      let fullReasoning = "";
      const toolCalls: any[] = [];
      let thoughtBuffer = "";
      let didStreamThought = false;
      const finishReasons = new Set<string>();
      let roleOnlyChunkCount = 0;
      let contentChunkCount = 0;
      let reasoningChunkCount = 0;
      let toolCallChunkCount = 0;
      let parsedEventCount = 0;

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
                    t.function.name === "internal_structured_edit" ||
	                  t.function.name === "internal_surgical_edit" ||
                    (!forceEditOnlyMode &&
                      !this.hasSatisfiedRequiredWrites(successfulWritePaths) &&
                      t.function.name.includes("read_file_lines")),
              )
            : getEffectiveTools(tools, consecutiveFailureCount);
        currentMessages = this.contextManager.compressMessages(
          currentMessages,
          round,
          this.getPhaseIndex(),
          DISPLAY_PHASES,
        );
        const promptBudget = this.getPromptCharacterBudget();
        if (promptBudget) {
          currentMessages = this.contextManager.enforceCharacterBudget(currentMessages, promptBudget);
        }
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
          toolNames: (effectiveTools || [])
            .map((tool) => tool?.function?.name || "")
            .filter(Boolean)
            .slice(0, 8),
          failureCount: consecutiveFailureCount,
          forceConclusionMode,
          forceWriteMode,
          forceEditOnlyMode,
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
              const finishReason = data.choices?.[0]?.finish_reason;
              if (finishReason) finishReasons.add(String(finishReason));
              const delta = data.choices?.[0]?.delta || data.choices?.[0]?.message || data;
              const r = delta.reasoning_content || delta.reasoning || delta.thought || "";
              const c = delta.content || delta.text || "";
              const hasToolDelta = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
              parsedEventCount++;

              if (r) {
                reasoningChunkCount++;
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
                contentChunkCount++;
                fullContent += c;
              }

              if (delta.tool_calls) {
                toolCallChunkCount++;
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

              if (delta.role && !r && !c && !hasToolDelta) {
                roleOnlyChunkCount++;
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
          consecutiveEmptyResponseCount = 0;
          consecutiveFailureCount = 0;
          consecutiveReasoningOnlyCount = 0;
          lastReasoningOnlySignature = "";
          if (!forceWriteMode || !this.hasSatisfiedRequiredWrites(successfulWritePaths)) {
            forceEditOnlyMode = false;
          }
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
          let sawNoopEditThisRound = false;
          let forceWriteInstruction = "";

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
            let resolvedArgPath: string | null = null;
            if (typeof args?.path === "string" && args.path) {
              try {
                resolvedArgPath = this.resolveProjectFilePath(String(args.path));
              } catch {
                resolvedArgPath = null;
              }
            }
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
	              !(fullName === "internal_structured_edit" || fullName === "internal_surgical_edit" || fullName === "surgical_edit" || fullName.includes("read_file_lines"))
	            ) {
              toolRes = "❌ 错误: 已进入编码强制收敛模式。禁止继续使用该工具，只允许一次精确补读后立即执行 internal_structured_edit 或 internal_surgical_edit。";
            } else if (
              forceWriteMode &&
              fullName.includes("read_file_lines") &&
              ++forceWriteRecoveryReads > 1
            ) {
              toolRes = "❌ 错误: 编码强制收敛模式下，补读次数已达上限。禁止继续读取，请立即调用 internal_structured_edit 或 internal_surgical_edit 写入目标文件。";
            } else if (
              fullName.includes("read_file_lines") &&
              resolvedArgPath &&
              !fs.existsSync(resolvedArgPath)
            ) {
              const relativeMissingPath =
                path.relative(this.config.projectPath!, resolvedArgPath) || path.basename(resolvedArgPath);
              const pendingCreateError = pendingCreateFailures.get(resolvedArgPath);
              toolRes = pendingCreateError
                ? `❌ 错误: 目标文件 \`${relativeMissingPath}\` 尚未创建，禁止读取不存在的新文件。上一次 create_file 失败原因：${pendingCreateError.replace(/^❌ 错误:\s*/, "")}。请直接修正 content 后再次调用 internal_structured_edit(create_file)，不要继续 read_file_lines。`
                : `❌ 错误: 目标文件 \`${relativeMissingPath}\` 尚未创建，无法读取。若要新建文件，请直接调用 internal_structured_edit(create_file) 或 internal_surgical_edit（search 为空字符串）。`;
              if (this.constructor.name === "CoderAgent") {
                forceWriteMode = true;
                forceWriteReason = `新文件 ${relativeMissingPath} 尚未创建成功，必须停止回读不存在文件并直接修正创建内容。`;
                forceWriteInstruction = this.buildCreateFileRetryInstruction(
                  relativeMissingPath,
                  pendingCreateError || toolRes,
                );
                forceWriteRecoveryReads = 0;
                triggeredForceWriteThisRound = true;
              }
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
	            } else if (fullName === "internal_structured_edit") {
                if (!isFeatureEnabled("ENABLE_STRUCTURED_EDIT")) {
                  toolRes = "❌ 错误: 当前环境已关闭 internal_structured_edit，请改用 internal_surgical_edit。";
                  currentMessages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolRes });
                  continue;
                }
                try {
                  if (onThought) onThought(`⚙️ 正在对 ${path.basename(args.path)} 执行结构化修改...`);
                  const rawTargetPath = String(args.path || "");
                  const targetPath = this.resolveProjectFilePath(rawTargetPath);
                  const operation = String(args.operation || "");
                  const targetExists = fs.existsSync(targetPath);

                  if (operation === "create_file") {
                    const createContent = String(args.content || "");
                    const relativeTargetPath =
                      path.relative(this.config.projectPath!, targetPath) || path.basename(targetPath);

                    if (!createContent.trim()) {
                      toolRes = `❌ 错误: create_file 必须提供非空 content，禁止创建空文件 (${relativeTargetPath})。`;
                      if (this.constructor.name === "CoderAgent") {
                        pendingCreateFailures.set(targetPath, toolRes);
                        forceWriteMode = true;
                        forceWriteReason = `新建文件 ${relativeTargetPath} 缺少内容，必须立即补齐后再创建。`;
                        forceWriteInstruction = this.buildCreateFileRetryInstruction(relativeTargetPath, toolRes);
                        forceWriteRecoveryReads = 0;
                        triggeredForceWriteThisRound = true;
                      }
            this.traceRound({
              type: "tool_result",
              round,
              tool: fullName,
                        success: false,
                        responseChars: toolRes.length,
                        responsePreview: summarizeText(toolRes, 180),
                      });
                      currentMessages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolRes });
                      continue;
                    }

                    if (targetExists) {
                      const existingContent = fs.readFileSync(targetPath, "utf-8");
                      const existingTrimmed = existingContent.trim();
                      if (!existingTrimmed) {
                        const validationError = this.validateCreateFileAgainstProjectStyle(rawTargetPath, createContent);
                        if (validationError) {
                          pendingCreateFailures.set(targetPath, validationError);
                          if (this.constructor.name === "CoderAgent") {
                            forceWriteMode = true;
                            forceWriteReason = `空文件 ${relativeTargetPath} 补写失败，需要修正 content 后立即重试。`;
                            forceWriteInstruction = this.buildCreateFileRetryInstruction(relativeTargetPath, validationError);
                            forceWriteRecoveryReads = 0;
                            triggeredForceWriteThisRound = true;
                          }
                          toolRes = validationError;
                          this.traceRound({
                            type: "tool_result",
                            round,
                            tool: fullName,
                            success: false,
                            responseChars: toolRes.length,
                            responsePreview: summarizeText(toolRes, 180),
                          });
                          currentMessages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolRes });
                          continue;
                        }
                        const astValidationError = this.validateNewContentWithAstGuard(rawTargetPath, createContent);
                        if (astValidationError) {
                          pendingCreateFailures.set(targetPath, astValidationError);
                          if (this.constructor.name === "CoderAgent") {
                            forceWriteMode = true;
                            forceWriteReason = `空文件 ${relativeTargetPath} 未通过语法校验，需要修正 content 后立即重试。`;
                            forceWriteInstruction = this.buildCreateFileRetryInstruction(relativeTargetPath, astValidationError);
                            forceWriteRecoveryReads = 0;
                            triggeredForceWriteThisRound = true;
                          }
                          toolRes = astValidationError;
                          this.traceRound({
                            type: "tool_result",
                            round,
                            tool: fullName,
                            success: false,
                            responseChars: toolRes.length,
                            responsePreview: summarizeText(toolRes, 180),
                          });
                          currentMessages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolRes });
                          continue;
                        }
                        fs.writeFileSync(targetPath, createContent, "utf-8");
                        pendingCreateFailures.delete(targetPath);
                        toolRes = `✅ 空文件内容补写成功: ${relativeTargetPath}`;
                        writeKind = "modify";
                      } else if (existingContent === createContent) {
                        pendingCreateFailures.delete(targetPath);
                        toolRes = "ℹ️ 文件内容已存在，无需重复创建。";
                      } else {
                        toolRes = `❌ 错误: 目标文件 \`${relativeTargetPath}\` 已存在且已有内容，create_file 不允许覆盖。请改用 internal_structured_edit 的其他操作或 internal_surgical_edit 精确修改。`;
                        if (this.constructor.name === "CoderAgent") {
                          forceWriteMode = true;
                          forceWriteReason = `文件 ${relativeTargetPath} 已存在，必须停止重复 create_file，改为精确修改。`;
                          forceWriteInstruction = this.buildSearchRetryInstruction(relativeTargetPath, summarizeText(existingContent, 1200));
                          forceWriteRecoveryReads = 0;
                          triggeredForceWriteThisRound = true;
                        }
                      }
                    } else {
                      const validationError = this.validateCreateFileAgainstProjectStyle(rawTargetPath, createContent);
                      if (validationError) {
                        pendingCreateFailures.set(targetPath, validationError);
                        if (this.constructor.name === "CoderAgent") {
                          forceWriteMode = true;
                          forceWriteReason = `新建文件 ${relativeTargetPath} 失败，需要修正 content 后立即重试创建。`;
                          forceWriteInstruction = this.buildCreateFileRetryInstruction(relativeTargetPath, validationError);
                          forceWriteRecoveryReads = 0;
                          triggeredForceWriteThisRound = true;
                        }
                        toolRes = validationError;
                        this.traceRound({
                          type: "tool_result",
                          round,
                          tool: fullName,
                          success: false,
                          responseChars: toolRes.length,
                          responsePreview: summarizeText(toolRes, 180),
                        });
                        currentMessages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolRes });
                        continue;
                      }
                      const astValidationError = this.validateNewContentWithAstGuard(rawTargetPath, createContent);
                      if (astValidationError) {
                        pendingCreateFailures.set(targetPath, astValidationError);
                        if (this.constructor.name === "CoderAgent") {
                          forceWriteMode = true;
                          forceWriteReason = `新建文件 ${relativeTargetPath} 未通过语法校验，需要修正 content 后立即重试创建。`;
                          forceWriteInstruction = this.buildCreateFileRetryInstruction(relativeTargetPath, astValidationError);
                          forceWriteRecoveryReads = 0;
                          triggeredForceWriteThisRound = true;
                        }
                        toolRes = astValidationError;
                        this.traceRound({
                          type: "tool_result",
                          round,
                          tool: fullName,
                          success: false,
                          responseChars: toolRes.length,
                          responsePreview: summarizeText(toolRes, 180),
                        });
                        currentMessages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolRes });
                        continue;
                      }
                      const dir = path.dirname(targetPath);
                      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                      fs.writeFileSync(targetPath, createContent, "utf-8");
                      pendingCreateFailures.delete(targetPath);
                      toolRes = `✅ 文件创建成功: ${path.relative(this.config.projectPath!, targetPath)}`;
                      writeKind = "create";
                    }
                  } else {
                    if (!targetExists) {
                      toolRes = "❌ 错误: 目标文件不存在，结构化编辑无法执行。若要新建文件请使用 create_file。";
                    } else {
                      const original = fs.readFileSync(targetPath, "utf-8");
                      let result:
                        | { changed: boolean; content: string; message: string }
                        | null = null;

                      if (operation === "upsert_import") {
                        result = this.upsertImportStatement(original, rawTargetPath, String(args.import_statement || ""));
                      } else if (operation === "ensure_export") {
                        result = this.ensureExportStatement(
                          original,
                          rawTargetPath,
                          String(args.export_statement || args.content || ""),
                        );
                      } else if (operation === "insert_before_anchor") {
                        result = this.insertByAnchor(original, String(args.anchor || ""), String(args.content || ""), "before");
                      } else if (operation === "insert_after_anchor") {
                        result = this.insertByAnchor(original, String(args.anchor || ""), String(args.content || ""), "after");
                      } else if (operation === "ensure_vue_option_entry") {
                        result = this.ensureVueOptionEntry(
                          original,
                          rawTargetPath,
                          String(args.section || ""),
                          String(args.entry_key || ""),
                          String(args.content || ""),
                        );
                      } else if (operation === "replace_range_by_lines") {
                        result = this.replaceRangeByLines(
                          original,
                          Number(args.start_line),
                          Number(args.end_line),
                          String(args.content || ""),
                        );
                      } else if (operation === "update_object_property") {
                        result = this.updateObjectProperty(
                          original,
                          rawTargetPath,
                          String(args.object_name || ""),
                          String(args.property_key || ""),
                          String(args.content || ""),
                        );
                      } else {
                        toolRes = `❌ 错误: 不支持的结构化操作 ${operation}。`;
                      }

                      if (result) {
                        if (result.changed) {
                          const astValidationError = this.validateMutationWithAstGuard(rawTargetPath, original, result.content);
                          if (astValidationError) {
                            toolRes = astValidationError;
                            currentMessages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolRes });
                            continue;
                          }
                          fs.writeFileSync(targetPath, result.content, "utf-8");
                          toolRes = `${result.message} (${path.relative(this.config.projectPath!, targetPath)})`;
                          writeKind = "modify";
                        } else {
                          toolRes = result.message;
                        }
                      }
                    }
                  }
                } catch (err: any) {
                  toolRes = `❌ 执行失败: ${err.message}`;
                }
              } else if (fullName === "internal_surgical_edit" || fullName === "surgical_edit") {
	              try {
	                if (onThought) onThought(`⚙️ 正在对 ${path.basename(args.path)} 执行修改手术...`);
	                const rawTargetPath = String(args.path || "");
	                const targetPath = this.resolveProjectFilePath(rawTargetPath);
	                const search = args.search || "";
                const replace = args.replace || "";
                const mismatchSignature = `${targetPath}:${this.normalizeLoopSignature(search)}`;

                if (forceWriteMode && search && (searchMissCounts.get(mismatchSignature) || 0) >= 2) {
                  toolRes = "❌ 错误: 该 SEARCH 块已失败多次，禁止继续重复同类手术。请改用 internal_structured_edit（优先 replace_range_by_lines / ensure_vue_option_entry / upsert_import），或只做一次精确补读后使用更小的唯一锚点。";
                } else if (!fs.existsSync(targetPath)) {
                  if (search === "") {
                    const astValidationError = this.validateNewContentWithAstGuard(rawTargetPath, replace);
                    if (astValidationError) {
                      pendingCreateFailures.set(targetPath, astValidationError);
                      toolRes = astValidationError;
                    } else {
                    const dir = path.dirname(targetPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(targetPath, replace, "utf-8");
                    pendingCreateFailures.delete(targetPath);
                    toolRes = `✅ 文件创建成功: ${path.relative(this.config.projectPath!, targetPath)}`;
                    writeKind = "create";
                    }
                  } else {
                    toolRes = `❌ 错误: 目标文件不存在。如果是要新建文件，请将 search 参数设为空字符串。`;
                  }
                } else {
                  const content = fs.readFileSync(targetPath, "utf8");
	                  if (content.includes(search)) {
                      const nextContent = content.replace(search, replace);
                      const astValidationError = this.validateMutationWithAstGuard(rawTargetPath, content, nextContent);
                      if (astValidationError) {
                        toolRes = astValidationError;
                      } else {
	                    fs.writeFileSync(targetPath, nextContent, "utf-8");
	                    toolRes = `✅ 代码修改成功: ${path.relative(this.config.projectPath!, targetPath)}`;
	                    writeKind = "modify";
                      }
	                  } else {
                      const looseReplaced = this.tryLooseSearchReplace(content, search, replace);
                      if (looseReplaced !== null) {
                        const astValidationError = this.validateMutationWithAstGuard(rawTargetPath, content, looseReplaced);
                        if (astValidationError) {
                          toolRes = astValidationError;
                        } else {
                          fs.writeFileSync(targetPath, looseReplaced, "utf-8");
                          toolRes = `✅ 代码修改成功: ${path.relative(this.config.projectPath!, targetPath)}（宽松匹配已对齐缩进/空白差异）`;
                          writeKind = "modify";
                        }
                      } else {
                        const missCount = (searchMissCounts.get(mismatchSignature) || 0) + 1;
                        searchMissCounts.set(mismatchSignature, missCount);
                        const exactSnippet = recentExactReadSnippets.get(targetPath) || "";
                        forceWriteInstruction = this.buildSearchRetryInstruction(
                          path.relative(this.config.projectPath!, targetPath),
                          exactSnippet,
                        );
	                    toolRes = missCount >= 2
                          ? `❌ 错误: 同一 SEARCH 块已连续 ${missCount} 次未命中。请停止重复同一 patch，改用更小且唯一的原文锚点后立即重试。`
                          : `❌ 错误: 无法在文件中匹配到指定的 SEARCH 块。请检查代码缩进、空格或换行符是否与原文件完全一致。建议先使用 read_file_lines 查看原文。`;
                      }
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
            if (
              !toolRes.startsWith("❌") &&
              fullName.includes("read_file_lines") &&
              typeof args?.path === "string"
            ) {
              try {
                const readPath = this.resolveProjectFilePath(String(args.path));
                const snippet = this.extractCodeSnippetFromToolResult(toolRes);
                if (snippet) recentExactReadSnippets.set(readPath, snippet);
              } catch {
                // noop
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
                writeKind !== null &&
	              (fullName === "internal_structured_edit" || fullName === "internal_surgical_edit" || fullName === "surgical_edit")
	            ) {
              const resolvedPath = this.resolveProjectFilePath(String(args.path || ""));
              successfulWriteCount++;
              successfulWritePaths.add(resolvedPath);
              if (writeKind === "create") successfulCreatePaths.add(resolvedPath);
              if (writeKind === "modify") successfulModifyPaths.add(resolvedPath);
            }
            if (
              writeKind === null &&
              this.isNoopWriteMessage(toolRes) &&
              (fullName === "internal_structured_edit" || fullName === "internal_surgical_edit" || fullName === "surgical_edit")
            ) {
              sawNoopEditThisRound = true;
            }
            const toolResultProgress = this.formatToolResultProgress(fullName, args, toolRes);
            if (toolResultProgress && onThought) {
              onThought(toolResultProgress);
            }
            currentMessages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolRes });
          }
          if (this.requiresWriteBeforeFinish() && this.hasSatisfiedRequiredWrites(successfulWritePaths)) {
            if (triggeredForceWriteThisRound || sawNoopEditThisRound) {
              forceConclusionMode = true;
              forceConclusionReason = sawNoopEditThisRound
                ? "关键目标文件已经写入完成，后续操作已退化为重复/无效修改，必须立即输出最终 JSON 交付结果。"
                : `关键目标文件已经写入完成，且已触发收敛保护，必须立即输出最终 JSON 交付结果。${forceWriteReason ? ` 触发保护原因：${forceWriteReason}` : ""}`;
              forceEditOnlyMode = true;
              triggeredForceConclusionThisRound = true;
              triggeredForceWriteThisRound = false;
            }
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
                this.requiresWriteBeforeFinish()
                  ? this.buildFinalDeliveryInstruction(forceConclusionReason)
                  : (
                      `你已经拥有足够证据，禁止继续调用任何工具。请直接基于已有的 PRD、API、项目目录树、目标组件片段与已读取代码，输出最终 JSON 实施方案。\n` +
                      `要求：必须包含 reasoning、files_to_modify、files_to_create、verification_points；如证据不足，请在 reasoning 中说明风险，但依然要给出当前最佳方案。\n` +
                      `触发原因：${forceConclusionReason}`
                    ),
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
                  `${forceWriteInstruction || this.buildSearchRetryInstruction("核心组件", "")}\n` +
	                `\n触发原因：${forceWriteReason}`,
	            });
	          }
          continue;
        }

        const hasSearchReplace = fullContent.includes("<<<<<<< SEARCH");
        // 使用外部作用域已计算好的 hasJson 和 hasReasoning
        
        if (hasSearchReplace || hasJson) {
          consecutiveEmptyResponseCount = 0;
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
                  "你必须优先完成这些文件的真实写入；如果 SEARCH 块失败，只允许一次精确补读，然后立即再次使用 internal_structured_edit 或 internal_surgical_edit。",
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
          consecutiveEmptyResponseCount = 0;
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

        const finishReasonList = Array.from(finishReasons).filter(Boolean);
        const emptyCompletion =
          !hasTools &&
          !hasJson &&
          !hasReasoning &&
          (roleOnlyChunkCount > 0 || finishReasonList.length > 0);

        if (emptyCompletion) {
          consecutiveReasoningOnlyCount = 0;
          lastReasoningOnlySignature = "";
          consecutiveEmptyResponseCount++;
          const effectiveToolNames = (effectiveTools || [])
            .map((tool) => tool?.function?.name || "")
            .filter(Boolean)
            .slice(0, 8);
          const emptyResponseCircuitLimit = this.getEmptyResponseCircuitLimit(effectiveToolNames);
          const missingWriteTargets = this.getMissingRequiredWriteTargets(successfulWritePaths);

          this.traceRound({
            type: "round_result",
            round,
            decision: "empty_completion",
            finishReasons: finishReasonList,
            parsedEventCount,
            roleOnlyChunks: roleOnlyChunkCount,
            contentChunks: contentChunkCount,
            reasoningChunks: reasoningChunkCount,
            toolCallChunks: toolCallChunkCount,
            toolNames: effectiveToolNames,
            emptyCount: consecutiveEmptyResponseCount,
            missingWriteTargets,
          });

          if (!this.requiresWriteBeforeFinish()) {
            throw new Error(
              `Silent output or invalid format. [empty_completion finish_reason=${finishReasonList.join(", ") || "none"} role_only_chunks=${roleOnlyChunkCount} tool_count=${effectiveToolNames.length}]`,
            );
          }

          if (onThought) {
            onThought(
              this.requiresWriteBeforeFinish()
                ? "[系统] 编码模型返回了空响应，已切换到强制出招恢复模式。"
                : "[系统] 模型返回了空响应，正在尝试强制恢复输出。"
            );
          }

          if (this.constructor.name === "CoderAgent") {
            forceWriteMode = true;
            forceWriteReason = "模型返回空响应，必须停止沉默并直接执行最小必要写入动作。";
            forceEditOnlyMode = true;
            forceWriteRecoveryReads = 0;
          }

          if (consecutiveEmptyResponseCount >= emptyResponseCircuitLimit) {
            const detail =
              `模型连续 ${consecutiveEmptyResponseCount} 轮返回空响应` +
              `（finish_reason=${finishReasonList.join(", ") || "none"}，` +
              `role_only_chunks=${roleOnlyChunkCount}，tool_count=${effectiveToolNames.length}，` +
              `limit=${emptyResponseCircuitLimit}）`;
            throw new Error(`【空响应熔断】${detail}`);
          }

          currentMessages.push({
            role: "user",
            content: this.buildEmptyResponseRecoveryInstruction(
              finishReasonList,
              effectiveToolNames,
              missingWriteTargets,
            ),
          });
          continue;
        }

        // 🚀 循环保护：如果内容为空或者与上一轮几乎一致，报错退出，防止死循环
        if (hasReasoning && !hasTools) {
          consecutiveEmptyResponseCount = 0;
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
              ? this.requiresWriteBeforeFinish()
                ? `${this.buildFinalDeliveryInstruction()}${langNudge}\n\n不要重复前面的扫描和写入过程。`
                : `请不要继续解释，也不要再调用任何工具。立即输出最终 JSON 实施方案。${langNudge}\n\n要求：必须包含 reasoning、files_to_modify、files_to_create、verification_points；不要重复前面的扫描过程。`
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
        const isImmediateCircuitBreak = /^【空响应熔断】/.test(err.message || "");
        consecutiveFailureCount++;
        this.traceRound({
          type: "round_error",
          round,
          failureCount: consecutiveFailureCount,
          message: err.message,
        });
        if (isImmediateCircuitBreak) throw new Error(`Circuit Breaker: ${err.message}`);
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
