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
exports.FeishuOpenApiReader = void 0;
const axios_1 = __importDefault(require("axios"));
class FeishuOpenApiReader {
    constructor() {
        this.accessToken =
            process.env.FEISHU_USER_ACCESS_TOKEN ||
                process.env.LARK_USER_ACCESS_TOKEN ||
                process.env.FEISHU_ACCESS_TOKEN ||
                process.env.LARK_ACCESS_TOKEN ||
                "";
        this.baseUrl = (process.env.FEISHU_OPEN_BASE_URL || process.env.LARK_OPEN_BASE_URL || "https://open.feishu.cn").replace(/\/+$/, "");
        this.client = this.accessToken
            ? axios_1.default.create({
                baseURL: this.baseUrl,
                timeout: 20000,
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    "Content-Type": "application/json",
                },
            })
            : null;
    }
    isConfigured() {
        return Boolean(this.client);
    }
    configurationDiagnostics() {
        if (this.client)
            return [];
        return [
            "未检测到可直连飞书 OpenAPI 的用户级 access token。",
            "可通过环境变量提供 `FEISHU_USER_ACCESS_TOKEN`（或 `LARK_USER_ACCESS_TOKEN`），让项目内直连读取替代 lark-cli 子进程。",
        ];
    }
    readSource(url, signal) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.client) {
                return {
                    url,
                    status: "error",
                    content: "飞书 OpenAPI 直连未启用：缺少用户级 access token。",
                    diagnostics: this.configurationDiagnostics(),
                    sheetContexts: [],
                };
            }
            try {
                if (this.isWikiUrl(url))
                    return yield this.readWikiSource(url, signal);
                if (this.isDocUrl(url))
                    return yield this.readDocumentSource(url, undefined, signal);
                if (this.isSheetUrl(url))
                    return yield this.readSheetSource(url, undefined, signal);
                return {
                    url,
                    status: "error",
                    content: "当前链接不是可识别的飞书 wiki/docx/sheets 链接。",
                    diagnostics: ["仅支持飞书 wiki/docx/doc/sheets 预读。"],
                    sheetContexts: [],
                };
            }
            catch (error) {
                return {
                    url,
                    status: "error",
                    content: `飞书 OpenAPI 直连失败：${this.humanizeError(error)}`,
                    diagnostics: [this.humanizeError(error)],
                    sheetContexts: [],
                };
            }
        });
    }
    readWikiSource(url, signal) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const wikiToken = this.extractToken(url, /\/wiki\/([^/?#]+)/);
            const diagnostics = [];
            if (!wikiToken) {
                return {
                    url,
                    status: "error",
                    content: "未能从 wiki 链接中解析 token。",
                    diagnostics: ["wiki token 解析失败。"],
                    sheetContexts: [],
                };
            }
            const envelope = yield this.get("/open-apis/wiki/v2/spaces/get_node", { token: wikiToken }, signal);
            const node = (_a = envelope.data) === null || _a === void 0 ? void 0 : _a.node;
            const resolvedType = typeof (node === null || node === void 0 ? void 0 : node.obj_type) === "string" ? node.obj_type : undefined;
            const objToken = typeof (node === null || node === void 0 ? void 0 : node.obj_token) === "string" ? node.obj_token : "";
            const spaceId = (node === null || node === void 0 ? void 0 : node.space_id) || "";
            const hasChild = (node === null || node === void 0 ? void 0 : node.has_child) || false;
            diagnostics.push(`已通过 OpenAPI 解析 wiki 节点 (Type: ${resolvedType || "unknown"}).`);
            let childrenText = "";
            if (hasChild && spaceId) {
                try {
                    const childrenEnv = yield this.get(`/open-apis/wiki/v2/spaces/${spaceId}/nodes/${wikiToken}/children`, undefined, signal);
                    const children = ((_b = childrenEnv.data) === null || _b === void 0 ? void 0 : _b.items) || [];
                    if (children.length > 0) {
                        childrenText = "\n\n### 🚀 发现子文档 (探索路径)\n" +
                            "当前 Wiki 页面包含以下子节点，如果正文内容不完整，请优先阅读这些子文档：\n" +
                            children.map(c => `- [${c.title}](https://himo-group.feishu.cn/wiki/${c.node_token}) (Type: ${c.obj_type})`).join("\n");
                        diagnostics.push(`发现 ${children.length} 个子节点并已注入上下文。`);
                    }
                }
                catch (e) {
                    diagnostics.push(`尝试读取子节点失败: ${this.humanizeError(e)}`);
                }
            }
            if (!objToken) {
                return {
                    url,
                    status: "success",
                    resolvedType,
                    content: `# Wiki 目录: ${(node === null || node === void 0 ? void 0 : node.title) || "未命名"}\n\n${childrenText || "当前是空节点或目录节点。"}`,
                    diagnostics,
                    sheetContexts: [],
                };
            }
            if (resolvedType === "sheet") {
                const sheet = yield this.readSpreadsheetToken(objToken, signal);
                return {
                    url,
                    status: sheet.preview.startsWith("未能") ? "partial" : "success",
                    resolvedType,
                    content: sheet.preview + childrenText,
                    diagnostics: diagnostics.concat(sheet.diagnostics),
                    sheetContexts: [sheet],
                };
            }
            const docResult = yield this.readDocumentSource(url, objToken, signal);
            docResult.resolvedType = resolvedType;
            docResult.content = docResult.content + childrenText;
            docResult.diagnostics = diagnostics.concat(docResult.diagnostics);
            return docResult;
        });
    }
    readDocumentSource(url, providedToken, signal) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const diagnostics = [];
            const sheetContexts = [];
            const documentToken = providedToken || this.extractToken(url, /\/(?:docx|doc)\/([^/?#]+)/);
            if (!documentToken) {
                return {
                    url,
                    status: "error",
                    content: "未能从文档链接中解析 doc token。",
                    diagnostics: ["doc token 解析失败。"],
                    sheetContexts,
                };
            }
            const metadata = yield this.get(`/open-apis/docx/v1/documents/${documentToken}`, undefined, signal);
            const raw = yield this.get(`/open-apis/docx/v1/documents/${documentToken}/raw_content`, undefined, signal);
            const title = String(((_b = (_a = metadata.data) === null || _a === void 0 ? void 0 : _a.document) === null || _b === void 0 ? void 0 : _b.title) || "").trim();
            const rawContent = String(((_c = raw.data) === null || _c === void 0 ? void 0 : _c.content) || "").trim();
            diagnostics.push("已通过 OpenAPI 读取文档元信息和 raw_content。");
            if (!rawContent) {
                return {
                    url,
                    status: "partial",
                    content: title ? `# ${title}\n\n(raw_content 为空)` : "(raw_content 为空)",
                    diagnostics,
                    sheetContexts,
                };
            }
            const content = [title ? `# ${title}` : "", rawContent].filter(Boolean).join("\n\n");
            diagnostics.push("当前直连路径优先保证正文稳定读取；若需要文档中的内嵌 sheet 展开，可继续走 CLI/MCP 降级补读。");
            return {
                url,
                status: "partial",
                content,
                diagnostics,
                sheetContexts,
            };
        });
    }
    readSheetSource(url, providedToken, signal) {
        return __awaiter(this, void 0, void 0, function* () {
            const spreadsheetToken = providedToken || this.extractToken(url, /\/sheets\/([^/?#]+)/);
            if (!spreadsheetToken) {
                return {
                    url,
                    status: "error",
                    content: "未能从表格链接中解析 spreadsheet token。",
                    diagnostics: ["spreadsheet token 解析失败。"],
                    sheetContexts: [],
                };
            }
            const sheet = yield this.readSpreadsheetToken(spreadsheetToken, signal);
            return {
                url,
                status: sheet.preview.startsWith("未能") ? "partial" : "success",
                resolvedType: "sheet",
                content: sheet.preview,
                diagnostics: sheet.diagnostics,
                sheetContexts: [sheet],
            };
        });
    }
    readSpreadsheetToken(spreadsheetToken, signal) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const diagnostics = [];
            const resolved = yield this.resolveEmbeddedSheetToken(spreadsheetToken, signal);
            diagnostics.push(...resolved.diagnostics);
            const effectiveToken = resolved.token;
            try {
                const metadata = yield this.get(`/open-apis/sheets/v3/spreadsheets/${effectiveToken}/sheets/query`, undefined, signal);
                const sheets = this.extractSheets(metadata.data);
                diagnostics.push(`已通过 OpenAPI 读取表格元信息，共发现 ${sheets.length} 个子表。`);
                const sheetResults = [];
                // 预读前 2 个子表的内容作为预览，其余仅列出名称
                for (let i = 0; i < Math.min(sheets.length, 2); i++) {
                    const s = sheets[i];
                    const sTitle = String(s.title || s.name || s.sheet_id || `Sheet${i + 1}`);
                    const sRange = `${sTitle}!A1:Z20`;
                    try {
                        const vEnv = yield this.get(`/open-apis/sheets/v2/spreadsheets/${effectiveToken}/values/${encodeURIComponent(sRange)}`, undefined, signal);
                        const v = this.extractValues(vEnv.data);
                        sheetResults.push({
                            token: effectiveToken,
                            title: sTitle,
                            preview: this.valuesToMarkdown(sTitle, v),
                            diagnostics: []
                        });
                    }
                    catch (e) {
                        diagnostics.push(`读取子表 ${sTitle} 失败: ${this.humanizeError(e)}`);
                    }
                }
                const allSheetNames = sheets.map(s => String(s.title || s.name || "未命名")).join(", ");
                const combinedPreview = [
                    `### 表格概览 (Spreadsheet Overview)`,
                    `当前表格共有 ${sheets.length} 个子表: [${allSheetNames}]`,
                    `以下展示前 ${sheetResults.length} 个子表的预览数据：`,
                    ...sheetResults.map(sr => sr.preview)
                ].join("\n\n");
                return {
                    token: spreadsheetToken,
                    title: String(((_a = sheets[0]) === null || _a === void 0 ? void 0 : _a.title) || ((_b = sheets[0]) === null || _b === void 0 ? void 0 : _b.name) || "Spreadsheet"),
                    preview: combinedPreview,
                    diagnostics,
                };
            }
            catch (error) {
                diagnostics.push(this.humanizeError(error));
                return {
                    token: spreadsheetToken,
                    title: "unknown",
                    preview: "未能通过 OpenAPI 展开内嵌表格。",
                    diagnostics,
                };
            }
        });
    }
    resolveEmbeddedSheetToken(spreadsheetToken, signal) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            if (!spreadsheetToken.includes("_")) {
                return { token: spreadsheetToken, diagnostics: [] };
            }
            const [docToken, blockId] = spreadsheetToken.split("_");
            if (!docToken || !blockId || docToken.length !== 27) {
                return { token: spreadsheetToken, diagnostics: [] };
            }
            try {
                const block = yield this.get(`/open-apis/docx/v1/documents/${docToken}/blocks/${blockId}`, undefined, signal);
                const realToken = (_c = (_b = (_a = block.data) === null || _a === void 0 ? void 0 : _a.block) === null || _b === void 0 ? void 0 : _b.sheet) === null || _c === void 0 ? void 0 : _c.token;
                if (typeof realToken === "string" && realToken.trim()) {
                    return {
                        token: realToken,
                        diagnostics: ["已将文档内嵌 sheet block 解析为真实 spreadsheet token。"],
                    };
                }
            }
            catch (error) {
                return {
                    token: spreadsheetToken,
                    diagnostics: [`解析内嵌 sheet block 失败：${this.humanizeError(error)}`],
                };
            }
            return {
                token: spreadsheetToken,
                diagnostics: ["未能从 docx block 响应中提取真实 spreadsheet token。"],
            };
        });
    }
    get(pathname, params, signal) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            if (!this.client)
                throw new Error("未配置飞书 OpenAPI access token。");
            const response = yield this.client.get(pathname, { params, signal });
            if (((_a = response.data) === null || _a === void 0 ? void 0 : _a.code) !== 0) {
                throw new Error(((_b = response.data) === null || _b === void 0 ? void 0 : _b.msg) || `OpenAPI 返回 code=${String((_d = (_c = response.data) === null || _c === void 0 ? void 0 : _c.code) !== null && _d !== void 0 ? _d : "unknown")}`);
            }
            return response.data;
        });
    }
    extractToken(url, pattern) {
        const match = url.match(pattern);
        return match === null || match === void 0 ? void 0 : match[1];
    }
    isWikiUrl(url) {
        return /https?:\/\/[^/]+\/wiki\//.test(url);
    }
    isDocUrl(url) {
        return /https?:\/\/[^/]+\/(?:docx|doc)\//.test(url);
    }
    isSheetUrl(url) {
        return /https?:\/\/[^/]+\/sheets\//.test(url);
    }
    extractSheets(payload) {
        var _a;
        if (!payload || typeof payload !== "object")
            return [];
        const data = payload;
        const candidates = [
            data.sheets,
            data.sheet_metadatas,
            (_a = data.spreadsheet) === null || _a === void 0 ? void 0 : _a.sheets,
            data.items,
        ];
        for (const candidate of candidates) {
            if (Array.isArray(candidate)) {
                return candidate.filter(item => Boolean(item) && typeof item === "object");
            }
        }
        return [];
    }
    extractValues(payload) {
        var _a, _b, _c, _d, _e;
        if (!payload || typeof payload !== "object")
            return [];
        const data = payload;
        const directCandidates = [
            data.values,
            (_a = data.valueRange) === null || _a === void 0 ? void 0 : _a.values,
            (_b = data.value_range) === null || _b === void 0 ? void 0 : _b.values,
            ((_c = data.data) === null || _c === void 0 ? void 0 : _c.values),
            ((_e = (_d = data.data) === null || _d === void 0 ? void 0 : _d.valueRange) === null || _e === void 0 ? void 0 : _e.values),
        ];
        for (const candidate of directCandidates) {
            if (Array.isArray(candidate))
                return candidate;
        }
        return [];
    }
    valuesToMarkdown(title, values) {
        const lines = [`## Sheet: ${title}`, ""];
        if (!values.length) {
            lines.push("- 当前 sheet 未返回单元格内容。");
            return lines.join("\n");
        }
        for (const row of values.slice(0, 20)) {
            if (!Array.isArray(row))
                continue;
            const rowText = row.map(cell => String(cell !== null && cell !== void 0 ? cell : "").trim()).join(" | ").trim();
            if (rowText)
                lines.push(`- ${rowText}`);
        }
        if (lines.length === 2)
            lines.push("- 当前 sheet 首屏没有可展示的非空单元格。");
        return lines.join("\n");
    }
    humanizeError(error) {
        var _a, _b, _c, _d;
        if (axios_1.default.isAxiosError(error)) {
            const code = (_b = (_a = error.response) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.code;
            const msg = ((_d = (_c = error.response) === null || _c === void 0 ? void 0 : _c.data) === null || _d === void 0 ? void 0 : _d.msg) || error.message;
            return code ? `${msg} (code=${code})` : msg;
        }
        return error instanceof Error ? error.message : String(error);
    }
}
exports.FeishuOpenApiReader = FeishuOpenApiReader;
