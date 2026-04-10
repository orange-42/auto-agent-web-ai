import axios from "axios";
import { TestCaseArtifact, deriveStructuredTestCases } from "../phase-artifacts";
import { buildQaProbeUrls, getCommonQaPorts } from "./runtime-discovery";

export interface QaCasePreviewPayload {
  phase: "VERIFY";
  index: number;
  title: string;
  summary: string;
  highlights: string[];
  stats: string[];
}

/**
 * 汇总 VERIFY 阶段要跑的测试点。
 *
 * 优先级是：
 * 1. 结构化 test_cases
 * 2. coding 阶段给出的 verification_points
 * 3. plan 阶段给出的 verification_points
 *
 * 目标不是“越多越好”，而是挑出少量最高价值 case，
 * 避免 QA prompt 被低价值重复项稀释。
 */
export function collectQaCases(codingRes: any, planRes: any): string[] {
  const structuredCases = deriveStructuredTestCases(planRes?.test_cases, 4);
  const sources = [
    ...structuredCases.map((item) => item.goal || item.name),
    ...(Array.isArray(codingRes?.verification_points) ? codingRes.verification_points : []),
    ...(Array.isArray(planRes?.verification_points) ? planRes.verification_points : []),
  ];

  return Array.from(new Set(sources.map((item) => String(item || "").trim()).filter(Boolean))).slice(0, 4);
}

/**
 * 从用户提示词中抽取显式写出来的 localhost / 127.0.0.1 地址。
 *
 * 如果用户已经明确给了本地站点地址，VERIFY 阶段应尽量直接复用，
 * 而不是重复自动启动一个新 runtime。
 */
export function extractQaUrlCandidates(prompt: string): string[] {
  const matches = prompt.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^\s`'"））]*)?/g) || [];
  const origins = matches
    .map((item) => {
      try {
        const url = new URL(item);
        return url.origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  return Array.from(new Set(origins));
}

/**
 * 用一个轻量 HTTP 探测判断某个站点当前是否可访问。
 *
 * 这里只做 reachability 判断，不做业务健康检查；
 * 对 QA 预检来说，先确认“站点活着”已经足够。
 */
export async function isReachableUrl(url: string): Promise<boolean> {
  try {
    const response = await axios.get(url, {
      timeout: 1500,
      validateStatus: () => true,
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * 按“显式优先”顺序寻找 QA baseUrl。
 *
 * 来源依次包括：
 * - llmConfig.qaConfig.baseUrl
 * - 环境变量
 * - 用户 prompt 里直接写出的 localhost 地址
 *
 * 只有真实可访问的候选才会被采用。
 */
export async function discoverExplicitQaBaseUrl(
  prompt: string,
  options?: {
    configuredBaseUrl?: string;
    envBaseUrls?: string[];
  },
): Promise<string> {
  const overrideCandidate = String(options?.configuredBaseUrl || "").trim();
  const envCandidates = (options?.envBaseUrls || [])
    .map((item) => item?.trim() || "")
    .filter(Boolean);
  const promptCandidates = extractQaUrlCandidates(prompt);

  for (const candidate of Array.from(new Set([overrideCandidate, ...envCandidates, ...promptCandidates])).filter(Boolean)) {
    if (await isReachableUrl(candidate)) {
      return candidate.replace(/\/+$/, "");
    }
  }

  return "";
}

/**
 * 当没有显式站点地址时，基于端口提示做一次本地探测。
 *
 * 这一步不负责启动项目，只负责“扫一遍可能已经运行着的站点”。
 */
export async function discoverReachableQaBaseUrl(portHints: number[] = []): Promise<string> {
  const candidateUrls = [
    ...buildQaProbeUrls(portHints),
    ...buildQaProbeUrls(getCommonQaPorts()),
  ];

  for (const candidate of Array.from(new Set(candidateUrls)).filter(Boolean)) {
    if (await isReachableUrl(candidate)) {
      return candidate.replace(/\/+$/, "");
    }
  }

  return "";
}

/**
 * 当浏览器 QA 不能执行时，构造一份结构兼容的 fallback 结果。
 *
 * 这样前端和 debug snapshot 仍能拿到统一格式，而不会因为“没跑 QA”
 * 就出现 result shape 不一致的问题。
 */
export function buildQaFallbackResult(
  overallStatus: "passed" | "failed" | "skipped",
  summary: string,
  cases: string[],
  extras?: { blockedReasons?: string[]; testedUrl?: string },
) {
  return {
    reasoning: summary,
    overall_status: overallStatus,
    tested_url: extras?.testedUrl || "",
    cases: cases.map((item) => ({
      name: item,
      status: overallStatus === "passed" ? "passed" : "skipped",
      evidence: overallStatus === "passed" ? "本轮未执行浏览器自动化，结果来自系统默认通过。" : summary,
    })),
    blocked_reasons: extras?.blockedReasons || [],
    qa_summary: summary,
  };
}

/**
 * 构造 QA 开始前展示给前端的“用例概览卡片”。
 *
 * 这份 payload 不直接发事件，而是由 orchestrator 拿去广播，
 * 这样 UI 展示和 QA 辅助逻辑就能解耦。
 */
export function buildQaCasePreviewPayload(
  cases: string[],
  qaBaseUrl: string,
  hasBrowserTools: boolean,
  structuredCases: TestCaseArtifact[] = [],
): QaCasePreviewPayload {
  const preferredCases = structuredCases.length > 0
    ? structuredCases.slice(0, 5).map((item, index) => `用例 ${index + 1}：${item.name} · ${item.goal}`)
    : cases.slice(0, 5).map((item, index) => `用例 ${index + 1}：${item}`);
  const stats = [
    `用例 ${structuredCases.length || cases.length}`,
    hasBrowserTools ? "浏览器工具已就绪" : "浏览器工具未就绪",
    qaBaseUrl ? `站点 ${qaBaseUrl}` : "站点待探测",
  ];

  return {
    phase: "VERIFY",
    index: 5,
    title: "测试用例清单已生成",
    summary: cases.length > 0
      ? "已基于规划与代码产出的验证点生成自动化 QA 用例，准备开始浏览器验证。"
      : "当前未收集到可执行测试用例，本轮将按条件决定是否跳过自动化 QA。",
    highlights: preferredCases,
    stats,
  };
}
