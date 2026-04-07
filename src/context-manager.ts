import { LLMMessage } from "./types";

/**
 * ContextManager: 处理消息滑窗、摘要替换、阅后即焚、长文本脱密
 */
export class ContextManager {
  /**
   * 按策略压缩消息历史
   * @param messages 当前消息数组
   * @param loopCount 当前循环轮次
   * @param currentPhaseIndex 当前阶段索引
   * @param displayPhases 阶段名称列表
   * @returns 压缩后的消息数组
   */
  public compressMessages(
    messages: LLMMessage[],
    loopCount: number,
    currentPhaseIndex: number,
    displayPhases: string[]
  ): LLMMessage[] {
    // 更早启动压缩，避免在规划/编码阶段把上下文拖到超长后才处理
    if (loopCount < 6 && messages.length < 14) return messages;

    const preservedSystemCount = 1;  // 系统提示词
    const preservedRecentCount = 10;  // 最近 10 条消息
    const isInCodePhase = currentPhaseIndex >= displayPhases.indexOf("编写代码");

    return messages.map((m, i) => {
      // 始终保留系统提示词、第一条用户消息和最近的消息
      const isFirstUser = m.role === 'user' && i === 1; // 假设 index 0 是 system, 1 是 user
      if (i < preservedSystemCount || isFirstUser || i > messages.length - preservedRecentCount) return m;

      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const toolNames = m.tool_calls
          .map((tool: any) => tool?.function?.name)
          .filter(Boolean)
          .join(', ');
        return {
          ...m,
          content: `[Summary: 该轮已调用工具 ${toolNames || 'unknown'} 推进任务]`
        };
      }

      if (m.role === 'user' && typeof m.content === 'string') {
        if (/^请继续。/.test(m.content)) {
          return {
            ...m,
            content: '[Summary: 系统已要求模型停止重复并直接给出 JSON 或执行下一步工具]'
          };
        }
        if (m.content.includes('编码阶段尚未真正写入任何文件')) {
          return {
            ...m,
            content: '[Summary: 系统已强制要求编码阶段先真实写入文件，再允许结束]'
          };
        }
        if (m.content.includes('reasoning 字段仍是英文')) {
          return {
            ...m,
            content: '[Summary: 系统已要求将 reasoning 字段改写为中文并重新输出 JSON]'
          };
        }
      }

      if (m.role === 'tool' && typeof m.content === 'string') {
        // 策略 1: read_file_lines / get_file_outline 的结果「阅后即焚」摘要化
        if (m.content.includes('--- [File:') && m.content.length > 500) {
          const headerMatch = m.content.match(/--- \[File: ([^,]+), Lines: ([^\]]+)/);
          const filePath = headerMatch ? headerMatch[1] : 'unknown';
          const lineRange = headerMatch ? headerMatch[2] : 'unknown';
          return {
            ...m,
            content: `[Summary: 已读取 ${filePath} 的 ${lineRange} 行代码，内容已被处理以节省 Token。如需重新查看请再次调用 code-surgeon__read_file_lines]`
          };
        }
        
        const isCoreDocTool = /fetch_doc|get_node|read_spreadsheet|# fetch_doc/.test(m.content);
        // 大模型配比：核心文档 8w 触发折叠，保留 4w；普通工具 1.5w 触发，保留 5000
        const truncateLimit = isCoreDocTool ? 80000 : 15000;
        const summaryLimit = isCoreDocTool ? 40000 : 5000;

        if (m.content.length > truncateLimit) {
          return {
            ...m,
            content: m.content.substring(0, summaryLimit) + "\n...[此段历史工具输出由于过长已被折叠。核心业务逻辑已在阶段知识库中同步，若需重读全文请再次调用工具]"
          };
        }
      }

      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 600) {
        return {
          ...m,
          content: m.content.substring(0, 220) + "\n...[中间过程已压缩，保留关键上下文以节省 Token]"
        };
      }

      // 策略 3: 进入编码阶段后，压缩早期的 PRD assistant 分析回复
      if (isInCodePhase && m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 2000 && i < messages.length - 15) {
        return {
          ...m,
          content: m.content.substring(0, 500) + "\n...[早期分析内容已压缩以腾出 Token 空间，核心结论已由系统在阶段知识库中备份]"
        };
      }

      return m;
    });
  }

  /**
   * 获取工具结果的截断保护文本
   */
  public protectToolResult(rawName: string, content: string): string {
    const lowerName = rawName.toLowerCase();
    // 飞书 PRD/API 文档放宽限制，允许较长的业务上下文 (4w)
    if (lowerName.includes('fetch_doc') || lowerName.includes('lark') || lowerName.includes('feishu')) {
      return content.length > 40000 ? content.substring(0, 40000) + "\n...[内容过长（已超4w字），已截断。建议针对性提取核心 API/逻辑摘要]" : content;
    }
    // Code-Surgeon 的 read_file_lines 结果允许 1.5w
    const maxLen = lowerName.includes('read_file_lines') ? 15000 : 10000;
    if (content.length > maxLen) {
      return content.substring(0, maxLen) + "\n...[内容过长，已截断。请使用 code-surgeon__read_file_lines 的 start_line/end_line 进行更精准的分段读取]";
    }
    return content;
  }
}
