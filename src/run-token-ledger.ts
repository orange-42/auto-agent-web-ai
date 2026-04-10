import fs from "fs";
import path from "path";
import { appendHarnessJsonl, getHarnessDir } from "./harness-logger";

export interface TokenUsageBucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  llmCalls: number;
  llmCallsWithUsage: number;
}

export interface RunTokenUsageSummary {
  runId: string;
  source: "live_ledger" | "raw_log_fallback" | "none";
  coverage: "complete" | "partial" | "none";
  primary: TokenUsageBucket;
  auxiliary: TokenUsageBucket;
  combined: TokenUsageBucket;
}

export interface RunTokenUsageEntry {
  runId: string;
  agent: string;
  round: number;
  model?: string;
  durationMs?: number;
  status?: string;
  finishReasons?: string[];
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
  hasUsage: boolean;
}

interface MutableBucket extends TokenUsageBucket {}

interface RawFallbackCacheValue {
  mtimeMs: number;
  summary: RunTokenUsageSummary;
}

const LEDGER_FILE_NAME = "run-token-usage.jsonl";
const RAW_LOG_FILE_NAME = "llm_raw_traffic.log";
const rawFallbackCache = new Map<string, RawFallbackCacheValue>();

function getLedgerPath(): string {
  return path.join(getHarnessDir(), LEDGER_FILE_NAME);
}

function getRawLogPath(): string {
  return path.join(getHarnessDir(), RAW_LOG_FILE_NAME);
}

function createEmptyBucket(): MutableBucket {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    llmCalls: 0,
    llmCallsWithUsage: 0,
  };
}

function cloneBucket(bucket: TokenUsageBucket): TokenUsageBucket {
  return {
    promptTokens: bucket.promptTokens,
    completionTokens: bucket.completionTokens,
    totalTokens: bucket.totalTokens,
    cachedPromptTokens: bucket.cachedPromptTokens,
    reasoningTokens: bucket.reasoningTokens,
    llmCalls: bucket.llmCalls,
    llmCallsWithUsage: bucket.llmCallsWithUsage,
  };
}

function toNonNegativeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }
  return 0;
}

function classifyRunId(parentRunId: string, candidateRunId: string): "primary" | "auxiliary" | null {
  if (!candidateRunId) return null;
  if (candidateRunId === parentRunId) return "primary";
  if (candidateRunId.startsWith(`${parentRunId}__`)) return "auxiliary";
  return null;
}

function accumulateEntry(
  bucket: MutableBucket,
  entry: {
    hasUsage: boolean;
    promptTokens?: unknown;
    completionTokens?: unknown;
    totalTokens?: unknown;
    cachedPromptTokens?: unknown;
    reasoningTokens?: unknown;
  },
) {
  bucket.llmCalls += 1;
  if (!entry.hasUsage) return;

  bucket.llmCallsWithUsage += 1;
  bucket.promptTokens += toNonNegativeNumber(entry.promptTokens);
  bucket.completionTokens += toNonNegativeNumber(entry.completionTokens);
  bucket.totalTokens += toNonNegativeNumber(entry.totalTokens);
  bucket.cachedPromptTokens += toNonNegativeNumber(entry.cachedPromptTokens);
  bucket.reasoningTokens += toNonNegativeNumber(entry.reasoningTokens);
}

function finalizeSummary(
  runId: string,
  source: RunTokenUsageSummary["source"],
  primary: MutableBucket,
  auxiliary: MutableBucket,
): RunTokenUsageSummary {
  const combined: MutableBucket = createEmptyBucket();
  combined.promptTokens = primary.promptTokens + auxiliary.promptTokens;
  combined.completionTokens = primary.completionTokens + auxiliary.completionTokens;
  combined.totalTokens = primary.totalTokens + auxiliary.totalTokens;
  combined.cachedPromptTokens = primary.cachedPromptTokens + auxiliary.cachedPromptTokens;
  combined.reasoningTokens = primary.reasoningTokens + auxiliary.reasoningTokens;
  combined.llmCalls = primary.llmCalls + auxiliary.llmCalls;
  combined.llmCallsWithUsage = primary.llmCallsWithUsage + auxiliary.llmCallsWithUsage;

  const coverage: RunTokenUsageSummary["coverage"] =
    combined.llmCalls === 0
      ? "none"
      : combined.llmCallsWithUsage === combined.llmCalls
        ? "complete"
        : combined.llmCallsWithUsage > 0
          ? "partial"
          : "none";

  return {
    runId,
    source,
    coverage,
    primary: cloneBucket(primary),
    auxiliary: cloneBucket(auxiliary),
    combined: cloneBucket(combined),
  };
}

function parseJsonlLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readLiveLedgerSummary(runId: string): RunTokenUsageSummary | null {
  const ledgerPath = getLedgerPath();
  if (!fs.existsSync(ledgerPath)) return null;

  const primary = createEmptyBucket();
  const auxiliary = createEmptyBucket();

  try {
    const lines = fs.readFileSync(ledgerPath, "utf-8").split("\n");
    for (const line of lines) {
      const entry = parseJsonlLine(line);
      if (!entry) continue;
      const bucketName = classifyRunId(runId, String(entry.runId || ""));
      if (!bucketName) continue;
      accumulateEntry(bucketName === "primary" ? primary : auxiliary, {
        hasUsage: Boolean(entry.hasUsage),
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        totalTokens: entry.totalTokens,
        cachedPromptTokens: entry.cachedPromptTokens,
        reasoningTokens: entry.reasoningTokens,
      });
    }
  } catch {
    return null;
  }

  if (primary.llmCalls === 0 && auxiliary.llmCalls === 0) return null;
  return finalizeSummary(runId, "live_ledger", primary, auxiliary);
}

function readRawFallbackSummary(runId: string): RunTokenUsageSummary {
  const rawLogPath = getRawLogPath();
  if (!fs.existsSync(rawLogPath)) {
    return finalizeSummary(runId, "none", createEmptyBucket(), createEmptyBucket());
  }

  const stat = fs.statSync(rawLogPath);
  const cached = rawFallbackCache.get(runId);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.summary;
  }

  const primary = createEmptyBucket();
  const auxiliary = createEmptyBucket();
  let activeRunId = "";

  // 这段 fallback 专门服务于“旧 run 还没有独立 token ledger”的场景。
  // raw traffic 日志本身已经按 `runId=... agent=...` 做了分段，因此我们只要在分段范围内
  // 捕捉每次带 `finish_reason` 的最终流式事件，就可以把 usage 回捞出来。
  try {
    const lines = fs.readFileSync(rawLogPath, "utf-8").split("\n");
    for (const line of lines) {
      const markerMatch = line.match(/runId=([^\s]+)\s+agent=/);
      if (markerMatch) {
        activeRunId = markerMatch[1] || "";
        continue;
      }

      const bucketName = classifyRunId(runId, activeRunId);
      if (!bucketName || !line.startsWith("data: ") || line.includes("[DONE]")) continue;

      let payload: any = null;
      try {
        payload = JSON.parse(line.slice(6));
      } catch {
        continue;
      }

      const finishReason = payload?.choices?.[0]?.finish_reason;
      if (!finishReason) continue;

      const bucket = bucketName === "primary" ? primary : auxiliary;
      bucket.llmCalls += 1;

      const usage = payload?.usage;
      if (!usage || typeof usage !== "object") continue;

      bucket.llmCallsWithUsage += 1;
      bucket.promptTokens += toNonNegativeNumber(usage.prompt_tokens);
      bucket.completionTokens += toNonNegativeNumber(usage.completion_tokens);
      bucket.totalTokens += toNonNegativeNumber(usage.total_tokens);
      bucket.cachedPromptTokens += toNonNegativeNumber(usage.prompt_tokens_details?.cached_tokens);
      bucket.reasoningTokens += toNonNegativeNumber(usage.completion_tokens_details?.reasoning_tokens);
    }
  } catch {
    const empty = finalizeSummary(runId, "none", createEmptyBucket(), createEmptyBucket());
    rawFallbackCache.set(runId, { mtimeMs: stat.mtimeMs, summary: empty });
    return empty;
  }

  const summary =
    primary.llmCalls === 0 && auxiliary.llmCalls === 0
      ? finalizeSummary(runId, "none", primary, auxiliary)
      : finalizeSummary(runId, "raw_log_fallback", primary, auxiliary);
  rawFallbackCache.set(runId, { mtimeMs: stat.mtimeMs, summary });
  return summary;
}

export function recordRunTokenUsage(entry: RunTokenUsageEntry): void {
  appendHarnessJsonl(LEDGER_FILE_NAME, {
    runId: entry.runId,
    agent: entry.agent,
    round: entry.round,
    model: entry.model || "",
    durationMs: toNonNegativeNumber(entry.durationMs),
    status: entry.status || "",
    finishReasons: Array.isArray(entry.finishReasons) ? entry.finishReasons : [],
    promptTokens: toNonNegativeNumber(entry.promptTokens),
    completionTokens: toNonNegativeNumber(entry.completionTokens),
    totalTokens: toNonNegativeNumber(entry.totalTokens),
    cachedPromptTokens: toNonNegativeNumber(entry.cachedPromptTokens),
    reasoningTokens: toNonNegativeNumber(entry.reasoningTokens),
    hasUsage: Boolean(entry.hasUsage),
  });
}

export function summarizeRunTokenUsage(runId: string): RunTokenUsageSummary {
  const liveSummary = readLiveLedgerSummary(runId);
  if (liveSummary) return liveSummary;
  return readRawFallbackSummary(runId);
}
