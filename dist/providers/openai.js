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
exports.OpenAIProvider = void 0;
const axios_1 = __importDefault(require("axios"));
const base_1 = require("./base");
class OpenAIProvider extends base_1.LLMProvider {
    constructor(apiKey, baseUrl = "https://api.openai.com/v1") {
        super();
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
    }
    generateResponse(messages, tools, signal) {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield axios_1.default.post(`${this.baseUrl}/chat/completions`, {
                model: "gpt-4o",
                messages: messages,
                tools: tools === null || tools === void 0 ? void 0 : tools.map(t => ({
                    type: "function",
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters
                    }
                }))
            }, {
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                signal
            });
            const choice = response.data.choices[0].message;
            return {
                content: choice.content,
                tool_calls: choice.tool_calls
            };
        });
    }
}
exports.OpenAIProvider = OpenAIProvider;
