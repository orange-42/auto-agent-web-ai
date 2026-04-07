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
exports.GitSandbox = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class GitSandbox {
    constructor(projectPath) {
        this.projectPath = projectPath;
    }
    prepareBranch() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const timestamp = Date.now();
                const branchName = `agent-auto-build-${timestamp}`;
                // 检查是否有未提交更改，有则 stash
                yield (0, util_1.promisify)(child_process_1.exec)(`git stash`, { cwd: this.projectPath }).catch(() => null);
                // 切出新分支
                yield (0, util_1.promisify)(child_process_1.exec)(`git checkout -b ${branchName}`, { cwd: this.projectPath });
                return branchName;
            }
            catch (e) {
                console.warn(`[Sandbox] Git 操作提示: ${e.message}`);
                return undefined;
            }
        });
    }
    checkHealth() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // 执行类型检查或构建 (假设有 npm run build 或使用 tsc)
                const { stdout, stderr } = yield execAsync(`npm run build`, {
                    cwd: this.projectPath,
                    timeout: 60000
                }).catch(err => err); // 捕获报错作为日志
                const combined = (stdout || '') + (stderr || '');
                const isError = combined.toLowerCase().includes('error') || combined.toLowerCase().includes('failed');
                return {
                    ok: !isError,
                    log: combined.slice(-2000) // 截取最后一部分核心错误
                };
            }
            catch (e) {
                return { ok: false, log: e.message };
            }
        });
    }
    rollback(branchName) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!branchName)
                return;
            try {
                yield execAsync(`git checkout -`, { cwd: this.projectPath });
                yield execAsync(`git branch -D ${branchName}`, { cwd: this.projectPath });
            }
            catch (e) { /* ignore */ }
        });
    }
}
exports.GitSandbox = GitSandbox;
