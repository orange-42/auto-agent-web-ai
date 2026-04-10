import {
  FeishuOpenApiReader,
  PrefetchedSheetContext,
  PrefetchedSourceContext,
} from "./feishu-openapi-reader";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);

/**
 * LarkPrefetcher: 专门处理飞书文档、表格的预读与穿透逻辑 (CLI / OpenAPI)
 */
export class LarkPrefetcher {
  private feishuOpenApiReader = new FeishuOpenApiReader();
  private cache: Map<string, PrefetchedSourceContext> = new Map();

  constructor(private telemetryCallback: (tool: string, duration: number, ok: boolean, detail?: string) => void) {}

  public isApiConfigured(): boolean { return this.feishuOpenApiReader.isConfigured(); }
  public clearCache(): void { this.cache.clear(); }

  // ────────────────── CLI 辅助方法 ──────────────────

  private async runLarkCli(args: string[], signal: AbortSignal): Promise<{ ok: boolean; text: string }> {
    const commandText = `lark-cli ${args.map(arg => `'${arg.replace(/'/g, `'\\''`)}'`).join(" ")}`;
    const shell = process.env.SHELL || "/bin/zsh";
    try {
      const { stdout, stderr } = await execFileAsync(shell, ["-lc", commandText], { timeout: 60000, signal });
      const output = `${stdout || ""}${stderr || ""}`.trim();
      return { ok: !/(^|\b)error\b|keychain entry not found|"ok"\s*:\s*false/i.test(output), text: output };
    } catch (e: any) {
      return { ok: false, text: e.message || "lark-cli execution failed" };
    }
  }

  // ────────────────── 核心预读逻辑 ──────────────────

  public async prefetchSource(url: string, signal: AbortSignal): Promise<PrefetchedSourceContext> {
    const cached = this.cache.get(url);
    if (cached) return cached;

    // 尝试 OpenAPI 直连
    if (this.isApiConfigured()) {
      const start = Date.now();
      const ctx = await this.feishuOpenApiReader.readSource(url, signal);
      this.telemetryCallback("feishu-openapi:prefetch", Date.now() - start, ctx.status !== "error", ctx.status === "error" ? ctx.content : undefined);

      if (this.shouldAttemptCliBackfill(url, ctx)) {
        const cliCtx = await this.prefetchViaCli(url, signal);
        const merged = this.mergeContexts(ctx, cliCtx);
        if (merged.status !== "error") this.cache.set(url, merged);
        return merged;
      }

      if (ctx.status !== "error") this.cache.set(url, ctx);
      return ctx;
    }

    // 回退到 CLI 预读 (代码略微精简，聚焦逻辑)
    return this.prefetchViaCli(url, signal);
  }

  private shouldAttemptCliBackfill(url: string, ctx: PrefetchedSourceContext): boolean {
    if (!ctx || ctx.status === "error") return true;
    if (!/https?:\/\/[^/]+\/(?:wiki|docx|doc)\//.test(url)) return false;

    const diagnosticsText = (ctx.diagnostics || []).join(" ");
    const content = ctx.content || "";
    const looksThin = content.length < 4500;
    const mentionsRawOnly = /raw_content|仅.*正文|嵌入.*sheet|补读/i.test(diagnosticsText);
    const missesStructuredSignals = !/(功能详述|原型|截图|表格|\|.+\||按钮|页面|功能说明)/.test(content);

    return ctx.status === "partial" || looksThin || mentionsRawOnly || missesStructuredSignals;
  }

  private mergeContexts(primary: PrefetchedSourceContext, secondary: PrefetchedSourceContext): PrefetchedSourceContext {
    if (secondary.status === "error") return primary;
    if (primary.status === "error") return secondary;

    const primaryContent = (primary.content || "").trim();
    const secondaryContent = (secondary.content || "").trim();
    let mergedContent = primaryContent;

    if (secondaryContent) {
      if (!primaryContent) {
        mergedContent = secondaryContent;
      } else if (primaryContent.includes(secondaryContent)) {
        mergedContent = primaryContent;
      } else if (secondaryContent.includes(primaryContent)) {
        mergedContent = secondaryContent;
      } else {
        mergedContent = [
          primaryContent ? `# OpenAPI 直连预读\n\n${primaryContent}` : "",
          secondaryContent ? `# CLI Markdown 补充\n\n${secondaryContent}` : "",
        ].filter(Boolean).join("\n\n---\n\n");
      }
    }

    return {
      url: primary.url || secondary.url,
      status: primary.status === "success" || secondary.status === "success" ? "success" : "partial",
      resolvedType: primary.resolvedType || secondary.resolvedType,
      content: mergedContent,
      diagnostics: Array.from(new Set([...(primary.diagnostics || []), "已尝试以 CLI Markdown 对 OpenAPI 结果做补充回填。", ...(secondary.diagnostics || [])])),
      sheetContexts: [...(primary.sheetContexts || []), ...(secondary.sheetContexts || [])],
    };
  }

  private async prefetchViaCli(url: string, signal: AbortSignal): Promise<PrefetchedSourceContext> {
    const start = Date.now();
    const result = await this.runLarkCli(["docs", "+fetch", "--as", "user", "--doc", url, "--format", "json"], signal);
    this.telemetryCallback("lark-cli:prefetch", Date.now() - start, result.ok, result.ok ? undefined : result.text);
    
    if (!result.ok) {
      return { url, status: "error", content: `飞书 PRD 预读失败: ${result.text}`, diagnostics: [], sheetContexts: [] } as PrefetchedSourceContext;
    }

    const payload = this.safeJsonParse(result.text);
    const markdown = payload?.data?.markdown || payload?.markdown || result.text;
    
    const success = { url, status: "success", content: markdown, diagnostics: [], sheetContexts: [] } as PrefetchedSourceContext;
    this.cache.set(url, success);
    return success;
  }

  private safeJsonParse(raw: string) { try { return JSON.parse(raw); } catch { return null; } }

  public extractLarkUrls(text: string): string[] {
    const matches = text.match(/https?:\/\/[^\s)"']+/g) || [];
    const unique = new Set<string>();
    for (const url of matches) {
      if (/https?:\/\/[^/]+\/(wiki|docx|doc|sheets)\//.test(url) && (url.includes("feishu.cn") || url.includes("larksuite.com"))) {
        unique.add(url);
      }
    }
    return Array.from(unique);
  }
}
