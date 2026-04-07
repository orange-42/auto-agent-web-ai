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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const axios_1 = __importDefault(require("axios"));
const dotenv = __importStar(require("dotenv"));
const loop_manager_1 = require("./orchestrator/loop-manager");
const mcp_hub_1 = require("./mcp-hub");
const prompt_engine_1 = require("./prompt-engine");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const harness_logger_1 = require("./harness-logger");
dotenv.config();
const app = (0, express_1.default)();
const port = 3000;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const mcpHub = new mcp_hub_1.MCPHub(path_1.default.join(process.cwd(), "mcp-config.json"));
let activeV2Orchestrator = null;
let activeRunId = null;
// 预热 MCP Hub
mcpHub.initialize().then(() => console.log("✅ MCP Hub 预热完成")).catch(e => console.error("❌ MCP Hub 预热失败:", e));
// SSE 客户端列表
let clients = [];
function makeRunId() {
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
function describeEvent(data) {
    const content = typeof (data === null || data === void 0 ? void 0 : data.content) === "string" ? data.content : "";
    const thought = typeof (data === null || data === void 0 ? void 0 : data.thought) === "string" ? data.thought : "";
    const message = typeof (data === null || data === void 0 ? void 0 : data.message) === "string" ? data.message : "";
    const summary = typeof (data === null || data === void 0 ? void 0 : data.summary) === "string" ? data.summary : "";
    return {
        phase: (data === null || data === void 0 ? void 0 : data.phase) || "",
        index: typeof (data === null || data === void 0 ? void 0 : data.index) === "number" ? data.index : null,
        status: (data === null || data === void 0 ? void 0 : data.status) || "",
        contentLen: content.length,
        thoughtLen: thought.length,
        messageLen: message.length,
        preview: (0, harness_logger_1.summarizeText)(content || thought || message || summary, 120),
    };
}
function buildModelsEndpoint(baseUrl) {
    const normalized = (baseUrl || "").replace(/\/+$/, "");
    if (normalized.endsWith("/models"))
        return normalized;
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
    (0, harness_logger_1.appendHarnessJsonl)("server_events.jsonl", {
        runId: activeRunId || "idle",
        type: "sse_open",
        clientId,
        clients: clients.length,
    });
    req.on("close", () => {
        clients = clients.filter(c => c.id !== clientId);
        (0, harness_logger_1.appendHarnessJsonl)("server_events.jsonl", {
            runId: activeRunId || "idle",
            type: "sse_close",
            clientId,
            clients: clients.length,
        });
    });
});
function broadcast(event, data) {
    const runId = activeRunId || (data === null || data === void 0 ? void 0 : data.runId) || "idle";
    const payload = runId !== (data === null || data === void 0 ? void 0 : data.runId) ? Object.assign(Object.assign({}, data), { runId }) : data;
    (0, harness_logger_1.appendHarnessJsonl)("sse_events.jsonl", Object.assign({ runId,
        event, clients: clients.length }, describeEvent(payload)));
    clients.forEach(client => {
        try {
            client.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        }
        catch (e) {
            // 忽略已断开的连接
        }
    });
}
app.post("/run", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    const { prompt, modelConfig } = req.body;
    if (!prompt) {
        return res.status(400).json({ error: "请填写任务指令。" });
    }
    if (!(modelConfig === null || modelConfig === void 0 ? void 0 : modelConfig.baseUrl) || !(modelConfig === null || modelConfig === void 0 ? void 0 : modelConfig.model)) {
        return res.status(400).json({ error: "模型配置不完整，请检查 baseUrl 和 model。" });
    }
    try {
        yield axios_1.default.get(buildModelsEndpoint(modelConfig.baseUrl), {
            timeout: 3000,
            headers: (modelConfig === null || modelConfig === void 0 ? void 0 : modelConfig.apiKey)
                ? { Authorization: `Bearer ${modelConfig.apiKey}` }
                : undefined,
        });
    }
    catch (err) {
        return res.status(502).json({
            error: `模型服务不可用：${((_c = (_b = (_a = err.response) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.error) === null || _c === void 0 ? void 0 : _c.message) || err.message}`,
        });
    }
    const runId = makeRunId();
    activeRunId = runId;
    // 📝 记录原始长指令日志
    const logDir = path_1.default.join(process.cwd(), ".harness");
    if (!fs_1.default.existsSync(logDir))
        fs_1.default.mkdirSync(logDir);
    fs_1.default.appendFileSync(path_1.default.join(logDir, "orchestrator.log"), `\n[${new Date().toISOString()}] 🚀 [runId=${runId}] New Intent Intake:\n${prompt}\n------------------\n`);
    (0, harness_logger_1.appendHarnessLog)("server_events.log", `[runId=${runId}] /run accepted model=${(modelConfig === null || modelConfig === void 0 ? void 0 : modelConfig.model) || "unknown"} baseUrl=${(modelConfig === null || modelConfig === void 0 ? void 0 : modelConfig.baseUrl) || "unknown"} promptChars=${prompt.length}`);
    (0, harness_logger_1.appendHarnessJsonl)("server_events.jsonl", {
        runId,
        type: "run_request",
        model: (modelConfig === null || modelConfig === void 0 ? void 0 : modelConfig.model) || "",
        baseUrl: (modelConfig === null || modelConfig === void 0 ? void 0 : modelConfig.baseUrl) || "",
        promptChars: prompt.length,
        promptPreview: (0, harness_logger_1.summarizeText)(prompt, 180),
    });
    // 创建 V2 编排引擎 (不再需要初始 projectPath)
    activeV2Orchestrator = new loop_manager_1.V2Orchestrator(Object.assign(Object.assign({}, modelConfig), { runId }), mcpHub);
    activeV2Orchestrator.on("workflow-start", (data) => broadcast("workflow-start", data));
    activeV2Orchestrator.on("step-start", (data) => broadcast("step-start", data));
    activeV2Orchestrator.on("step-progress", (data) => broadcast("step-progress", data));
    activeV2Orchestrator.on("phase-summary", (data) => broadcast("phase-summary", data));
    activeV2Orchestrator.on("step-complete", (data) => broadcast("step-complete", data));
    activeV2Orchestrator.on("workflow-complete", (data) => {
        (0, harness_logger_1.appendHarnessJsonl)("server_events.jsonl", {
            runId,
            type: "workflow_complete",
            status: (data === null || data === void 0 ? void 0 : data.status) || "",
            message: (data === null || data === void 0 ? void 0 : data.message) || "",
        });
        broadcast("workflow-complete", data);
        activeV2Orchestrator = null;
        activeRunId = null;
    });
    // 异步执行：让指挥官自己从长文本里拆意图
    activeV2Orchestrator.runFullPipeline(prompt).catch((err) => {
        console.error("Pipeline crashed:", err);
        (0, harness_logger_1.appendHarnessJsonl)("server_events.jsonl", {
            runId,
            type: "pipeline_crash",
            message: err.message,
        });
        broadcast("workflow-complete", { status: "error", message: err.message });
        activeV2Orchestrator = null;
        activeRunId = null;
    });
    res.json({ message: "Intake successful, pipeline running...", runId });
}));
app.post("/stop", (req, res) => {
    if (activeV2Orchestrator) {
        (0, harness_logger_1.appendHarnessJsonl)("server_events.jsonl", {
            runId: activeRunId || "idle",
            type: "stop_requested",
        });
        activeV2Orchestrator.stopWorkflow();
    }
    res.json({ message: "Workflow stop signal sent" });
});
// Proxy route for fetching models (LM Studio / MLX)
app.get("/api/model-proxy", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d;
    const url = req.query.url;
    const apiKey = req.query.apiKey;
    if (!url)
        return res.status(400).json({ error: "Missing url parameter" });
    try {
        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'Feishu-Agent-Proxy/1.0'
        };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        const response = yield axios_1.default.get(url, {
            headers,
            timeout: 5000 // 5s timeout to prevent long hangs
        });
        res.json(response.data);
    }
    catch (err) {
        const status = ((_a = err.response) === null || _a === void 0 ? void 0 : _a.status) || 500;
        const message = ((_d = (_c = (_b = err.response) === null || _b === void 0 ? void 0 : _b.data) === null || _c === void 0 ? void 0 : _c.error) === null || _d === void 0 ? void 0 : _d.message) || err.message;
        res.status(status).json({ error: message });
    }
}));
app.listen(port, () => {
    console.log(`🚀 Feishu-to-Code Backend running at http://localhost:${port}`);
    console.log(`📦 Loaded Config: 
    - Model Path: ${process.env.OPENAI_API_BASE || 'Default'}
    - API Key: ${process.env.OPENAI_API_KEY ? '******' : 'None'}
    - Phase Count: ${prompt_engine_1.DISPLAY_PHASES.length}`);
});
