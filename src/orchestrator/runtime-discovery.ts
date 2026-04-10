import * as fs from "fs";
import * as path from "path";
import { ProjectRuntimeOption, RuntimeDiscoveryResult } from "./loop-manager-types";

/** 前端项目最常见的一组本地开发端口，供 QA 探测兜底使用。 */
export function getCommonQaPorts(): number[] {
  return [5173, 5174, 4173, 3000, 8080, 8000];
}

/** 检查某个命令是否真实存在于当前系统 PATH 中。 */
export function isCommandAvailable(bin: string): boolean {
  const command = String(bin || "").trim();
  if (!command) return false;
  if (path.isAbsolute(command)) return fs.existsSync(command);

  const pathValue = process.env.PATH || "";
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  return pathEntries.some((dir) => extensions.some((ext) => {
    const candidate = path.join(dir, `${command}${ext}`);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

/** 根据 lockfile 和命令可用性，推断当前项目最适合使用的包管理器。 */
export function detectPackageManager(projectPath: string): "yarn" | "pnpm" | "npm" {
  const preferred: Array<"yarn" | "pnpm" | "npm"> = [];
  if (fs.existsSync(path.join(projectPath, "yarn.lock"))) preferred.push("yarn");
  if (fs.existsSync(path.join(projectPath, "pnpm-lock.yaml"))) preferred.push("pnpm");
  preferred.push("npm", "pnpm", "yarn");

  for (const manager of Array.from(new Set(preferred))) {
    if (isCommandAvailable(manager)) return manager;
  }

  return "npm";
}

/** 列出项目根目录中的环境文件，例如 `.env.dev`。 */
export function listProjectEnvFiles(projectPath: string): string[] {
  if (!projectPath || !fs.existsSync(projectPath)) return [];

  try {
    return fs.readdirSync(projectPath)
      .filter((name) => /^\.?env(\..+)?$/i.test(name) || /^env\..+$/i.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** 从所有环境文件中挑出与某个 mode 最匹配的一组。 */
export function pickEnvFilesForMode(envFiles: string[], mode: string): string[] {
  if (!Array.isArray(envFiles) || envFiles.length === 0) return [];

  const aliases: Record<string, string[]> = {
    local: ["local"],
    dev: ["dev"],
    pre: ["pre"],
    release: ["release"],
    production: ["production", "prod", "pro"],
    preview: ["preview"],
  };

  const tokens = aliases[mode] || [mode];
  const matched = envFiles.filter((file) => {
    const lower = file.toLowerCase();
    return tokens.some((token) =>
      lower === `.env.${token}` ||
      lower.endsWith(`.${token}`) ||
      lower.includes(`.${token}.`) ||
      lower.includes(`-${token}`),
    );
  });

  return matched.length > 0 ? matched : envFiles;
}

/** 从脚本文本或 env 内容中提取可能的端口提示。 */
export function extractPortHintsFromText(text: string): number[] {
  const hits = new Set<number>();
  if (!text) return [];

  const patterns = [
    /--port(?:=|\s+)(\d{2,5})/gi,
    /\b(?:PORT|VITE_PORT|DEV_PORT|APP_PORT|SERVER_PORT)\s*=\s*(\d{2,5})/gi,
    /localhost:(\d{2,5})/gi,
    /127\.0\.0\.1:(\d{2,5})/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const port = Number(match[1]);
      if (port >= 1000 && port <= 65535) hits.add(port);
    }
  }

  return Array.from(hits);
}

/** 根据 script 名称和命令内容，推断更像 dev/pre/local 哪种运行模式。 */
export function detectRuntimeMode(scriptName: string, command: string): string {
  const lower = `${scriptName} ${command}`.toLowerCase();
  if (/(?:^|[-_:])local(?:$|[-_:])|--mode\s*=?\s*local/.test(lower)) return "local";
  if (/(?:^|[-_:])pre(?:$|[-_:])|--mode\s*=?\s*pre/.test(lower)) return "pre";
  if (/(?:^|[-_:])release(?:$|[-_:])|--mode\s*=?\s*release/.test(lower)) return "release";
  if (/(?:^|[-_:])production(?:$|[-_:])|(?:^|[-_:])prod(?:$|[-_:])|(?:^|[-_:])pro(?:$|[-_:])|--mode\s*=?\s*production/.test(lower)) return "production";
  if (/(?:^|[-_:])dev(?:$|[-_:])|--mode\s*=?\s*dev/.test(lower)) return "dev";
  if (/(?:^|[-_:])start(?:$|[-_:])/.test(lower)) return "start";
  if (/(?:^|[-_:])preview(?:$|[-_:])/.test(lower)) return "preview";
  return "auto";
}

/** 给候选运行脚本打分，帮助优先挑出更像本地前端开发环境的脚本。 */
export function getRuntimeOptionScore(mode: string, scriptName: string): number {
  const lowerScript = scriptName.toLowerCase();
  const baseScores: Record<string, number> = {
    local: 100,
    dev: 90,
    auto: 80,
    start: 70,
    preview: 60,
    pre: 55,
    release: 50,
    production: 45,
  };

  let score = baseScores[mode] ?? 40;
  if (lowerScript === "serve" || lowerScript === "dev" || lowerScript === "start") score += 6;
  if (lowerScript.includes("mock")) score -= 10;
  return score;
}

/** 判断某个 package.json script 是否像“能拉起站点”的前端运行脚本。 */
export function isRuntimeScript(scriptName: string, command: string): boolean {
  const lower = `${scriptName} ${command}`.toLowerCase();
  return /(vue-cli-service serve|vite(?:\s|$)|webpack-dev-server|react-scripts start|next dev|nuxt|umi dev|(?:^|[\s:._-])serve(?:$|[\s:._-])|(?:^|[\s:._-])dev(?:$|[\s:._-])|(?:^|[\s:._-])start(?:$|[\s:._-])|(?:^|[\s:._-])preview(?:$|[\s:._-]))/.test(lower);
}

/** 扫描 package.json 与 env 文件，生成一组可供 QA 启动的 runtime 候选。 */
export function discoverProjectRuntimeOptions(projectPath: string): RuntimeDiscoveryResult | null {
  if (!projectPath) return null;

  const packageJsonPath = path.join(projectPath, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;

  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  } catch {
    return null;
  }

  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const envFiles = listProjectEnvFiles(projectPath);

  const options: ProjectRuntimeOption[] = Object.entries(scripts)
    .filter(([scriptName, command]) => typeof command === "string" && isRuntimeScript(scriptName, command))
    .map(([scriptName, command]) => {
      const mode = detectRuntimeMode(scriptName, command as string);
      const modeEnvFiles = pickEnvFilesForMode(envFiles, mode);
      const envPortHints = modeEnvFiles.flatMap((file) => {
        try {
          const content = fs.readFileSync(path.join(projectPath, file), "utf-8");
          return extractPortHintsFromText(content);
        } catch {
          return [];
        }
      });
      const portHints = Array.from(new Set([
        ...extractPortHintsFromText(command as string),
        ...envPortHints,
        ...getCommonQaPorts(),
      ]));

      return {
        scriptName,
        mode,
        commandPreview: String(command),
        portHints,
        envFiles: modeEnvFiles,
        score: getRuntimeOptionScore(mode, scriptName),
      };
    })
    .sort((a, b) => b.score - a.score);

  return {
    packageManager: detectPackageManager(projectPath),
    envFiles,
    options,
  };
}

/** 从配置与提示语里推断 QA 更偏向哪个环境，例如 dev / pre / local。 */
export function inferQaEnvPreference(input: {
  prompt: string;
  configuredPreference?: string;
  taskObjective?: string;
  targetRoute?: string;
  targetComponentPath?: string;
}): string {
  const configured = String(input.configuredPreference || "auto").trim().toLowerCase();
  if (configured && configured !== "auto") return configured;

  const haystack = [
    input.prompt,
    input.taskObjective,
    input.targetRoute,
    input.targetComponentPath,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  const preferencePatterns: Array<{ mode: string; patterns: RegExp[] }> = [
    { mode: "pre", patterns: [/(?:^|[^a-z])pre(?:$|[^a-z])/, /预发/, /spre\./, /api\.pre\./, /pre\.fed\./] },
    { mode: "dev", patterns: [/(?:^|[^a-z])dev(?:$|[^a-z])/, /开发/, /daily/, /api\.dev\./, /dev\.fed\./] },
    { mode: "local", patterns: [/(?:^|[^a-z])local(?:$|[^a-z])/, /本地/] },
    { mode: "release", patterns: [/(?:^|[^a-z])release(?:$|[^a-z])/] },
    { mode: "production", patterns: [/(?:^|[^a-z])production(?:$|[^a-z])/, /(?:^|[^a-z])prod(?:$|[^a-z])/, /线上/, /生产/] },
  ];

  for (const candidate of preferencePatterns) {
    if (candidate.patterns.some((pattern) => pattern.test(haystack))) {
      return candidate.mode;
    }
  }

  return "auto";
}

/** 从 runtime 候选中选出本轮最值得尝试启动的那个脚本。 */
export function selectRuntimeOption(
  discovery: RuntimeDiscoveryResult | null,
  input: {
    prompt?: string;
    configuredPreference?: string;
    taskObjective?: string;
    targetRoute?: string;
    targetComponentPath?: string;
  } = {},
): ProjectRuntimeOption | null {
  if (!discovery || discovery.options.length === 0) return null;

  const preferred = inferQaEnvPreference({
    prompt: input.prompt || "",
    configuredPreference: input.configuredPreference,
    taskObjective: input.taskObjective,
    targetRoute: input.targetRoute,
    targetComponentPath: input.targetComponentPath,
  });
  if (preferred && preferred !== "auto") {
    const exact = discovery.options.find((option) => option.mode === preferred);
    if (exact) return exact;

    const fuzzy = discovery.options.find((option) => option.scriptName.toLowerCase().includes(preferred));
    if (fuzzy) return fuzzy;
  }

  return discovery.options[0] || null;
}

/** 把端口提示展开成 localhost / 127.0.0.1 的候选探测地址。 */
export function buildQaProbeUrls(portHints: number[]): string[] {
  const urls: string[] = [];
  for (const port of portHints) {
    urls.push(`http://127.0.0.1:${port}`);
    urls.push(`http://localhost:${port}`);
  }
  return Array.from(new Set(urls));
}

/** 把 scriptName 和 package manager 翻译成可执行命令。 */
export function getRuntimeLaunchCommand(scriptName: string, packageManager: "yarn" | "pnpm" | "npm") {
  if (packageManager === "yarn") {
    return { bin: "yarn", args: [scriptName], label: `yarn ${scriptName}` };
  }
  if (packageManager === "pnpm") {
    return { bin: "pnpm", args: [scriptName], label: `pnpm ${scriptName}` };
  }
  return { bin: "npm", args: ["run", scriptName], label: `npm run ${scriptName}` };
}

/** 生成一组可回退的运行命令，优先选 lockfile/机器环境更匹配的包管理器。 */
export function getRuntimeLaunchCandidates(scriptName: string, preferred: "yarn" | "pnpm" | "npm") {
  return Array.from(new Set([preferred, "npm", "pnpm", "yarn"]))
    .filter((packageManager) => isCommandAvailable(packageManager))
    .map((packageManager) => getRuntimeLaunchCommand(scriptName, packageManager as "yarn" | "pnpm" | "npm"));
}
