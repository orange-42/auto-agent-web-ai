import { BaseAgent, LLMConfig } from "./base-agent";
import { MCPHub } from "../mcp-hub";
import { summarizeText } from "../harness-logger";

export class CoderAgent extends BaseAgent {

  public async execute(input: { prd: any, api: any, plan: any, error?: string, projectPath: string, query?: string, targetComponentPath?: string, targetRoute?: string, targetComponentContext?: string, styleContext?: string, prdFocusContext?: string, artifacts?: any }, lessons: string, onThought?: (thought: string) => void): Promise<any> {
    const compactPrd = {
      content_verified: input.prd?.content_verified || "",
      logic_rules: Array.isArray(input.prd?.logic_rules) ? input.prd.logic_rules.slice(0, 5) : [],
      ui_requirements: Array.isArray(input.prd?.ui_requirements) ? input.prd.ui_requirements.slice(0, 5) : [],
      placement_hints: Array.isArray(input.prd?.placement_hints) ? input.prd.placement_hints.slice(0, 5) : [],
      dependency_checks: Array.isArray(input.prd?.dependency_checks) ? input.prd.dependency_checks.slice(0, 5) : [],
    };
    const compactApi = {
      api_mappings: Array.isArray(input.api?.api_mappings) ? input.api.api_mappings.slice(0, 5) : [],
      component_impact: Array.isArray(input.api?.component_impact) ? input.api.component_impact.slice(0, 5) : [],
      constraints: Array.isArray(input.api?.constraints) ? input.api.constraints.slice(0, 5) : [],
    };
    const planModifyFiles = Array.isArray(input.plan?.files_to_modify)
      ? input.plan.files_to_modify
          .map((item: any) => item?.path || item?.file || item?.target_file || "")
          .filter(Boolean)
      : [];
    const planCreateFiles = Array.isArray(input.plan?.files_to_create)
      ? input.plan.files_to_create
          .map((item: any) => item?.path || item?.file || item?.target_file || "")
          .filter(Boolean)
      : [];
    const focusFiles = Array.from(
      new Set(
        [input.targetComponentPath || "", ...planModifyFiles, ...planCreateFiles].filter(Boolean),
      ),
    );
    const primaryTarget = focusFiles[0] || input.targetComponentPath || "Unknown";
    const planArtifact = input.artifacts?.plan || input.plan || {};
    const projectSnapshotArtifact = input.artifacts?.projectSnapshot || {};
    const prdArtifact = input.artifacts?.prd || compactPrd;
    const apiArtifact = input.artifacts?.api || compactApi;
    const compactPrdArtifact = {
      content_verified: String(prdArtifact.content_verified || compactPrd.content_verified || ""),
      logic_rules: Array.isArray(prdArtifact.logic_rules || compactPrd.logic_rules)
        ? (prdArtifact.logic_rules || compactPrd.logic_rules).slice(0, 6)
        : [],
      ui_requirements: Array.isArray(prdArtifact.ui_requirements || compactPrd.ui_requirements)
        ? (prdArtifact.ui_requirements || compactPrd.ui_requirements).slice(0, 6)
        : [],
      placement_hints: Array.isArray(prdArtifact.placement_hints || compactPrd.placement_hints)
        ? (prdArtifact.placement_hints || compactPrd.placement_hints).slice(0, 6)
        : [],
      dependency_checks: Array.isArray(prdArtifact.dependency_checks || compactPrd.dependency_checks)
        ? (prdArtifact.dependency_checks || compactPrd.dependency_checks).slice(0, 6)
        : [],
      evidence_refs: Array.isArray(prdArtifact.evidence_refs)
        ? prdArtifact.evidence_refs.slice(0, 6)
        : [],
    };
    const compactApiArtifact = {
      api_mappings: Array.isArray(apiArtifact.api_mappings || compactApi.api_mappings)
        ? (apiArtifact.api_mappings || compactApi.api_mappings).slice(0, 6)
        : [],
      component_impact: Array.isArray(apiArtifact.component_impact || compactApi.component_impact)
        ? (apiArtifact.component_impact || compactApi.component_impact).slice(0, 6)
        : [],
      constraints: Array.isArray(apiArtifact.constraints || compactApi.constraints)
        ? (apiArtifact.constraints || compactApi.constraints).slice(0, 6)
        : [],
      evidence_refs: Array.isArray(apiArtifact.evidence_refs)
        ? apiArtifact.evidence_refs.slice(0, 6)
        : [],
    };
    const compactProjectSnapshot = {
      target_component_context: summarizeText(
        String(projectSnapshotArtifact.target_component_context || input.targetComponentContext || ""),
        3600,
      ),
      style_context: summarizeText(
        String(projectSnapshotArtifact.style_context || input.styleContext || ""),
        900,
      ),
      runtime_options: summarizeText(
        JSON.stringify(projectSnapshotArtifact.runtime_options || {}, null, 2),
        600,
      ),
      permission_index: Array.isArray(projectSnapshotArtifact.permission_index)
        ? projectSnapshotArtifact.permission_index.slice(0, 8)
        : [],
      config_index: Array.isArray(projectSnapshotArtifact.config_index)
        ? projectSnapshotArtifact.config_index.slice(0, 8)
        : [],
      evidence_refs: Array.isArray(projectSnapshotArtifact.evidence_refs)
        ? projectSnapshotArtifact.evidence_refs.slice(0, 6)
        : [],
    };
    const compactPlanArtifact = {
      reasoning: summarizeText(String(planArtifact.reasoning || input.plan?.reasoning || ""), 600),
      files_to_modify: Array.isArray(planArtifact.files_to_modify || input.plan?.files_to_modify)
        ? (planArtifact.files_to_modify || input.plan?.files_to_modify).slice(0, 6)
        : [],
      files_to_create: Array.isArray(planArtifact.files_to_create || input.plan?.files_to_create)
        ? (planArtifact.files_to_create || input.plan?.files_to_create).slice(0, 6)
        : [],
      operations_outline: Array.isArray(planArtifact.operations_outline)
        ? planArtifact.operations_outline.slice(0, 8)
        : [],
      verification_points: Array.isArray(planArtifact.verification_points || input.plan?.verification_points)
        ? (planArtifact.verification_points || input.plan?.verification_points).slice(0, 6)
        : [],
      test_cases: Array.isArray(planArtifact.test_cases)
        ? planArtifact.test_cases.slice(0, 4)
        : [],
      risk_flags: Array.isArray(planArtifact.risk_flags)
        ? planArtifact.risk_flags.slice(0, 6)
        : [],
    };
    const allowedFilesBlock = focusFiles.length > 0
      ? focusFiles.map((file: string) => `- ${file}`).join("\n")
      : "- 当前规划结果未给出明确文件，请先围绕核心组件收敛并完成写入";
    this.requiredWriteTargets = input.targetComponentPath
      ? [input.targetComponentPath]
      : [];

    const systemPrompt = `# 角色与核心哲学

你是一个运行在全自动工程流水线中的「顶级 AI 软件工程师」。你的目标是以“外科手术般的精准度”修改代码库。

## 📍 当前作战指令：高确定性落地模式

优先目标文件：\`${primaryTarget}\`。

允许修改或新增的文件范围：
${allowedFilesBlock}

如果规划结果不完整，但用户已经明确给出核心组件路径，你必须先完成该核心组件的集成落地，再按需补充其直接依赖文件。

你的目标不是继续写方案，而是**真正写入代码**，完成当前任务目标要求的系统集成。

**请务必始终使用中文进行思考 (Reasoning/Thought) 和回复。**

如果系统已经提供“目标组件关键片段”，优先围绕这些片段进行精确读取和修改。除非 search block 匹配失败，否则不要从文件开头顺序扫描整个大文件。

## 🎯 风格对齐要求

如果系统已经提供“目标项目风格快照”，你必须优先对齐目标项目现有风格后再写码：

- 不要臆造仓库中不存在的请求封装、路径别名、工具函数或基础模块。
- 新建 API 文件时，优先复用同目录已有的请求封装与导入写法。
- 新建文件扩展名必须跟同目录主流保持一致；如果同目录基本都是 .js，就不要创建 .ts。
- 修改组件时，优先沿用原文件已有的状态组织、methods 结构和命名风格。
- 如果不确定某个 import 是否存在，先做一次最小必要读取或参考系统给出的风格快照，再写入。

## 🔍 落地前自检清单

在输出最终 JSON 前，你必须做一轮极轻量自检，确保不要“主体功能对了，但落点和依赖没补齐”：

- 若 PRD 给出了“功能详述 / 表格 / 截图说明 / 页面区域”，按钮位置、文案、状态展示必须优先对齐这些细节。
- 若你引入了新的权限码、能力标识、枚举、配置键、状态字段，必须确认项目里已存在声明，或同步补齐其直接依赖位置。
- 若你新增了 import / API 方法 / 组件引用，必须确保目标模块确实存在对应导出，不要只在当前文件里调用。
- 如果证据只支持“主体功能”，但具体按钮位置、入口区域、权限声明位置仍不确定，必须先做一次最小必要补读，不能靠猜。
- 系统会在写码后执行 AST/语法级静态校验；如果你在 \`.js\` 文件中写入 TypeScript 标注、错误导入或非法语法，后续会被直接拦下。

## ✅ 收尾协议

当你确认真实代码已经写入完成后，必须立即停止继续扫描，并输出最终 JSON，而不是输出 Markdown 总结报告。

**最终 JSON 契约：**
{
  "reasoning": "本轮实际完成了哪些代码改动、为什么这样改、还有哪些风险（必须中文）",
  "files_to_create": [{ "path": "src/xxx", "content": "如为新建文件可给出概要或最终内容摘要" }],
  "files_to_modify": [{ "path": "src/yyy", "description": "本轮实际落地的修改点" }],
  "operations_executed": ["create:src/xxx", "modify:src/yyy"],
  "verification_points": ["需要验证的关键行为"],
  "validation_summary": ["本轮已完成的静态自检或仍需关注的点"],
  "completion_summary": "一句话总结本轮代码集成结果"
}

禁止输出“已完成报告”“实现清单”这类自由格式正文作为最终答案。

## 🗺️ 路径规则 (重要)

1. **自动锚定**: 你的工作目录已被锁定在项目根路径 \`${input.projectPath}\`。

2. **相对路径**: 在调用任何工具（filesystem, code-surgeon, internal_structured_edit, internal_surgical_edit）时，只需提供**相对于项目根目录**的路径（例如 \`src/api/user.js\`）。

3. **系统保障**: 系统会自动将你的相对路径解析为物理绝对路径。请千万不要尝试在路径前叠加 \`webapp/\` 或其他不在 PRD 定义中的前缀。

## 🔴 核心工具：结构化编辑器 + 外科手术刀

优先使用 \`internal_structured_edit\` 处理高频稳定场景：

- 新建文件
- 补 import
- 补 export
- 在模板锚点附近插入块
- 往 Vue 的 \`data / methods / computed / watch / components / root(如 mounted、created)\` 中补条目
- 按行号替换小范围代码块
- 更新对象字面量中的属性项

当且仅当你需要替换一个已经存在的完整代码块，而且结构化编辑不适用时，再使用 \`internal_surgical_edit\`。

**使用规范**：

1. **精确定位**: \`search\` 块必须与源文件中的内容 100% 匹配。

2. **即时校验**: 调用该工具后，系统会立刻返回执行结果。

3. **自我修复**: 如果 \`internal_surgical_edit\` 报错 "Search block not found"，必须立即使用 \`code-surgeon:read_file_lines\` 重新查看原始缩进，或改用 \`internal_structured_edit\` 的更稳定操作，严禁盲猜。

4. **锚点插入纪律**: 使用 \`insert_before_anchor / insert_after_anchor\` 时，\`content\` 只能提供“新增内容”，不要把 \`anchor\` 本身再次复制进 \`content\`。

5. **Vue 生命周期钩子**: 如果要给 \`export default\` 增加 \`mounted / created / beforeDestroy\` 这类根级选项，优先使用 \`ensure_vue_option_entry\`，并传入 \`section: "root"\`，不要为了补一个生命周期去整体替换 methods 结尾块。

6. **ensure_vue_option_entry 参数完整性**: 调用 \`ensure_vue_option_entry\` 时，必须同时提供 \`section\`、\`entry_key\`、\`content\` 三个字段。

7. **新建 API 文件纪律**: 新建 \`src/api/*\` 文件时，必须优先复用同目录真实存在的请求封装（如 \`./http\` 或 \`./axios\`）。如果 \`create_file\` 返回“当前目录主流请求封装为 XXX”，就直接按该路径修正并再次 \`create_file\`，禁止去读取一个尚未创建成功的新文件。

**【操作守则】**：

- **新建文件**: 将 \`search\` 参数设为空字符串 ""。

- **物理路径绝对忠诚**: 严格使用 PRD 要求的路径。

## 🔴 辅助工具

- \`code-surgeon:read_file_lines\`: 在必须精确对齐原文时补读小范围片段。
- \`internal_structured_edit\`: 优先处理导入、插入和 Vue option 条目写入。

- \`filesystem:read_text_file\`: 了解文件全局上下文。

- \`filesystem:list_directory\`: 探测目录结构。

**【上下文环境】**

${lessons}

`;

    const userPrompt = `【优先目标文件】: ${primaryTarget}

【目标路由】: ${input.targetRoute || "未明确提供"}

【核心组件】: ${input.targetComponentPath || "未明确提供"}

【目标组件关键片段】:
${compactProjectSnapshot.target_component_context || "暂未预取组件热点片段，请按需读取最小必要上下文。"}

【目标项目风格快照】:
${compactProjectSnapshot.style_context || "暂未生成风格快照，请优先复用目标文件所在目录中已有的 import 与封装风格。"}

【阶段工件摘要 - Intent】:
${JSON.stringify({
  taskObjective: input.artifacts?.intent?.taskObjective || input.query || "",
  targetRoute: input.artifacts?.intent?.targetRoute || input.targetRoute || "",
  targetComponentPath: input.artifacts?.intent?.targetComponentPath || input.targetComponentPath || "",
}, null, 2)}

【阶段工件摘要 - PRD】:
${JSON.stringify(compactPrdArtifact, null, 2)}

【阶段工件摘要 - API】:
${JSON.stringify(compactApiArtifact, null, 2)}

【阶段工件摘要 - Plan】:
${JSON.stringify(compactPlanArtifact, null, 2)}

【阶段工件摘要 - ProjectSnapshot】:
${JSON.stringify({
  runtime_options: compactProjectSnapshot.runtime_options,
  permission_index: compactProjectSnapshot.permission_index,
  config_index: compactProjectSnapshot.config_index,
  evidence_refs: compactProjectSnapshot.evidence_refs,
}, null, 2)}

【PRD 细节锚点】:
${input.prdFocusContext || "暂未抽取到额外 PRD 细节，请至少遵循业务规则并谨慎确认按钮落点与依赖项。"}

若实施方案来自系统兜底，请直接基于 PRD、API 和目标组件关键片段开始写码，不要再次回到“重新规划”状态。

【全局业务背景 (仅参考)】:

${input.artifacts
  ? "上方阶段工件已提供结构化 PRD/API/PLAN/ProjectSnapshot，上述信息无需再次展开。"
  : `PRD: ${JSON.stringify(compactPrd)}\n\nAPI: ${JSON.stringify(compactApi)}`}

【原始用户指令】: ${input.query || ""}

【执行反馈】: ${input.error || 'None'}`;

    const toolPattern = input.targetComponentContext
      ? ["code-surgeon:read_file_lines", "internal_structured_edit", "internal_surgical_edit"]
      : ["filesystem:read_text_file", "code-surgeon:read_file_lines", "internal_structured_edit", "internal_surgical_edit"];

    return await this.callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], onThought, toolPattern, 20);
  }
}
