import {
  normalizeApiArtifact,
  normalizePlanArtifact,
  normalizePrdArtifact,
  normalizeProjectSnapshotArtifact,
} from "../phase-artifacts";
import {
  cloneForDebug,
  DebugRunSnapshot,
  ReplayStageName,
} from "../debug-run-store";
import { CodingExecutionInput } from "./loop-manager-types";

/**
 * 单阶段 replay 时，前端时间线仍然需要“当前处于第几步、显示什么标题”。
 *
 * 这类信息本质上是静态映射，和 orchestrator 实例状态无关，
 * 因此适合从主类中抽成一个独立的纯数据辅助函数。
 */
export interface ReplayStageDescriptor {
  index: number;
  title: string;
}

/**
 * 创建一份新的 debug snapshot 外壳。
 *
 * orchestrator 在正式流程和 replay 流程里都会创建快照，
 * 但它们的结构完全一致，只是 mode / replayOf 不同。
 * 这里统一封装，避免主流程里散落大段对象字面量。
 */
export function createDebugSnapshot(params: {
  runId: string;
  prompt: string;
  modelConfig: {
    type?: string;
    baseUrl: string;
    model?: string;
    modelId?: string;
    hasApiKey: boolean;
    qaConfig?: {
      envPreference?: string;
      baseUrl?: string;
      autoBoot?: boolean;
    };
  };
  context: {
    projectPath: string;
    targetRoute: string;
    targetComponentPath: string;
    taskObjective: string;
  };
  options?: {
    mode?: "full" | "replay";
    replayOf?: { runId: string; stage: ReplayStageName } | null;
  };
}): DebugRunSnapshot {
  const now = new Date().toISOString();
  return {
    runId: params.runId,
    mode: params.options?.mode || "full",
    replayOf: params.options?.replayOf || null,
    createdAt: now,
    updatedAt: now,
    status: "running",
    originalPrompt: params.prompt,
    modelConfig: cloneForDebug(params.modelConfig),
    context: cloneForDebug(params.context),
    artifacts: {},
    stages: {},
  };
}

/**
 * 返回一份更新了 status 的 snapshot 副本。
 *
 * 我们坚持在 helper 层返回新对象，而不是直接隐式修改调用方引用，
 * 这样 orchestrator 包装层更容易理解：拿到新快照 -> 赋值 -> 持久化。
 */
export function withDebugSnapshotStatus(
  snapshot: DebugRunSnapshot,
  status: string,
): DebugRunSnapshot {
  return {
    ...snapshot,
    status,
  };
}

/**
 * 把 patch 合并进 snapshot.context。
 *
 * replay / full pipeline 都会不断往 context 里补新信息，例如：
 * - planStyleContext
 * - replaySourceRunId
 * - targetComponentPath
 *
 * 这类增量写入适合统一成一个 helper，避免主类里重复展开对象。
 */
export function withMergedDebugContext(
  snapshot: DebugRunSnapshot,
  patch: Record<string, unknown>,
): DebugRunSnapshot {
  return {
    ...snapshot,
    context: {
      ...snapshot.context,
      ...cloneForDebug(patch),
    },
  };
}

/**
 * 把当前内存中的 phaseArtifacts 镜像到 snapshot.artifacts。
 *
 * debug snapshot 的价值在于“即使中途失败，也能回头看到当时每个阶段产物”。
 * 所以每次 artifact 更新后，我们都会同步一份快照副本。
 */
export function withSyncedDebugArtifacts(
  snapshot: DebugRunSnapshot,
  phaseArtifacts: Record<string, unknown>,
): DebugRunSnapshot {
  return {
    ...snapshot,
    artifacts: cloneForDebug(phaseArtifacts),
  };
}

/**
 * 往指定阶段追加一条 attempt 记录。
 *
 * attempt 记录用于回答“这一阶段到底试过几次、每次输入输出是什么、为什么失败”。
 * 它是 stage replay 排障时最关键的时间线证据之一。
 */
export function withAppendedDebugStageAttempt(
  snapshot: DebugRunSnapshot,
  stage: ReplayStageName,
  label: string,
  input?: unknown,
  output?: unknown,
  error?: string,
  meta?: Record<string, unknown>,
): DebugRunSnapshot {
  const existing = snapshot.stages[stage] || { attempts: [] };
  const attempts = Array.isArray(existing.attempts) ? existing.attempts : [];

  return {
    ...snapshot,
    stages: {
      ...snapshot.stages,
      [stage]: {
        ...existing,
        attempts: [
          ...attempts,
          {
            at: new Date().toISOString(),
            label,
            input: cloneForDebug(input),
            output: cloneForDebug(output),
            error,
            meta: meta ? cloneForDebug(meta) : undefined,
          },
        ],
      },
    },
  };
}

/**
 * 收口某个阶段最终对外可见的 replay 输入、输出、artifact 和摘要。
 *
 * attempt 是“过程日志”，finalize 则是“当前阶段最终定稿版”。
 * 前端详情页和后续 replay 更常读取这里，而不是逐条 attempts。
 */
export function withFinalizedDebugStage(
  snapshot: DebugRunSnapshot,
  stage: ReplayStageName,
  payload: {
    replayInput?: unknown;
    output?: unknown;
    artifact?: unknown;
    humanSummary?: string;
    meta?: Record<string, unknown>;
  },
): DebugRunSnapshot {
  const existing = snapshot.stages[stage] || { attempts: [] };
  const nextStageRecord = {
    ...existing,
  } as typeof existing;

  if (payload.replayInput !== undefined) {
    nextStageRecord.replay_input = cloneForDebug(payload.replayInput);
  }
  if (payload.output !== undefined) {
    nextStageRecord.output = cloneForDebug(payload.output);
  }
  if (payload.artifact !== undefined) {
    nextStageRecord.artifact = cloneForDebug(payload.artifact);
  }
  if (payload.humanSummary !== undefined) {
    nextStageRecord.human_summary = payload.humanSummary;
  }
  if (payload.meta) {
    nextStageRecord.meta = {
      ...(existing.meta || {}),
      ...cloneForDebug(payload.meta),
    };
  }

  return {
    ...snapshot,
    stages: {
      ...snapshot.stages,
      [stage]: nextStageRecord,
    },
  };
}

