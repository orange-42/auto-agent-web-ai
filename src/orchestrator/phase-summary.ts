import { summarizeText } from "../harness-logger";
import { QAResultCase } from "./loop-manager-types";

function toReadablePhaseSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

/**
 * 按阶段类型把原始结果翻译成时间线卡片数据。
 *
 * 这里是“结构化结果 -> 前端展示模型”的转换层：
 * - title / summary 负责一句话讲清结果
 * - highlights 负责列出最值得用户看的要点
 * - stats 负责展示量化信息，例如修改文件数、接口数、测试数
 */
export function buildPhaseSummary(label: string, result: any) {
  const phaseIndexMap: Record<string, number> = {
    INTENT: 0,
    PRD: 1,
    API: 2,
    PLAN: 3,
    CODING: 4,
    VERIFY: 5,
  };
  const index = phaseIndexMap[label];
  const highlights: string[] = [];
  const stats: string[] = [];
  let title = "";
  let summary = "";

  if (label === "PRD") {
    title = "需求摘要已生成";
    summary = toReadablePhaseSummary(result?.content_verified || result?.reasoning || "");
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
    if (Array.isArray(result?.placement_hints) && result.placement_hints.length > 0) {
      stats.push(`落点 ${result.placement_hints.length}`);
      highlights.push(...result.placement_hints.slice(0, 2).map((item: string) => `落点：${item}`));
    }
    if (Array.isArray(result?.dependency_checks) && result.dependency_checks.length > 0) {
      highlights.push(...result.dependency_checks.slice(0, 2).map((item: string) => `依赖：${item}`));
    }
  } else if (label === "API") {
    title = "接口映射已收敛";
    summary = toReadablePhaseSummary(result?.reasoning || "");
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
    summary = toReadablePhaseSummary(result?.reasoning || "");
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
    if (Array.isArray(result?.api_coverage) && result.api_coverage.length > 0) {
      stats.push(`接口决策 ${result.api_coverage.length}`);
      highlights.push(
        ...result.api_coverage.slice(0, 3).map((item: any) =>
          `接口决策：${item?.method || ""} ${item?.endpoint || ""} · ${item?.decision || "implement"}${item?.reason ? ` · ${item.reason}` : ""}`.trim(),
        ),
      );
    }
    if (Array.isArray(result?.verification_points) && result.verification_points.length > 0) {
      stats.push(`验证点 ${result.verification_points.length}`);
      highlights.push(...result.verification_points.slice(0, 2).map((item: string) => `验证：${item}`));
    }
    if (Array.isArray(result?.test_cases) && result.test_cases.length > 0) {
      stats.push(`测试用例 ${result.test_cases.length}`);
      highlights.push(
        ...result.test_cases.slice(0, 2).map((item: any) =>
          `用例：${item?.name || item?.goal || "未命名"}${item?.goal ? ` · ${item.goal}` : ""}`,
        ),
      );
    }
  } else if (label === "CODING") {
    title = "代码集成已执行";
    summary = toReadablePhaseSummary(
      result?.reasoning || result?.raw_content || JSON.stringify(result || {}),
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
  } else if (label === "VERIFY") {
    title = result?.overall_status === "failed"
      ? "自动化 QA 未通过"
      : result?.overall_status === "skipped"
        ? "自动化 QA 已跳过"
        : "自动化 QA 已完成";
    summary = toReadablePhaseSummary(result?.qa_summary || result?.reasoning || "");
    if (Array.isArray(result?.cases)) {
      const cases = result.cases as QAResultCase[];
      const passed = cases.filter((item) => item?.status === "passed").length;
      const failed = cases.filter((item) => item?.status === "failed").length;
      const skipped = cases.filter((item) => item?.status === "skipped").length;
      stats.push(`用例 ${cases.length}`);
      stats.push(`通过 ${passed}`);
      if (failed > 0) stats.push(`失败 ${failed}`);
      if (skipped > 0) stats.push(`跳过 ${skipped}`);
      highlights.push(
        ...cases.slice(0, 3).map((item) =>
          `用例：${item?.name || "未命名"} · ${item?.status || "unknown"}${item?.evidence ? ` · ${item.evidence}` : ""}`,
        ),
      );
    }
    if (Array.isArray(result?.blocked_reasons) && result.blocked_reasons.length > 0) {
      highlights.push(...result.blocked_reasons.slice(0, 2).map((item: string) => `受阻：${item}`));
    }
  } else {
    return null;
  }

  return {
    phase: label,
    index,
    title,
    summary: summary || `${label} 阶段已完成。`,
    highlights: Array.from(new Set(highlights)).slice(0, 6),
    stats,
  };
}

/**
 * 从阶段原始结果里提取一句“人类可读摘要”。
 *
 * 这句摘要会被重复用于：
 * - phase artifact 的 human summary
 * - debug snapshot 的阶段摘要
 * - replay 面板里对该阶段的简述
 */
export function buildHumanSummaryFromResult(label: string, result: any): string {
  const phaseSummary = buildPhaseSummary(label, result);
  if (phaseSummary) {
    return `${phaseSummary.title}：${phaseSummary.summary}`;
  }
  if (typeof result?.summary === "string" && result.summary.trim()) return result.summary.trim();
  if (typeof result?.reasoning === "string" && result.reasoning.trim()) {
    return summarizeText(result.reasoning);
  }
  return `${label} 阶段已完成。`;
}
