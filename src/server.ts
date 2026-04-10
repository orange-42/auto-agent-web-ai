import express from "express";
import cors from "cors";
import axios from "axios";
import * as dotenv from "dotenv";
import { V2Orchestrator } from "./orchestrator/loop-manager";
import { MCPHub } from "./mcp-hub";
import { DISPLAY_PHASES } from "./prompt-engine";
import path from "path";
import fs from "fs";
import { appendHarnessJsonl, appendHarnessLog, summarizeText } from "./harness-logger";
import {
  listDebugRunSnapshots,
  readDebugRunSnapshot,
  REPLAY_STAGES,
  ReplayStageName,
  summarizeDebugRunSnapshot,
} from "./debug-run-store";
import { EvalHarness } from "./harness/lesson-rag";
import { summarizeRunTokenUsage } from "./run-token-ledger";

dotenv.config();

/**
 * HTTP 服务入口。
 *
 * 这个文件本身不承担“编排决策”，它只做三件事：
 * 1. 接收外部请求并做基础参数校验
 * 2. 创建/持有当前活跃的 V2Orchestrator
 * 3. 把 orchestrator 的阶段事件转成 SSE 广播给前端
 *
 * 真正的工作流推进、阶段重试、校验修复都在 loop-manager.ts 中。
 */
const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

const mcpHub = new MCPHub(path.join(process.cwd(), "mcp-config.json"));
const evalHarness = new EvalHarness(process.cwd());
// 服务进程只维护“当前活跃”的一次工作流，便于 stop / SSE / 调试接口共享状态。
let activeV2Orchestrator: V2Orchestrator | null = null;
let activeRunId: string | null = null;

// 预热 MCP Hub
mcpHub.initialize().then(() => console.log("✅ MCP Hub 预热完成")).catch(e => console.error("❌ MCP Hub 预热失败:", e));

// SSE 客户端列表
let clients: any[] = [];

// runId 是整个链路的主键：日志、调试快照、SSE、token 统计都会围绕它串起来。
function makeRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// 统一把高频事件裁成轻量摘要，避免 server 侧日志被大文本淹没。
function describeEvent(data: any) {
  const content = typeof data?.content === "string" ? data.content : "";
  const thought = typeof data?.thought === "string" ? data.thought : "";
  const message = typeof data?.message === "string" ? data.message : "";
  const summary = typeof data?.summary === "string" ? data.summary : "";
  return {
    phase: data?.phase || "",
    index: typeof data?.index === "number" ? data.index : null,
    status: data?.status || "",
    contentLen: content.length,
    thoughtLen: thought.length,
    messageLen: message.length,
    preview: summarizeText(content || thought || message || summary),
  };
}

function buildModelsEndpoint(baseUrl: string): string {
  const normalized = (baseUrl || "").replace(/\/+$/, "");
  if (normalized.endsWith("/models")) return normalized;
  return `${normalized}/models`;
}

async function ensureModelReady(modelConfig: any) {
  if (!modelConfig?.baseUrl || !modelConfig?.model) {
    throw new Error("模型配置不完整，请检查 baseUrl 和 model。");
  }

  await axios.get(buildModelsEndpoint(modelConfig.baseUrl), {
    timeout: 3000,
    headers: modelConfig?.apiKey
      ? { Authorization: `Bearer ${modelConfig.apiKey}` }
      : undefined,
  });
}

/**
 * 把 orchestrator 的内部事件桥接成前端可消费的 SSE。
 *
 * 这里故意不做业务转换，只负责：
 * - 广播原始阶段事件
 * - 在 workflow-complete 时补充 token 汇总
 * - 清空服务端当前活跃 orchestrator 状态
 */
function attachOrchestratorListeners(orchestrator: V2Orchestrator, runId: string) {
  orchestrator.on("workflow-start", (data: any) => broadcast("workflow-start", data));
  orchestrator.on("step-start", (data: any) => broadcast("step-start", data));
  orchestrator.on("step-progress", (data: any) => broadcast("step-progress", data));
  orchestrator.on("phase-summary", (data: any) => broadcast("phase-summary", data));
  orchestrator.on("step-complete", (data: any) => broadcast("step-complete", data));
  orchestrator.on("workflow-complete", (data: any) => {
    const tokenUsage = summarizeRunTokenUsage(runId);
    appendHarnessJsonl("server_events.jsonl", {
      runId,
      type: "workflow_complete",
      status: data?.status || "",
      message: data?.message || "",
      tokenUsage,
    });
    // 任务结束时一并把 token 汇总塞回前端事件，
    // 这样 UI 不用再额外补一次详情请求，就能直接展示本轮消耗。
    broadcast("workflow-complete", { ...data, tokenUsage });
    activeV2Orchestrator = null;
    activeRunId = null;
  });
}

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  clients.push(newClient);
  appendHarnessJsonl("server_events.jsonl", {
    runId: activeRunId || "idle",
    type: "sse_open",
    clientId,
    clients: clients.length,
  });

  req.on("close", () => {
    clients = clients.filter(c => c.id !== clientId);
    appendHarnessJsonl("server_events.jsonl", {
      runId: activeRunId || "idle",
      type: "sse_close",
      clientId,
      clients: clients.length,
    });
  });
});

