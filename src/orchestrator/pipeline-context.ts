import { buildArtifactEnvelope, ProjectSnapshotArtifact } from "../phase-artifacts";
import { summarizeText } from "../harness-logger";
import { discoverProjectRuntimeOptions } from "./runtime-discovery";
import { RuntimeDiscoveryResult } from "./loop-manager-types";

export interface PipelineContextResult {
  sharedLessons: string;
  executionBrief: string;
  targetComponentContext: string;
  styleContext: string;
  runtimeDiscovery: RuntimeDiscoveryResult | null;
  baseProjectSnapshotArtifact: ProjectSnapshotArtifact;
}

/**
 * 准备整条主流程都会反复复用的“共享上下文”。
 *
 * 这一步本质上是在做一次 pipeline bootstrap：
 * - 拉历史 lessons
 * - 生成执行摘要
 * - 提取目标组件热点代码
 * - 构造项目风格快照
 * - 发现本地运行时候选
 * - 同步 debug snapshot / trace
 *
 * 这些工作虽然不是某个业务阶段本身，但又是阶段启动前必须完成的准备动作，
 * 所以适合独立成模块，避免 loop-manager 把准备细节全写在 run() 里。
 */
export function preparePipelineRunContext(params: {
  originalPrompt: string;
  projectPath: string;
  targetRoute: string;
  targetComponentPath: string;
  phaseArtifactsEnabled: boolean;
  getRelevantLessons: (query: any) => string;
  buildLessonQuery: (originalPrompt: string, stage?: any, extra?: Record<string, unknown>) => any;
  buildExecutionBrief: () => string;
  buildTargetComponentContext: () => string;
  buildStyleContext: (plan: any) => string;
  buildProjectSnapshotArtifact: (
    targetComponentContext: string,
    styleContext: string,
    runtimeDiscovery: RuntimeDiscoveryResult | null,
  ) => ProjectSnapshotArtifact;
  setPhaseArtifact: (phase: "PROJECT_SNAPSHOT", envelope: any) => void;
  trace: (type: string, payload: Record<string, unknown>) => void;
  updateDebugContext: (patch: Record<string, unknown>) => void;
}): PipelineContextResult {
  const sharedLessons = params.getRelevantLessons(
    params.buildLessonQuery(params.originalPrompt, undefined, {
      extraText: `${params.targetComponentPath}\n${params.targetRoute}`,
    }),
  );
  const executionBrief = params.buildExecutionBrief();
  const targetComponentContext = params.buildTargetComponentContext();
  const styleContext = params.buildStyleContext({});
  const runtimeDiscovery = discoverProjectRuntimeOptions(params.projectPath);
  const baseProjectSnapshotArtifact = params.buildProjectSnapshotArtifact(
    targetComponentContext,
    styleContext,
    runtimeDiscovery,
  );

  if (params.phaseArtifactsEnabled) {
    params.setPhaseArtifact(
      "PROJECT_SNAPSHOT",
      buildArtifactEnvelope("PLAN", "已生成基础项目快照，供规划与编码阶段复用。", baseProjectSnapshotArtifact),
    );
  }

  params.trace("lessons_loaded", {
    chars: sharedLessons.length,
    preview: summarizeText(sharedLessons),
  });
  params.trace("target_component_context", {
    path: params.targetComponentPath,
    chars: targetComponentContext.length,
    preview: summarizeText(targetComponentContext),
  });
  params.trace("style_context", {
    chars: styleContext.length,
    preview: summarizeText(styleContext),
  });
  params.updateDebugContext({
    originalPrompt: params.originalPrompt,
    sharedLessons,
    executionBrief,
    targetComponentContext,
    styleContext,
    runtimeDiscovery,
  });

  return {
    sharedLessons,
    executionBrief,
    targetComponentContext,
    styleContext,
    runtimeDiscovery,
    baseProjectSnapshotArtifact,
  };
}

/**
 * 追加在线 Hermes checkpoint lessons。
 *
 * 这个 helper 非常小，但它把“如何拼接注入文本”从 orchestrator 里拿走，
 * 让主流程只表达“某阶段结束后，如果有 checkpoint，就把它并入 shared lessons”。
 */
export function mergeCheckpointLessons(sharedLessons: string, checkpointLessons: string): string {
  if (!checkpointLessons) return sharedLessons;
  return sharedLessons ? `${sharedLessons}\n\n${checkpointLessons}` : checkpointLessons;
}
