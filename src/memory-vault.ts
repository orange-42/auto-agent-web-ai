import * as fs from "fs";
import * as path from "path";

/**
 * MemoryVault: 处理 Episodic (事件) 和 Semantic (策略) 记忆的持久化与加载
 */
export class MemoryVault {
  private episodicMemory = "";
  private semanticMemory = "";
  
  constructor(
    private episodicFile: string,
    private semanticFile: string
  ) {
    this.load();
  }

  private load() {
    try {
      this.episodicMemory = fs.existsSync(this.episodicFile)
        ? fs.readFileSync(this.episodicFile, "utf-8")
        : "";
      this.semanticMemory = fs.existsSync(this.semanticFile)
        ? fs.readFileSync(this.semanticFile, "utf-8")
        : "";
    } catch (e) {
      console.error("[MemoryVault] 加载记忆失败:", e);
    }
  }

  public getEpisodic(): string { return this.episodicMemory; }
  public getSemantic(): string { return this.semanticMemory; }

  public async saveEpisodic(content: string) {
    this.episodicMemory += `\n\n## Task: ${new Date().toISOString()}\n${content}`;
    fs.writeFileSync(this.episodicFile, this.episodicMemory, "utf-8");
  }

  public async saveSemantic(content: string) {
    this.semanticMemory = content; // 语义记忆通常是全量覆盖或合并提炼
    fs.writeFileSync(this.semanticFile, this.semanticMemory, "utf-8");
  }
}
