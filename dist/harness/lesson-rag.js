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
exports.EvalHarness = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class EvalHarness {
    constructor(baseDir) {
        this.baseDir = baseDir;
        this.lessonsDir = path.join(this.baseDir, ".harness", "lessons");
        if (!fs.existsSync(this.lessonsDir)) {
            fs.mkdirSync(this.lessonsDir, { recursive: true });
        }
    }
    recordLesson(lesson) {
        return __awaiter(this, void 0, void 0, function* () {
            const data = Object.assign(Object.assign({}, lesson), { id: Math.random().toString(36).substring(7), timestamp: Date.now() });
            const fileName = `${data.id}_${data.grade}.json`;
            fs.writeFileSync(path.join(this.lessonsDir, fileName), JSON.stringify(data, null, 2));
            return data;
        });
    }
    getRelevantLessons(context, limit = 3) {
        try {
            const files = fs.readdirSync(this.lessonsDir);
            const allLessons = files
                .filter(f => f.endsWith('.json'))
                .map(f => JSON.parse(fs.readFileSync(path.join(this.lessonsDir, f), 'utf-8')))
                .filter(l => l.grade !== 'S'); // We learn from mistakes (A/F)
            // Simple keyword matching for context relevance
            const relevant = allLessons
                .filter(l => context.split(' ').some(word => l.context.includes(word)))
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, limit);
            if (relevant.length === 0)
                return "";
            return "### 🎓 历史经验教训 (Evolution Lessons)\n" +
                relevant.map(l => `- 错误情境: ${l.context}\n- 失败原因: ${l.errorLog || '未知'}\n- 进化指令: ${l.lesson}`).join("\n\n");
        }
        catch (e) {
            return "";
        }
    }
}
exports.EvalHarness = EvalHarness;