// 统一广播出口。所有阶段进度最终都从这里扇出到前端和调试日志。
function broadcast(event: string, data: any) {
  const runId = activeRunId || data?.runId || "idle";
  const payload = runId !== data?.runId ? { ...data, runId } : data;
  appendHarnessJsonl("sse_events.jsonl", {
    runId,
    event,
    clients: clients.length,
    ...describeEvent(payload),
  });
  clients.forEach(client => {
    try {
        client.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
        // 忽略已断开的连接
    }
  });
}

/**
 * 主工作流入口。
 *
 * 请求进来后只做“能否开始”的判断：
 * - prompt 是否存在
 * - 模型服务是否可连通
 * 然后立即异步启动 orchestrator，把后续结果交给 SSE 推送。
 */
app.post("/run", async (req, res) => {
  const { prompt, modelConfig } = req.body;
  
  if (!prompt) {
    return res.status(400).json({ error: "请填写任务指令。" });
  }

  try {
    await ensureModelReady(modelConfig);
  } catch (err: any) {
    return res.status(502).json({
      error: `模型服务不可用：${err.response?.data?.error?.message || err.message}`,
    });
  }

  const runId = makeRunId();
  activeRunId = runId;

  // 📝 记录原始长指令日志
  const logDir = path.join(process.cwd(), ".harness");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
  fs.appendFileSync(path.join(logDir, "orchestrator.log"), `\n[${new Date().toISOString()}] 🚀 [runId=${runId}] New Intent Intake:\n${prompt}\n------------------\n`);
  appendHarnessLog(
    "server_events.log",
    `[runId=${runId}] /run accepted model=${modelConfig?.model || "unknown"} baseUrl=${modelConfig?.baseUrl || "unknown"} promptChars=${prompt.length}`,
  );
  appendHarnessJsonl("server_events.jsonl", {
    runId,
    type: "run_request",
    model: modelConfig?.model || "",
    baseUrl: modelConfig?.baseUrl || "",
    promptChars: prompt.length,
    promptPreview: summarizeText(prompt),
  });

  // 这里先不传 projectPath。项目路径会在 INTENT 阶段由 IntentAgent 自己解析并验证。
  activeV2Orchestrator = new V2Orchestrator({ ...modelConfig, runId }, mcpHub);
  attachOrchestratorListeners(activeV2Orchestrator, runId);

  // 异步执行，让 HTTP 请求尽快返回；真正的阶段进度走 SSE。
  activeV2Orchestrator.runFullPipeline(prompt).catch((err: any) => {
    console.error("Pipeline crashed:", err);
    appendHarnessJsonl("server_events.jsonl", {
      runId,
      type: "pipeline_crash",
      message: err.message,
    });
    broadcast("workflow-complete", { status: "error", message: err.message });
    activeV2Orchestrator = null;
    activeRunId = null;
  });

  res.json({ message: "Intake successful, pipeline running...", runId });
});

app.get("/api/debug/runs", (req, res) => {
  const rawLimit = Number(req.query.limit || 20);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
  res.json({
    runs: listDebugRunSnapshots(limit),
  });
});

// 调试快照详情：用于回放某次 run 的完整上下文、阶段输入输出和工件。
app.get("/api/debug/runs/:runId", (req, res) => {
  const snapshot = readDebugRunSnapshot(req.params.runId);
  if (!snapshot) {
    return res.status(404).json({ error: "未找到对应 runId 的调试快照。" });
  }

  res.json({
    summary: summarizeDebugRunSnapshot(snapshot),
    snapshot,
  });
});

app.get("/api/debug/runs/:runId/hermes", (req, res) => {
  const report = evalHarness.readHermesReport(req.params.runId);
  if (!report) {
    return res.status(404).json({ error: "未找到对应 runId 的 Hermes 复盘报告。" });
  }
  res.json(report);
});

app.get("/api/debug/runs/:runId/tokens", (req, res) => {
  res.json({
    runId: req.params.runId,
    tokenUsage: summarizeRunTokenUsage(req.params.runId),
  });
});

