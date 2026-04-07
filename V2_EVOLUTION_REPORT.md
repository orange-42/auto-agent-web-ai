# 🚀 Feishu-to-Code Agent: V2 引擎架构演进报告 (2026-04-07)

## 0. 核心痛点解决 (The Great Bug Cleanup)
在前几轮中，我们彻底解决了困扰系统的三大幽灵 Bug：
1. **僵尸警告 (The Ghost Warning)**: 彻底物理删除了 1032 行的旧版本 `src/orchestrator.ts`。由于旧代码残留导致 `dist/` 编译后一直报 `projectPath is missing`。现在已实现物理路径验证，不再有配置空窗。
2. **类型血崩 (Type Mismatch)**: 修复了 `LLMConfig` 接口在 `BaseAgent`、`LoopManager` 和 `main.ts` 三地不统一的问题（如 `model` vs `modelId`），确保 `tsc` 编译 100% 通过。
3. **SSE 残差 (UI Stalls)**: 修正了前端 `App.tsx` 和后端 `server.ts` 对异步流式日志的处理逻辑，确保推理过程中的 Thought 不再被 UI “吞掉”。

---

## 1. 意图优先架构 (Intent-First Paradigm)
这是 V2 版最核心的逻辑变化：**不再依赖外界硬编码路径。**

### 1.1 IntentAgent (预检先遣队)
- **位置**: `src/orchestrator/loop-manager.ts`
- **逻辑**: 在主流水线启动前，`IntentAgent` 会首先全量读取用户的“作战手册”。
- **实地探测**: 只要模型识别出潜在路径（如 `/Users/allen/...`），它被强制要求调用 `list_dir` 进行实地探测。
- **环境绑定**: 只有当 `list_dir` 返回内容，证明该路径真实存在且有权限访问时，该路径才会被注入到后续的 `PRDAgent` 和 `CoderAgent` 中。

### 1.2 注入机制
后续的所有 Agent (PRD -> API -> PLAN -> CODING) 的 `config` 都是在 `Discovery` 阶段成功后动态创建的，保证了上下文的一致性。

---

## 2. 工程规范与运维
1. **单一入口**: `server.ts` 现在是唯一的 Web 后端入口，`main.ts` 已同步升级为支持 Composite Prompt 的 CLI。
2. **物理清理**: 以后若遇到灵异现象，首选命令：`rm -rf dist && npm run build`。
3. **停止机制**: 深度贯彻 `AbortSignal` 对齐。在 `BaseAgent` 的 `callLLM` 循环中，每一步都会检查信号，点击“停止”按钮可实现秒关。

---

## 3. 文件清单演进
- `src/server.ts`: 已精简，支持原始长文本 Intake。
- `src/orchestrator/loop-manager.ts`: 实现了 V2 引擎的主循环分层。
- `src/agents/base-agent.ts`: 所有的 Agent 都继承自此，集成了 SSE 通讯、Linter 自动纠偏和实地日志系统。
- `src/main.ts`: CLI 版本升级，现支持直接接长文。

---

## 4. 后续注意事项
- **PRD URL 提取**: 系统会自动从你的长文中提取 wiki 链接，但建议在长文中明确标出“核心资源”板块。
- **接口文档兼容**: 目前针对 `/wiki/Vs30w` 等特定格式做了基于 `LarkPrefetcher` 的自动提取。

---
**当前状态：** 系统全链路已打通，`tsc` 编译通过，`dist/` 已更新。  
**汇报人：** Antigravity Agent (2026.04.07)
