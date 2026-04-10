import * as fs from "fs";
import * as path from "path";
import { analyzeCodeFile } from "../code-analysis";
import { ApiArtifact, PrdArtifact } from "../phase-artifacts";
import { ValidationIssue, ValidationReport } from "./loop-manager-types";

interface ValidationContext {
  projectPath: string;
  targetComponentPath?: string;
  targetRoute?: string;
  taskObjective?: string;
  phaseArtifacts?: {
    PRD?: { artifact?: Partial<PrdArtifact> };
    API?: { artifact?: Partial<ApiArtifact> };
  };
  useAstGate?: boolean;
  getApiStyleContract: (targetRelativePath: string, limit?: number) => {
    dominantImport: string;
    preferredExt: string;
    referenceFiles: string[];
  };
  detectPreferredExtensionForDirectory: (relativePath: string) => string;
}

interface ValidationBuildInput extends ValidationContext {
  result: any;
  plan: any;
}

function escapeRegex(text: string): string {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectChangedFiles(result: any, plan: any): { created: string[]; modified: string[] } {
  const resultCreates = Array.isArray(result?.files_to_create) ? result.files_to_create : [];
  const resultModifies = Array.isArray(result?.files_to_modify) ? result.files_to_modify : [];
  const planCreates = Array.isArray(plan?.files_to_create) ? plan.files_to_create : [];
  const planModifies = Array.isArray(plan?.files_to_modify) ? plan.files_to_modify : [];

  const normalizePath = (item: any) =>
    String(item?.path || item?.file || item?.target || item?.target_file || "")
      .replace(/\\/g, "/")
      .trim();

  const created = Array.from(new Set([
    ...resultCreates.map(normalizePath),
    ...planCreates.map(normalizePath),
  ].filter(Boolean)));

  const modified = Array.from(new Set([
    ...resultModifies.map(normalizePath),
    ...planModifies.map(normalizePath),
  ].filter(Boolean)));

  return { created, modified };
}

function isLikelyProjectAlias(projectPath: string, specifier: string): boolean {
  if (!projectPath || !specifier) return false;
  if (specifier.startsWith(".") || specifier.startsWith("@/")) return false;
  if (specifier.startsWith("@")) return false;

  const firstSegment = specifier.split("/")[0] || "";
  if (!firstSegment) return false;
  if (firstSegment === "src") return true;

  const rootCandidate = path.resolve(projectPath, firstSegment);
  const srcCandidate = path.resolve(projectPath, "src", firstSegment);
  return fs.existsSync(rootCandidate) || fs.existsSync(srcCandidate);
}

function resolveImportCandidates(projectPath: string, sourceRelativePath: string, specifier: string): string[] {
  const candidates: string[] = [];
  const basePaths = specifier.startsWith("@/")
    ? [
        path.resolve(projectPath, "src", specifier.slice(2)),
        path.resolve(projectPath, specifier.slice(2)),
      ]
    : isLikelyProjectAlias(projectPath, specifier)
      ? [
          path.resolve(projectPath, "src", specifier),
          path.resolve(projectPath, specifier),
        ]
      : [path.resolve(path.dirname(path.resolve(projectPath, sourceRelativePath)), specifier)];

  for (const basePath of basePaths) {
    candidates.push(basePath);
    [".js", ".ts", ".tsx", ".vue", ".json"].forEach((ext) => candidates.push(`${basePath}${ext}`));
    ["index.js", "index.ts", "index.tsx", "index.vue", "index.json"].forEach((entry) =>
      candidates.push(path.join(basePath, entry)),
    );
  }

  return Array.from(new Set(candidates));
}

export function resolveImportTarget(projectPath: string, sourceRelativePath: string, specifier: string): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !isLikelyProjectAlias(projectPath, specifier)) {
    return null;
  }
  const candidates = resolveImportCandidates(projectPath, sourceRelativePath, specifier);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export function isCodeImportTarget(resolvedPath: string): boolean {
  return /\.(js|jsx|ts|tsx|vue|json)$/i.test(String(resolvedPath || ""));
}

