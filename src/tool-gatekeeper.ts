import { TaskItem } from "./types";
import { getReadLoopWeight, ReadLoopGuardConfig } from "./agents/execution-guard-policy";

/**
 * ToolGatekeeper: 封装 isTechnicalTool 门禁逻辑和 ReadTracker 物理死循环拦截
 */
export class ToolGatekeeper {
  /**
   * ReadTracker 用于物理级防扫描死循环 (key: path + start + end)
   */
  private readTracker: Map<string, number> = new Map();
  /**
   * FileVisitTracker 用于跟踪单个文件被频繁访问的次数 (不限行号)
   */
  private fileVisitTracker: Map<string, number> = new Map();

  /**
   * 检查是否正在调用技术相关的本地工具（filesystem 或 code-surgeon）
   */
  public isTechnicalTool(toolName: string): boolean {
    const lowerName = toolName.toLowerCase();
    return lowerName.includes('filesystem') || lowerName.includes('code-surgeon');
  }

  /**
   * 检查是否是会修改本地代码/文件的写入类工具
   */
  public isWriteTool(toolName: string): boolean {
    const lowerName = toolName.toLowerCase();
    return (
      lowerName.includes('apply_patch') ||
      lowerName.includes('write_file') ||
      lowerName.includes('edit_file') ||
      lowerName.includes('replace_text') ||
      lowerName.includes('create_file') ||
      lowerName.includes('internal_structured_edit') ||
      lowerName.includes('internal_surgical_edit')
    );
  }

  /**
   * 检查是否正在调用读取或探测相关的工具
   */
  public isReadOrProbeTool(toolName: string): boolean {
    const lowerName = toolName.toLowerCase();
    return (
      lowerName.includes('read_file_lines') || 
      lowerName.includes('read_text_file') ||
      lowerName.includes('get_file_outline') ||
      lowerName.includes('read_file')
    );
  }

  /**
   * 检查是否属于“探索/探测”型工具。
   * 这类工具在完成结构定位后如果继续滥用，会显著拖慢进入编码阶段的速度。
   */
  public isExplorationTool(toolName: string): boolean {
    const lowerName = toolName.toLowerCase();
    return (
      this.isReadOrProbeTool(toolName) ||
      lowerName.includes('search_files') ||
      lowerName.includes('get_file_info') ||
      lowerName.includes('list_directory') ||
      lowerName.includes('directory_tree') ||
      lowerName.includes('glob')
    );
  }

  /**
   * 更新读取计数器，如果读取次数过多则触发拦截
   * @param toolName 工具全名
   * @param args 工具参数
   * @returns 拦截原因（如果无需拦截则为 null）
   */
  public checkReadLoop(toolName: string, args: any, config: ReadLoopGuardConfig): string | null {
    if (!this.isReadOrProbeTool(toolName)) return null;

    const filePath = args.path || args.AbsolutePath || args.target_file || 'unknown';
    const startLine = args.start_line || args.StartLine || 0;
    const endLine = args.end_line || args.EndLine || 0;
    
    // 1. 结构化重复探测拦截 (相同的行号区间)
    const trackKey = `${filePath}:${startLine}-${endLine}:${toolName}`;
    const readCount = (this.readTracker.get(trackKey) || 0) + 1;
    this.readTracker.set(trackKey, readCount);
    
    if (readCount > config.sameRegionLimit) {
      return `⚠️ [系统级死循环拦截器] 你已在当前阶段重复调用 \`${toolName}\` 读取相同区域 (${trackKey}) 超过 ${config.sameRegionLimit} 次。
这说明你可能陷入了无效的“扫描死循环”。
**强制行动指引**：
- **停止扫描**：无论你是否找到了目标逻辑，现在立即停止对该文件的搜索。
- **做最坏打算**：假定该功能在原代码中完全不存在，你必须从零开始编写。
- **切换阶段**：立即进入 [PHASE:规划实施方案] 阶段，拟定一份全新的代码实现计划。`;
    }

    // 2. 频率探测拦截 (同一个文件被反复翻看)
    const fileVisitScore = (this.fileVisitTracker.get(filePath) || 0) + getReadLoopWeight(toolName, config);
    this.fileVisitTracker.set(filePath, fileVisitScore);
    if (fileVisitScore > config.fileVisitLimit) {
      return `⚠️ [系统级频率拦截器] 该文件 \`${filePath}\` 已被你反复查阅了 ${Math.ceil(fileVisitScore)} 次等价读取。
你的“碎片化阅读”效率极低。
**强制行动指引**：
- 如果你需要全量上下文，请使用 \`filesystem__read_text_file\` 一次性读完 (限 50KB 以下)。
- 如果你要修改，请直接基于已有印象进行 [PHASE:规划实施方案] 并输出 Diff。
- **禁止继续对此文件执行探测尝试。**`;
    }
    
    return null;
  }

  /**
   * 生成针对文档未完成的门禁提示信息
   */
  public getInterceptionNotice(undoneDocTasks: TaskItem[]): string {
    return `[系统拦截] 为了防止逻辑幻觉，Agent 必须先完成文档深度分析并产出摘要。
检测到以下前置任务尚未标记为 [TASK_DONE]：
${undoneDocTasks.map(t => `- #${t.id}: ${t.description}`).join("\n")}

**你的下一步行动建议：**
1. 切换到 [PHASE:读取 PRD] 或 [PHASE:读取 API 文档]。
2. 调用飞书工具读取对应的源文档。
3. **输出该文档的核心业务逻辑摘要（不少于3条）**。
4. 使用 [TASK_DONE:ID] 强制标记任务状态为完成。
5. 完成所有文档任务并获取摘要结论后，对应的代码手术刀工具才会解锁。`;
  }

  /**
   * 生成 apply_patch 的重试指引增强
   */
  public getPatchRetryNotice(toolResultContent: string, args: any): string {
    const targetPath = args.path || args.target_file || 'unknown';
    let lastReadNotice = "";
    
    // 检查 readTracker 中是否包含该文件的读取记录，从而说明模型最近“视察”过这个文件
    for (const key of this.readTracker.keys()) {
      if (key.startsWith(targetPath)) {
        lastReadNotice = `\n检测到你最后一次读取该区域是在本阶段。`;
        break;
      }
    }
    
    return `\n\n[系统自动提示] apply_patch 匹配失败(Could not find search_block)。${lastReadNotice}请核对缩进和换行（必须与 read_file_lines 的输出完全一致）。建议你立即再次调用 code-surgeon__read_file_lines 重新读取该目标区域，获取最新的精确内容后重试，切勿凭空猜测。`;
  }

  /**
   * 重置受本轮工具调用影响的临时状态 (如果有)
   */
  public resetPerRound(): void {
    // 暂无需要每轮重置的状态，保持跨 Round 持久化拦截能力
  }

  /**
   * 重置计数器 (通常仅在 Workflow 启动时调用)
   */
  public reset(): void {
    this.readTracker.clear();
    this.fileVisitTracker.clear();
  }
}
