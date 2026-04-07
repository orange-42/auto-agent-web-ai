import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";

const execAsync = promisify(exec);

export class GitSandbox {
  constructor(private projectPath: string) {}

  public async prepareBranch(): Promise<string | undefined> {
    try {
      const timestamp = Date.now();
      const branchName = `agent-auto-build-${timestamp}`;
      
      // 检查是否有未提交更改，有则 stash
      await promisify(exec)(`git stash`, { cwd: this.projectPath }).catch(() => null);
      
      // 切出新分支
      await promisify(exec)(`git checkout -b ${branchName}`, { cwd: this.projectPath });
      return branchName;
    } catch (e: any) {
      console.warn(`[Sandbox] Git 操作提示: ${e.message}`);
      return undefined;
    }
  }

  public async checkHealth(): Promise<{ ok: boolean; log?: string }> {
    try {
      // 执行类型检查或构建 (假设有 npm run build 或使用 tsc)
      const { stdout, stderr } = await execAsync(`npm run build`, { 
        cwd: this.projectPath,
        timeout: 60000 
      }).catch(err => err); // 捕获报错作为日志
      
      const combined = (stdout || '') + (stderr || '');
      const isError = combined.toLowerCase().includes('error') || combined.toLowerCase().includes('failed');
      
      return { 
        ok: !isError, 
        log: combined.slice(-2000) // 截取最后一部分核心错误
      };
    } catch (e: any) {
      return { ok: false, log: e.message };
    }
  }

  public async rollback(branchName: string) {
    if (!branchName) return;
    try {
      await execAsync(`git checkout -`, { cwd: this.projectPath });
      await execAsync(`git branch -D ${branchName}`, { cwd: this.projectPath });
    } catch (e) { /* ignore */ }
  }
}
