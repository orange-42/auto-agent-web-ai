import fs from "fs";
import path from "path";

export function getHarnessDir(): string {
  const harnessDir = path.join(process.cwd(), ".harness");
  if (!fs.existsSync(harnessDir)) {
    fs.mkdirSync(harnessDir, { recursive: true });
  }
  return harnessDir;
}

export function appendHarnessLog(fileName: string, message: string): void {
  const logPath = path.join(getHarnessDir(), fileName);
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf-8");
}

export function appendHarnessJsonl(fileName: string, payload: Record<string, unknown>): void {
  const logPath = path.join(getHarnessDir(), fileName);
  const entry = {
    ts: new Date().toISOString(),
    ...payload,
  };
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
}

export function summarizeText(value: unknown, maxLen: number = 160): string {
  if (typeof value !== "string") return "";
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen)}...`;
}