function parseImportClause(
  clause: string,
): { defaultImport?: string; namedImports: string[]; namespaceImport?: string } {
  const trimmed = clause.trim();
  if (!trimmed || trimmed.startsWith("* as ")) {
    const namespaceOnlyMatch = trimmed.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    return {
      namedImports: [],
      namespaceImport: namespaceOnlyMatch?.[1],
    };
  }

  const result: { defaultImport?: string; namedImports: string[]; namespaceImport?: string } = {
    namedImports: [],
  };
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

  const namespaceMatch = trimmed.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespaceMatch?.[1]) {
    result.namespaceImport = namespaceMatch[1];
  }

  const defaultPart = trimmed.split(",")[0]?.trim();
  if (
    defaultPart &&
    !defaultPart.startsWith("{") &&
    !defaultPart.startsWith("* as ") &&
    !/\*\s+as\s+/.test(defaultPart)
  ) {
    result.defaultImport = defaultPart;
  }

  return result;
}

function hasNamedExport(targetContent: string, exportName: string): boolean {
  const escaped = escapeRegex(exportName);
  const patterns = [
    new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|class|const|let|var)\\s+${escaped}\\b`),
    new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b(?:\\s+as\\s+\\w+)?[^}]*\\}`),
    new RegExp(`\\bexport\\s+type\\s+\\{[^}]*\\b${escaped}\\b[^}]*\\}`),
    new RegExp(`\\bexport\\s+interface\\s+${escaped}\\b`),
    new RegExp(`\\bexport\\s+enum\\s+${escaped}\\b`),
  ];

  return patterns.some((pattern) => pattern.test(targetContent));
}

function hasDefaultExport(targetContent: string): boolean {
  return /\bexport\s+default\b/.test(targetContent);
}

function extractVueScriptForValidation(content: string): string {
  const match = String(content || "").match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/i);
  return match?.[1] || "";
}

function extractSearchableScriptContent(relativePath: string, content: string): string {
  if (!/\.vue$/i.test(relativePath)) return content;
  return extractVueScriptForValidation(content);
}

function findMatchingBrace(source: string, openBraceIndex: number): number {
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

function extractVueOptionBodies(
  script: string,
  optionName: string,
  kind: "function" | "object",
): string[] {
  const bodies: string[] = [];
  const pattern = kind === "function"
    ? new RegExp(`\\b(?:async\\s+)?${escapeRegex(optionName)}\\s*\\([^)]*\\)\\s*\\{`, "g")
    : new RegExp(`\\b${escapeRegex(optionName)}\\s*:\\s*\\{`, "g");

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(script)) !== null) {
    const openIndex = script.indexOf("{", match.index);
    if (openIndex === -1) continue;
    const closeIndex = findMatchingBrace(script, openIndex);
    if (closeIndex === -1) continue;
    bodies.push(script.slice(openIndex + 1, closeIndex));
    pattern.lastIndex = closeIndex + 1;
  }

  return bodies;
}

function stripImportStatements(scriptContent: string): string {
  return String(scriptContent || "").replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, "");
}

