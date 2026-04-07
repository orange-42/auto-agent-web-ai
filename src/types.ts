export interface LLMMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  reasoning_content?: string; // 支持含有推理信息的模型
  tool_call_id?: string;
  tool_calls?: any[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: any;
}

export interface TelemetryEvent {
  traceId: string;
  ts: string;
  event: "tool_call" | "llm_call" | "phase_score" | "circuit_breaker" | "evolution";
  tool?: string;
  durationMs?: number;
  success?: boolean;
  score?: number;
  tokens?: number;
  detail?: string;
}

export interface TaskItem {
  id: number;
  description: string;
  status: "pending" | "in_progress" | "done" | "skipped";
  phase: string;
}

export interface AvailableMCPTool {
  name?: string;
  description?: string;
  inputSchema?: unknown;
  serverName: string;
  fullName: string;
}
