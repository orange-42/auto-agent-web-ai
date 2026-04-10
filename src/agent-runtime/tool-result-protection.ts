/**
 * 工具结果保护的附加上下文。
 *
 * 目前最重要的是工具读取到的真实文件路径。
 * 这样保护器才能区分“代码文件全文读取”和“普通长文本工具输出”。
 */
export interface ToolResultProtectionMetadata {
  path?: string;
}

/**
 * 工具结果保护决策。
 *
 * 这份结构会被上层拿去打埋点，帮助定位：
 * - 是否发生了截断
 * - 采用了哪种保护策略
 * - 对代码文件是否执行了“完整保留”策略
 */
export interface ToolResultProtectionDecision {
  applied: boolean;
  strategy:
    | "passthrough"
    | "doc_truncate"
    | "browser_truncate"
    | "code_preserve_full"
    | "code_head_tail_truncate"
    | "line_read_truncate"
    | "generic_truncate";
  originalChars: number;
  finalChars: number;
  path: string;
  note: string;
}

export interface ProtectToolResultParams {
  toolName: string;
  content: string;
  metadata?: ToolResultProtectionMetadata;
}

const CODE_FILE_EXTENSIONS = new Set([
  ".vue",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".scss",
  ".sass",
  ".less",
  ".css",
  ".html",
  ".mdx",
]);

function isCodeFilePath(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.toLowerCase();
  for (const extension of CODE_FILE_EXTENSIONS) {
    if (normalized.endsWith(extension)) return true;
  }
  return false;
}

function truncateWithHeadTail(
  content: string,
  headChars: number,
  tailChars: number,
  note: string,
): string {
  if (content.length <= headChars + tailChars + 64) return content;
  const head = content.slice(0, headChars).trimEnd();
  const tail = content.slice(-tailChars).trimStart();
  return `${head}\n...[中间内容已折叠，保留头尾关键窗口。${note}]\n${tail}`;
}

function buildDecision(
  strategy: ToolResultProtectionDecision["strategy"],
  originalChars: number,
  finalChars: number,
  path: string,
  note: string,
): ToolResultProtectionDecision {
  return {
    applied: strategy !== "passthrough",
    strategy,
    originalChars,
    finalChars,
    path,
    note,
  };
}

/**
 * 统一处理工具结果保护。
 *
 * 设计目标：
 * - 文档和浏览器输出仍然保留长度保护
 * - 代码文件全文读取时，若文件总长 <= 50k，则尽量完整透传
 * - 超过 50k 的代码文件不再粗暴截成 10k，而是保留更宽的头尾窗口
 */
export function protectToolResult(
  params: ProtectToolResultParams,
): { content: string; decision: ToolResultProtectionDecision } {
  const lowerName = String(params.toolName || "").toLowerCase();
  const content = String(params.content || "");
  const filePath = String(params.metadata?.path || "");
  const originalChars = content.length;

  if (!content) {
    return {
      content,
      decision: buildDecision("passthrough", 0, 0, filePath, "工具输出为空，无需保护。"),
    };
  }

  if (lowerName.includes("fetch_doc") || lowerName.includes("lark") || lowerName.includes("feishu")) {
    if (content.length <= 40000) {
      return {
        content,
        decision: buildDecision("passthrough", originalChars, originalChars, filePath, "文档输出未超过保护阈值。"),
      };
    }
    const nextContent =
      `${content.substring(0, 40000)}\n...[内容过长（已超4w字），已截断。建议针对性提取核心 API/逻辑摘要]`;
    return {
      content: nextContent,
      decision: buildDecision("doc_truncate", originalChars, nextContent.length, filePath, "文档输出超过 4w，保留前部关键上下文。"),
    };
  }

  if (lowerName.includes("chrome-devtools") || lowerName.includes("playwright")) {
    if (content.length <= 8000) {
      return {
        content,
        decision: buildDecision("passthrough", originalChars, originalChars, filePath, "浏览器输出未超过保护阈值。"),
      };
    }
    const nextContent =
      `${content.substring(0, 8000)}\n...[浏览器工具输出过长，已截断。请改用更精准的页面断言或局部验证]`;
    return {
      content: nextContent,
      decision: buildDecision("browser_truncate", originalChars, nextContent.length, filePath, "浏览器输出过长，已做前部截断。"),
    };
  }

  if (lowerName.includes("read_text_file") && isCodeFilePath(filePath)) {
    if (content.length <= 50000) {
      return {
        content,
        decision: buildDecision("code_preserve_full", originalChars, originalChars, filePath, "代码文件长度不超过 50k，完整透传。"),
      };
    }

    const nextContent = truncateWithHeadTail(
      content,
      24000,
      12000,
      "如需中间片段，请继续使用更精准的分段读取工具。",
    );
    return {
      content: nextContent,
      decision: buildDecision(
        "code_head_tail_truncate",
        originalChars,
        nextContent.length,
        filePath,
        "代码文件超过 50k，保留头尾窗口而不是粗暴截断。",
      ),
    };
  }

  if (lowerName.includes("read_file_lines")) {
    if (content.length <= 18000) {
      return {
        content,
        decision: buildDecision("passthrough", originalChars, originalChars, filePath, "分段代码读取未超过保护阈值。"),
      };
    }
    const nextContent =
      `${content.substring(0, 18000)}\n...[内容过长，已截断。请进一步缩小 start_line/end_line 范围以获取更精准片段]`;
    return {
      content: nextContent,
      decision: buildDecision("line_read_truncate", originalChars, nextContent.length, filePath, "分段读取片段过长，建议继续缩小行号范围。"),
    };
  }

  if (content.length <= 10000) {
    return {
      content,
      decision: buildDecision("passthrough", originalChars, originalChars, filePath, "普通工具输出未超过通用保护阈值。"),
    };
  }

  const nextContent =
    `${content.substring(0, 10000)}\n...[内容过长，已截断。请改用更精准的工具参数缩小读取范围]`;
  return {
    content: nextContent,
    decision: buildDecision("generic_truncate", originalChars, nextContent.length, filePath, "普通工具输出超过通用保护阈值。"),
  };
}
