import { BaseAgent, LLMConfig } from "./base-agent";
import { MCPHub } from "../mcp-hub";
import { appendHarnessJsonl, summarizeText } from "../harness-logger";
import * as fs from "fs";

/**
 * 代码落地阶段。
 *
 * CoderAgent 的职责不是“给方案”，而是把前面三个阶段沉淀的证据真正写进代码库。
 * 它会把 PRD / API / PLAN / 项目风格快照压缩后喂给模型，并通过 BaseAgent 的写码守卫确保：
 * - 至少真的写到了目标文件
 * - 不是只补 import / data 就草草结束
 * - 对 Vue 组件场景，必要时必须补齐真实 template/UI 落点
 */
export class CoderAgent extends BaseAgent {
  protected getExecutionPolicy() {
    return {
      displayPhase: "编写代码",
      explorationBudget: 12,
      promptCharacterBudget: 18000,
      requiresRealWriteBeforeFinish: true,
      forceWriteRecovery: true,
      forceWriteExplorationBudget: 3,
    };
  }

  /**
   * 组织编码阶段输入。
   *
   * 这里做了三类关键裁剪：
   * 1. 压缩各阶段 artifact，避免 prompt 被大 JSON 淹没
   * 2. 推导 requiredWriteTargets / requiredRuntimeLinkTargets，交给 BaseAgent 收敛
   * 3. 生成一份“上下文充分 + 护栏适度”的 system prompt，让模型既能自主决策，也不会偏离项目契约
   */
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
    const pendingCreateFiles = planCreateFiles.filter((file: string) => {
      try {
        return !fs.existsSync(this.resolveProjectFilePath(file));
      } catch {
        return true;
      }
    });
    // focusFiles 决定“这一轮允许改哪些文件”；
    // requiredWriteTargets 则决定“不改到这些文件就不许结束”。
    const focusFiles = Array.from(
      new Set(
        [input.targetComponentPath || "", ...planModifyFiles, ...planCreateFiles].filter(Boolean),
      ),
    );
    const requiredWriteTargets = Array.from(
      new Set(
        [input.targetComponentPath || "", ...planModifyFiles, ...pendingCreateFiles].filter(Boolean),
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
      ),
      style_context: summarizeText(
        String(projectSnapshotArtifact.style_context || input.styleContext || ""),
      ),
      runtime_options: summarizeText(
        JSON.stringify(projectSnapshotArtifact.runtime_options || {}, null, 2),
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
      reasoning: summarizeText(String(planArtifact.reasoning || input.plan?.reasoning || "")),
      files_to_modify: Array.isArray(planArtifact.files_to_modify || input.plan?.files_to_modify)
        ? (planArtifact.files_to_modify || input.plan?.files_to_modify).slice(0, 6)
        : [],
      files_to_create: Array.isArray(planArtifact.files_to_create || input.plan?.files_to_create)
        ? (planArtifact.files_to_create || input.plan?.files_to_create).slice(0, 6)
        : [],
      operations_outline: Array.isArray(planArtifact.operations_outline)
        ? planArtifact.operations_outline.slice(0, 8)
        : [],
      api_coverage: Array.isArray(planArtifact.api_coverage)
        ? planArtifact.api_coverage.slice(0, 8)
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
    this.requiredWriteTargets = requiredWriteTargets;
    this.requiredSubstantiveWriteTargets = input.targetComponentPath
      ? [input.targetComponentPath]
      : focusFiles.slice(0, 1);
    const visibilitySignals = [
      input.query || "",
      compactPrdArtifact.content_verified,
      ...compactPrdArtifact.logic_rules,
      ...compactPrdArtifact.ui_requirements,
      ...compactPrdArtifact.placement_hints,
      ...compactApiArtifact.component_impact,
      compactProjectSnapshot.target_component_context,
      compactProjectSnapshot.style_context,
    ].join("\n");
    // 如果任务本质上是一个用户可见的前端能力，就要求至少完成一次真实的视图层接线。
    const requiresViewLayerClosure =
      Boolean(input.targetComponentPath) &&
      /\.vue$/i.test(input.targetComponentPath || "") &&
      (
        compactPrdArtifact.ui_requirements.length > 0 ||
        compactPrdArtifact.placement_hints.length > 0 ||
        /按钮|图标|弹窗|tooltip|toast|页面|视图|渲染|展示|点击|入口|列表|卡片|弹层|文案|显隐|交互|template|ui|button|icon|dialog|modal|drawer|popover|badge|render/i.test(
          visibilitySignals,
        )
      );
    this.requiredRuntimeLinkTargets =
      requiresViewLayerClosure && input.targetComponentPath
        ? [input.targetComponentPath]
        : [];
    this.setTargetComponentContext(
      String(projectSnapshotArtifact.target_component_context || input.targetComponentContext || ""),
    );

    const systemPrompt = `# 角色与核心哲学

你是一个运行在全自动工程流水线中的「顶级全栈架构师」与「前端领域专家」。
你的目标是以“外科手术般的精准度”将新的业务需求无缝融入现有的工程代码中。

## 📍 当前作战指令：全栈级功能闭环

优先目标文件：\`${primaryTarget}\`。
允许操作的文件范围：
${allowedFilesBlock}

你的核心任务是**真正写入代码**。作为架构师，你非常清楚：一个前端功能的交付，绝对不仅是加几个字段，而是【状态(State) -> 逻辑(Logic) -> 视图(View)】的完整闭环。

## 🎯 动态技术栈与专家直觉 (Expert Persona)

仔细阅读下方提供的【目标项目风格快照】和【目标组件关键片段】。你要像人类架构师一样，瞬间嗅探出当前项目的技术栈血液，并**完全化身该技术栈的骨灰级专家**进行编码：

- **若是 Vue 2 (Options API)**：自然地运用 \`data\`, \`methods\`, \`computed\`, \`watch\`，熟练处理 \`this\` 上下文，**绝不混入** \`setup\` 等组合式 API 写法。
- **项目基建复用**：绝不臆造项目里不存在的请求库，优先观察同目录其他文件是如何引入 \`api\` 或 \`utils\` 的，1:1 像素级复刻其导入风格。

## ⚔️ 编码铁律：三层击穿原则 (Definition of Done)

你由于思考速度太快，偶尔会犯下“只写了接口忘绑 UI”的低级失误。在对某个组件动刀时，必须连续调用工具，打穿这三个层面：
1. **Model 层 (数据/接口)**：补齐 \`import\`，在 \`data\` 中初始化变量，在 \`mounted/created\` 中发起请求。
2. **Controller 层 (交互逻辑)**：在 \`methods\` 中编写防抖、参数组装、错误捕获（try-catch）以及状态流转逻辑。
3. **View 层 (视图展示/模板)**：**【最容易遗漏的重点！】** 必须在 \`<template>\` 中找到合适的位置，插入按钮/图标、绑定点击事件 (\`@click\`)，并用刚才定义的变量控制显隐 (\`v-if\`) 和禁用 (\`:disabled\`) 状态！

**只要这三层有任何一层没写完，严禁交卷！必须发起下一轮工具调用继续修改！**
如果当前任务本质上只是接口、配置、类型或底层工具层修改，你可以明确判断 View 层不适用；但只要任务属于用户可见功能，就不能跳过真实模板落点。
在正式动刀前，你可以先做 1-2 次最小必要读取来确认技术栈、风格和真实锚点，不必机械按照固定顺序操作。

## 🔴 核心工具使用规范

1. **\`internal_structured_edit\`**: **首选利器**。专门处理高频稳定场景（新建文件、补 import、精确插入 data/methods 块、按锚点插入）。
2. **\`internal_surgical_edit\`**: **重构级手术刀**。当且仅当结构化编辑无法满足时使用。
🚨 **【致命红线】**: 无论使用哪种工具，在 \`content\` 或 \`replace\` 参数中，**严禁写入任何占位符**（如 \`// ...省略原有代码...\`）。必须保留修改范围内的所有真实代码，否则会破坏源文件！

## ✅ 强制出栈自检与最终交付

在你决定停止调用工具并准备交卷前，**必须**在 \`reasoning\` 字段中按顺序回答：
“我已核对：1. 接口已接入？ 2. 状态已声明？ 3. 逻辑已闭环？ 4. 模板 UI 已绑定？”
确认无误后，输出最终 JSON。

**最终 JSON 契约：**
{
  "reasoning": "出栈自检与中文总结",
  "files_to_create": [{ "path": "src/xxx", "content": "新建文件摘要" }],
  "files_to_modify": [{ "path": "src/yyy", "description": "修改点摘要" }],
  "operations_executed": ["create:xxx", "modify:yyy"],
  "verification_points": ["需要验证的关键行为"],
  "validation_summary": ["静态自检结果"],
  "completion_summary": "代码集成结果"
}

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
      ? [
          "filesystem:read_text_file",
          "filesystem:list_directory",
          "code-surgeon:get_file_outline",
          "code-surgeon:read_file_lines",
          "internal_structured_edit",
          "internal_surgical_edit",
        ]
      : [
          "filesystem:read_text_file",
          "filesystem:list_directory",
          "filesystem:directory_tree",
          "code-surgeon:get_file_outline",
          "code-surgeon:read_file_lines",
          "internal_structured_edit",
          "internal_surgical_edit",
        ];

    const codingPromptSnapshot = {
      runId: this.runId,
      agent: this.constructor.name,
      stage: "CODING",
      primaryTarget,
      focusFiles,
      requiredWriteTargets: this.requiredWriteTargets,
      requiredSubstantiveWriteTargets: this.requiredSubstantiveWriteTargets,
      requiredRuntimeLinkTargets: this.requiredRuntimeLinkTargets,
      requiresViewLayerClosure,
      toolPattern,
      promptChars: {
        system: systemPrompt.length,
        user: userPrompt.length,
        lessons: String(lessons || "").length,
        targetComponentContext: String(compactProjectSnapshot.target_component_context || "").length,
        styleContext: String(compactProjectSnapshot.style_context || "").length,
        prdFocusContext: String(input.prdFocusContext || "").length,
      },
      rawInput: {
        query: input.query || "",
        error: input.error || "",
        targetComponentPath: input.targetComponentPath || "",
        targetRoute: input.targetRoute || "",
        prd: input.prd,
        api: input.api,
        plan: input.plan,
        artifacts: input.artifacts || {},
        styleContext: input.styleContext || "",
        targetComponentContext: input.targetComponentContext || "",
        prdFocusContext: input.prdFocusContext || "",
      },
      compactEvidence: {
        compactPrd,
        compactApi,
        compactPrdArtifact,
        compactApiArtifact,
        compactPlanArtifact,
        compactProjectSnapshot,
      },
      promptPayload: {
        systemPrompt,
        userPrompt,
      },
    };
    appendHarnessJsonl("coding_evidence_flow.jsonl", {
      layer: "coder_prompt",
      ...codingPromptSnapshot,
    });
    this.traceRound({
      type: "coding_prompt_context",
      primaryTarget,
      focusFiles,
      requiredWriteTargets: this.requiredWriteTargets,
      requiredRuntimeLinkTargets: this.requiredRuntimeLinkTargets,
      requiresViewLayerClosure,
      toolPattern,
      systemPromptChars: systemPrompt.length,
      userPromptChars: userPrompt.length,
      compactEvidence: {
        compactPrdArtifact,
        compactApiArtifact,
        compactPlanArtifact,
        compactProjectSnapshot,
      },
    });

    // 真正的 round-loop、工具执行、强制收敛都由 BaseAgent.callLLM 接管。
    return await this.callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], onThought, toolPattern, 20);
  }
}
