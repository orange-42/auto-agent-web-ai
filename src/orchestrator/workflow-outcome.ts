import { summarizeText } from "../harness-logger";

/**
 * 成功收口。
 *
 * 把“更新 snapshot -> 跑 Hermes -> 广播完成”这组固定动作收敛成一个 helper，
 * 这样 orchestrator 主流程里就只剩一句“成功后怎么收口”。
 */
export async function finalizeWorkflowSuccess(params: {
  runHermesEvolution: (workflowStatus: "success", finalMessage?: string) => Promise<void>;
  updateDebugSnapshotStatus: (status: string) => void;
  emitWorkflowComplete: (status: string, message?: string) => void;
}): Promise<void> {
  params.updateDebugSnapshotStatus("success");
  await params.runHermesEvolution("success");
  params.emitWorkflowComplete("success");
}

/**
 * 中断收口。
 *
 * 这里和 error 的最大差别是：
 * - 状态标记为 aborted
 * - Hermes 不再调用大模型，只保留轻量本地复盘
 */
export async function finalizeWorkflowAbort(params: {
  runHermesEvolution: (
    workflowStatus: "aborted",
    finalMessage?: string,
    options?: { allowLLM?: boolean },
  ) => Promise<void>;
  updateDebugSnapshotStatus: (status: string) => void;
  emitWorkflowComplete: (status: string, message?: string) => void;
}): Promise<void> {
  params.updateDebugSnapshotStatus("aborted");
  await params.runHermesEvolution("aborted", "Workflow Aborted", { allowLLM: false });
  params.emitWorkflowComplete("error", "Workflow Aborted");
}

/**
 * 失败收口。
 *
 * 把错误 trace、snapshot 更新、Hermes 失败复盘和 UI 广播打包在一起，
 * 让 run() 的 catch 分支不再堆控制细节。
 */
export async function finalizeWorkflowError(params: {
  error: unknown;
  trace: (type: string, payload: Record<string, unknown>) => void;
  runHermesEvolution: (workflowStatus: "error", finalMessage?: string) => Promise<void>;
  updateDebugSnapshotStatus: (status: string) => void;
  emitWorkflowComplete: (status: string, message?: string) => void;
}): Promise<void> {
  const errorMessage = String((params.error as any)?.message || "unknown");
  params.trace("workflow_error", {
    message: errorMessage,
    stack: summarizeText((params.error as any)?.stack || ""),
  });
  params.updateDebugSnapshotStatus("error");
  await params.runHermesEvolution("error", errorMessage);
  params.emitWorkflowComplete("error", errorMessage);
}
