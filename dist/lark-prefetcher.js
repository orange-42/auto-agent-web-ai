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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LarkPrefetcher = void 0;
const feishu_openapi_reader_1 = require("./feishu-openapi-reader");
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/**
 * LarkPrefetcher: 专门处理飞书文档、表格的预读与穿透逻辑 (CLI / OpenAPI)
 */
class LarkPrefetcher {
    constructor(telemetryCallback) {
        this.telemetryCallback = telemetryCallback;
        this.feishuOpenApiReader = new feishu_openapi_reader_1.FeishuOpenApiReader();
        this.cache = new Map();
    }
    isApiConfigured() { return this.feishuOpenApiReader.isConfigured(); }
    clearCache() { this.cache.clear(); }
    // ────────────────── CLI 辅助方法 ──────────────────
    runLarkCli(args, signal) {
        return __awaiter(this, void 0, void 0, function* () {
            const commandText = `lark-cli ${args.map(arg => `'${arg.replace(/'/g, `'\\''`)}'`).join(" ")}`;
            const shell = process.env.SHELL || "/bin/zsh";
            try {
                const { stdout, stderr } = yield execFileAsync(shell, ["-lc", commandText], { timeout: 60000, signal });
                const output = `${stdout || ""}${stderr || ""}`.trim();
                return { ok: !/(^|\b)error\b|keychain entry not found|"ok"\s*:\s*false/i.test(output), text: output };
            }
            catch (e) {
                return { ok: false, text: e.message || "lark-cli execution failed" };
            }
        });
    }
    // ────────────────── 核心预读逻辑 ──────────────────
    prefetchSource(url, signal) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const cached = this.cache.get(url);
            if (cached)
                return cached;
            // 尝试 OpenAPI 直连
            if (this.isApiConfigured()) {
                const start = Date.now();
                const ctx = yield this.feishuOpenApiReader.readSource(url, signal);
                this.telemetryCallback("feishu-openapi:prefetch", Date.now() - start, ctx.status !== "error", ctx.status === "error" ? ctx.content : undefined);
                if (ctx.status !== "error")
                    this.cache.set(url, ctx);
                return ctx;
            }
            // 回退到 CLI 预读 (代码略微精简，聚焦逻辑)
            const start = Date.now();
            const result = yield this.runLarkCli(["docs", "+fetch", "--as", "user", "--doc", url, "--format", "json"], signal);
            this.telemetryCallback("lark-cli:prefetch", Date.now() - start, result.ok, result.ok ? undefined : result.text);
            if (!result.ok) {
                return { url, status: "error", content: `飞书 PRD 预读失败: ${result.text}`, diagnostics: [], sheetContexts: [] };
            }
            const payload = this.safeJsonParse(result.text);
            const markdown = ((_a = payload === null || payload === void 0 ? void 0 : payload.data) === null || _a === void 0 ? void 0 : _a.markdown) || (payload === null || payload === void 0 ? void 0 : payload.markdown) || result.text;
            const success = { url, status: "success", content: markdown, diagnostics: [], sheetContexts: [] };
            this.cache.set(url, success);
            return success;
        });
    }
    safeJsonParse(raw) { try {
        return JSON.parse(raw);
    }
    catch (_a) {
        return null;
    } }
    extractLarkUrls(text) {
        const matches = text.match(/https?:\/\/[^\s)"']+/g) || [];
        const unique = new Set();
        for (const url of matches) {
            if (/https?:\/\/[^/]+\/(wiki|docx|doc|sheets)\//.test(url) && (url.includes("feishu.cn") || url.includes("larksuite.com"))) {
                unique.add(url);
            }
        }
        return Array.from(unique);
    }
}
exports.LarkPrefetcher = LarkPrefetcher;
