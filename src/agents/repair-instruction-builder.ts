import { RepairGapAnalysis, RepairStagnationState } from "./repair-gap-analyzer";
import { UiAnchorHint } from "./ui-anchor-hints";

export interface RepairInstructionContext {
  missingTargets: string[];
  gapAnalysis: RepairGapAnalysis;
  stagnationState: RepairStagnationState;
  targetPath?: string;
  uiAnchorHints?: UiAnchorHint[];
  forceWriteExplorationBudget: number;
  fallbackInstruction: string;
}

export interface RepairInstructionDecision {
  content: string;
  upgraded: boolean;
  reason: string;
}

function formatUiAnchorHints(hints: UiAnchorHint[]): string {
  if (hints.length === 0) return "";
  return [
    "以下是从当前组件结构中提炼出的通用候选落点，请优先围绕这些位置下刀：",
    ...hints.map((hint, index) => `${index + 1}. [${hint.kind}] ${hint.summary} 锚点示例：${hint.anchor}`),
  ].join("\n");
}

function buildRuntimeLinkInstruction(context: RepairInstructionContext): string {
  const anchorHintsBlock = formatUiAnchorHints(context.uiAnchorHints || []);
  return [
    "当前主缺口是真实功能落点，而不是继续补 script。",
    context.targetPath ? `优先目标文件：${context.targetPath}` : "",
    "下一步优先把视图层/交互入口真正接到目标组件上：模板展示区、点击入口、显隐绑定、禁用态、状态回流至少要落一处真实代码。",
    `如仍缺少局部锚点，只允许最多 ${context.forceWriteExplorationBudget} 次最小必要补读，然后立即继续写入。`,
    "优先使用 internal_structured_edit 的 insert_before_anchor / insert_after_anchor / replace_range_by_lines；如果结构化插入无法稳定命中，再使用 internal_surgical_edit。",
    context.stagnationState.isStagnating
      ? "最近多轮缺口没有变化，禁止继续重复 import / data / methods / computed 这类 script-only 写入。"
      : "",
    anchorHintsBlock,
    "补齐真实落点后，再决定是否输出最终 JSON。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSubstantiveWriteInstruction(context: RepairInstructionContext): string {
  return [
    "当前仍缺少真实的实质修改，不能停留在导入补齐或空操作层面。",
    context.targetPath ? `优先目标文件：${context.targetPath}` : "",
    "请把修改推进到真实状态承接、逻辑实现或功能落点，不要重复提交 import/noop 类修改。",
    `如仍缺上下文，只允许最多 ${context.forceWriteExplorationBudget} 次最小必要补读后立即写入。`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFileWriteInstruction(context: RepairInstructionContext): string {
  return [
    "当前仍缺少关键目标文件的真实写入。",
    context.targetPath ? `优先目标文件：${context.targetPath}` : "",
    "请直接回到目标文件执行创建或精确修改，不要继续泛化搜索。",
    `必要时最多补读 ${context.forceWriteExplorationBudget} 次，然后立刻写入。`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 把“还差什么”翻译成“下一步该怎么做”的通用修复指令。
 *
 * 这里的语义只围绕交付缺口类型展开，不理解任何业务词。
 */
export function buildRepairInstruction(context: RepairInstructionContext): RepairInstructionDecision {
  if (!context.gapAnalysis.hasBlockingGap) {
    return {
      content: context.fallbackInstruction,
      upgraded: false,
      reason: "no_blocking_gap",
    };
  }

  if (context.gapAnalysis.gapType === "missing_runtime_link") {
    return {
      content: buildRuntimeLinkInstruction(context),
      upgraded: true,
      reason: context.stagnationState.isStagnating ? "runtime_link_stagnation" : "runtime_link_gap",
    };
  }

  if (context.gapAnalysis.gapType === "missing_substantive_write") {
    return {
      content: buildSubstantiveWriteInstruction(context),
      upgraded: context.stagnationState.isStagnating,
      reason: context.stagnationState.isStagnating ? "substantive_stagnation" : "substantive_gap",
    };
  }

  if (context.gapAnalysis.gapType === "missing_file_write") {
    return {
      content: buildFileWriteInstruction(context),
      upgraded: context.stagnationState.isStagnating,
      reason: context.stagnationState.isStagnating ? "file_write_stagnation" : "file_write_gap",
    };
  }

  if (context.gapAnalysis.gapType === "mixed") {
    return {
      content: [
        buildFileWriteInstruction(context),
        buildSubstantiveWriteInstruction(context),
        context.stagnationState.runtimeLinkPending ? buildRuntimeLinkInstruction(context) : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      upgraded: context.stagnationState.shouldUpgradeInstruction,
      reason: context.stagnationState.shouldUpgradeInstruction ? "mixed_gap_upgraded" : "mixed_gap",
    };
  }

  return {
    content: context.fallbackInstruction,
    upgraded: false,
    reason: "fallback",
  };
}
