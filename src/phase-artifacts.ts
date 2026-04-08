export type ArtifactPhase = "INTENT" | "PRD" | "API" | "PLAN" | "CODING" | "VERIFY";

export interface TestCaseArtifact {
  name: string;
  goal: string;
  preconditions: string[];
  steps: string[];
  expected: string[];
}

export interface IntentArtifact {
  projectPath: string;
  prdUrl: string;
  apiUrl: string;
  taskObjective: string;
  targetRoute: string;
  targetComponentPath: string;
  confidence_flags: string[];
}

export interface PrdArtifact {
  content_verified: string;
  logic_rules: string[];
  ui_requirements: string[];
  placement_hints: string[];
  dependency_checks: string[];
  evidence_refs: string[];
}

export interface ApiMappingArtifact {
  endpoint: string;
  method: string;
  purpose: string;
}

export interface ApiArtifact {
  api_mappings: ApiMappingArtifact[];
  constraints: string[];
  component_impact: string[];
  evidence_refs: string[];
}

export interface ProjectSnapshotArtifact {
  target_component_context: string;
  style_context: string;
  permission_index: string[];
  config_index: string[];
  runtime_options: string[];
  evidence_refs: string[];
}

export interface PlanOperationOutline {
  target: string;
  kind: string;
  intent: string;
}

export interface PlanFileArtifact {
  path: string;
  description?: string;
  content?: string;
}

export interface PlanArtifact {
  reasoning: string;
  files_to_modify: PlanFileArtifact[];
  files_to_create: PlanFileArtifact[];
  operations_outline: PlanOperationOutline[];
  test_cases: TestCaseArtifact[];
  verification_points: string[];
  risk_flags: string[];
}

export interface CodeArtifact {
  operations_executed: string[];
  files_to_modify: PlanFileArtifact[];
  files_to_create: PlanFileArtifact[];
  verification_points: string[];
  validation_summary: string[];
  completion_summary: string;
}

export interface VerifyCaseArtifact {
  name: string;
  status: "passed" | "failed" | "skipped";
  evidence: string;
}

export interface VerifyArtifact {
  static_validation: string[];
  qa_cases: TestCaseArtifact[];
  qa_results: VerifyCaseArtifact[];
  overall_status: string;
}

export interface PhaseArtifactEnvelope<T> {
  phase: ArtifactPhase;
  human_summary: string;
  artifact: T;
}

function toStringArray(input: unknown, limit: number = 8): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ),
  ).slice(0, limit);
}

function summarizeText(text: unknown, maxLen: number): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}

function normalizeFileArtifacts(input: unknown): PlanFileArtifact[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const path =
        String((item as any).path || (item as any).file || (item as any).target_file || "").trim();
      if (!path) return null;
      return {
        path,
        description: String((item as any).description || "").trim() || undefined,
        content: String((item as any).content || "").trim() || undefined,
      };
    })
    .filter(Boolean) as PlanFileArtifact[];
}

export function deriveStructuredTestCases(source: unknown, limit: number = 4): TestCaseArtifact[] {
  if (!Array.isArray(source)) return [];

  const normalized: TestCaseArtifact[] = [];
  for (const item of source) {
    if (normalized.length >= limit) break;

    if (typeof item === "string") {
      const text = item.trim();
      if (!text) continue;
      normalized.push({
        name: summarizeText(text, 36),
        goal: text,
        preconditions: [],
        steps: [`进入目标页面并验证：${text}`],
        expected: [text],
      });
      continue;
    }

    if (!item || typeof item !== "object") continue;
    const name = String((item as any).name || (item as any).goal || "").trim();
    const goal = String((item as any).goal || (item as any).name || "").trim();
    const steps = toStringArray((item as any).steps, 6);
    const expected = toStringArray((item as any).expected, 4);
    const preconditions = toStringArray((item as any).preconditions, 4);
    const effectiveGoal = goal || name;
    if (!effectiveGoal) continue;

    normalized.push({
      name: name || summarizeText(effectiveGoal, 36),
      goal: effectiveGoal,
      preconditions,
      steps: steps.length > 0 ? steps : [`执行与“${effectiveGoal}”相关的关键路径`],
      expected: expected.length > 0 ? expected : [effectiveGoal],
    });
  }

  return normalized.slice(0, limit);
}

export function normalizeIntentArtifact(input: any): IntentArtifact {
  return {
    projectPath: String(input?.projectPath || "").trim(),
    prdUrl: String(input?.prdUrl || "").trim(),
    apiUrl: String(input?.apiUrl || "").trim(),
    taskObjective: String(input?.taskObjective || "").trim(),
    targetRoute: String(input?.targetRoute || "").trim(),
    targetComponentPath: String(input?.targetComponentPath || "").trim(),
    confidence_flags: toStringArray(input?.confidence_flags, 6),
  };
}

export function normalizePrdArtifact(input: any): PrdArtifact {
  return {
    content_verified: String(input?.content_verified || "").trim(),
    logic_rules: toStringArray(input?.logic_rules, 8),
    ui_requirements: toStringArray(input?.ui_requirements, 8),
    placement_hints: toStringArray(input?.placement_hints, 8),
    dependency_checks: toStringArray(input?.dependency_checks, 8),
    evidence_refs: toStringArray(input?.evidence_refs, 10),
  };
}

