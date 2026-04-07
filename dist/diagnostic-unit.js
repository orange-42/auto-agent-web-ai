"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiagnosticUnit = void 0;
const fs = __importStar(require("fs"));
/**
 * DiagnosticUnit: 工具熔断、遥测日志、敏感脱密、LLM Debug
 */
class DiagnosticUnit {
    constructor(telemetryFile, debugLogFile) {
        this.telemetryFile = telemetryFile;
        this.debugLogFile = debugLogFile;
        this.circuitBreakers = new Map();
        this.currentTraceId = "";
    }
    setTraceId(traceId) { this.currentTraceId = traceId; }
    // ────────────────── 遥测与脱密 ──────────────────
    telemetry(event) {
        const entry = Object.assign(Object.assign({ traceId: this.currentTraceId, ts: new Date().toISOString() }, event), { detail: event.detail ? this.redactForLogs(event.detail) : event.detail });
        try {
            fs.appendFileSync(this.telemetryFile, JSON.stringify(entry) + "\n", "utf-8");
        }
        catch ( /**/_a) { /**/ }
    }
    redactForLogs(value) {
        return value
            .replace(/https?:\/\/([^.]+\.)?(feishu\.cn|larksuite\.com)\/(wiki|docx|doc|sheets)\/([A-Za-z0-9_-]+)/g, "https://$1$2/$3/<redacted>")
            .replace(/\b[A-Za-z0-9]{27}_[A-Za-z0-9]{6,12}\b/g, "<sheet-token>")
            .replace(/\b(cli_[A-Za-z0-9]+)\b/g, "<app-id>");
    }
    writeLLMDebugLog(data) {
        try {
            const ts = new Date().toISOString().replace(/T/, " ").replace(/\..+/, "");
            fs.appendFileSync(this.debugLogFile, `[${ts}] ${data}\n`, "utf-8");
        }
        catch ( /**/_a) { /**/ }
    }
    // ────────────────── 熔断逻辑 ──────────────────
    isCircuitOpen(toolName) {
        const state = this.circuitBreakers.get(toolName);
        if (!state || !state.tripped)
            return false;
        // 30 秒半开策略
        if (Date.now() - state.lastFailure > 30000) {
            state.tripped = false;
            state.failures = 0;
            return false;
        }
        return true;
    }
    recordToolFailure(toolName, detail, alternatives = []) {
        var _a;
        const state = (_a = this.circuitBreakers.get(toolName)) !== null && _a !== void 0 ? _a : { failures: 0, lastFailure: 0, tripped: false, alternatives: [] };
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
    recordToolSuccess(toolName) {
        var _a;
        const state = (_a = this.circuitBreakers.get(toolName)) !== null && _a !== void 0 ? _a : { failures: 0, lastFailure: 0, tripped: false, alternatives: [] };
        state.failures = 0;
        state.tripped = false;
        state.lastSuccess = Date.now();
        this.telemetry({ event: "evolution", tool: toolName, detail: "recovered" });
        this.circuitBreakers.set(toolName, state);
    }
    getCircuitBreakerWarnings() {
        return Array.from(this.circuitBreakers.entries())
            .filter(([, s]) => s.tripped)
            .map(([name, state]) => {
            const alt = state.alternatives.length > 0 ? `；建议改用 ${state.alternatives.map(item => `\`${item.replace(/[-:]/g, "__")}\``).join(" / ")}` : "";
            const reason = state.lastError ? `；最近错误：${state.lastError}` : "";
            return `- ⚠️ 工具 \`${name.replace(/[-:]/g, "__")}\` 近期多次失败，暂时被熔断${reason}${alt}`;
        })
            .join("\n");
    }
    getAdaptiveGuidance() {
        const now = Date.now();
        return Array.from(this.circuitBreakers.entries())
            .filter(([, state]) => state.tripped || (state.lastFailure > 0 && now - state.lastFailure < 5 * 60000))
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
    getToolAdvice(toolName) {
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
exports.DiagnosticUnit = DiagnosticUnit;
