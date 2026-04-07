"use strict";
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
exports.MCPHub = void 0;
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class MCPHub {
    constructor(configPath) {
        this.clients = new Map();
        this.configs = {};
        this.toolsCache = null;
        const config = JSON.parse(fs_1.default.readFileSync(configPath, 'utf-8'));
        this.configs = config.mcpServers;
    }
    initialize() {
        return __awaiter(this, void 0, void 0, function* () {
            console.log("🚀 Initializing Feishu Agent MCP Hub...");
            const promises = Object.entries(this.configs).map((_a) => __awaiter(this, [_a], void 0, function* ([name, config]) {
                try {
                    const transport = new stdio_js_1.StdioClientTransport({
                        command: config.command,
                        args: config.args,
                        env: Object.assign(Object.assign({}, process.env), config.env)
                    });
                    const client = new index_js_1.Client({
                        name: "feishu-to-code-agent",
                        version: "1.0.0"
                    }, {
                        capabilities: {}
                    });
                    yield client.connect(transport);
                    this.clients.set(name, client);
                    console.log(`✅ Connected to MCP server: ${name}`);
                }
                catch (error) {
                    console.error(`❌ Failed to connect to MCP server ${name}:`, error instanceof Error ? error.message : String(error));
                }
            }));
            yield Promise.allSettled(promises);
            // 预热工具缓存
            yield this.getAllTools();
        });
    }
    getAllTools() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.toolsCache)
                return this.toolsCache;
            console.log("📡 Fetching tools from all MCP servers...");
            const allTools = [];
            for (const [name, client] of this.clients.entries()) {
                try {
                    const response = yield client.listTools();
                    if (response === null || response === void 0 ? void 0 : response.tools) {
                        for (const tool of response.tools) {
                            allTools.push(Object.assign(Object.assign({}, tool), { serverName: name, fullName: `${name}:${tool.name}` }));
                        }
                    }
                }
                catch (error) {
                    console.error(`⚠️ Skipping tools for ${name}:`, error);
                }
            }
            this.toolsCache = allTools;
            return allTools;
        });
    }
    logToolCall(serverName, toolName, args, response) {
        const timestamp = new Date().toISOString();
        const harnessDir = path_1.default.join(process.cwd(), ".harness");
        if (!fs_1.default.existsSync(harnessDir))
            fs_1.default.mkdirSync(harnessDir, { recursive: true });
        const logPath = path_1.default.join(harnessDir, "mcp_tools.log");
        const logEntry = `\n[${timestamp}] 🛠️ SERVER: ${serverName} | TOOL: ${toolName}\n` +
            `👉 ARGS: ${JSON.stringify(args, null, 2)}\n` +
            `✅ RESPONSE: ${JSON.stringify(response, null, 2)}\n` +
            `--------------------------------------------------\n`;
        fs_1.default.appendFileSync(logPath, logEntry);
    }
    callTool(fullName, args) {
        return __awaiter(this, void 0, void 0, function* () {
            // 💡 保持向后兼容：解析 server:tool 格式
            const [serverName, toolName] = fullName.includes(':') ? fullName.split(':') : fullName.split('__');
            if (!serverName || !toolName) {
                throw new Error(`Invalid tool name format: ${fullName}. Expected 'server:tool' or 'server__tool'`);
            }
            // 🚀 核心加固：参数自动对齐 (Parameter Adapter)
            // 专门针对 Gemma 等模型的“参数名幻觉”
            let adaptedArgs = Object.assign({}, args);
            if (serverName === 'lark-feishu') {
                if (toolName === 'fetch_doc' || toolName === 'resolve_wiki_token') {
                    if (adaptedArgs.url && !adaptedArgs.doc_url_or_token) {
                        adaptedArgs.doc_url_or_token = adaptedArgs.url;
                        delete adaptedArgs.url;
                    }
                }
                if (toolName === 'search_wiki_node' && adaptedArgs.name && !adaptedArgs.title) {
                    adaptedArgs.title = adaptedArgs.name;
                }
            }
            const server = this.clients.get(serverName);
            if (!server)
                throw new Error(`MCP Server ${serverName} not found. Available servers: ${Array.from(this.clients.keys()).join(', ')}`);
            const response = yield server.callTool({ name: toolName, arguments: adaptedArgs });
            // 📝 记录审计日志 (记录修正后的参数)
            this.logToolCall(serverName, toolName, adaptedArgs, response);
            return response;
        });
    }
    getTools(toolNames) {
        if (!this.toolsCache || toolNames.length === 0)
            return undefined;
        return this.toolsCache.filter(t => toolNames.includes(t.serverName) || toolNames.includes(t.fullName));
    }
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            for (const client of this.clients.values()) {
                yield client.close();
            }
            this.toolsCache = null;
        });
    }
}
exports.MCPHub = MCPHub;
