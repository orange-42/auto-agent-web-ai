import { BaseAgent, LLMConfig } from "./base-agent";
import { MCPHub } from "../mcp-hub";

/**
 * PlannerAgent 负责把“需求 + API + 项目结构”压成一份可执行计划。
 *
 * 它输出的不是最终代码，而是 CoderAgent 的作战地图：
 * - 改哪些文件
 * - 每个文件改什么
 * - 哪些 API 本轮 implement / defer
 * - 最后应该怎么验证
 */
export class PlannerAgent extends BaseAgent {
  protected getExecutionPolicy() {
    return {
      displayPhase: "规划实施方案",
      explorationBudget: 8,
      promptCharacterBudget: 16000,
      forceConclusionOnExplorationSaturation: true,
    };
  }

  /**
   * 规划阶段允许有限度探索，但不能无限扫代码。
   * 如果 orchestrator 已经预抓取了核心组件片段，这里会显著收缩工具权限，逼它直接收敛。
   */
  public async execute(input: { prd: any, api: any, query?: string, projectPath?: string, projectTree?: string, targetComponentPath?: string, targetRoute?: string, targetComponentContext?: string, prdFocusContext?: string, artifacts?: any, gateFeedback?: string }, lessons: string, onThought?: (thought: string) => void): Promise<any> {
    const hasPrefetchedComponentContext = Boolean(input.targetComponentContext?.trim());
    const compactPrd = {
      logic_rules: Array.isArray(input.artifacts?.prd?.logic_rules || input.prd?.logic_rules)
        ? (input.artifacts?.prd?.logic_rules || input.prd?.logic_rules).slice(0, 6)
        : [],
      placement_hints: Array.isArray(input.artifacts?.prd?.placement_hints || input.prd?.placement_hints)
        ? (input.artifacts?.prd?.placement_hints || input.prd?.placement_hints).slice(0, 6)
        : [],
      dependency_checks: Array.isArray(input.artifacts?.prd?.dependency_checks || input.prd?.dependency_checks)
        ? (input.artifacts?.prd?.dependency_checks || input.prd?.dependency_checks).slice(0, 6)
        : [],
      evidence_refs: Array.isArray(input.artifacts?.prd?.evidence_refs || input.prd?.evidence_refs)
        ? (input.artifacts?.prd?.evidence_refs || input.prd?.evidence_refs).slice(0, 6)
        : [],
    };
    const compactApi = {
      api_mappings: Array.isArray(input.artifacts?.api?.api_mappings || input.api?.api_mappings)
        ? (input.artifacts?.api?.api_mappings || input.api?.api_mappings).slice(0, 6)
        : [],
      component_impact: Array.isArray(input.artifacts?.api?.component_impact || input.api?.component_impact)
        ? (input.artifacts?.api?.component_impact || input.api?.component_impact).slice(0, 6)
        : [],
      constraints: Array.isArray(input.artifacts?.api?.constraints || input.api?.constraints)
        ? (input.artifacts?.api?.constraints || input.api?.constraints).slice(0, 6)
        : [],
      evidence_refs: Array.isArray(input.artifacts?.api?.evidence_refs || input.api?.evidence_refs)
        ? (input.artifacts?.api?.evidence_refs || input.api?.evidence_refs).slice(0, 6)
        : [],
    };
    const systemPrompt = `你是一位顶级全栈架构师。你的目标是制定一份精密、可直接执行的实施方案，直接供 Coder Agent 落地。

**1. 核心工作流：探索-分析-决策三阶段协议**
你必须分阶段、有节奏地进行规划，严禁跳步：

- **阶段 A: 精准探索**: 根据需求关键词，使用 \`filesystem:grep_search\` 或者结构探测工具精准定位文件。
- **阶段 B: 分析与骨骼扫描**: 
  - 你当前只拥有局部读取工具。必须先使用 \`get_file_outline\` 确定行号，再使用 \`read_file_lines\` 精准截取几十行代码。
- **阶段 C: 决策方案闭环**: 一旦确认了需要修改或新增的文件列表及其关键逻辑变更点，立即输出方案。

**2. 🚫 严禁死循环**
- **禁止对同一个文件反复调用相同的工具（如 get_file_outline）**。如果你已经获取了大纲，请直接进行 read_file_lines 或得出结论。
- 如果某个路径探测不到，请立即尝试搜索其他可能的路径，或根据目录树推断。
- 如果已经拿到项目目录树，请优先利用目录树收敛范围，禁止从根目录开始反复盲搜。
- 连续 3 次探索仍未新增有效证据时，必须停止搜索，直接输出“当前最佳方案 + 风险点” JSON。
- 只能使用模型原生的工具调用能力，严禁在正文里输出 \`<tool_call>\`、\`<function=...>\`、\`<parameter=...>\` 这类伪工具标签。
- 如果用户已经明确给出核心组件路径，你必须先围绕该文件收敛证据；除非发现强耦合依赖，否则不要离开这个文件做大范围搜索。
- 在规划阶段，对同一个核心组件最多做 4 次读取。拿到足够证据后必须立即输出方案，不要为了“更完整”继续扫尾。
- 如果系统已经提供“目标组件快照/关键片段”，优先基于这些证据直接输出方案。除非确实缺少关键上下文，否则不要再从头顺序扫描整个大文件。
${hasPrefetchedComponentContext ? "- 当前回合已经提供了目标组件快照与热点代码片段。你必须直接基于这些证据输出 JSON，禁止再调用工具。" : ""}

**3. 语言要求**
**必须全过程使用中文进行思考 (Reasoning/Thought) 和回复内容。严禁出现英文 Reasoning。**

**4. 输出协议**
理解方案后，必须以 JSON 格式输出最终结论。

**预期 JSON 契约:**
{
  "reasoning": "由于探测到 XXX.vue 的第 50 行存在 API 调用逻辑，我计划... (必须中文)",
  "files_to_create": [ { "path": "src/types/api.ts", "content": "..." } ],
  "files_to_modify": [ { "path": "src/components/User.vue", "description": "增加 XXX 逻辑" } ],
  "operations_outline": [
    { "target": "src/components/User.vue", "kind": "modify", "intent": "补状态、接接口、加交互入口" }
  ],
  "api_coverage": [
    {
      "method": "GET",
      "endpoint": "/xxx/info",
      "purpose": "查询状态",
      "decision": "implement",
      "reason": "当前页面初始化必须接入该能力",
      "target_files": ["src/api/order.js", "src/components/User.vue"]
    }
  ],
  "external_libs": [],
  "verification_points": ["点击按钮应触发 XXX API", "UI 应显示响应结果"],
  "test_cases": [
    {
      "name": "基础集成验证",
      "goal": "验证本轮需求核心行为是否按预期落地",
      "preconditions": [],
      "steps": ["进入目标页面", "执行关键交互"],
      "expected": ["关键 UI、接口调用和状态变化符合预期"]
    }
  ],
  "risk_flags": ["若仍存在证据缺口，请在此明确指出"]
}

**API 覆盖硬约束：**
- \`API Artifact.api_mappings\` 中的每一条映射，都必须在最终 JSON 的 \`api_coverage\` 中逐项给出决策。
- \`decision\` 只能是 \`implement\` 或 \`defer\`。
- 禁止静默忽略接口。即使某个接口本轮不在当前组件直接触发，也必须明确写成 \`defer\` 并解释原因。
- 对于“查询 / 详情 / 状态同步 / 动作提交”这类组合接口，必须分别写清楚当前页面或相关流程如何承接，不允许只覆盖其中最显眼的一条而静默漏掉其余关键接口。

**5. ⚠️ 熔断与避坑指南**
- **超大文件响应**: 若出现 "FILE_TOO_LARGE"，务必切换为 \`get_file_outline\` 或缩小查询范围。
- **环境意识 (Path Loyalty)**: 当前项目物理根路径已在下方 [Project Context] 中给出。
- **80% 完备准则 (80% Done Rule)**: 只要你已经掌握了修改涉及的核心逻辑，立即停止探索，直接输出 JSON 方案。
`;

    const userPrompt = `[Project Context]
- 项目路径: ${input.projectPath}
- 目标路由: ${input.targetRoute || "未明确提供"}
- 核心组件: ${input.targetComponentPath || "未明确提供"}
- 项目全景图 (Directory Tree):
${(input as any).projectTree || "项目目录树暂未预取。如仍缺少结构信息，请优先调用 filesystem:directory_tree 或 filesystem:list_directory，禁止盲目重复搜索。"}
- 目标组件快照 (Hotspots):
${input.targetComponentContext || "目标组件关键片段暂未预取。如已明确核心组件，请最多做少量定点读取后立即收敛。"}

[Task Requirements]
PRD Detail Anchors:
${input.prdFocusContext || "暂无额外 PRD 细节锚点，请至少基于已知业务规则收敛方案。"}

PRD Artifact: ${JSON.stringify(compactPrd, null, 2)}
API Artifact: ${JSON.stringify(compactApi, null, 2)}
${input.gateFeedback ? `\n本轮必须修复的结构化缺口：${input.gateFeedback}\n` : ""}
USER CMD: ${input.query}`;
    
    const toolPattern = hasPrefetchedComponentContext
      ? []
      : input.targetComponentPath
        ? ["filesystem:search_files", "code-surgeon:get_file_outline", "code-surgeon:read_file_lines"]
        : ["filesystem:search_files", "filesystem:list_directory", "filesystem:directory_tree", "filesystem:read_text_file", "code-surgeon:get_file_outline", "code-surgeon:read_file_lines"];

    return await this.callLLM(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ], 
      onThought, 
      toolPattern,
      hasPrefetchedComponentContext ? 4 : 10
    );
  }
}
