"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskPlanner = void 0;
/**
 * TaskPlanner: 专门处理任务清单 JSON 的解析、状态更新和 Phase 门禁判定
 */
class TaskPlanner {
    constructor() {
        this.taskList = [];
        this.lastMarkedDoneId = null;
    }
    /**
     * 初始化或增量更新任务列表
     */
    updateTaskList(rawJson) {
        if (!rawJson.trim())
            return;
        const normalized = this.extractTaskPayload(rawJson);
        if (!normalized)
            return;
        try {
            const cleaned = normalized.replace(/```json/g, "").replace(/```/g, "").trim();
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed)) {
                this.mergeTasks(parsed);
            }
        }
        catch (_a) {
            const markdownTasks = this.parseMarkdownTaskList(normalized);
            if (markdownTasks.length > 0) {
                this.mergeTasks(markdownTasks);
            }
        }
    }
    markTaskDoneFromContent(content) {
        const matches = Array.from(content.matchAll(/\[TASK_DONE:(\d+)\]/g));
        for (const match of matches) {
            this.markTaskDone(Number(match[1]));
        }
    }
    getTaskById(id) {
        return this.taskList.find(t => t.id === id);
    }
    /**
     * 标记任务完成
     */
    markTaskDone(taskId) {
        const task = this.taskList.find(t => t.id === taskId);
        if (task && task.status !== "done") {
            task.status = "done";
            this.lastMarkedDoneId = taskId;
        }
    }
    areDocTasksDone() {
        const docPhases = this.taskList.filter(t => t.phase.includes("PRD") || t.phase.includes("API"));
        // 强制引导：如果模型还没定义任务列表，提示它定义
        if (docPhases.length === 0) {
            return [{ id: 0, phase: "读取 PRD", description: "⚠️ 提示：请先使用 [TASK_LIST] 格式定义你的全流程任务清单。系统将根据你的 [TASK_DONE:ID] 标记自动为你解锁后续工具权限。", status: "pending" }];
        }
        return docPhases.filter(t => t.status !== "done");
    }
    isDocPhaseJustDone() {
        if (this.lastMarkedDoneId === null)
            return false;
        const task = this.getTaskById(this.lastMarkedDoneId);
        this.lastMarkedDoneId = null; // 消费后重置
        if (!task)
            return false;
        return task.phase.includes("PRD") || task.phase.includes("API");
    }
    getUndoneTasks() {
        return this.taskList.filter(t => t.status !== "done");
    }
    buildTaskListSnapshot() {
        if (this.taskList.length === 0)
            return "";
        return `\n## 📋 任务状态大盘 (Task Dashboard)\n| ID | 阶段 | 任务描述 | 状态 |\n|---|---|---|---|\n` +
            this.taskList.map(t => `| ${t.id} | ${t.phase} | ${t.description} | ${t.status === 'done' ? '✅ 已完成' : '⏳ 待处理'} |`).join("\n") + "\n";
    }
    reset() {
        this.taskList = [];
        this.lastMarkedDoneId = null;
    }
    mergeTasks(tasks) {
        tasks.forEach((newTask) => {
            const existing = this.taskList.find(t => t.id === newTask.id);
            if (existing) {
                if (newTask.status === "done")
                    existing.status = "done";
                if (existing.status !== "done" && newTask.status)
                    existing.status = newTask.status;
                existing.description = newTask.description;
                existing.phase = newTask.phase;
            }
            else {
                this.taskList.push(newTask);
            }
        });
    }
    extractTaskPayload(rawContent) {
        var _a;
        const blockMatch = rawContent.match(/\[TASK_LIST\]([\s\S]*?)(?=\n\[[A-Z_]+:?|\n## |\n### |\n\[PHASE:|$)/);
        if ((_a = blockMatch === null || blockMatch === void 0 ? void 0 : blockMatch[1]) === null || _a === void 0 ? void 0 : _a.trim())
            return blockMatch[1].trim();
        if (rawContent.includes("[TASK_LIST]"))
            return rawContent;
        return rawContent.trim();
    }
    parseMarkdownTaskList(rawContent) {
        var _a;
        const lines = rawContent
            .split("\n")
            .map(line => line.trim())
            .filter(Boolean);
        const tasks = [];
        let currentPhase = "未分组";
        for (const line of lines) {
            const phaseMatch = line.match(/^\[PHASE:([^\]]+)\]$/);
            if (phaseMatch) {
                currentPhase = phaseMatch[1];
                continue;
            }
            const taskMatch = line.match(/^-\s*\[(x|X| )\]\s*(?:#?(\d+)[\.\s、:-]*)?(.*)$/);
            if (!taskMatch)
                continue;
            const explicitId = taskMatch[2] ? Number(taskMatch[2]) : tasks.length + 1;
            const description = (_a = taskMatch[3]) === null || _a === void 0 ? void 0 : _a.trim();
            if (!description)
                continue;
            tasks.push({
                id: explicitId,
                description,
                status: /x/i.test(taskMatch[1] || "") ? "done" : "pending",
                phase: currentPhase,
            });
        }
        return tasks;
    }
}
exports.TaskPlanner = TaskPlanner;
