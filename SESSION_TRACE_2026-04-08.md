# 会话变更追溯记录

更新时间：2026-04-08

本文档记录本次对话周期内，对 `feishu-to-code-agent` 项目做过的关键问题分析、根因判断、代码改造、验证结果和后续关注点，便于后续功能迭代追溯。

## 一、目标

本轮持续优化的目标是：

1. 让工作流从 `INTENT -> PRD -> API -> PLAN -> CODING` 尽可能稳定走通。
2. 修复右侧执行流中的异常输出，包括英文思维流、字符级吐字、乱码式 thought。
3. 解决 `实施方案规划` 阶段的死循环和超大文件扫描问题。
4. 增强日志与可观测性，方便后续按 `runId` 精确复盘。
5. 提升本地大模型场景下的流畅度、token 利用率和整体稳定性。

---

## 二、本次会话中发现过的主要问题

### 1. 右侧 thought 出现字符级吐字、重复碎片

现象：

- 一段思维被拆成多个极小片段输出。
- 同一内容看起来像“一个字一个字吐”。
- 有时同一条内容在 thought 和普通日志里重复出现。

根因：

- 后端阶段进度流里，thought 和 content 存在重复透传。
- 前端对两种流同时消费，导致 thought 合并逻辑失效。

处理：

- 去掉同一段内容的双重透传。
- 前端改为 thought 优先，content 仅在不等于 thought 时才进入普通日志。

### 2. PRD / API 阶段一直输出英文思考过程

现象：

- 前 2 个 Agent 经常输出英文 thought。
- 即使提示词要求中文，右侧仍能看到英文 reasoning 流。

根因：

- 展示的是模型原生 `reasoning_content`，本地模型这一通道约束弱，常默认英文。
- 真正稳定可控的是最终 JSON 中的 `reasoning` 字段，而不是原生流式 thought。

处理：

- 加强中文约束。
- 对最终 JSON 中的 `reasoning` 做英文检测与重写。
- 后续进一步收紧为默认不直接展示 raw reasoning。

### 3. PLAN 阶段反复扫描同一大文件，最终 `Max rounds reached`

现象：

- `UserInfoCard.vue` 被从头到尾分段读取。
- 即使已经被系统拦截“禁止继续探测”，模型还是继续 `read_file_lines`。
- 最后止步于 `实施方案规划`。

根因：

- 初期是伪 `<tool_call>` 文本没有被解析成真实工具调用。
- 后续修完后，模型变成了真实顺序扫文件。
- 原有读文件频率拦截只是“提示”，并不会真正让下一轮禁用工具或强制收敛。

处理：

- 增加伪工具调用解析。
- 再增加“强制收敛模式”：Planner 一旦命中高频读取拦截或探索预算超限，下一轮直接禁用工具并要求输出最终 JSON 方案。

### 4. 右侧出现乱码式 thought，例如 `**:**`、`` `/-` ``、`//:`

现象：

- 页面详细日志中出现大量非自然中文的符号流。
- 这些内容虽然不完全是英文，但明显不是人可读的思考过程。

根因：

- 这类内容来自模型原生 `reasoning_content` 本身。
- 之前的过滤只挡英文，没有挡住“中文很少、符号很多”的噪声块。

处理：

- 增加 noisy reasoning 检测。
- 默认关闭 raw reasoning 直出。
- 改用更干净的阶段总结和系统进度提示替代。

### 5. 右侧执行过程不够直观，用户看不清每阶段做了什么

现象：

- 普通日志和阶段结果混在一起。
- 很难快速判断当前走到哪一步。
- 看不到 PRD/API 阶段的明确总结。

处理：

- 新增 `phase-summary` 事件。
- 前端渲染阶段总结卡片。
- 增加当前阶段标识。

### 6. Token 消耗偏大，本地 35B 模型容易慢

现象：

- 后续阶段反复重复塞入原始长 prompt。
- Planner 多轮上下文堆积后 prompt chars 明显膨胀。

处理：

- 原始长意图只在 Intent 完整使用一次。
- 后续阶段使用结构化 `executionBrief`。
- 接入 `ContextManager` 做更激进的历史压缩。

---

## 三、本次会话中完成的核心改造

### A. 执行流与思维流展示链路

完成内容：

1. 修复 thought / content 双写导致的重复和碎片化。
2. 前端增加批量 flush，降低高频小块更新带来的卡顿。
3. 当前阶段增加显式状态展示。
4. 阶段结束后输出总结卡，而不是只留一堆普通日志。

涉及方向：

- `webapp/src/App.tsx`
- `webapp/src/index.css`
- `src/orchestrator/loop-manager.ts`
- `src/server.ts`

