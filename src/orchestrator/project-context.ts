import * as fs from "fs";
import * as path from "path";
import { normalizeProjectSnapshotArtifact, ProjectSnapshotArtifact } from "../phase-artifacts";
import { isCodeImportTarget, resolveImportTarget } from "./coding-validation";
import { RuntimeDiscoveryResult } from "./loop-manager-types";

interface ProjectContextOptions {
  projectPath: string;
  taskObjective?: string;
  targetRoute?: string;
  targetComponentPath?: string;
  log?: (message: string) => void;
}

function escapeRegex(text: string): string {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenizeForSimilarity(text: string): string[] {
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

function scoreReferenceCandidate(targetRelativePath: string, candidateRelativePath: string): number {
  const targetTokens = tokenizeForSimilarity(targetRelativePath);
  const candidateTokens = tokenizeForSimilarity(candidateRelativePath);
  const targetSet = new Set(targetTokens);
  let score = 0;

  for (const token of candidateTokens) {
    if (targetSet.has(token)) score += 3;
  }

  if (path.dirname(targetRelativePath) === path.dirname(candidateRelativePath)) score += 2;
  if (path.extname(targetRelativePath) === path.extname(candidateRelativePath)) score += 1;

  return score;
}

function buildTargetContextKeywordRules(options: ProjectContextOptions): RegExp[] {
  const taskText = [options.taskObjective, options.targetRoute, options.targetComponentPath]
    .filter(Boolean)
    .join("\n");
  const stopwords = new Set([
    "and",
    "api",
    "button",
    "component",
    "data",
    "detail",
    "for",
    "from",
    "info",
    "list",
    "methods",
    "page",
    "route",
    "show",
    "state",
    "status",
    "template",
    "the",
    "this",
    "view",
  ]);

  const rawTokens = taskText
    .split(/[^a-zA-Z0-9\u4e00-\u9fa5/_:-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const routeSegments = String(options.targetRoute || "")
    .split(/[\/:_-]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  rawTokens.push(...routeSegments);

  const derivedRules = Array.from(new Set(rawTokens))
    .filter((token) => token.length >= 2 && !stopwords.has(token))
    .slice(0, 14)
    .map((token) => new RegExp(escapeRegex(token), /[A-Za-z]/.test(token) ? "i" : ""));

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

export function buildTargetComponentContext(options: ProjectContextOptions): string {
  if (!options.projectPath || !options.targetComponentPath) return "";

  const absolutePath = path.resolve(options.projectPath, options.targetComponentPath);
  if (!fs.existsSync(absolutePath)) return "";

  try {
    const raw = fs.readFileSync(absolutePath, "utf-8");
    const lines = raw.split(/\r?\n/);
    const snippets: string[] = [];
    const seenWindows = new Set<string>();
    const keywordRules = buildTargetContextKeywordRules(options);
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
      "[目标组件快照]",
      `文件：${options.targetComponentPath}`,
      `总行数：${lines.length}`,
      snippets.join("\n\n"),
    ]
      .filter(Boolean)
      .join("\n");

    return result.slice(0, 12000);
  } catch (error: any) {
    options.log?.(`Target component context prefetch failed: ${error.message}`);
    return "";
  }
}

export function extractPlanFilePaths(plan: any, field: "files_to_modify" | "files_to_create"): string[] {
  const source = Array.isArray(plan?.[field]) ? plan[field] : [];
  return source
    .map((item: any) => item?.path || item?.file || item?.target_file || "")
    .filter((item: string) => typeof item === "string" && item.trim().length > 0);
}

function pickReferenceFiles(options: ProjectContextOptions, targetRelativePath: string, limit: number = 2): string[] {
  if (!options.projectPath || !targetRelativePath) return [];

  const absoluteTarget = path.resolve(options.projectPath, targetRelativePath);
  const targetDir = path.dirname(absoluteTarget);
  if (!fs.existsSync(targetDir)) return [];

  const candidates = fs
    .readdirSync(targetDir)
    .filter((entry) => /\.(js|ts|tsx|vue)$/.test(entry))
    .map((entry) => path.join(targetDir, entry))
    .filter((absolutePath) => absolutePath !== absoluteTarget)
    .map((absolutePath) => ({
      absolutePath,
      relativePath: path.relative(options.projectPath, absolutePath),
      score: scoreReferenceCandidate(targetRelativePath, path.relative(options.projectPath, absolutePath)),
    }))
    .sort((a, b) => (b.score - a.score) || a.relativePath.localeCompare(b.relativePath));

  return candidates.slice(0, limit).map((item) => item.relativePath);
}

function summarizeComponentStyle(options: ProjectContextOptions, relativePath: string): string[] {
  if (!relativePath || !options.projectPath) return [];

  const absolutePath = path.resolve(options.projectPath, relativePath);
  if (!fs.existsSync(absolutePath)) return [];

  try {
    const content = fs.readFileSync(absolutePath, "utf-8");
    const hints: string[] = [];

    if (/<script>/.test(content) && /export\s+default\s*\{/.test(content)) {
      hints.push("目标组件是 Vue 单文件组件，当前以 Options API 结构为主。");
      hints.push("将当前组件视为“Vue2 Options API 技能场景”：禁止使用 `setup / defineComponent / ref / reactive / onMounted` 这类 Composition API 写法。");
      hints.push("禁止在 import 区和 `export default` 之间声明组件状态、带 `this` 的函数或游离生命周期片段；新增状态必须进入 `data()`，新增交互必须进入 `methods`。");
    }
    if (/^\s*data\s*\(\)\s*\{/m.test(content)) {
      hints.push("组件已有 data() 状态区，新增状态优先并入现有 data() 返回值。");
    }
    if (/^\s*methods:\s*\{/m.test(content)) {
      hints.push("组件已有 methods 区域，新增交互和接口方法应收敛到现有 methods 中。");
    }
    if (/^\s*(?:async\s+)?mounted\s*\(/m.test(content) || /^\s*(?:async\s+)?created\s*\(/m.test(content)) {
      hints.push("组件已存在初始化生命周期，若需加载接口数据，应优先补入现有 `mounted/created`，不要在组件外新写初始化函数。");
    }
    if (/props:\s*\{/.test(content)) {
      hints.push("组件依赖 props 传入上下文，新增逻辑前优先复用已有入参、页面上下文与现有数据流。");
    }
    if (/import\s+.*from\s+['"]@\//.test(content)) {
      hints.push("组件内部允许使用 @/ 别名，但新增依赖前仍需先确认目标路径真实存在。");
    }

    return hints.slice(0, 6);
  } catch (error: any) {
    options.log?.(`Component style summary failed: ${error.message}`);
    return [];
  }
}

function summarizeApiModuleStyle(options: ProjectContextOptions, referenceFiles: string[]): string[] {
  if (!options.projectPath || referenceFiles.length === 0) return [];

  const importPatternCounts = new Map<string, number>();
  const extensionCounts = new Map<string, number>();
  let getWithParamsCount = 0;
  let postWithDataCount = 0;

  for (const relativePath of referenceFiles) {
    const absolutePath = path.resolve(options.projectPath, relativePath);
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
      options.log?.(`API style summary failed for ${relativePath}: ${error.message}`);
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
    for (const referenceFile of referenceFiles) {
      const resolvedTransport = resolveImportTarget(options.projectPath, referenceFile, dominantImport[0]);
      if (!resolvedTransport || !isCodeImportTarget(resolvedTransport)) continue;
      try {
        const transportContent = fs.readFileSync(resolvedTransport, "utf-8");
        if (/interceptors\.response\.use/.test(transportContent) && /return\s+res\.msg\b/.test(transportContent)) {
          hints.push(`请求封装 \`${dominantImport[0]}\` 会在响应拦截器中直接返回业务数据，业务代码应直接使用返回值，不要再写 \`res.data\` / \`response.data\`。`);
          break;
        }
      } catch (error: any) {
        options.log?.(`API transport style summary failed for ${resolvedTransport}: ${error.message}`);
      }
    }
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

  return hints.slice(0, 5);
}

export function detectPreferredExtensionForDirectory(options: ProjectContextOptions, relativePath: string): string {
  if (!options.projectPath || !relativePath) return path.extname(relativePath);

  const absoluteDir = path.resolve(options.projectPath, path.dirname(relativePath));
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

export function getApiStyleContract(
  options: ProjectContextOptions,
  targetRelativePath: string,
  limit: number = 2,
): {
  referenceFiles: string[];
  dominantImport: string;
  preferredExt: string;
} {
  const referenceFiles = pickReferenceFiles(options, targetRelativePath, limit);
  const importPatternCounts = new Map<string, number>();
  const extensionCounts = new Map<string, number>();

  for (const relativePath of referenceFiles) {
    const absolutePath = path.resolve(options.projectPath, relativePath);
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
      options.log?.(`API style contract failed for ${relativePath}: ${error.message}`);
    }
  }

  const dominantImport =
    Array.from(importPatternCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const preferredExt =
    Array.from(extensionCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ||
    detectPreferredExtensionForDirectory(options, targetRelativePath);

  return {
    referenceFiles,
    dominantImport,
    preferredExt,
  };
}

function normalizeRelativePathToProjectStyle(options: ProjectContextOptions, relativePath: string): string {
  const normalized = String(relativePath || "").trim();
  if (!normalized) return normalized;
  if (!/^src\/api\//.test(normalized)) return normalized;

  const preferredExt = detectPreferredExtensionForDirectory(options, normalized);
  if (!preferredExt || ![".js", ".ts", ".tsx", ".jsx"].includes(preferredExt)) return normalized;

  const currentExt = path.extname(normalized);
  if (!currentExt) return `${normalized}${preferredExt}`;
  if ([".js", ".ts", ".tsx", ".jsx"].includes(currentExt) && currentExt !== preferredExt) {
    return `${normalized.slice(0, -currentExt.length)}${preferredExt}`;
  }
  return normalized;
}

export function normalizePlanToProjectStyle(options: ProjectContextOptions, plan: any): any {
  if (!plan || typeof plan !== "object") return plan;

  const clone = JSON.parse(JSON.stringify(plan));
  const normalizeEntries = (field: "files_to_modify" | "files_to_create") => {
    if (!Array.isArray(clone[field])) return;
    clone[field] = clone[field].map((item: any) => {
      if (!item || typeof item !== "object") return item;
      const next = { ...item };
      for (const key of ["path", "file", "target_file"]) {
        if (typeof next[key] === "string" && next[key].trim()) {
          next[key] = normalizeRelativePathToProjectStyle(options, next[key]);
        }
      }
      return next;
    });
  };

  normalizeEntries("files_to_modify");
  normalizeEntries("files_to_create");
  return clone;
}

export function buildStyleContext(options: ProjectContextOptions, plan: any): string {
  const hints: string[] = [];
  const targetFiles = Array.from(
    new Set([
      options.targetComponentPath,
      ...extractPlanFilePaths(plan, "files_to_modify"),
      ...extractPlanFilePaths(plan, "files_to_create"),
    ].filter((item): item is string => typeof item === "string" && item.trim().length > 0)),
  );

  hints.push(...summarizeComponentStyle(options, options.targetComponentPath || ""));

  const apiTargets = targetFiles.filter((item) => /^src\/api\//.test(item));
  for (const relativePath of apiTargets.slice(0, 2)) {
    const references = pickReferenceFiles(options, relativePath, 2);
    hints.push(...summarizeApiModuleStyle(options, references));
  }

  const dedupedHints = Array.from(new Set(hints)).filter(Boolean).slice(0, 8);
  if (dedupedHints.length === 0) return "";

  return ["[目标项目风格快照]", ...dedupedHints.map((item) => `- ${item}`)].join("\n");
}

function buildPermissionIndex(options: ProjectContextOptions, targetComponentContext: string): string[] {
  const tokens = new Set<string>();
  const sources = [targetComponentContext, options.taskObjective, options.targetComponentPath];
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

function buildConfigIndex(options: ProjectContextOptions): string[] {
  if (!options.projectPath || !fs.existsSync(options.projectPath)) return [];
  const candidates: string[] = [];
  const roots = ["src", "config", "src/config", "src/constants", "src/enums", "src/permission"];

  for (const root of roots) {
    const absoluteRoot = path.resolve(options.projectPath, root);
    if (!fs.existsSync(absoluteRoot)) continue;
    if (fs.statSync(absoluteRoot).isFile()) {
      candidates.push(path.relative(options.projectPath, absoluteRoot));
      continue;
    }

    for (const entry of fs.readdirSync(absoluteRoot)) {
      const absolutePath = path.join(absoluteRoot, entry);
      if (!fs.statSync(absolutePath).isFile()) continue;
      if (!/\.(js|ts|json|vue)$/i.test(entry)) continue;
      candidates.push(path.relative(options.projectPath, absolutePath));
      if (candidates.length >= 12) return candidates;
    }
  }

  return candidates.slice(0, 12);
}

function summarizeRuntimeOptions(discovery: RuntimeDiscoveryResult | null): string[] {
  if (!discovery) return [];
  return discovery.options
    .slice(0, 4)
    .map((option) => `${option.scriptName} [${option.mode}] -> ${option.commandPreview}`);
}

export function buildProjectSnapshotArtifact(
  options: ProjectContextOptions,
  targetComponentContext: string,
  styleContext: string,
  runtimeDiscovery: RuntimeDiscoveryResult | null,
): ProjectSnapshotArtifact {
  const permissionIndex = buildPermissionIndex(options, targetComponentContext);
  const configIndex = buildConfigIndex(options);
  const runtimeOptions = summarizeRuntimeOptions(runtimeDiscovery);
  const evidenceRefs = [
    options.targetComponentPath ? `核心组件：${options.targetComponentPath}` : "",
    options.targetRoute ? `目标路由：${options.targetRoute}` : "",
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