/**
 * 从历史 snapshot 还原 orchestrator 运行态需要的最小上下文。
 *
 * 这里不直接操作 orchestrator 实例，而是返回一份“可赋值的运行时快照”，
 * 让主类自己决定如何落回成员变量。
 */
export function deriveRuntimeStateFromSnapshot(snapshot: DebugRunSnapshot): {
  projectPath: string;
  targetRoute: string;
  targetComponentPath: string;
  taskObjective: string;
  phaseArtifacts: Record<string, unknown>;
} {
  const context = snapshot.context || {};
  return {
    projectPath: String(context.projectPath || ""),
    targetRoute: String(context.targetRoute || ""),
    targetComponentPath: String(context.targetComponentPath || ""),
    taskObjective: String(context.taskObjective || ""),
    phaseArtifacts: cloneForDebug(snapshot.artifacts || {}) as Record<string, unknown>,
  };
}

/**
 * 获取某个阶段在 UI 时间线中的标题和序号。
 *
 * 这是一份静态描述表，抽出去以后：
 * - loop-manager 主类更短
 * - replay 相关语义也更集中
 */
export function getReplayStageDescriptor(stage: ReplayStageName): ReplayStageDescriptor {
  const descriptors: Record<ReplayStageName, ReplayStageDescriptor> = {
    INTENT: { index: 0, title: "🧭 正在重放意图解析..." },
    PRD: { index: 1, title: "📄 正在重放需求解析..." },
    API: { index: 2, title: "🔌 正在重放接口解析..." },
    PLAN: { index: 3, title: "🗺️ 正在重放实施规划..." },
    CODING: { index: 4, title: "🛠️ 正在重放代码集成..." },
    VERIFY: { index: 5, title: "🧪 正在重放验证阶段..." },
  };
  return descriptors[stage];
}

/**
 * 当历史快照缺少 CODING.replay_input 时，尝试用 PLAN 阶段产物合成一份最小输入。
 *
 * 这是 replay 体验里非常关键的兜底：
 * 很多旧 run 没有把 coder 的输入完整落盘，但只要 PLAN / PROJECT_SNAPSHOT 还在，
 * 我们仍然可以拼出一份足够让 coder 再跑一次的输入。
 */
export function buildSyntheticCodingReplayInput(
  snapshot: DebugRunSnapshot,
): CodingExecutionInput | null {
  const artifacts = (snapshot.artifacts || {}) as Record<string, any>;
  const planStage = snapshot.stages?.PLAN;
  const planReplayInput = (planStage?.replay_input || {}) as Record<string, any>;
  const planOutput = planStage?.output || artifacts.PLAN?.artifact || {};
  const projectSnapshotArtifact = normalizeProjectSnapshotArtifact(
    artifacts.PROJECT_SNAPSHOT?.artifact || {},
  );
  const planArtifact = normalizePlanArtifact(
    artifacts.PLAN?.artifact || planOutput || {},
  );
  const prdArtifact = normalizePrdArtifact(
    planReplayInput.prd || artifacts.PRD?.artifact || snapshot.stages?.PRD?.output || {},
  );
  const apiArtifact = normalizeApiArtifact(
    planReplayInput.api || artifacts.API?.artifact || snapshot.stages?.API?.output || {},
  );

  const projectPath = String(snapshot.context?.projectPath || planReplayInput.projectPath || "").trim();
  const targetComponentPath = String(
    snapshot.context?.targetComponentPath || planReplayInput.targetComponentPath || "",
  ).trim();
  const targetRoute = String(snapshot.context?.targetRoute || planReplayInput.targetRoute || "").trim();
  const query = String(
    planReplayInput.query || snapshot.context?.taskObjective || snapshot.originalPrompt || "",
  ).trim();
  const targetComponentContext = String(
    planReplayInput.targetComponentContext || projectSnapshotArtifact.target_component_context || "",
  ).trim();
  const styleContext = String(
    snapshot.context?.planStyleContext || planReplayInput.styleContext || projectSnapshotArtifact.style_context || "",
  ).trim();
  const prdFocusContext = String(planReplayInput.prdFocusContext || "").trim();

  const hasPlanTargets =
    planArtifact.files_to_modify.length > 0 ||
    planArtifact.files_to_create.length > 0 ||
    planArtifact.operations_outline.length > 0;

  if (!projectPath || (!targetComponentPath && !hasPlanTargets)) {
    return null;
  }

  return {
    prd: prdArtifact,
    api: apiArtifact,
    plan: planArtifact,
    projectPath,
    query,
    targetComponentPath: targetComponentPath || undefined,
    targetRoute: targetRoute || undefined,
    targetComponentContext: targetComponentContext || undefined,
    styleContext: styleContext || undefined,
    prdFocusContext: prdFocusContext || undefined,
    artifacts: {
      intent: artifacts.INTENT?.artifact,
      prd: artifacts.PRD?.artifact || prdArtifact,
      api: artifacts.API?.artifact || apiArtifact,
      projectSnapshot: artifacts.PROJECT_SNAPSHOT?.artifact || projectSnapshotArtifact,
      plan: artifacts.PLAN?.artifact || planArtifact,
      code: artifacts.CODING?.artifact,
      verify: artifacts.VERIFY?.artifact,
    },
  };
}
