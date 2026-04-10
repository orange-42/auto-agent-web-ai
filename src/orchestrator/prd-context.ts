import * as path from "path";
import { summarizeText } from "../harness-logger";
import { normalizePrdArtifact, PrdArtifact } from "../phase-artifacts";

interface PrdContextOptions {
  taskObjective?: string;
  projectPath?: string;
  targetRoute?: string;
  targetComponentPath?: string;
}

function escapeRegex(text: string): string {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从若干 seed 文本里提炼出少量高价值关键词。
 *
 * 这些关键词只服务一个目标：把超长文档压缩时尽量保住与当前需求最相关的片段，
 * 而不是把整份 PRD / API 原文完整塞给模型。
 */
function extractEvidenceKeywords(seedTexts: string[]): string[] {
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

/**
 * 从原文里捞取命中关键词的证据片段。
 *
 * 这里不是做严格的文档解析，而是做“排障友好的证据卡片”：
 * 一旦 PRDAgent 提取不完整，我们至少还能回退到这些命中过的原句。
 */
function collectDocumentEvidenceSnippets(rawContent: string, patterns: RegExp[], limit: number = 10): string[] {
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
    snippets.push(summarizeText(snippet));
    if (snippets.length >= limit) break;
  }

  return Array.from(new Set(snippets));
}

/**
 * 清洗 PRD 文本行，去掉 markdown 噪声并尽量保住业务语义。
 */
function sanitizePrdTextLine(line: string): string {
  return String(line || "")
    .replace(/^\[.*?\]\s*/g, "")
    .replace(/^[-*]\s*/g, "")
    .replace(/^#+\s*/g, "")
    .replace(/[`*_>]/g, "")
    .replace(/\s*\|\s*/g, "；")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 从一段 PRD 文本块里提取若干条更适合写进 artifact 的事实句。
 */
function extractPrdBlockLines(block: string, limit: number = 8): string[] {
  if (!block.trim()) return [];
  return Array.from(
    new Set(
      block
        .split(/\r?\n/)
        .map((line) => sanitizePrdTextLine(line))
        .filter((line) => line && !/^SOURCE:/i.test(line)),
    ),
  ).slice(0, limit);
}

/**
 * 在原始 PRD 文本里按关键词收集可兜底使用的事实句。
 */
function collectPrdFallbackLines(rawContent: string, patterns: RegExp[], limit: number = 6): string[] {
  if (!rawContent.trim()) return [];

  const lines = rawContent
    .split(/\r?\n/)
    .map((line) => sanitizePrdTextLine(line))
    .filter(Boolean);

  const picked: string[] = [];
  for (const line of lines) {
    if (!patterns.some((pattern) => pattern.test(line))) continue;
    if (/^(预读|指令|高优先级证据锚点)$/u.test(line)) continue;
    if (line.length < 4) continue;
    picked.push(summarizeText(line));
    if (picked.length >= limit) break;
  }

  return Array.from(new Set(picked));
}

/**
 * 判断 PRD 文本是不是“暂无内容/文档未读到”这类占位文本。
 */
function isPlaceholderPrdText(text: unknown): boolean {
  const normalized = String(text || "").replace(/\s+/g, "").trim();
  if (!normalized) return true;
  return /暂无.*(内容|文档)|等待文档解析|文档内容.*为空|预读部分为空|暂无文档内容可验证|无法访问外部链接|无法读取文档|fetch_doc|获取文档的Markdown内容|先执行(读取|抓取)操作/u.test(
    normalized,
  );
}

/**
 * 尝试从任务目标里抽出一个较短的功能名。
 *
 * 本地 fallback 会拿它来生成更像人话的 summary / modules。
 */
function extractFeatureNameFromObjective(taskObjective: string): string {
  const objective = String(taskObjective || "").trim();
  if (!objective) return "";

  const quoted = objective.match(/[“"]([^”"]{2,24})[”"]/u);
  if (quoted?.[1]) return quoted[1].trim();

  const integrationMatch = objective.match(/集成[“"]?([^”"。；，]{2,24})/u);
  if (integrationMatch?.[1]) {
    return integrationMatch[1].replace(/功能$/u, "").trim();
  }

  return "";
}

/**
 * 在 PRD 结构不完整时，启发式构造一个最小模块划分。
 */
function buildPrdFallbackModules(featureName: string, componentLabel: string, sourceText: string) {
  const modules: Array<{ name: string; desc: string }> = [];

  if (/审批|风控|限制|校验|规则|流程/u.test(sourceText)) {
    modules.push({
      name: "业务规则约束",
      desc: `围绕 ${featureName || "目标功能"} 明确关键流程中的状态判断、限制条件与校验要求。`,
    });
  }

  modules.push({
    name: "页面集成落点",
    desc: `在 ${componentLabel} 内承接状态展示、入口交互与接口联动。`,
  });

  return modules.slice(0, 3);
}

/**
 * 当 PRDAgent 输出不够可用时，本地生成一份最小可用 PRD artifact。
 *
 * 这个 fallback 的目标不是“完美复刻 PRD”，而是保住后续 PLAN / CODING
 * 至少还能围绕页面落点、业务规则和证据锚点继续推进。
 */
function buildLocalPrdFallback(rawContent: string, evidenceContext: string, options: PrdContextOptions) {
  const featureName = extractFeatureNameFromObjective(String(options.taskObjective || "")) || "目标功能";
  const routeLabel = options.targetRoute || "目标页面";
  const componentPath = options.targetComponentPath || "";
  const componentLabel = componentPath ? path.basename(componentPath) : "目标组件";
  const sourceText = [rawContent, evidenceContext, options.taskObjective, routeLabel, componentPath]
    .filter(Boolean)
    .join("\n");

  const evidenceRefs = Array.from(
    new Set([
      ...extractPrdBlockLines(evidenceContext, 8),
      ...collectDocumentEvidenceSnippets(
        rawContent,
        [/功能详述/u, /原型/u, /截图/u, /页面/u, /按钮/u, /入口/u, /位置/u, /文案/u, /状态/u, /交互/u, /校验/u, /流程/u],
        6,
      ).map((item) => sanitizePrdTextLine(item)),
      ...collectPrdFallbackLines(
        rawContent,
        [/状态/u, /流程/u, /校验/u, /限制/u, /风控/u, /依赖/u, /入口/u, /按钮/u, /页面/u, /组件/u],
        6,
      ),
    ].filter(Boolean)),
  ).slice(0, 10);

  const logicRules = collectPrdFallbackLines(
    rawContent,
    [/必须/u, /需要/u, /需/u, /应/u, /如果/u, /当/u, /只有/u, /避免/u, /状态/u, /校验/u, /流程/u, /限制/u, /依赖/u],
    6,
  );
  if (logicRules.length === 0) {
    if (/审批|风控|限制|校验|规则/u.test(sourceText)) {
      logicRules.push("涉及业务规则或风险控制时，需要明确状态判断、触发条件和异常分支，避免错误操作。");
    }
    if (/状态|启用|停用|开关|可用|不可用|详情/u.test(sourceText)) {
      logicRules.push("页面需根据当前数据或状态决定展示内容与可执行动作，避免重复提交或错误触发。");
    }
    if (componentPath) {
      logicRules.push(`功能应优先收敛到 ${componentPath}，并与当前页面已有上下文和数据流联动。`);
    } else {
      logicRules.push(`需围绕 ${featureName} 在目标页面落实核心交互、状态承接与结果反馈。`);
    }
  }

  const placementHints = collectPrdFallbackLines(
    rawContent,
    [/页面/u, /入口/u, /位置/u, /按钮/u, /模块/u, /卡片/u, /组件/u, /详情/u],
    4,
  ).filter((item) => !/按钮状态/u.test(item));
  if (placementHints.length === 0) {
    placementHints.push(`功能入口应落在 ${routeLabel} 对应页面的 ${componentLabel} 内。`);
  } else if (componentPath) {
    placementHints.unshift(`优先在 ${componentPath} 对应的 ${componentLabel} 内承接入口与状态展示。`);
  }

  const uiRequirements = collectPrdFallbackLines(
    rawContent,
    [/按钮/u, /文案/u, /状态/u, /展示/u, /提示/u, /弹窗/u, /交互/u, /入口/u, /显隐/u, /禁用/u],
    4,
  );
  if (uiRequirements.length === 0) {
    uiRequirements.push(`在 ${componentLabel} 区域展示 ${featureName} 相关状态、入口或结果反馈。`);
  }

  const dependencyChecks = collectPrdFallbackLines(
    rawContent,
    [/权限/u, /配置/u, /枚举/u, /字段/u, /接口/u, /错误/u, /校验/u, /依赖/u],
    5,
  );
  if (dependencyChecks.length === 0) {
    dependencyChecks.push("需要确认前端所依赖的状态字段、接口能力、权限项与错误文案映射。");
  }

  const contentSummaryCandidates = [
    ...collectPrdFallbackLines(
      rawContent,
      [/用户故事/u, /功能详述/u, /流程/u, /状态/u, /交互/u, /入口/u, /页面/u, /组件/u, /字段/u],
      3,
    ),
    ...extractPrdBlockLines(evidenceContext, 2),
  ];
  const contentVerified = contentSummaryCandidates.length > 0
    ? summarizeText(contentSummaryCandidates.join("；"))
    : `${featureName} 需集成到 ${routeLabel} 的 ${componentLabel}，并围绕当前业务流程补齐状态查询、交互入口与风险控制。`;

  const artifact: PrdArtifact = {
    content_verified: contentVerified,
    logic_rules: Array.from(new Set(logicRules)).slice(0, 6),
    ui_requirements: Array.from(new Set(uiRequirements)).slice(0, 6),
    placement_hints: Array.from(new Set(placementHints)).slice(0, 4),
    dependency_checks: Array.from(new Set(dependencyChecks)).slice(0, 6),
    evidence_refs: evidenceRefs.length > 0
      ? evidenceRefs
      : [`任务目标：${options.taskObjective || `${routeLabel} / ${componentLabel}`}`],
  };

  const result = {
    reasoning: contentVerified,
    modules: buildPrdFallbackModules(featureName, componentLabel, sourceText),
    ...artifact,
    fallback_generated: true,
  };

  return { artifact, result };
}

/**
 * 从用户原始长提示里提炼一句简短任务目标。
 */
export function extractTaskObjective(prompt: string): string {
  const headingMatch = prompt.match(/##\s*4\.\s*任务目标\s*([\s\S]*?)(?:\n##\s|\n#\s|$)/);
  if (headingMatch?.[1]) {
    return headingMatch[1].replace(/[-*]/g, " ").replace(/\s+/g, " ").trim();
  }

  const lineMatch = prompt.match(/任务目标[:：]\s*(.+)/);
  if (lineMatch?.[1]) {
    return lineMatch[1].trim();
  }

  return summarizeText(prompt.replace(/\s+/g, " ").trim());
}

/**
 * 生成贯穿 PRD / API / PLAN / CODING 的统一执行摘要。
 *
 * 这段 brief 的职责是把最关键的上下文压成几行“作战指令”，
 * 方便不同 agent 在统一目标下协作，而不是各自重新猜任务重点。
 */
export function buildExecutionBrief(options: PrdContextOptions): string {
  return [
    `任务目标：${options.taskObjective || "根据需求文档与接口文档完成指定迭代开发"}`,
    options.projectPath ? `项目路径：${options.projectPath}` : "",
    options.targetRoute ? `目标路由：${options.targetRoute}` : "",
    options.targetComponentPath ? `核心组件：${options.targetComponentPath}` : "",
    "要求：先理解 PRD 与接口，再围绕目标组件高效收敛并落地写码。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 把超长 PRD/API 文档压缩成证据优先视图，减少模型阅读噪音。
 */
export function buildFocusedDocumentContent(
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

  const keywordPatterns = extractEvidenceKeywords(seedTexts)
    .map((token) => new RegExp(escapeRegex(token), "i"));

  const phasePatterns =
    phase === "PRD"
      ? [/功能详述/u, /原型/u, /截图/u, /按钮/u, /入口/u, /位置/u, /文案/u, /状态/u, /页面/u, /交互/u, /流程/u]
      : [/GET\b/i, /POST\b/i, /PUT\b/i, /DELETE\b/i, /接口/u, /endpoint/i, /path/i, /params/i, /body/i, /响应/u, /返回/u, /状态码/u, /status/i, /detail/i, /query/i];

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

/**
 * 构造 PRD 的原型/截图/按钮/落点证据卡片。
 */
export function buildPrdEvidenceContext(rawContent: string): string {
  const evidence = collectDocumentEvidenceSnippets(
    rawContent,
    [/功能详述/u, /原型/u, /截图/u, /页面/u, /按钮/u, /入口/u, /位置/u, /文案/u, /状态/u, /交互/u, /流程/u],
    10,
  );
  if (evidence.length === 0) return "";
  return ["[PRD 原型/落点证据锚点]", ...evidence.map((item) => `- ${item}`)].join("\n");
}

/**
 * 把结构化 PRD 结果再压成一段短上下文，给后续阶段继续引用。
 */
export function buildPrdFocusContext(prd: any): string {
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

/**
 * 用本地兜底 PRD 结果回填模型输出，尽量保住后续阶段继续执行。
 *
 * 这层的策略很克制：
 * - 优先保留模型已有字段
 * - 只在缺项或明显占位文本时补齐
 * - 最终仍走 normalizePrdArtifact，保证输出口径一致
 */
export function backfillPrdResultWithLocalEvidence(
  prdRes: any,
  rawContent: string,
  evidenceContext: string,
  options: PrdContextOptions,
) {
  const fallback = buildLocalPrdFallback(rawContent, evidenceContext, options);
  const merged = prdRes && typeof prdRes === "object" ? { ...prdRes } : {};

  if (isPlaceholderPrdText(merged.reasoning)) {
    merged.reasoning = fallback.result.reasoning;
  }
  if (isPlaceholderPrdText(merged.content_verified)) {
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
