import * as fs from "fs";
import * as path from "path";
import { TelemetryEvent } from "./types";

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  tripped: boolean;
  lastError?: string;
  alternatives: string[];
  lastSuccess?: number;
}

/**
 * DiagnosticUnit: 工具熔断、遥测日志、敏感脱密、LLM Debug
 */
export class DiagnosticUnit {
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();
  private currentTraceId = "";
  
  constructor(
    private telemetryFile: string,
    private debugLogFile: string
  ) {}

  public setTraceId(traceId: string) { this.currentTraceId = traceId; }

  // ────────────────── 遥测与脱密 ──────────────────

  public telemetry(event: Omit<TelemetryEvent, "traceId" | "ts">) {
    const entry: TelemetryEvent = {
      traceId: this.currentTraceId,
      ts: new Date().toISOString(),
      ...event,
      detail: event.detail ? this.redactForLogs(event.detail) : event.detail,
    };
    try {
      fs.appendFileSync(this.telemetryFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch { /**/ }
  }

  public redactForLogs(value: string): string {
    return value
      .replace(/https?:\/\/([^.]+\.)?(feishu\.cn|larksuite\.com)\/(wiki|docx|doc|sheets)\/([A-Za-z0-9_-]+)/g, "https://$1$2/$3/<redacted>")
      .replace(/\b[A-Za-z0-9]{27}_[A-Za-z0-9]{6,12}\b/g, "<sheet-token>")
      .replace(/\b(cli_[A-Za-z0-9]+)\b/g, "<app-id>");
  }

  public writeLLMDebugLog(data: string) {
    try {
      const ts = new Date().toISOString().replace(/T/, " ").replace(/\..+/, "");
      fs.appendFileSync(this.debugLogFile, `[${ts}] ${data}\n`, "utf-8");
    } catch { /**/ }
  }

  // ────────────────── 熔断逻辑 ──────────────────

  public isCircuitOpen(toolName: string): boolean {
    const state = this.circuitBreakers.get(toolName);
    if (!state || !state.tripped) return false;
    // 30 秒半开策略
    if (Date.now() - state.lastFailure > 30_000) {
      state.tripped = false;
      state.failures = 0;
      return false;
    }
    return true;
  }

  public recordToolFailure(toolName: string, detail?: string, alternatives: string[] = []) {
    const state = this.circuitBreakers.get(toolName) ?? { failures: 0, lastFailure: 0, tripped: false, alternatives: [] };
    state.failures++;
    state.lastFailure = Date.now();
    state.lastError = detail;
    state.alternatives = Array.from(new Set([...state.alternatives, ...alternatives])).slice(0, 4);
    if (state.failures >= 3) {
      state.tripped = true;
      this.telemetry({
        event: "circuit_breaker",
        tool: toolName,
        detail: `tripped${detail ? `: ${detail}` : ""}`
      });
    }
    this.telemetry({
      event: "evolution",
      tool: toolName,
      detail: `failure#${state.failures}${detail ? `: ${detail}` : ""}`
    });
    this.circuitBreakers.set(toolName, state);
  }

  public recordToolSuccess(toolName: string) {
    const state = this.circuitBreakers.get(toolName) ?? { failures: 0, lastFailure: 0, tripped: false, alternatives: [] };
    state.failures = 0;
    state.tripped = false;
    state.lastSuccess = Date.now();
    this.telemetry({ event: "evolution", tool: toolName, detail: "recovered" });
    this.circuitBreakers.set(toolName, state);
  }

  public getCircuitBreakerWarnings(): string {
    return Array.from(this.circuitBreakers.entries())
      .filter(([, s]) => s.tripped)
      .map(([name, state]) => {
        const alt = state.alternatives.length > 0 ? `；建议改用 ${state.alternatives.map(item => `\`${item.replace(/[-:]/g, "__")}\``).join(" / ")}` : "";
        const reason = state.lastError ? `；最近错误：${state.lastError}` : "";
        return `- ⚠️ 工具 \`${name.replace(/[-:]/g, "__")}\` 近期多次失败，暂时被熔断${reason}${alt}`;
      })
      .join("\n");
  }

  public getAdaptiveGuidance(): string {
    const now = Date.now();
    return Array.from(this.circuitBreakers.entries())
      .filter(([, state]) => state.tripped || (state.lastFailure > 0 && now - state.lastFailure < 5 * 60_000))
      .sort((a, b) => b[1].lastFailure - a[1].lastFailure)
      .slice(0, 5)
      .map(([name, state]) => {
        const cooldown = state.tripped ? "，30 秒内不要再试" : "";
        const reason = state.lastError ? `；最近错误：${state.lastError}` : "";
        const alt = state.alternatives.length > 0 ? `；优先改用 ${state.alternatives.map(item => `\`${item.replace(/[-:]/g, "__")}\``).join(" / ")}` : "";
        return `- \`${name.replace(/[-:]/g, "__")}\` 最近已失败 ${state.failures} 次${cooldown}${reason}${alt}`;
      })
      .join("\n");
  }

  public getToolAdvice(toolName: string): { failures: number; lastError?: string; alternatives: string[]; tripped: boolean } {
    const state = this.circuitBreakers.get(toolName);
    if (!state) {
      return { failures: 0, alternatives: [], tripped: false };
    }
    return {
      failures: state.failures,
      lastError: state.lastError,
      alternatives: state.alternatives,
      tripped: state.tripped,
    };
  }
}
