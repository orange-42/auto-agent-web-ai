import fs from "fs";
import path from "path";
import { getHarnessDir, summarizeText } from "./harness-logger";
import { RunTokenUsageSummary, summarizeRunTokenUsage } from "./run-token-ledger";

export const REPLAY_STAGES = ["INTENT", "PRD", "API", "PLAN", "CODING", "VERIFY"] as const;

export type ReplayStageName = typeof REPLAY_STAGES[number];

export interface DebugStageAttempt {
  at: string;
  label: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface DebugStageRecord {
  replay_input?: unknown;
  output?: unknown;
  artifact?: unknown;
  human_summary?: string;
  meta?: Record<string, unknown>;
  attempts: DebugStageAttempt[];
}

export interface DebugRunSnapshot {
  runId: string;
  mode: "full" | "replay";
  replayOf?: {
    runId: string;
    stage: ReplayStageName;
  } | null;
  createdAt: string;
  updatedAt: string;
  status: string;
  originalPrompt: string;
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
  context: Record<string, unknown>;
  tokenUsage?: RunTokenUsageSummary;
  artifacts: Record<string, unknown>;
  stages: Partial<Record<ReplayStageName, DebugStageRecord>>;
}

export interface DebugRunSummary {
  runId: string;
  mode: "full" | "replay";
  replayOf?: {
    runId: string;
    stage: ReplayStageName;
  } | null;
  createdAt: string;
  updatedAt: string;
  status: string;
  model: string;
  baseUrl: string;
  projectPath: string;
  taskObjective: string;
  tokenUsage: RunTokenUsageSummary;
  replayableStages: ReplayStageName[];
}

function ensureDebugRunsDir(): string {
  const dir = path.join(getHarnessDir(), "debug-runs");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getDebugSnapshotPath(runId: string): string {
  return path.join(ensureDebugRunsDir(), `${runId}.snapshot.json`);
}

export function cloneForDebug<T>(value: T): T {
  if (value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return JSON.parse(JSON.stringify({ value: summarizeText(String(value || "")) })) as T;
  }
}

export function writeDebugRunSnapshot(snapshot: DebugRunSnapshot): void {
  const nextSnapshot: DebugRunSnapshot = {
    ...snapshot,
    updatedAt: new Date().toISOString(),
    // 快照持久化时顺手把 run 级 token 汇总写进去，
    // 这样列表接口、详情接口和离线排查都能直接拿到同一份统计口径。
    tokenUsage: summarizeRunTokenUsage(snapshot.runId),
  };
  fs.writeFileSync(
    getDebugSnapshotPath(snapshot.runId),
    JSON.stringify(nextSnapshot, null, 2),
    "utf-8",
  );
}

export function readDebugRunSnapshot(runId: string): DebugRunSnapshot | null {
  const snapshotPath = getDebugSnapshotPath(runId);
  if (!fs.existsSync(snapshotPath)) return null;

  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as DebugRunSnapshot;
    return {
      ...snapshot,
      tokenUsage: summarizeRunTokenUsage(runId),
    };
  } catch {
    return null;
  }
}

function canSynthesizeCodingReplay(snapshot: DebugRunSnapshot): boolean {
  const planStage = snapshot.stages?.PLAN;
  const planArtifact = (snapshot.artifacts as any)?.PLAN?.artifact || planStage?.output || {};
  const filesToModify = Array.isArray((planArtifact as any)?.files_to_modify) ? (planArtifact as any).files_to_modify : [];
  const filesToCreate = Array.isArray((planArtifact as any)?.files_to_create) ? (planArtifact as any).files_to_create : [];
  const operationsOutline = Array.isArray((planArtifact as any)?.operations_outline) ? (planArtifact as any).operations_outline : [];
  const projectPath = String(snapshot.context?.projectPath || (planStage?.replay_input as any)?.projectPath || "").trim();
  const targetComponentPath = String(
    snapshot.context?.targetComponentPath || (planStage?.replay_input as any)?.targetComponentPath || "",
  ).trim();

  return Boolean(
    projectPath &&
    (targetComponentPath || filesToModify.length > 0 || filesToCreate.length > 0 || operationsOutline.length > 0),
  );
}

export function summarizeDebugRunSnapshot(snapshot: DebugRunSnapshot): DebugRunSummary {
  const replayableStages = REPLAY_STAGES.filter((stage) => {
    if (snapshot.stages?.[stage]?.replay_input) return true;
    if (stage === "CODING") return canSynthesizeCodingReplay(snapshot);
    return false;
  });
  const tokenUsage = snapshot.tokenUsage || summarizeRunTokenUsage(snapshot.runId);
  return {
    runId: snapshot.runId,
    mode: snapshot.mode,
    replayOf: snapshot.replayOf || null,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    status: snapshot.status,
    model: String(snapshot.modelConfig?.model || snapshot.modelConfig?.modelId || ""),
    baseUrl: String(snapshot.modelConfig?.baseUrl || ""),
    projectPath: String(snapshot.context?.projectPath || ""),
    taskObjective: String(snapshot.context?.taskObjective || ""),
    tokenUsage,
    replayableStages,
  };
}

export function listDebugRunSnapshots(limit: number = 20): DebugRunSummary[] {
  const dir = ensureDebugRunsDir();
  const entries = fs.readdirSync(dir)
    .filter((file) => file.endsWith(".snapshot.json"))
    .map((file) => path.join(dir, file));

  const snapshots = entries
    .map((filePath) => {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as DebugRunSnapshot;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as DebugRunSnapshot[];

  return snapshots
    .sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.createdAt).getTime();
      const bTime = new Date(b.updatedAt || b.createdAt).getTime();
      return bTime - aTime;
    })
    .slice(0, Math.max(1, limit))
    .map((snapshot) => summarizeDebugRunSnapshot(snapshot));
}
