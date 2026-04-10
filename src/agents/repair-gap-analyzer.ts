/**
 * 归一化后的交付缺口类别。
 *
 * 这些类型只描述“代码交付还缺哪一层”，不绑定任何具体业务场景。
 */
export type RepairGapType =
  | "none"
  | "missing_file_write"
  | "missing_substantive_write"
  | "missing_runtime_link"
  | "mixed";

/**
 * 最近一次成功写入的类别。
 *
 * 这让执行层可以分辨：
 * - 是不是一直停留在 import / script 层
 * - 是否真正触达了 runtime link
 */
export type RepairWriteCategory =
  | "file_create"
  | "runtime_link"
  | "substantive_script"
  | "import_only"
  | "noop"
  | "other";

export interface RepairGapAnalysis {
  gapType: RepairGapType;
  gapSignature: string;
  missingTargets: string[];
  hasBlockingGap: boolean;
  isRuntimeLinkOnly: boolean;
  buckets: {
    fileWrite: string[];
    substantive: string[];
    runtimeLink: string[];
  };
}

export interface RepairStagnationState {
  isStagnating: boolean;
  repeatedRounds: number;
  repeatedGapSignature: string;
  repeatedScriptOnlyWrites: boolean;
  runtimeLinkPending: boolean;
  shouldUpgradeInstruction: boolean;
}

const SUBSTANTIVE_SUFFIX = "（需完成非导入级实质修改）";
const RUNTIME_LINK_SUFFIX = "（需补齐与功能落点直接相关的脚本/模板接线）";

function normalizeGapTarget(target: string): string {
  return String(target || "")
    .replace(SUBSTANTIVE_SUFFIX, "")
    .replace(RUNTIME_LINK_SUFFIX, "")
    .trim();
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

export function analyzeRepairGaps(missingTargets: string[]): RepairGapAnalysis {
  const normalizedTargets = missingTargets.map((item) => String(item || "").trim()).filter(Boolean);
  const fileWrite: string[] = [];
  const substantive: string[] = [];
  const runtimeLink: string[] = [];

  for (const target of normalizedTargets) {
    if (target.includes(RUNTIME_LINK_SUFFIX)) {
      runtimeLink.push(normalizeGapTarget(target));
      continue;
    }
    if (target.includes(SUBSTANTIVE_SUFFIX)) {
      substantive.push(normalizeGapTarget(target));
      continue;
    }
    fileWrite.push(normalizeGapTarget(target));
  }

  const normalizedBuckets = {
    fileWrite: uniqueSorted(fileWrite),
    substantive: uniqueSorted(substantive),
    runtimeLink: uniqueSorted(runtimeLink),
  };

  const activeBucketCount = [
    normalizedBuckets.fileWrite.length,
    normalizedBuckets.substantive.length,
    normalizedBuckets.runtimeLink.length,
  ].filter((count) => count > 0).length;

  let gapType: RepairGapType = "none";
  if (activeBucketCount === 1) {
    if (normalizedBuckets.fileWrite.length > 0) gapType = "missing_file_write";
    if (normalizedBuckets.substantive.length > 0) gapType = "missing_substantive_write";
    if (normalizedBuckets.runtimeLink.length > 0) gapType = "missing_runtime_link";
  } else if (activeBucketCount > 1) {
    gapType = "mixed";
  }

  const gapSignature = JSON.stringify({
    fileWrite: normalizedBuckets.fileWrite,
    substantive: normalizedBuckets.substantive,
    runtimeLink: normalizedBuckets.runtimeLink,
  });

  return {
    gapType,
    gapSignature,
    missingTargets: normalizedTargets,
    hasBlockingGap: normalizedTargets.length > 0,
    isRuntimeLinkOnly: gapType === "missing_runtime_link",
    buckets: normalizedBuckets,
  };
}

export function classifyRepairWriteCategory(params: {
  writeKind: "create" | "modify" | null;
  isRuntimeLink: boolean;
  isSubstantive: boolean;
  isNoop: boolean;
}): RepairWriteCategory {
  if (params.isNoop) return "noop";
  if (params.writeKind === "create") return "file_create";
  if (params.isRuntimeLink) return "runtime_link";
  if (params.isSubstantive) return "substantive_script";
  if (params.writeKind === "modify") return "import_only";
  return "other";
}

/**
 * 根据最近几轮的缺口签名和写入类别判断是否已经停滞。
 *
 * 这里只做通用停滞判断，不理解任何业务词，也不对具体框架写死特殊规则。
 */
export function detectRepairStagnation(params: {
  recentGapSignatures: string[];
  currentAnalysis: RepairGapAnalysis;
  recentWriteCategories: RepairWriteCategory[];
}): RepairStagnationState {
  const signatures = [...params.recentGapSignatures, params.currentAnalysis.gapSignature].filter(Boolean);
  let repeatedRounds = 0;
  for (let index = signatures.length - 1; index >= 0; index--) {
    if (signatures[index] !== params.currentAnalysis.gapSignature) break;
    repeatedRounds++;
  }

  const trailingWriteCategories = params.recentWriteCategories.slice(-3);
  const repeatedScriptOnlyWrites =
    trailingWriteCategories.length >= 2 &&
    trailingWriteCategories.every((category) => category !== "runtime_link");
  const runtimeLinkPending =
    params.currentAnalysis.gapType === "missing_runtime_link" ||
    params.currentAnalysis.buckets.runtimeLink.length > 0;
  const isStagnating =
    params.currentAnalysis.hasBlockingGap &&
    repeatedRounds >= 2 &&
    (runtimeLinkPending || repeatedScriptOnlyWrites);

  return {
    isStagnating,
    repeatedRounds,
    repeatedGapSignature: params.currentAnalysis.gapSignature,
    repeatedScriptOnlyWrites,
    runtimeLinkPending,
    shouldUpgradeInstruction: runtimeLinkPending || isStagnating,
  };
}