### B. 中文 reasoning 与英文泄漏治理

完成内容：

1. 系统提示中强化“必须中文思考和回复”。
2. 对 JSON 的 `reasoning` 做英文检测。
3. 若 `reasoning` 仍是英文，则自动发起一次中文重写。
4. 默认不再把模型 raw reasoning 直接暴露到右侧。
5. 针对符号流、伪工具标签、噪声块做过滤。

涉及方向：

- `src/agents/base-agent.ts`
- `src/agents/prd-agent.ts`
- `src/agents/api-agent.ts`

### C. Planner 防死循环与收敛机制

完成内容：

1. 伪 `<tool_call>` / `<function=...>` / `<parameter=...>` 输出解析为真实工具调用。
2. Planner 工具集在已知核心组件路径时收窄为：
   - `filesystem:grep_search`
   - `code-surgeon:get_file_outline`
   - `code-surgeon:read_file_lines`
3. 引入探索预算与高频读文件拦截。
4. 新增“强制收敛模式”：
   - 一旦触发高频文件读取拦截或探索预算超限
   - 下一轮直接禁用工具
   - 强制要求输出最终 JSON 实施方案

涉及方向：

- `src/agents/base-agent.ts`
- `src/agents/planner-agent.ts`
- `src/tool-gatekeeper.ts`

### D. 目标组件热点预取

完成内容：

1. 对已知核心组件提前做本地静态预取。
2. 自动抽取与以下关键词相关的热点片段：
   - 退款
   - 照片
   - photo
   - lock
   - download
   - refund
   - after_sale
3. 把这些关键窗口作为上下文提前喂给 Planner 和 Coder。

意义：

- 避免 Planner 从头顺扫 `UserInfoCard.vue` 的 1500+ 行。
- 更快聚焦退款与照片授权相关代码区域。

涉及方向：

- `src/orchestrator/loop-manager.ts`
- `src/agents/planner-agent.ts`
- `src/agents/coder-agent.ts`

### E. 性能与 token 优化

完成内容：

1. 新增 `taskObjective` 抽取。
2. 后续阶段统一使用结构化 `executionBrief`。
3. 接入 `ContextManager` 对旧消息、工具调用说明、继续提示、超长 assistant 内容做压缩。
4. 缩短 reasoning-only 回灌内容，避免把大段推理继续喂回模型。
5. 让前端日志刷新节奏更平滑。

涉及方向：

- `src/orchestrator/loop-manager.ts`
- `src/context-manager.ts`
- `src/agents/intent-agent.ts`
- `src/agents/base-agent.ts`
- `webapp/src/App.tsx`

### F. 日志与可观测性增强

完成内容：

1. 新增统一 harness 日志能力。
2. 记录 `runId`、SSE 事件、阶段输出、Agent 每轮状态、工具分发和结果。
3. 前端直接显示 `Run ID`。
4. 便于后续按某次 run 精确排查：
   - 是模型流问题
   - 还是工具调用问题
   - 还是阶段编排问题

涉及日志：

- `.harness/server_events.jsonl`
- `.harness/sse_events.jsonl`
- `.harness/workflow_steps.jsonl`
- `.harness/agent_rounds.jsonl`
- `.harness/mcp_tools.log`
- `.harness/llm_debug.log`
- `.harness/llm_raw_traffic.log`

---

## 四、本次会话中的关键结论

### 1. `System resources observer exited unexpectedly` 不是主因

从时间线判断：

- 工作流先在 `PLAN` 阶段因 `Max rounds reached.` 失败。
- 模型服务相关退出日志出现在其后。

结论：

- `SIGTERM` 更像服务停止后的伴随现象，不是本次流程中断的根因。

### 2. 当前最大的稳定性瓶颈是 Planner 收敛效率

结论：

- 从伪工具调用问题，已经演进到“真实但低效的分段扫描”问题。
- 必须减少 Planner 的自由探索空间，并在拦截后真正切断继续读文件的能力。

### 3. 右侧显示不应依赖模型 raw reasoning

结论：

- 本地大模型 raw reasoning 质量不稳定。
- 用户真正需要的是：
  - 当前阶段
  - 当前动作
  - 阶段总结
  - 关键产出

因此策略改为：

- 系统进度 + 阶段总结优先
- raw reasoning 默认不展示

---

## 五、本次会话涉及的主要文件

### 后端

- `src/agents/base-agent.ts`
- `src/agents/intent-agent.ts`
- `src/agents/prd-agent.ts`
- `src/agents/api-agent.ts`
- `src/agents/planner-agent.ts`
- `src/agents/coder-agent.ts`
- `src/orchestrator/loop-manager.ts`
- `src/context-manager.ts`
- `src/tool-gatekeeper.ts`
- `src/server.ts`
- `src/harness-logger.ts`

