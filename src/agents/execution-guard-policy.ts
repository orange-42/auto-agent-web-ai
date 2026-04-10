/**
 * 各阶段 Agent 的执行策略声明。
 *
 * BaseAgent 只消费这些抽象能力，不再直接认识具体类名。
 * 这样后续新增 Agent 或调整策略时，只需要在子类里声明配置即可。
 */
export interface AgentExecutionPolicy {
  displayPhase?: string;
  explorationBudget?: number | null;
  promptCharacterBudget?: number | null;
  requiresRealWriteBeforeFinish?: boolean;
  forceWriteRecovery?: boolean;
  forceConclusionOnExplorationSaturation?: boolean;
  forceWriteExplorationBudget?: number | null;
  readLoopSameRegionLimit?: number | null;
  readLoopFileVisitLimit?: number | null;
  readToolWeights?: Partial<Record<ReadLoopToolKind, number>>;
}

export type ReadLoopToolKind =
  | "read_text_file"
  | "read_file_lines"
  | "get_file_outline"
  | "read_file"
  | "other";

/**
 * 单轮读循环门禁配置。
 *
 * 这里把“多少次算高频读取”“不同读取工具各算多重”抽出来，
 * 避免这些数字继续硬编码在 ToolGatekeeper 里。
 */
export interface ReadLoopGuardConfig {
  sameRegionLimit: number;
  fileVisitLimit: number;
  fileVisitWeights: Record<ReadLoopToolKind, number>;
}

function normalizePositiveInteger(value: number | null | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.max(1, Math.floor(value));
  }
  return fallback;
}

export function resolveReadLoopToolKind(toolName: string): ReadLoopToolKind {
  const lowerName = String(toolName || "").toLowerCase();
  if (lowerName.includes("read_text_file")) return "read_text_file";
  if (lowerName.includes("read_file_lines")) return "read_file_lines";
  if (lowerName.includes("get_file_outline")) return "get_file_outline";
  if (lowerName.includes("read_file")) return "read_file";
  return "other";
}

export function getReadLoopWeight(toolName: string, config: ReadLoopGuardConfig): number {
  return config.fileVisitWeights[resolveReadLoopToolKind(toolName)] || config.fileVisitWeights.other || 1;
}

/**
 * 基于阶段策略推导读循环门禁配置。
 *
 * 规则是通用的：
 * - 默认同区域重复读取仍然保持保守拦截
 * - 单文件高频读取门槛和探索预算对齐
 * - 一次性全文读取的权重低于碎片化分段读取
 */
export function buildReadLoopGuardConfig(policy: AgentExecutionPolicy): ReadLoopGuardConfig {
  const explorationBudget = normalizePositiveInteger(policy.explorationBudget ?? null, 6);
  const sameRegionLimit = normalizePositiveInteger(policy.readLoopSameRegionLimit ?? null, 2);
  const fileVisitLimit = normalizePositiveInteger(
    policy.readLoopFileVisitLimit ?? null,
    Math.max(6, explorationBudget),
  );

  const defaultWeights: Record<ReadLoopToolKind, number> = {
    read_text_file: 0.5,
    read_file_lines: 1,
    get_file_outline: 0.75,
    read_file: 1,
    other: 1,
  };

  return {
    sameRegionLimit,
    fileVisitLimit,
    fileVisitWeights: {
      ...defaultWeights,
      ...(policy.readToolWeights || {}),
    },
  };
}