export function normalizeApiArtifact(input: any): ApiArtifact {
  const rawMappings = Array.isArray(input?.api_mappings) ? input.api_mappings : [];
  return {
    api_mappings: rawMappings
      .map((item: any) => ({
        endpoint: String(item?.endpoint || "").trim(),
        method: String(item?.method || "").trim().toUpperCase(),
        purpose: String(item?.purpose || "").trim(),
      }))
      .filter((item: ApiMappingArtifact) => item.endpoint),
    constraints: toStringArray(input?.constraints, 8),
    component_impact: toStringArray(input?.component_impact, 8),
    evidence_refs: toStringArray(input?.evidence_refs, 10),
  };
}

export function normalizeProjectSnapshotArtifact(input: any): ProjectSnapshotArtifact {
  return {
    target_component_context: String(input?.target_component_context || input?.targetComponentContext || "").trim(),
    style_context: String(input?.style_context || input?.styleContext || "").trim(),
    permission_index: toStringArray(input?.permission_index || input?.permissionIndex, 12),
    config_index: toStringArray(input?.config_index || input?.configIndex, 12),
    runtime_options: toStringArray(input?.runtime_options || input?.runtimeOptions, 8),
    evidence_refs: toStringArray(input?.evidence_refs || input?.evidenceRefs, 12),
  };
}

export function normalizePlanArtifact(input: any): PlanArtifact {
  const filesToModify = normalizeFileArtifacts(input?.files_to_modify);
  const filesToCreate = normalizeFileArtifacts(input?.files_to_create);
  const verificationPoints = toStringArray(input?.verification_points, 8);
  const testCases = deriveStructuredTestCases(input?.test_cases, 5);
  const fallbackCases = testCases.length > 0 ? testCases : deriveStructuredTestCases(verificationPoints, 5);

  const operationsOutline = Array.isArray(input?.operations_outline)
    ? input.operations_outline
        .map((item: any) => ({
          target: String(item?.target || item?.path || "").trim(),
          kind: String(item?.kind || "").trim() || "modify",
          intent: String(item?.intent || item?.description || "").trim(),
        }))
        .filter((item: PlanOperationOutline) => item.target || item.intent)
    : [
        ...filesToModify.map((item) => ({
          target: item.path,
          kind: "modify",
          intent: item.description || "修改现有文件以完成需求落地。",
        })),
        ...filesToCreate.map((item) => ({
          target: item.path,
          kind: "create",
          intent: item.content || "新增支撑文件以承接本次需求。",
        })),
      ];

  return {
    reasoning: String(input?.reasoning || "").trim(),
    files_to_modify: filesToModify,
    files_to_create: filesToCreate,
    operations_outline: operationsOutline.slice(0, 12),
    test_cases: fallbackCases,
    verification_points: verificationPoints.length > 0
      ? verificationPoints
      : fallbackCases.map((item) => item.goal).filter(Boolean),
    risk_flags: toStringArray(input?.risk_flags, 8),
  };
}

export function normalizeCodeArtifact(input: any, validationSummary: string[] = []): CodeArtifact {
  const filesToModify = normalizeFileArtifacts(input?.files_to_modify);
  const filesToCreate = normalizeFileArtifacts(input?.files_to_create);
  const operationsExecuted = Array.isArray(input?.operations_executed)
    ? toStringArray(input.operations_executed, 10)
    : [
        ...filesToCreate.map((item) => `create:${item.path}`),
        ...filesToModify.map((item) => `modify:${item.path}`),
      ];

  return {
    operations_executed: operationsExecuted,
    files_to_modify: filesToModify,
    files_to_create: filesToCreate,
    verification_points: toStringArray(input?.verification_points, 8),
    validation_summary: Array.from(
      new Set([
        ...toStringArray(input?.validation_summary, 8),
        ...validationSummary.map((item) => String(item || "").trim()).filter(Boolean),
      ]),
    ).slice(0, 10),
    completion_summary: String(input?.completion_summary || input?.reasoning || "").trim(),
  };
}

export function normalizeVerifyArtifact(input: any, qaCases: TestCaseArtifact[] = [], validationSummary: string[] = []): VerifyArtifact {
  const qaResults = Array.isArray(input?.cases)
    ? input.cases
        .map((item: any) => ({
          name: String(item?.name || "").trim(),
          status: (item?.status || "skipped") as "passed" | "failed" | "skipped",
          evidence: String(item?.evidence || "").trim(),
        }))
        .filter((item: VerifyCaseArtifact) => item.name || item.evidence)
    : [];

  return {
    static_validation: Array.from(
      new Set([
        ...validationSummary.map((item) => String(item || "").trim()).filter(Boolean),
        ...toStringArray(input?.static_validation, 8),
      ]),
    ).slice(0, 10),
    qa_cases: qaCases,
    qa_results: qaResults,
    overall_status: String(input?.overall_status || "").trim() || "skipped",
  };
}

export function buildArtifactEnvelope<T>(
  phase: ArtifactPhase,
  humanSummary: string,
  artifact: T,
): PhaseArtifactEnvelope<T> {
  return {
    phase,
    human_summary: summarizeText(humanSummary, 220),
    artifact,
  };
}
