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
const dotenv = __importStar(require("dotenv"));
const mcp_hub_1 = require("./mcp-hub");
const loop_manager_1 = require("./orchestrator/loop-manager");
const path_1 = __importDefault(require("path"));
dotenv.config();
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        const mcpHub = new mcp_hub_1.MCPHub(path_1.default.join(process.cwd(), 'mcp-config.json'));
        yield mcpHub.initialize();
        const modelConfig = {
            apiKey: process.env.OPENAI_API_KEY || "",
            baseUrl: process.env.OPENAI_API_BASE || "https://api.openai.com/v1",
            model: process.env.OPENAI_MODEL || "gpt-4-turbo",
            modelId: process.env.OPENAI_MODEL || "gpt-4-turbo"
        };
        const orchestrator = new loop_manager_1.V2Orchestrator(modelConfig, mcpHub);
        console.log("\n🤖 Feishu Requirement to Code Agent [V2 Engine] Ready.");
        console.log("-----------------------------------------");
        const args = process.argv.slice(2);
        const userQuery = args[0];
        if (!userQuery) {
            console.log("Usage: npm run start \"Your instruction task manual\"");
            process.exit(0);
        }
        // CLI 注入监听，方便调试
        orchestrator.on("step-progress", (data) => {
            if (data.thought)
                console.log(`\n💭 Thought: ${data.thought.substring(0, 500)}...`);
            if (data.content)
                console.log(`\n✅ Progress: ${data.content}`);
        });
        orchestrator.on("workflow-complete", (data) => {
            console.log("\n🏁 Workflow Finished:", data.status);
            process.exit(0);
        });
        yield orchestrator.runFullPipeline(userQuery);
    });
}
main().catch(console.error);
