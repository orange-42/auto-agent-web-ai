import { BaseAgent, LLMConfig } from "./base-agent";
import { MCPHub } from "../mcp-hub";

export class CoderAgent extends BaseAgent {

  public async execute(input: { prd: any, api: any, plan: any, error?: string, projectPath: string, query?: string, targetComponentPath?: string, targetRoute?: string, targetComponentContext?: string }, lessons: string, onThought?: (thought: string) => void): Promise<any> {
    const planModifyFiles = Array.isArray(input.plan?.files_to_modify)
      ? input.plan.files_to_modify
          .map((item: any) => item?.path || item?.file || item?.target_file || "")
          .filter(Boolean)
      : [];
    const planCreateFiles = Array.isArray(input.plan?.files_to_create)
      ? input.plan.files_to_create
          .map((item: any) => item?.path || item?.file || item?.target_file || "")
          .filter(Boolean)
      : [];
    const focusFiles = Array.from(
      new Set(
        [input.targetComponentPath || "", ...planModifyFiles, ...planCreateFiles].filter(Boolean),
      ),
    );
    const primaryTarget = focusFiles[0] || input.targetComponentPath || "Unknown";
    const allowedFilesBlock = focusFiles.length > 0
      ? focusFiles.map((file: string) => `- ${file}`).join("\n")
      : "- 当前规划结果未给出明确文件，请先围绕核心组件收敛并完成写入";
    this.requiredWriteTargets = input.targetComponentPath
      ? [input.targetComponentPath]
      : [];

    const systemPrompt = `# 角色与核心哲学

你是一个运行在全自动工程流水线中的「顶级 AI 软件工程师」。你的目标是以“外科手术般的精准度”修改代码库。

## 📍 当前作战指令：高确定性落地模式

优先目标文件：\`${primaryTarget}\`。

允许修改或新增的文件范围：
${allowedFilesBlock}

如果规划结果不完整，但用户已经明确给出核心组件路径，你必须先完成该核心组件的集成落地，再按需补充其直接依赖文件。

你的目标不是继续写方案，而是**真正写入代码**，完成“照片锁定”功能的系统集成。

**请务必始终使用中文进行思考 (Reasoning/Thought) 和回复。**

如果系统已经提供“目标组件关键片段”，优先围绕这些片段进行精确读取和修改。除非 search block 匹配失败，否则不要从文件开头顺序扫描整个大文件。

## 🗺️ 路径规则 (重要)

1. **自动锚定**: 你的工作目录已被锁定在项目根路径 \`${input.projectPath}\`。

2. **相对路径**: 在调用任何工具（filesystem, code-surgeon, internal_surgical_edit）时，只需提供**相对于项目根目录**的路径（例如 \`src/api/user.js\`）。

3. **系统保障**: 系统会自动将你的相对路径解析为物理绝对路径。请千万不要尝试在路径前叠加 \`webapp/\` 或其他不在 PRD 定义中的前缀。

## 🔴 核心工具：外科手术刀 (internal_surgical_edit)

直接使用 \`internal_surgical_edit\` 工具进行核心代码修改。

**使用规范**：

1. **精确定位**: \`search\` 块必须与源文件中的内容 100% 匹配。

2. **即时校验**: 调用该工具后，系统会立刻返回执行结果。

3. **自我修复**: 如果报错 "Search block not found"，必须立即使用 \`code-surgeon:read_file_lines\` 重新查看原始缩进，严禁盲猜。

**【操作守则】**：

- **新建文件**: 将 \`search\` 参数设为空字符串 ""。

- **物理路径绝对忠诚**: 严格使用 PRD 要求的路径。

## 🔴 辅助工具

- \`code-surgeon:read_file_lines\`: 确保 SEARCH 块 100% 匹配。

- \`filesystem:read_text_file\`: 了解文件全局上下文。

- \`filesystem:list_directory\`: 探测目录结构。

**【上下文环境】**

${lessons}

`;

    const userPrompt = `【优先目标文件】: ${primaryTarget}

【目标路由】: ${input.targetRoute || "未明确提供"}

【核心组件】: ${input.targetComponentPath || "未明确提供"}

【目标组件关键片段】:
${input.targetComponentContext || "暂未预取组件热点片段，请按需读取最小必要上下文。"}

【实施方案】: ${JSON.stringify(input.plan)}

若实施方案来自系统兜底，请直接基于 PRD、API 和目标组件关键片段开始写码，不要再次回到“重新规划”状态。

【全局业务背景 (仅参考)】:

PRD: ${JSON.stringify(input.prd)}

API: ${JSON.stringify(input.api)}

【原始用户指令】: ${input.query || ""}

【执行反馈】: ${input.error || 'None'}`;

    const toolPattern = input.targetComponentContext
      ? ["code-surgeon:read_file_lines", "internal_surgical_edit"]
      : ["filesystem:read_text_file", "code-surgeon:read_file_lines", "internal_surgical_edit"];

    return await this.callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], onThought, toolPattern, 20);
  }
}
