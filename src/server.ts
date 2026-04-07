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

dotenv.config();

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

const mcpHub = new MCPHub(path.join(process.cwd(), "mcp-config.json"));
let activeV2Orchestrator: V2Orchestrator | null = null;
let activeRunId: string | null = null;

// 预热 MCP Hub
mcpHub.initialize().then(() => console.log("✅ MCP Hub 预热完成")).catch(e => console.error("❌ MCP Hub 预热失败:", e));

// SSE 客户端列表
let clients: any[] = [];

function makeRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

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
    preview: summarizeText(content || thought || message || summary, 120),
  };
}

function buildModelsEndpoint(baseUrl: string): string {
  const normalized = (baseUrl || "").replace(/\/+$/, "");
  if (normalized.endsWith("/models")) return normalized;
  return `${normalized}/models`;
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

app.post("/run", async (req, res) => {
  const { prompt, modelConfig } = req.body;
  
  if (!prompt) {
    return res.status(400).json({ error: "请填写任务指令。" });
  }

  if (!modelConfig?.baseUrl || !modelConfig?.model) {
    return res.status(400).json({ error: "模型配置不完整，请检查 baseUrl 和 model。" });
  }

  try {
    await axios.get(buildModelsEndpoint(modelConfig.baseUrl), {
      timeout: 3000,
      headers: modelConfig?.apiKey
        ? { Authorization: `Bearer ${modelConfig.apiKey}` }
        : undefined,
    });
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
    promptPreview: summarizeText(prompt, 180),
  });

  // 创建 V2 编排引擎 (不再需要初始 projectPath)
  activeV2Orchestrator = new V2Orchestrator({ ...modelConfig, runId }, mcpHub);
  
  activeV2Orchestrator.on("workflow-start", (data: any) => broadcast("workflow-start", data));
  activeV2Orchestrator.on("step-start", (data: any) => broadcast("step-start", data));
  activeV2Orchestrator.on("step-progress", (data: any) => broadcast("step-progress", data));
  activeV2Orchestrator.on("phase-summary", (data: any) => broadcast("phase-summary", data));
  activeV2Orchestrator.on("step-complete", (data: any) => broadcast("step-complete", data));
  activeV2Orchestrator.on("workflow-complete", (data: any) => {
    appendHarnessJsonl("server_events.jsonl", {
      runId,
      type: "workflow_complete",
      status: data?.status || "",
      message: data?.message || "",
    });
    broadcast("workflow-complete", data);
    activeV2Orchestrator = null;
    activeRunId = null;
  });

  // 异步执行：让指挥官自己从长文本里拆意图
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

// Proxy route for fetching models (LM Studio / MLX)
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