function collectVueOptionsApiStructureIssues(relativePath: string, content: string): ValidationIssue[] {
  if (!/\.vue$/i.test(relativePath)) return [];

  const script = extractVueScriptForValidation(content);
  if (!script) return [];

  const usesOptionsApi =
    /export\s+default\s*\{/.test(script) &&
    (/\bdata\s*\(\)\s*\{/.test(script) || /\bmethods\s*:\s*\{/.test(script));
  if (!usesOptionsApi) return [];

  const [preExportBlock = ""] = script.split(/export\s+default\s*\{/);
  const significantPrelude = preExportBlock
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("import ")) return false;
      if (trimmed.startsWith("//")) return false;
      if (trimmed === "/*" || trimmed === "*/" || trimmed.startsWith("*")) return false;
      return true;
    })
    .join("\n");

  const issues: ValidationIssue[] = [];
  if (/\bthis\./.test(significantPrelude)) {
    issues.push({
      severity: "error",
      file: relativePath,
      message: "检测到在 `export default` 之外新增了依赖 `this` 的脚本逻辑。",
      suggestion: "请把实例方法收敛到 `methods`，把初始化逻辑收敛到根级 `mounted/created`。",
      kind: "vue_options_api_escape",
    });
  }
  if (/(?:^|\n)\s*(?:let|var)\s+[A-Za-z_$][\w$]*/.test(significantPrelude)) {
    issues.push({
      severity: "error",
      file: relativePath,
      message: "检测到在 `export default` 之外声明了模块级可变状态 (`let/var`)。",
      suggestion: "当前项目以 Vue2 Options API 为主，组件状态必须进入 `data()` 返回值。",
      kind: "vue_options_api_escape",
    });
  }
  if (/(?:^|\n)\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(significantPrelude)) {
    issues.push({
      severity: "error",
      file: relativePath,
      message: "检测到在 `export default` 之外声明了顶层函数。",
      suggestion: "组件交互方法请写入 `methods`，不要把 `handle*/init*` 一类函数游离在 import 区后面。",
      kind: "vue_options_api_escape",
    });
  }
  if (/\b(?:setup\s*\(|defineComponent\s*\(|reactive\s*\(|ref\s*\(|onMounted\s*\(|watchEffect\s*\()/.test(script)) {
    issues.push({
      severity: "error",
      file: relativePath,
      message: "检测到向 Vue2 Options API 组件混入了 Composition API / Vue3 风格写法。",
      suggestion: "请继续使用 `data / computed / methods / mounted` 完成集成，不要引入 `setup/ref/reactive/onMounted`。",
      kind: "vue_options_api_escape",
    });
  }
  return issues;
}

function taskLikelyRequiresVisibleUi(ctx: ValidationContext, plan?: any): boolean {
  if (!/\.(vue|jsx|tsx)$/i.test(ctx.targetComponentPath || "")) return false;

  const prdArtifact = ctx.phaseArtifacts?.PRD?.artifact as Partial<PrdArtifact> | undefined;
  const sources = [
    ctx.taskObjective,
    ctx.targetRoute,
    ctx.targetComponentPath,
    ...(Array.isArray(prdArtifact?.ui_requirements) ? prdArtifact.ui_requirements : []),
    ...(Array.isArray(prdArtifact?.placement_hints) ? prdArtifact.placement_hints : []),
    ...(Array.isArray(prdArtifact?.logic_rules) ? prdArtifact.logic_rules : []),
    ...(Array.isArray(plan?.verification_points) ? plan.verification_points : []),
    ...(Array.isArray(plan?.operations_outline) ? plan.operations_outline : []),
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("\n");

  return (
    (Array.isArray(prdArtifact?.ui_requirements) && prdArtifact.ui_requirements.length > 0) ||
    (Array.isArray(prdArtifact?.placement_hints) && prdArtifact.placement_hints.length > 0) ||
    /按钮|图标|弹窗|tooltip|toast|页面|视图|渲染|展示|点击|入口|列表|卡片|弹层|文案|显隐|交互|template|ui|button|icon|dialog|modal|drawer|popover|badge|render/i.test(sources)
  );
}

function taskRequiresStateInitialization(ctx: ValidationContext, plan?: any): boolean {
  if (!/\.(vue|jsx|tsx)$/i.test(ctx.targetComponentPath || "")) return false;

  const prdArtifact = ctx.phaseArtifacts?.PRD?.artifact as Partial<PrdArtifact> | undefined;
  const apiArtifact = ctx.phaseArtifacts?.API?.artifact as Partial<ApiArtifact> | undefined;
  const apiMappings = Array.isArray(apiArtifact?.api_mappings) ? apiArtifact.api_mappings : [];
  const sources = [
    ctx.taskObjective,
    ctx.targetRoute,
    ctx.targetComponentPath,
    ...(Array.isArray(prdArtifact?.logic_rules) ? prdArtifact.logic_rules : []),
    ...(Array.isArray(apiArtifact?.component_impact) ? apiArtifact.component_impact : []),
    ...apiMappings.map((item: any) => `${item?.endpoint || ""} ${item?.purpose || ""}`.trim()),
    ...(Array.isArray(plan?.verification_points) ? plan.verification_points : []),
    ...(Array.isArray(plan?.operations_outline) ? plan.operations_outline : []),
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("\n");

  return /初始化|初始|加载时|页面加载|进入.+页|mounted|created|自动调用|自动获取|组件加载|同步\s*ui\s*初始状态|初始状态|查询.+状态/u.test(sources);
}

function buildFeatureDomainTokens(ctx: ValidationContext, plan?: any): string[] {
  const prdArtifact = ctx.phaseArtifacts?.PRD?.artifact as Partial<PrdArtifact> | undefined;
  const apiArtifact = ctx.phaseArtifacts?.API?.artifact as Partial<ApiArtifact> | undefined;
  const apiMappings = Array.isArray(apiArtifact?.api_mappings) ? apiArtifact.api_mappings : [];
  const stopwords = new Set([
    "admin","api","button","component","created","data","detail","fetch","get","info","list","load","logic","method","methods","mounted","order","page","query","route","show","state","status","template","userinfo","view",
  ]);
  const sources = [
    ctx.taskObjective,
    ctx.targetRoute,
    ctx.targetComponentPath,
    ...(Array.isArray(prdArtifact?.logic_rules) ? prdArtifact.logic_rules : []),
    ...(Array.isArray(prdArtifact?.ui_requirements) ? prdArtifact.ui_requirements : []),
    ...(Array.isArray(apiArtifact?.component_impact) ? apiArtifact.component_impact : []),
    ...apiMappings.map((item: any) => `${item?.endpoint || ""} ${item?.purpose || ""}`.trim()),
    ...(Array.isArray(plan?.verification_points) ? plan.verification_points : []),
    ...(Array.isArray(plan?.operations_outline) ? plan.operations_outline : []),
  ]
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean)
    .join("\n");

  return Array.from(new Set(
    sources
      .split(/[^a-z0-9]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 4 && !stopwords.has(item)),
  )).slice(0, 12);
}

function collectComponentInitFlowIssues(
  ctx: ValidationContext,
  relativePath: string,
  content: string,
  plan?: any,
): ValidationIssue[] {
  if (relativePath !== ctx.targetComponentPath) return [];
  if (!/\.vue$/i.test(relativePath)) return [];
  if (!taskRequiresStateInitialization(ctx, plan)) return [];

  const script = extractVueScriptForValidation(content);
  if (!script) return [];

  const domainTokens = buildFeatureDomainTokens(ctx, plan);
  const domainPattern = domainTokens.length > 0
    ? new RegExp(domainTokens.map((token) => escapeRegex(token)).join("|"), "i")
    : null;
  const queryMethodNames = Array.from(
    new Set(
      Array.from(script.matchAll(/\b(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g))
        .map((match) => match[1])
        .filter(Boolean)
        .filter((name) =>
          /(fetch|get|load|query)/i.test(name) &&
          /(status|state|info|detail|config|meta)/i.test(name) &&
          (!domainPattern || domainPattern.test(name)),
        ),
    ),
  );
  const directApiCallPattern = domainPattern
    ? new RegExp(
        `\\b[A-Za-z_$][\\w$]*Action\\.(?:get|fetch|load|query)[A-Za-z_$\\d]*(?:${domainTokens
          .map((token) => escapeRegex(token))
          .join("|")})[A-Za-z_$\\d]*\\s*\\(`,
        "i",
      )
    : /\b[A-Za-z_$][\w$]*Action\.(?:get|fetch|load|query)\w*\(/;
  const hasQueryLikeMethod = queryMethodNames.length > 0 || directApiCallPattern.test(script);
  if (!hasQueryLikeMethod) return [];

  const initBodies = [
    ...extractVueOptionBodies(script, "mounted", "function"),
    ...extractVueOptionBodies(script, "created", "function"),
    ...extractVueOptionBodies(script, "watch", "object"),
  ];
  const hasLifecycleHook = initBodies.length > 0;
  const hasInitMethodCall = queryMethodNames.some((name) =>
    initBodies.some((body) => new RegExp(`\\b(?:this\\.)?${escapeRegex(name)}\\s*\\(`).test(body)),
  );
  const hasInitDirectApiCall = initBodies.some((body) => directApiCallPattern.test(body));

  if (!hasLifecycleHook || (!hasInitMethodCall && !hasInitDirectApiCall)) {
    return [{
      severity: "error",
      file: relativePath,
      message: "组件缺少首屏初始化查询接线：当前任务要求页面加载时同步关键数据或状态，但未在 mounted/created/watch 中发现对应调用。",
      suggestion: "请在组件现有的 mounted/created 或合适的 watch 中接入查询方法，并确保首屏渲染前后状态能同步到 UI。",
      kind: "component_init_flow_missing",
    }];
  }
  return [];
}

function isImportedBindingUsed(relativePath: string, content: string, binding: string): boolean {
  const normalizedBinding = String(binding || "").trim();
  if (!normalizedBinding) return false;
  const searchableContent = stripImportStatements(extractSearchableScriptContent(relativePath, content));
  return new RegExp(`\\b${escapeRegex(normalizedBinding)}\\b`).test(searchableContent);
}

function collectIncompleteCodingSignals(ctx: ValidationContext, result: any, plan?: any): string[] {
  const fragments = [
    String(result?.reasoning || ""),
    String(result?.completion_summary || ""),
    ...(Array.isArray(result?.validation_summary) ? result.validation_summary.map((item: any) => String(item || "")) : []),
  ]
    .map((item) => item.trim())
    .filter(Boolean);

  if (fragments.length === 0) return [];

  const joined = fragments.join("\n");
  const signals: string[] = [];
  const visibleUiTask = taskLikelyRequiresVisibleUi(ctx, plan);
  const mentionsViewLanding = /template|模板|UI|视图|渲染|按钮|点击|显隐|入口|展示|交互/u.test(joined);
  const mentionsScriptOrApiWork = /导入|import|接口|API|data|methods|computed|watch|mounted|created|状态|方法/i.test(joined);
  const claimsIntegratedDone = /(?:本轮|当前|已).{0,12}(?:完成|落地|集成)|核心集成|完成了/u.test(joined);

  if (/由于强制收敛模式限制/u.test(joined)) {
    signals.push("编码结果自述受强制收敛模式影响，当前交付并未真正落地完整功能。");
  }
  if (/需开发者[^。\n]{0,30}补充|后续[^。\n]{0,40}(?:补充|完成|实现)|尚未(?:完成|实现|接入|绑定)|待补充|仍需(?:补充|继续|完善)|还需(?:补充|继续|完善)/u.test(joined)) {
    signals.push("编码结果自述仍存在待补充或尚未落地的实现步骤。");
  }
  if (/仅(?:完成|导入)|基础集成/u.test(joined) && /data|mounted|created|模板|UI|绑定|状态/u.test(joined)) {
    signals.push("编码结果显示当前只完成了基础接线，但核心状态、生命周期或 UI 绑定仍未落实。");
  }
  if (visibleUiTask && claimsIntegratedDone && mentionsScriptOrApiWork && !mentionsViewLanding) {
    signals.push("编码结果总结只覆盖了脚本/接口层改动，未体现 template/UI 落地，疑似提早交卷。");
  }

  return Array.from(new Set(signals));
}

function collectCodeElisionIssues(relativePath: string, content: string): ValidationIssue[] {
  if (!/\.(vue|js|ts|jsx|tsx)$/i.test(relativePath)) return [];

  const lines = String(content || "").split(/\r?\n/);
  const suspiciousPatterns = [
    /^\s*\/\/\s*(?:\.\.\.|…+)(?:\s.*)?$/u,
    /^\s*\/\/.*(?:原有代码|其余代码|剩余代码|省略|略去|existing code|rest of code|other code|same as above|unchanged code).*$/iu,
    /^\s*\/\*+\s*(?:\.\.\.|…+|原有代码|其余代码|剩余代码|省略|略去|existing code|rest of code|other code|same as above|unchanged code).*?\*\/\s*$/iu,
    /^\s*\{\s*\/\*+\s*(?:\.\.\.|…+|原有代码|其余代码|剩余代码|省略|略去|existing code|rest of code|other code|same as above|unchanged code).*?\*\/\s*\}\s*$/iu,
    /^\s*<!--\s*(?:\.\.\.|…+|原有代码|其余代码|剩余代码|省略|略去|existing code|rest of code|other code|same as above|unchanged code).*?-->\s*$/iu,
    /^\s*\*+\s*(?:\.\.\.|…+|原有代码|其余代码|剩余代码|省略|略去|existing code|rest of code|other code).*$/iu,
  ];

  const hits = lines
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter((item) => suspiciousPatterns.some((pattern) => pattern.test(item.text)))
    .slice(0, 3);

  if (hits.length === 0) return [];

  const preview = hits.map((item) => `第 ${item.line} 行 ${item.text.trim()}`).join("；");
  return [{
    severity: "error",
    file: relativePath,
    message: `检测到疑似占位式省略代码：${preview}`,
    suggestion: "请保留未改动的真实源码，禁止使用 `// ...`、`/* ... */`、`<!-- ... -->`、`existing code`、`省略其余代码` 等占位符替代原有实现。",
    kind: "code_elision_placeholder",
  }];
}

function extractPermissionTokens(content: string): string[] {
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

function walkProjectFiles(projectPath: string, dirPath: string, acc: string[] = []): string[] {
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
      walkProjectFiles(projectPath, path.join(dirPath, entry.name), acc);
      continue;
    }
    if (/\.(vue|js|ts|tsx|jsx|json)$/i.test(entry.name)) {
      acc.push(path.join(dirPath, entry.name));
    }
  }

  return acc;
}

function countProjectTokenOccurrences(projectPath: string, token: string): number {
  if (!projectPath || !token) return 0;
  const pattern = new RegExp(escapeRegex(token), "g");
  let total = 0;

  for (const absolutePath of walkProjectFiles(projectPath, projectPath)) {
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

export function buildValidationReport(input: ValidationBuildInput): ValidationReport {
  const changed = collectChangedFiles(input.result, input.plan);
  const checkedFiles = Array.from(new Set([...changed.created, ...changed.modified])).filter(Boolean);
  const issues: ValidationIssue[] = [];
  const useAstGate = Boolean(input.useAstGate);
  const createdAbsolutePaths = new Set(changed.created.map((relativePath) => path.resolve(input.projectPath, relativePath)));
  const importedCreatedModules = new Set<string>();
  const incompleteSignals = collectIncompleteCodingSignals(input, input.result, input.plan);

  if (incompleteSignals.length > 0) {
    issues.push({
      severity: "error",
      file: input.targetComponentPath || checkedFiles[0] || "CODING",
      message: incompleteSignals[0],
      suggestion: "请继续完成组件内的数据初始化、方法接入和模板/UI 绑定，不要在 completion_summary 中保留“后续需补充”的半成品描述。",
      kind: "coding_result_incomplete",
    });
  }

  for (const relativePath of checkedFiles) {
    const absolutePath = path.resolve(input.projectPath, relativePath);
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
      const brief = analysis.diagnostics.slice(0, 2).map((item) => `第 ${item.line} 行 ${item.message}`).join("；");
      issues.push({
        severity: "error",
        file: relativePath,
        message: `AST/语法解析失败：${brief}`,
        suggestion: "请修复明显的语法问题、类型标注误用或 script 内容结构错误后再继续。",
        kind: "syntax_invalid",
      });
    }

    issues.push(...collectVueOptionsApiStructureIssues(relativePath, content));
    issues.push(...collectComponentInitFlowIssues(input, relativePath, content, input.plan));
    issues.push(...collectCodeElisionIssues(relativePath, content));

    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = line.match(/^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/);
      if (!match) return;

      const clause = match[1];
      const specifier = match[2];
      const resolved = resolveImportTarget(input.projectPath, relativePath, specifier);
      const shouldResolve =
        specifier.startsWith(".") ||
        specifier.startsWith("@/") ||
        isLikelyProjectAlias(input.projectPath, specifier);
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

      if (useAstGate && resolved && isCodeImportTarget(resolved)) {
        try {
          const targetContent = fs.readFileSync(resolved, "utf-8");
          const targetAnalysis = analyzeCodeFile(resolved, targetContent);
          const importInfo = parseImportClause(clause);

          if (importInfo.defaultImport && !(targetAnalysis.hasDefaultExport || hasDefaultExport(targetContent))) {
            issues.push({
              severity: "warning",
              file: relativePath,
              message: `第 ${index + 1} 行默认导入 \`${importInfo.defaultImport}\`，但目标模块未发现明显的 default export。`,
              suggestion: "请确认目标模块是否确实默认导出，或改为与项目现状一致的导入方式。",
              kind: "default_export_unverified",
            });
          }

          for (const exportName of importInfo.namedImports) {
            if (!(targetAnalysis.namedExports.includes(exportName) || hasNamedExport(targetContent, exportName))) {
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

      if (resolved && createdAbsolutePaths.has(resolved)) {
        importedCreatedModules.add(resolved);
        const importInfo = parseImportClause(clause);
        const importedBindings = [
          importInfo.defaultImport || "",
          importInfo.namespaceImport || "",
          ...importInfo.namedImports,
        ].filter(Boolean);

        if (importedBindings.length > 0 && !importedBindings.some((binding) => isImportedBindingUsed(relativePath, content, binding))) {
          issues.push({
            severity: "error",
            file: relativePath,
            message: `第 ${index + 1} 行引入了新建模块 \`${specifier}\`，但当前文件中未发现对应的实际调用或引用。`,
            suggestion: "请继续在组件逻辑中调用该新模块并完成状态/方法/UI 绑定，或删除无效 import，避免只完成接线而未真正实现功能。",
            kind: "created_module_import_unused",
          });
        }
      }
    });

    const permissionTokens = extractPermissionTokens(content);
    for (const token of permissionTokens) {
      const occurrenceCount = countProjectTokenOccurrences(input.projectPath, token);
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
      const apiStyleContract = input.getApiStyleContract(relativePath, 2);
      const preferredExt = apiStyleContract.preferredExt || input.detectPreferredExtensionForDirectory(relativePath);
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
      const usesDominantImport = dominant ? analysis.importSpecifiers.includes(dominant) : false;
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

  for (const relativePath of changed.created.filter((item) => /^src\/api\/.+\.(js|ts)$/i.test(item))) {
    const absolutePath = path.resolve(input.projectPath, relativePath);
    if (importedCreatedModules.has(absolutePath)) continue;
    issues.push({
      severity: "error",
      file: relativePath,
      message: "新建的 API 模块未被本轮修改文件实际引入，当前更像是只创建了封装但未接入页面逻辑。",
      suggestion: "请把该 API 模块真正接入目标组件或直接复用已有接口封装，不要留下未被消费的孤立 API 文件。",
      kind: "created_api_unwired",
    });
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
  const stats = [`校验文件 ${checkedFiles.length}`, `阻断问题 ${errorCount}`, `提醒 ${warningCount}`];

  return {
    checkedFiles,
    issues,
    hasBlockingIssues: errorCount > 0,
    summary,
    highlights,
    stats,
  };
}

export function buildValidationFixPrompt(report: ValidationReport): string {
  const blockingIssues = report.issues.filter((item) => item.severity === "error");
  return [
    "本地静态校验发现以下阻断问题，请只修复这些具体问题，不要扩散改动：",
    ...blockingIssues.map((item, index) =>
      `${index + 1}. 文件 ${item.file}：${item.message}${item.suggestion ? ` 建议：${item.suggestion}` : ""}`,
    ),
    "要求：优先复用目标项目已存在的导入路径、请求封装和代码风格；禁止臆造不存在的工具包或别名模块。",
    "要求：禁止用 `// ...`、`/* ... */`、`<!-- ... -->`、`existing code`、`省略其余代码` 这类占位式内容代替真实源码。",
    "修复完成后立即输出最终 JSON 交付结果。",
  ].join("\n");
}

export function shouldRunConsistencyReview(report: ValidationReport): boolean {
  return report.issues.some((item) =>
    item.severity === "warning" &&
    ["permission_token_unverified", "api_style_drift"].includes(item.kind || ""),
  );
}

export function buildConsistencyReviewPrompt(report: ValidationReport): string {
  const warningIssues = report.issues
    .filter((item) =>
      item.severity === "warning" &&
      ["permission_token_unverified", "api_style_drift"].includes(item.kind || ""),
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
