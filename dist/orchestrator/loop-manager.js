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
Object.defineProperty(exports, "__esModule", { value: true });
exports.V2Orchestrator = void 0;
const agents_1 = require("../agents");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const events_1 = require("events");
const lark_prefetcher_1 = require("../lark-prefetcher");
const harness_logger_1 = require("../harness-logger");
const lesson_rag_1 = require("../harness/lesson-rag");
class V2Orchestrator extends events_1.EventEmitter {
    constructor(llmConfig, mcpHub) {
        super();
        this.llmConfig = llmConfig;
        this.mcpHub = mcpHub;
        this.projectPath = "";
        this.targetRoute = "";
        this.targetComponentPath = "";
        this.taskObjective = "";
        this.evalHarness = new lesson_rag_1.EvalHarness(process.cwd());
        this.larkPrefetcher = new lark_prefetcher_1.LarkPrefetcher((tool, dur, ok, det) => {
            this.log(`[Prefetch Telemetry] ${tool} - ${dur}ms - ${ok} - ${det || ""}`);
        });
        this.abortController = new AbortController();
    }
    log(content) {
        (0, harness_logger_1.appendHarnessLog)("orchestrator.log", `🚀 [runId=${this.runId}] ${content}`);
    }
    get runId() {
        return this.llmConfig.runId || "run_unknown";
    }
    trace(type, payload) {
        (0, harness_logger_1.appendHarnessJsonl)("workflow_steps.jsonl", Object.assign({ runId: this.runId, type }, payload));
    }
    emitStepStart(phase, title, index) {
        this.log(`[STEP_START] phase=${phase} index=${index} title=${title}`);
        this.trace("step_start", { phase, title, index });
        this.emit("step-start", { phase, title, index });
    }
    emitStepProgress(data) {
        var _a, _b;
        this.trace("step_progress", {
            phase: data.phase,
            index: data.index,
            thoughtLen: ((_a = data.thought) === null || _a === void 0 ? void 0 : _a.length) || 0,
            contentLen: ((_b = data.content) === null || _b === void 0 ? void 0 : _b.length) || 0,
            preview: (0, harness_logger_1.summarizeText)(data.content || data.thought || "", 140),
        });
        this.emit("step-progress", data);
    }
    emitStepComplete(phase, status, index) {
        this.log(`[STEP_COMPLETE] phase=${phase} index=${index} status=${status}`);
        this.trace("step_complete", { phase, status, index });
        this.emit("step-complete", { phase, status, index });
    }
    emitPhaseSummary(data) {
        this.trace("phase_summary", {
            phase: data.phase,
            index: data.index,
            title: data.title,
            summary: data.summary,
            highlights: data.highlights,
            stats: data.stats,
        });
        this.emit("phase-summary", data);
    }
    emitWorkflowComplete(status, message) {
        this.log(`[WORKFLOW_COMPLETE] status=${status}${message ? ` message=${message}` : ""}`);
        this.trace("workflow_complete", { status, message: message || "" });
        this.emit("workflow-complete", { status, message });
    }
    summarizeResult(label, result) {
        const summary = {
            label,
            keys: result && typeof result === "object" ? Object.keys(result) : [],
            modules: Array.isArray(result === null || result === void 0 ? void 0 : result.modules) ? result.modules.length : undefined,
            logicRules: Array.isArray(result === null || result === void 0 ? void 0 : result.logic_rules) ? result.logic_rules.length : undefined,
            apiMappings: Array.isArray(result === null || result === void 0 ? void 0 : result.api_mappings) ? result.api_mappings.length : undefined,
            componentImpact: Array.isArray(result === null || result === void 0 ? void 0 : result.component_impact) ? result.component_impact.length : undefined,
            filesToCreate: Array.isArray(result === null || result === void 0 ? void 0 : result.files_to_create) ? result.files_to_create.length : undefined,
            filesToModify: Array.isArray(result === null || result === void 0 ? void 0 : result.files_to_modify) ? result.files_to_modify.length : undefined,
            verificationPoints: Array.isArray(result === null || result === void 0 ? void 0 : result.verification_points) ? result.verification_points.length : undefined,
            reasoningPreview: (0, harness_logger_1.summarizeText)((result === null || result === void 0 ? void 0 : result.reasoning) || "", 160),
        };
        this.trace("phase_output", summary);
        this.log(`[PHASE_OUTPUT] ${label} ${JSON.stringify(summary)}`);
        const phaseSummary = this.buildPhaseSummary(label, result);
        if (phaseSummary) {
            this.emitPhaseSummary(phaseSummary);
        }
    }
    buildPhaseSummary(label, result) {
        const phaseIndexMap = {
            INTENT: 0,
            PRD: 1,
            API: 2,
            PLAN: 3,
            CODING: 4,
        };
        const index = phaseIndexMap[label];
        const highlights = [];
        const stats = [];
        let title = "";
        let summary = "";
        if (label === "PRD") {
            title = "需求摘要已生成";
            summary = (result === null || result === void 0 ? void 0 : result.content_verified) || (0, harness_logger_1.summarizeText)((result === null || result === void 0 ? void 0 : result.reasoning) || "", 150);
            if (Array.isArray(result === null || result === void 0 ? void 0 : result.modules)) {
                stats.push(`模块 ${result.modules.length}`);
                highlights.push(...result.modules.slice(0, 3).map((module) => `模块：${(module === null || module === void 0 ? void 0 : module.name) || "未命名"}${(module === null || module === void 0 ? void 0 : module.desc) ? ` · ${module.desc}` : ""}`));
            }
            if (Array.isArray(result === null || result === void 0 ? void 0 : result.logic_rules)) {
                stats.push(`规则 ${result.logic_rules.length}`);
                highlights.push(...result.logic_rules.slice(0, 3).map((rule) => `规则：${rule}`));
            }
        }
        else if (label === "API") {
            title = "接口映射已收敛";
            summary = (0, harness_logger_1.summarizeText)((result === null || result === void 0 ? void 0 : result.reasoning) || "", 150);
            if (Array.isArray(result === null || result === void 0 ? void 0 : result.api_mappings)) {
                stats.push(`接口 ${result.api_mappings.length}`);
                highlights.push(...result.api_mappings.slice(0, 3).map((mapping) => `接口：${(mapping === null || mapping === void 0 ? void 0 : mapping.method) || ""} ${(mapping === null || mapping === void 0 ? void 0 : mapping.endpoint) || ""}${(mapping === null || mapping === void 0 ? void 0 : mapping.purpose) ? ` · ${mapping.purpose}` : ""}`.trim()));
            }
            if (Array.isArray(result === null || result === void 0 ? void 0 : result.component_impact) && result.component_impact.length > 0) {
                stats.push(`影响组件 ${result.component_impact.length}`);
                highlights.push(...result.component_impact.slice(0, 2).map((item) => `组件：${item}`));
            }
        }
        else if (label === "PLAN") {
            title = "实施方案已确定";
            summary = (0, harness_logger_1.summarizeText)((result === null || result === void 0 ? void 0 : result.reasoning) || "", 150);
            if (Array.isArray(result === null || result === void 0 ? void 0 : result.files_to_modify)) {
                stats.push(`修改文件 ${result.files_to_modify.length}`);
                highlights.push(...result.files_to_modify.slice(0, 3).map((item) => `修改：${(item === null || item === void 0 ? void 0 : item.path) || (item === null || item === void 0 ? void 0 : item.file) || "未标明文件"}${(item === null || item === void 0 ? void 0 : item.description) ? ` · ${item.description}` : ""}`));
            }
            if (Array.isArray(result === null || result === void 0 ? void 0 : result.files_to_create) && result.files_to_create.length > 0) {
                stats.push(`新增文件 ${result.files_to_create.length}`);
                highlights.push(...result.files_to_create.slice(0, 2).map((item) => `新增：${(item === null || item === void 0 ? void 0 : item.path) || (item === null || item === void 0 ? void 0 : item.file) || "未标明文件"}`));
            }
            if (Array.isArray(result === null || result === void 0 ? void 0 : result.verification_points) && result.verification_points.length > 0) {
                stats.push(`验证点 ${result.verification_points.length}`);
                highlights.push(...result.verification_points.slice(0, 2).map((item) => `验证：${item}`));
            }
        }
        else if (label === "CODING") {
            title = "代码集成已执行";
            summary = (0, harness_logger_1.summarizeText)((result === null || result === void 0 ? void 0 : result.reasoning) || (result === null || result === void 0 ? void 0 : result.raw_content) || JSON.stringify(result || {}), 150);
            if (Array.isArray(result === null || result === void 0 ? void 0 : result.files_to_modify) && result.files_to_modify.length > 0) {
                stats.push(`修改文件 ${result.files_to_modify.length}`);
            }
            if (Array.isArray(result === null || result === void 0 ? void 0 : result.files_to_create) && result.files_to_create.length > 0) {
                stats.push(`新增文件 ${result.files_to_create.length}`);
            }
            if (Array.isArray(result === null || result === void 0 ? void 0 : result.verification_points) && result.verification_points.length > 0) {
                highlights.push(...result.verification_points.slice(0, 3).map((item) => `验证：${item}`));
            }
        }
        else {
            return null;
        }
        return {
            phase: label,
            index,
            title,
            summary,
            highlights: highlights.filter(Boolean).slice(0, 5),
            stats: stats.filter(Boolean).slice(0, 4),
        };
    }
    extractToolText(result) {
        var _a;
        if (!result)
            return "";
        if (typeof result === "string")
            return result;
        if (Array.isArray(result.content)) {
            return result.content
                .map((item) => (typeof (item === null || item === void 0 ? void 0 : item.text) === "string" ? item.text : JSON.stringify(item)))
                .join("\n");
        }
        if (typeof ((_a = result === null || result === void 0 ? void 0 : result.structuredContent) === null || _a === void 0 ? void 0 : _a.content) === "string") {
            return result.structuredContent.content;
        }
        return JSON.stringify(result);
    }
    buildProjectTree() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.projectPath)
                return "";
            try {
                const treeResult = yield this.mcpHub.callTool("filesystem:directory_tree", {
                    path: this.projectPath,
                });
                const treeText = this.extractToolText(treeResult).trim();
                if (treeText)
                    return treeText.slice(0, 12000);
            }
            catch (error) {
                this.log(`Project tree prefetch failed, fallback to list_directory: ${error.message}`);
            }
            try {
                const listingResult = yield this.mcpHub.callTool("filesystem:list_directory", {
                    path: this.projectPath,
                });
                const listingText = this.extractToolText(listingResult).trim();
                if (listingText)
                    return `[根目录概览]\n${listingText}`.slice(0, 12000);
            }
            catch (error) {
                this.log(`Project root listing fallback failed: ${error.message}`);
            }
            return "";
        });
    }
    extractTaskObjective(prompt) {
        const headingMatch = prompt.match(/##\s*4\.\s*任务目标\s*([\s\S]*?)(?:\n##\s|\n#\s|$)/);
        if (headingMatch === null || headingMatch === void 0 ? void 0 : headingMatch[1]) {
            return headingMatch[1].replace(/[-*]/g, " ").replace(/\s+/g, " ").trim();
        }
        const lineMatch = prompt.match(/任务目标[:：]\s*(.+)/);
        if (lineMatch === null || lineMatch === void 0 ? void 0 : lineMatch[1]) {
            return lineMatch[1].trim();
        }
        return (0, harness_logger_1.summarizeText)(prompt.replace(/\s+/g, " ").trim(), 120);
    }
    buildExecutionBrief() {
        return [
            `任务目标：${this.taskObjective || "根据需求文档与接口文档完成指定迭代开发"}`,
            this.projectPath ? `项目路径：${this.projectPath}` : "",
            this.targetRoute ? `目标路由：${this.targetRoute}` : "",
            this.targetComponentPath ? `核心组件：${this.targetComponentPath}` : "",
            "要求：先理解 PRD 与接口，再围绕目标组件高效收敛并落地写码。",
        ]
            .filter(Boolean)
            .join("\n");
    }
    buildTargetComponentContext() {
        if (!this.projectPath || !this.targetComponentPath)
            return "";
        const absolutePath = path.resolve(this.projectPath, this.targetComponentPath);
        if (!fs.existsSync(absolutePath))
            return "";
        try {
            const raw = fs.readFileSync(absolutePath, "utf-8");
            const lines = raw.split(/\r?\n/);
            const snippets = [];
            const seenWindows = new Set();
            const keywordRules = [/退款/, /照片/, /photo/i, /lock/i, /download/i, /refund/i, /after_sale/i];
            const hitLines = [];
            lines.forEach((line, index) => {
                if (keywordRules.some((rule) => rule.test(line))) {
                    hitLines.push(index + 1);
                }
            });
            const addWindow = (startLine, endLine, title) => {
                const start = Math.max(1, startLine);
                const end = Math.min(lines.length, endLine);
                const key = `${start}-${end}`;
                if (seenWindows.has(key))
                    return;
                seenWindows.add(key);
                const snippet = lines
                    .slice(start - 1, end)
                    .map((line, offset) => `${start + offset} | ${line}`)
                    .join("\n");
                snippets.push(`[${title}] ${start}-${end}\n${snippet}`);
            };
            addWindow(1, Math.min(lines.length, 80), "组件头部与模板入口");
            let keptHits = 0;
            let lastHit = -999;
            for (const lineNo of hitLines) {
                if (keptHits >= 6)
                    break;
                if (lineNo - lastHit < 24)
                    continue;
                addWindow(lineNo - 8, lineNo + 12, `关键热点 ${keptHits + 1}`);
                keptHits++;
                lastHit = lineNo;
            }
            const result = [
                `[目标组件快照]`,
                `文件：${this.targetComponentPath}`,
                `总行数：${lines.length}`,
                snippets.join("\n\n"),
            ]
                .filter(Boolean)
                .join("\n");
            return result.slice(0, 12000);
        }
        catch (error) {
            this.log(`Target component context prefetch failed: ${error.message}`);
            return "";
        }
    }
    isUsablePlan(plan) {
        if (!plan || typeof plan !== "object")
            return false;
        if (!plan.reasoning || typeof plan.reasoning !== "string")
            return false;
        if (Array.isArray(plan.files_to_modify) && plan.files_to_modify.length > 0)
            return true;
        if (Array.isArray(plan.files_to_create) && plan.files_to_create.length > 0)
            return true;
        return false;
    }
    buildFallbackPlan(prdRes, apiRes, targetComponentContext) {
        const filesToModify = [];
        const filesToCreate = [];
        const verificationPoints = [];
        const componentPath = this.targetComponentPath || "";
        const route = this.targetRoute || "订单详情页";
        const prdRules = Array.isArray(prdRes === null || prdRes === void 0 ? void 0 : prdRes.logic_rules) ? prdRes.logic_rules : [];
        const apiMappings = Array.isArray(apiRes === null || apiRes === void 0 ? void 0 : apiRes.api_mappings) ? apiRes.api_mappings : [];
        if (componentPath) {
            filesToModify.push({
                path: componentPath,
                description: "在目标组件中增加照片锁定状态查询、锁定/解锁交互、按钮显隐与禁用逻辑，并结合退款相关状态控制入口展示。",
            });
        }
        const apiPurposeSummary = apiMappings
            .slice(0, 3)
            .map((item) => `${(item === null || item === void 0 ? void 0 : item.method) || ""} ${(item === null || item === void 0 ? void 0 : item.endpoint) || ""} ${(item === null || item === void 0 ? void 0 : item.purpose) || ""}`.trim())
            .filter(Boolean)
            .join("；");
        verificationPoints.push("进入订单详情页后，应根据订单编号拉取照片锁定状态并正确展示。", "执行锁定或解锁操作后，界面状态应立即刷新，并对失败场景给出明确提示。", "退款相关场景下，照片下载入口或授权入口应符合 PRD 中的限制规则。");
        if (apiMappings.some((item) => /lock/i.test((item === null || item === void 0 ? void 0 : item.endpoint) || ""))) {
            verificationPoints.push("锁定接口调用成功后，重复进入详情页时应保持锁定态。");
        }
        const reasoningParts = [
            this.taskObjective || "本次目标是在订单详情页完成照片锁定功能集成。",
            componentPath ? `当前已锁定核心组件 ${componentPath}，规划应优先围绕该文件落地。` : "",
            route ? `目标页面为 ${route}。` : "",
            prdRules.length > 0
                ? `PRD 已明确业务约束，核心规则包括：${prdRules.slice(0, 3).join("；")}。`
                : "PRD 已明确这是围绕退款场景和照片访问控制的功能改造。",
            apiPurposeSummary ? `接口侧已识别的关键能力包括：${apiPurposeSummary}。` : "",
            targetComponentContext
                ? "系统已预取目标组件热点代码片段，当前证据足以直接制定实施方案，无需继续顺序扫描大文件。"
                : "当前可基于已有证据直接收敛方案。",
        ].filter(Boolean);
        return {
            reasoning: reasoningParts.join(""),
            files_to_create: filesToCreate,
            files_to_modify: filesToModify,
            external_libs: [],
            verification_points: Array.from(new Set(verificationPoints)),
            fallback_generated: true,
        };
    }
    forwardAgentProgress(phase, index) {
        return (message) => {
            if (!message)
                return;
            if (message.startsWith("[系统]")) {
                this.emitStepProgress({ phase, content: message, index });
                return;
            }
            this.emitStepProgress({ phase, thought: message, index });
        };
    }
    runFullPipeline(prompt) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.abortController.signal.aborted)
                return;
            const signal = this.abortController.signal;
            this.log(`[WORKFLOW_START] promptChars=${prompt.length}`);
            this.trace("workflow_start", {
                promptChars: prompt.length,
                promptPreview: (0, harness_logger_1.summarizeText)(prompt, 200),
            });
            // 🔍 阶段 0: 深度意图解析 (不依赖任何外部传入路径，模型自主发现)
            this.emitStepStart("INTENT", "🤖 正在深度解析意图...", 0);
            // 初始化 IntentAgent 时，它的 config.projectPath 是未定义的，这是正常的
            const intentAgent = new agents_1.IntentAgent(Object.assign({}, this.llmConfig), this.mcpHub, signal);
            const intentResult = yield intentAgent.execute({ prompt }, "", (t) => this.emitStepProgress({ phase: "INTENT", thought: t, index: 0 }));
            const config = intentResult.parsed;
            this.trace("intent_result", {
                parsedKeys: config && typeof config === "object" ? Object.keys(config) : [],
                projectPath: (config === null || config === void 0 ? void 0 : config.projectPath) || "",
                prdUrl: (config === null || config === void 0 ? void 0 : config.prdUrl) || "",
                apiUrl: (config === null || config === void 0 ? void 0 : config.apiUrl) || "",
                targetRoute: (config === null || config === void 0 ? void 0 : config.targetRoute) || "",
                targetComponentPath: (config === null || config === void 0 ? void 0 : config.targetComponentPath) || "",
                taskObjective: (config === null || config === void 0 ? void 0 : config.taskObjective) || "",
                reasoningPreview: (0, harness_logger_1.summarizeText)((config === null || config === void 0 ? void 0 : config.reasoning) || "", 160),
            });
            // 💡 只有模型真的带回来了验证过的路径，我们才继续
            if (config && config.projectPath) {
                this.projectPath = config.projectPath;
                this.targetRoute = config.targetRoute || "";
                this.targetComponentPath = config.targetComponentPath || "";
                this.taskObjective = config.taskObjective || this.extractTaskObjective(prompt);
                this.llmConfig.projectPath = this.projectPath; // 💉 注入到全局配置
                this.log(`Success: Intent settled at ${this.projectPath}`);
                this.emitStepProgress({ phase: "INTENT", content: `✅ 意图已解析！锁定路径: ${this.projectPath}`, index: 0 });
                this.emitPhaseSummary({
                    phase: "INTENT",
                    index: 0,
                    title: "意图已锁定",
                    summary: `已确定项目路径，并准备进入文档解析阶段。`,
                    highlights: [
                        this.taskObjective ? `目标：${this.taskObjective}` : "",
                        `项目：${this.projectPath}`,
                        this.targetRoute ? `路由：${this.targetRoute}` : "",
                        this.targetComponentPath ? `组件：${this.targetComponentPath}` : "",
                        (config === null || config === void 0 ? void 0 : config.prdUrl) ? `PRD：${config.prdUrl}` : "",
                        (config === null || config === void 0 ? void 0 : config.apiUrl) ? `API：${config.apiUrl}` : "",
                    ].filter(Boolean),
                    stats: [
                        (config === null || config === void 0 ? void 0 : config.prdUrl) ? "PRD 已提取" : "",
                        (config === null || config === void 0 ? void 0 : config.apiUrl) ? "API 已提取" : "",
                        this.targetComponentPath ? "核心组件已识别" : "",
                    ].filter(Boolean),
                });
                if (this.targetComponentPath) {
                    const absoluteComponentPath = path.resolve(this.projectPath, this.targetComponentPath);
                    const componentExists = fs.existsSync(absoluteComponentPath);
                    this.trace("target_component_probe", {
                        targetComponentPath: this.targetComponentPath,
                        absoluteComponentPath,
                        exists: componentExists,
                    });
                    this.emitStepProgress({
                        phase: "INTENT",
                        content: componentExists
                            ? `✅ 核心组件已确认存在: ${this.targetComponentPath}`
                            : `⚠️ 核心组件路径未命中: ${this.targetComponentPath}，后续将回退到目录搜索`,
                        index: 0,
                    });
                }
            }
            else {
                this.emitStepComplete("INTENT", "error", 0);
                this.emitWorkflowComplete("error", "未能从长文中解析到有效项目路径，请确保文档中包含绝对路径并能被 list_dir 访问。");
                return;
            }
            if (signal.aborted)
                return;
            this.emitStepComplete("INTENT", "success", 0);
            const originalPrompt = prompt; // 💡 记录原始长文意图，作为后续所有 Agent 的“最高纲领”
            // 🚀 到这里，我们已经拿齐了所有的武器 (projectPath, prdUrl, apiUrl)，启动主流程
            return this.run(config.prdUrl || prompt, config.apiUrl || "", signal, originalPrompt);
        });
    }
    run(prdUrl, apiUrl, signal, originalPrompt) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            try {
                // 核心：在拿到正确 projectPath 后再创建这些 Agent，让它们“从一开始就看到正确的路”
                this.prdAgent = new agents_1.PRDAgent(this.llmConfig, this.mcpHub, signal);
                this.apiAgent = new agents_1.APIAgent(this.llmConfig, this.mcpHub, signal);
                this.plannerAgent = new agents_1.PlannerAgent(this.llmConfig, this.mcpHub, signal);
                this.coderAgent = new agents_1.CoderAgent(this.llmConfig, this.mcpHub, signal);
                const sharedLessons = this.evalHarness.getRelevantLessons(`${originalPrompt}\n${this.targetComponentPath}\n${this.targetRoute}`);
                const executionBrief = this.buildExecutionBrief();
                const targetComponentContext = this.buildTargetComponentContext();
                this.trace("lessons_loaded", {
                    chars: sharedLessons.length,
                    preview: (0, harness_logger_1.summarizeText)(sharedLessons, 180),
                });
                this.trace("target_component_context", {
                    path: this.targetComponentPath,
                    chars: targetComponentContext.length,
                    preview: (0, harness_logger_1.summarizeText)(targetComponentContext, 200),
                });
                if (signal.aborted)
                    return;
                // PHASE 1: PRD
                this.emitStepStart("PRD", "📄 正在解析需求文档...", 1);
                this.emitStepProgress({
                    phase: "PRD",
                    content: "[系统] 正在抽取需求模块、业务规则和核心约束。",
                    index: 1,
                });
                let prdContent = "";
                const urls = this.larkPrefetcher.extractLarkUrls(prdUrl);
                this.trace("prd_prefetch_start", { sourceUrl: prdUrl, urlCount: urls.length, urls });
                for (const url of urls) {
                    if (signal.aborted)
                        throw new Error("AbortError");
                    const res = yield this.larkPrefetcher.prefetchSource(url, signal);
                    if (res.status === "success") {
                        prdContent += `\n--- SOURCE: ${url} ---\n${res.content}\n`;
                    }
                    this.trace("prd_prefetch_result", {
                        url,
                        status: res.status,
                        contentLen: ((_a = res.content) === null || _a === void 0 ? void 0 : _a.length) || 0,
                        diagnostics: ((_b = res.diagnostics) === null || _b === void 0 ? void 0 : _b.slice(0, 5)) || [],
                    });
                }
                const prdRes = yield this.prdAgent.execute({ query: executionBrief, rawContent: prdContent }, sharedLessons, this.forwardAgentProgress("PRD", 1));
                this.summarizeResult("PRD", prdRes);
                this.emitStepComplete("PRD", "success", 1);
                // PHASE 2: API
                if (signal.aborted)
                    throw new Error("AbortError");
                this.emitStepStart("API", "🔌 正在对接 API 接口...", 2);
                this.emitStepProgress({
                    phase: "API",
                    content: "[系统] 正在对齐接口前缀、能力边界和组件影响面。",
                    index: 2,
                });
                let apiContent = "";
                const apiUrls = apiUrl ? [apiUrl] : this.larkPrefetcher.extractLarkUrls(prdUrl).filter(u => u.includes('wiki/Vs30w'));
                this.trace("api_prefetch_start", { sourceUrl: apiUrl || prdUrl, urlCount: apiUrls.length, urls: apiUrls });
                const targetApiUrl = apiUrls[0] || apiUrl;
                if (targetApiUrl) {
                    const res = yield this.larkPrefetcher.prefetchSource(targetApiUrl, signal);
                    if (res.status === "success")
                        apiContent = res.content;
                    this.trace("api_prefetch_result", {
                        url: targetApiUrl,
                        status: res.status,
                        contentLen: ((_c = res.content) === null || _c === void 0 ? void 0 : _c.length) || 0,
                        diagnostics: ((_d = res.diagnostics) === null || _d === void 0 ? void 0 : _d.slice(0, 5)) || [],
                    });
                }
                const apiRes = yield this.apiAgent.execute({ prd: prdRes, rawContent: apiContent, query: executionBrief }, sharedLessons, this.forwardAgentProgress("API", 2));
                this.summarizeResult("API", apiRes);
                this.emitStepComplete("API", "success", 2);
                // PHASE 3: PLAN
                if (signal.aborted)
                    throw new Error("AbortError");
                const projectTree = yield this.buildProjectTree();
                this.trace("project_tree_ready", {
                    projectPath: this.projectPath,
                    treeChars: projectTree.length,
                    treePreview: (0, harness_logger_1.summarizeText)(projectTree, 200),
                });
                this.emitStepStart("PLAN", "🗺️ 正在制定开发方案...", 3);
                if (projectTree) {
                    this.emitStepProgress({
                        phase: "PLAN",
                        content: "[系统] 已预取项目目录树，规划阶段将优先依据目录结构收敛。",
                        index: 3,
                    });
                }
                if (targetComponentContext) {
                    this.emitStepProgress({
                        phase: "PLAN",
                        content: "[系统] 已预取核心组件关键片段，规划阶段将优先围绕热点代码收敛。",
                        index: 3,
                    });
                }
                let planRes;
                try {
                    planRes = yield this.plannerAgent.execute({
                        prd: prdRes,
                        api: apiRes,
                        projectPath: this.projectPath,
                        projectTree,
                        targetComponentContext,
                        query: executionBrief,
                        targetComponentPath: this.targetComponentPath,
                        targetRoute: this.targetRoute,
                    }, sharedLessons, this.forwardAgentProgress("PLAN", 3));
                }
                catch (error) {
                    this.trace("plan_primary_failed", {
                        message: (error === null || error === void 0 ? void 0 : error.message) || "unknown",
                    });
                    this.emitStepProgress({
                        phase: "PLAN",
                        content: "[系统] 规划阶段主流程未收敛，正在基于现有证据生成兜底实施方案。",
                        index: 3,
                    });
                }
                if (!this.isUsablePlan(planRes)) {
                    planRes = this.buildFallbackPlan(prdRes, apiRes, targetComponentContext);
                    this.trace("plan_fallback_built", {
                        filesToModify: Array.isArray(planRes === null || planRes === void 0 ? void 0 : planRes.files_to_modify) ? planRes.files_to_modify.length : 0,
                        filesToCreate: Array.isArray(planRes === null || planRes === void 0 ? void 0 : planRes.files_to_create) ? planRes.files_to_create.length : 0,
                        verificationPoints: Array.isArray(planRes === null || planRes === void 0 ? void 0 : planRes.verification_points) ? planRes.verification_points.length : 0,
                    });
                    this.emitStepProgress({
                        phase: "PLAN",
                        content: "[系统] 已切换为规划兜底方案，继续进入代码系统集成。",
                        index: 3,
                    });
                }
                this.summarizeResult("PLAN", planRes);
                this.emitStepComplete("PLAN", "success", 3);
                // PHASE 4: CODING
                if (signal.aborted)
                    throw new Error("AbortError");
                this.emitStepStart("CODING", "🛠️ 正在执行系统集成...", 4);
                this.emitStepProgress({
                    phase: "CODING",
                    content: "[系统] 将优先围绕核心组件执行真实代码写入。",
                    index: 4,
                });
                const codingRes = yield this.coderAgent.execute({
                    prd: prdRes,
                    api: apiRes,
                    plan: planRes,
                    projectPath: this.projectPath,
                    query: executionBrief,
                    targetComponentContext,
                    targetComponentPath: this.targetComponentPath,
                    targetRoute: this.targetRoute,
                }, sharedLessons, this.forwardAgentProgress("CODING", 4));
                this.summarizeResult("CODING", codingRes);
                this.emitStepComplete("CODING", "success", 4);
                this.emitWorkflowComplete("success");
            }
            catch (err) {
                if (signal.aborted || err.message === "AbortError") {
                    this.emitWorkflowComplete("error", "Workflow Aborted");
                }
                else {
                    this.trace("workflow_error", { message: err.message, stack: (0, harness_logger_1.summarizeText)(err.stack || "", 400) });
                    this.emitWorkflowComplete("error", err.message);
                    throw err;
                }
            }
        });
    }
    stopWorkflow() {
        this.abortController.abort();
        this.log("Workflow stop signal received.");
    }
}
exports.V2Orchestrator = V2Orchestrator;