### 前端

- `webapp/src/App.tsx`
- `webapp/src/index.css`

### 追溯材料

- `PROJECT_HANDOVER.md`
- `.harness/*.jsonl`
- `.harness/*.log`

---

## 六、最近一轮新增改造（相对于前几轮的增量）

这是最后一轮新增的重点增量：

1. 新增 noisy reasoning 过滤器，彻底压掉乱码式 thought。
2. 默认关闭 raw reasoning 直出。
3. 工具调用过程改为更清晰的系统进度提示。
4. Planner 触发高频扫描拦截后，下一轮禁用工具并强制输出 JSON。
5. 预取目标组件热点片段，缩短 Planner 对大文件的探索时间。
6. Coder 也可以直接拿到核心组件关键片段，减少重复读取。
7. 前端日志 flush 节奏进一步放缓，降低卡顿感。

---

## 六点五、最新补充改造：疏通规划与编码主通路

这是在上面基础上继续追加的最新收敛动作，目标是让 `实施方案规划` 不再稳定报错，并尽量把流程带进 `代码系统集成`：

### 1. Planner 改为“有证据就直接出方案”

新增策略：

- 如果系统已经预取到 `targetComponentContext`（核心组件热点片段），Planner 不再开放工具调用。
- 直接要求模型基于：
  - PRD 结果
  - API 结果
  - 项目目录树
  - 核心组件热点片段
  输出最终 JSON 方案。

目的：

- 避免 Planner 再次进入顺序扫描大文件的模式。

### 2. Planner 增加系统级兜底方案

新增策略：

- 即使 Planner 主流程仍未成功输出可用 JSON，编排层也会基于已有证据直接生成一份 fallback plan。
- 这个兜底方案至少保证：
  - `reasoning`
  - `files_to_modify`
  - `files_to_create`
  - `verification_points`
  是齐全的。

目的：

- 不让流程死在 `PLAN` 阶段。
- 强行把流水线推进到 `CODING`。

### 3. Coder 收紧为围绕目标组件热点片段落地

新增策略：

- 若系统已提供“目标组件关键片段”，Coder 优先围绕这些片段精确读取和修改。
- 不再鼓励从文件开头顺序扫描整个大文件。
- 如果规划来自系统兜底，也要求直接开始写码，而不是重新回到“继续规划”状态。

### 4. 对乱码问题的策略调整

调整结论：

- 不再依赖“把英文 thought 强行切碎过滤”这种方式。
- 当前方向改为：
  - 不直接展示脏 raw reasoning
  - 改展示清晰的系统进度
  - 配合阶段总结卡片

这样比半截过滤后的乱码流更可读。

---

## 七、验证状态

本次会话内多轮修改后，均已做编译级验证。

最近一轮验证结果：

- 后端：`npm run build` 通过
- 前端：`webapp npm run build` 通过

说明：

- 目前已验证到编译通过。
- 真实端到端稳定性，仍需继续通过实际 `runId` 测试来确认。

---

## 八、后续建议测试路径

下一轮测试建议重点看：

1. `INTENT / PRD / API` 右侧是否不再出现乱码 thought。
2. `PLAN` 阶段是否出现：
   - “已触发收敛保护”
   - 然后直接输出 JSON 方案
   - 而不是继续读 `UserInfoCard.vue`
3. `CODING` 阶段是否至少出现一次真实写入。
4. 最终是否能走到代码系统集成结束，而不是止步于规划。

建议每次测试后记录：

- `Run ID`
- 是否进入 `CODING`
- 是否发生真实写入
- 是否出现 `Max rounds reached`
- 是否出现英文或乱码 thought

---

## 九、已知仍需继续观察的点

1. 本地 35B 模型的稳定输出能力仍受上下文大小和推理速度影响。
2. 即使 Planner 已被强制收敛，最终 JSON 方案质量仍依赖模型本身。
3. 目前主要验证的是“走通”和“收敛”，后续还要继续强化“写码后自动验证”的链路。
4. 若后续要追求更高一次过成功率，建议继续加入：
   - 代码写入后的自动 lint/build/test 验证
   - 针对 Coder 的回滚/重试策略
   - 更细粒度的 patch 校验

---

## 十、推荐后续维护方式

建议以后每次大改都在本文件尾部追加一个小节，格式固定为：

### [日期] [主题]

- 背景
- 根因
- 改动文件
- 验证结果
- 待观察风险

这样后续做功能迭代时，可以快速看到：

- 哪个问题什么时候被发现
- 是怎么修的
- 有没有反复出现
- 哪类修复最容易引入副作用