/**
 * 单阶段重放入口。
 *
 * 典型用途：
 * - CODING 阶段写坏了，只重放 CODING
 * - VERIFY 失败，只重放 VERIFY
 *
 * replay 和正常 run 共用同一套 orchestrator，只是 debugSnapshot 会切到 replay 模式。
 */
app.post("/api/debug/replay-stage", async (req, res) => {
  const { sourceRunId, stage, modelConfig } = req.body || {};
  const normalizedStage = String(stage || "").trim().toUpperCase() as ReplayStageName;

  if (!sourceRunId) {
    return res.status(400).json({ error: "缺少 sourceRunId。" });
  }
  if (!REPLAY_STAGES.includes(normalizedStage)) {
    return res.status(400).json({ error: `stage 非法，必须是 ${REPLAY_STAGES.join(" / ")} 之一。` });
  }

  const sourceSnapshot = readDebugRunSnapshot(String(sourceRunId));
  if (!sourceSnapshot) {
    return res.status(404).json({ error: "未找到源调试快照，请确认 runId 是否正确。" });
  }

  const mergedModelConfig = {
    type: modelConfig?.type || sourceSnapshot.modelConfig?.type || "",
    baseUrl: modelConfig?.baseUrl || sourceSnapshot.modelConfig?.baseUrl || "",
    model: modelConfig?.model || sourceSnapshot.modelConfig?.model || sourceSnapshot.modelConfig?.modelId || "",
    modelId: modelConfig?.modelId || sourceSnapshot.modelConfig?.modelId || sourceSnapshot.modelConfig?.model || "",
    apiKey: modelConfig?.apiKey || "",
    qaConfig: modelConfig?.qaConfig || sourceSnapshot.modelConfig?.qaConfig || {},
  };

  try {
    await ensureModelReady(mergedModelConfig);
  } catch (err: any) {
    return res.status(502).json({
      error: `模型服务不可用：${err.response?.data?.error?.message || err.message}`,
    });
  }

  const runId = makeRunId();
  activeRunId = runId;
  activeV2Orchestrator = new V2Orchestrator({ ...mergedModelConfig, runId }, mcpHub);
  attachOrchestratorListeners(activeV2Orchestrator, runId);

  appendHarnessLog(
    "server_events.log",
    `[runId=${runId}] /api/debug/replay-stage accepted sourceRunId=${sourceRunId} stage=${normalizedStage}`,
  );
  appendHarnessJsonl("server_events.jsonl", {
    runId,
    type: "stage_replay_request",
    sourceRunId: String(sourceRunId),
    stage: normalizedStage,
    model: mergedModelConfig.model || "",
    baseUrl: mergedModelConfig.baseUrl || "",
  });

  activeV2Orchestrator.replayStageFromSnapshot(sourceSnapshot, normalizedStage).catch((err: any) => {
    console.error("Stage replay crashed:", err);
    appendHarnessJsonl("server_events.jsonl", {
      runId,
      type: "stage_replay_crash",
      sourceRunId: String(sourceRunId),
      stage: normalizedStage,
      message: err.message,
    });
    broadcast("workflow-complete", { status: "error", message: err.message });
    activeV2Orchestrator = null;
    activeRunId = null;
  });

  res.json({
    message: "Stage replay started",
    runId,
    sourceRunId: String(sourceRunId),
    stage: normalizedStage,
  });
});

// 对外暴露一个轻量 stop，实际中止逻辑由 orchestrator 持有的 AbortController 负责。
app.post("/stop", (req, res) => {
  if (activeV2Orchestrator) {
    appendHarnessJsonl("server_events.jsonl", {
      runId: activeRunId || "idle",
      type: "stop_requested",
    });
    activeV2Orchestrator.stopWorkflow();
  }
  res.json({ message: "Workflow stop signal sent" });
});

// 纯代理接口：前端可借此探测第三方模型服务，不必直接跨域访问。
app.get("/api/model-proxy", async (req, res) => {
  const url = req.query.url as string;
  const apiKey = req.query.apiKey as string;
  
  if (!url) return res.status(400).json({ error: "Missing url parameter" });
  
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent': 'Feishu-Agent-Proxy/1.0'
    };
    
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await axios.get(url, { 
      headers,
      timeout: 5000 // 5s timeout to prevent long hangs
    });
    
    res.json(response.data);
  } catch (err: any) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.error?.message || err.message;
    res.status(status).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`🚀 Feishu-to-Code Backend running at http://localhost:${port}`);
  console.log(`📦 Loaded Config: 
    - Model Path: ${process.env.OPENAI_API_BASE || 'Default'}
    - API Key: ${process.env.OPENAI_API_KEY ? '******' : 'None'}
    - Phase Count: ${DISPLAY_PHASES.length}`);
});
