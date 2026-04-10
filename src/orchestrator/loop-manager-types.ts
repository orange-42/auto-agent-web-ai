/**
 * 单条本地校验问题。
 *
 * validation 阶段不会只返回“过 / 不过”，
 * 而是尽量把问题定位到具体文件、具体原因和建议修复方式。
 */
export interface ValidationIssue {
  severity: "error" | "warning";
  file: string;
  message: string;
  suggestion?: string;
  kind?: string;
}

/**
 * 一轮本地编码校验的聚合结果。
 *
 * orchestrator 会基于它判断：
 * 1. 是否允许直接进入 QA
 * 2. 是否应该触发 coder repair loop
 * 3. 最终应该向前端展示哪些摘要和高亮问题
 */
export interface ValidationReport {
  checkedFiles: string[];
  issues: ValidationIssue[];
  hasBlockingIssues: boolean;
  summary: string;
  highlights: string[];
  stats: string[];
}

/**
 * 传给 CoderAgent.execute 的标准输入。
 *
 * 这个结构刻意把 PRD / API / PLAN 和工程上下文放在一起，
 * 让 coder 在一个对象里拿齐“为什么改、改什么、在哪改、风格是什么”。
 */
export interface CodingExecutionInput {
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
}

/**
 * QA 阶段单条测试用例的执行结果。
 *
 * 这和 plan 里的“建议验证点”不同，
 * 这里描述的是实际执行后得到的 pass/fail/skipped 状态与证据。
 */
export interface QAResultCase {
  name?: string;
  status?: "passed" | "failed" | "skipped";
  evidence?: string;
}

/**
 * 项目里某个可启动 runtime 选项的摘要。
 *
 * 例如：
 * - `npm run dev`
 * - `pnpm preview`
 * - `yarn serve-dev`
 *
 * orchestrator 会给候选脚本打分，再挑一个最适合 QA 自动启动的入口。
 */
export interface ProjectRuntimeOption {
  scriptName: string;
  mode: string;
  commandPreview: string;
  portHints: number[];
  envFiles: string[];
  score: number;
}

/**
 * runtime 自动发现阶段的总产物。
 *
 * 这份结果会被 QA 预检复用，帮助系统回答：
 * - 当前项目更像 npm / pnpm / yarn 哪种生态
 * - 存在哪些 env 文件
 * - 哪些 scripts 看起来最适合本地起站
 */
export interface RuntimeDiscoveryResult {
  packageManager: "yarn" | "pnpm" | "npm";
  envFiles: string[];
  options: ProjectRuntimeOption[];
}
