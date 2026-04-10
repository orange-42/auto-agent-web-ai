import * as fs from "fs";
import * as path from "path";
import { REPLAY_STAGES, ReplayStageName } from "../debug-run-store";
import { summarizeText } from "../harness-logger";

export type LessonGrade = "S" | "A" | "F";
export type LessonSeverity = "low" | "medium" | "high";
export type LessonStage = ReplayStageName | "SYSTEM";

export interface Lesson {
  id: string;
  timestamp: number;
  grade: LessonGrade;
  errorLog?: string;
  lesson: string;
  context: string;
  source?: "legacy" | "hermes";
  runId?: string;
  workflowStatus?: string;
  title?: string;
  stage?: LessonStage;
  applicableStages?: LessonStage[];
  tags?: string[];
  severity?: LessonSeverity;
  rootCause?: string;
  promptPatch?: string;
  checklist?: string[];
  projectPath?: string;
  targetRoute?: string;
  targetComponentPath?: string;
  taskObjective?: string;
  mode?: "full" | "replay";
  confidence?: number;
}

export interface LessonQuery {
  runId?: string;
  workflowStatus?: string;
  stage?: LessonStage;
  projectPath?: string;
  targetRoute?: string;
  targetComponentPath?: string;
  taskObjective?: string;
  originalPrompt?: string;
  extraText?: string;
  tags?: string[];
}

export interface HermesEvolutionLesson {
  title?: string;
  stage?: LessonStage;
  applicable_stages?: LessonStage[];
  severity?: LessonSeverity;
  tags?: string[];
  context: string;
  lesson: string;
  errorLog?: string;
  rootCause?: string;
  promptPatch?: string;
  checklist?: string[];
}

export interface HermesEvolutionReport {
  runId: string;
  workflowStatus: string;
  mode?: "full" | "replay";
  overallGrade: LessonGrade;
  runSummary: string;
  reasoning?: string;
  operatorNotes?: string[];
  context?: LessonQuery;
  lessons: HermesEvolutionLesson[];
  createdAt?: string;
}

interface NormalizedLessonQuery extends LessonQuery {
  keywords: string[];
  lookupText: string;
}

const STAGE_SET = new Set<LessonStage>([...REPLAY_STAGES, "SYSTEM"]);

export class EvalHarness {
  private lessonsDir: string;
  private hermesReportsDir: string;

  constructor(private baseDir: string) {
    this.lessonsDir = path.join(this.baseDir, ".harness", "lessons");
    this.hermesReportsDir = path.join(this.baseDir, ".harness", "hermes");
    if (!fs.existsSync(this.lessonsDir)) {
      fs.mkdirSync(this.lessonsDir, { recursive: true });
    }
    if (!fs.existsSync(this.hermesReportsDir)) {
      fs.mkdirSync(this.hermesReportsDir, { recursive: true });
    }
  }

  public async recordLesson(lesson: Omit<Lesson, "id" | "timestamp">): Promise<Lesson> {
    const data: Lesson = {
      ...lesson,
      id: Math.random().toString(36).substring(2, 10),
      timestamp: Date.now(),
    };

    const fileName = `${data.id}_${data.grade}.json`;
    fs.writeFileSync(path.join(this.lessonsDir, fileName), JSON.stringify(data, null, 2));
    return data;
  }

  public async recordHermesReport(report: HermesEvolutionReport): Promise<Lesson[]> {
    const normalizedReport: HermesEvolutionReport = {
      ...report,
      createdAt: report.createdAt || new Date().toISOString(),
      operatorNotes: Array.isArray(report.operatorNotes) ? report.operatorNotes.slice(0, 6) : [],
      lessons: Array.isArray(report.lessons) ? report.lessons.slice(0, 6) : [],
    };

    fs.writeFileSync(
      this.getHermesReportPath(report.runId),
      JSON.stringify(normalizedReport, null, 2),
      "utf-8",
    );

    const savedLessons: Lesson[] = [];
    for (const item of normalizedReport.lessons) {
      const saved = await this.recordLesson({
        source: "hermes",
        runId: normalizedReport.runId,
        workflowStatus: normalizedReport.workflowStatus,
        mode: normalizedReport.mode || "full",
        grade: normalizedReport.overallGrade,
        title: item.title || normalizedReport.runSummary,
        stage: this.normalizeStage(item.stage),
        applicableStages: this.normalizeStages(item.applicable_stages),
        severity: item.severity || this.gradeToSeverity(normalizedReport.overallGrade),
        tags: this.normalizeStringArray(item.tags),
        context: item.context || normalizedReport.runSummary,
        lesson: item.lesson || normalizedReport.runSummary,
        errorLog: item.errorLog,
        rootCause: item.rootCause,
        promptPatch: item.promptPatch,
        checklist: this.normalizeStringArray(item.checklist),
        projectPath: normalizedReport.context?.projectPath,
        targetRoute: normalizedReport.context?.targetRoute,
        targetComponentPath: normalizedReport.context?.targetComponentPath,
        taskObjective: normalizedReport.context?.taskObjective,
        confidence: normalizedReport.overallGrade === "S" ? 0.8 : 0.92,
      });
      savedLessons.push(saved);
    }

    return savedLessons;
  }

  public readHermesReport(runId: string): HermesEvolutionReport | null {
    const reportPath = this.getHermesReportPath(runId);
    if (!fs.existsSync(reportPath)) return null;

    try {
      return JSON.parse(fs.readFileSync(reportPath, "utf-8")) as HermesEvolutionReport;
    } catch {
      return null;
    }
  }

  public getRelevantLessons(context: string | LessonQuery, limit = 4): string {
    try {
      const allLessons = this.loadLessons();
      if (allLessons.length === 0) return "";

      const query = this.normalizeQuery(context);
      const scored = allLessons
        .map((lesson) => ({
          lesson,
          score: this.computeLessonScore(lesson, query),
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, limit))
        .map((item) => item.lesson);

      const fallback = scored.length > 0
        ? scored
        : allLessons
            .filter((lesson) => lesson.grade !== "S")
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, Math.max(1, Math.min(limit, 2)));

      if (fallback.length === 0) return "";

      return [
        "### Hermes 历史经验",
        ...fallback.map((lesson) => this.formatLessonForPrompt(lesson)),
      ].join("\n");
    } catch {
      return "";
    }
  }

  private getHermesReportPath(runId: string): string {
    return path.join(this.hermesReportsDir, `${runId}.report.json`);
  }

  private loadLessons(): Lesson[] {
    const files = fs.readdirSync(this.lessonsDir).filter((file) => file.endsWith(".json"));
    return files
      .map((file) => {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(this.lessonsDir, file), "utf-8")) as Record<string, unknown>;
          return this.normalizeLesson(raw);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Lesson[];
  }

  private normalizeLesson(raw: Record<string, unknown>): Lesson {
    const stage = this.normalizeStage(raw.stage);
    const applicableStages = this.normalizeStages(raw.applicableStages);
    const grade = this.normalizeGrade(raw.grade);
    return {
      id: String(raw.id || Math.random().toString(36).substring(2, 10)),
      timestamp: Number(raw.timestamp || Date.now()),
      grade,
      errorLog: this.normalizeOptionalString(raw.errorLog),
      lesson: String(raw.lesson || ""),
      context: String(raw.context || ""),
      source: raw.source === "hermes" ? "hermes" : "legacy",
      runId: this.normalizeOptionalString(raw.runId),
      workflowStatus: this.normalizeOptionalString(raw.workflowStatus),
      title: this.normalizeOptionalString(raw.title),
      stage,
      applicableStages,
      tags: this.normalizeStringArray(raw.tags),
      severity: this.normalizeSeverity(raw.severity, grade),
      rootCause: this.normalizeOptionalString(raw.rootCause),
      promptPatch: this.normalizeOptionalString(raw.promptPatch),
      checklist: this.normalizeStringArray(raw.checklist),
      projectPath: this.normalizeOptionalString(raw.projectPath),
      targetRoute: this.normalizeOptionalString(raw.targetRoute),
      targetComponentPath: this.normalizeOptionalString(raw.targetComponentPath),
      taskObjective: this.normalizeOptionalString(raw.taskObjective),
      mode: raw.mode === "replay" ? "replay" : "full",
      confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
    };
  }

  private normalizeQuery(context: string | LessonQuery): NormalizedLessonQuery {
    const query: LessonQuery = typeof context === "string" ? { extraText: context } : context;
    const lookupText = [
      query.projectPath || "",
      query.targetRoute || "",
      query.targetComponentPath || "",
      query.taskObjective || "",
      query.originalPrompt || "",
      query.extraText || "",
      ...(Array.isArray(query.tags) ? query.tags : []),
      query.stage || "",
    ].join("\n");

    return {
      ...query,
      stage: this.normalizeStage(query.stage),
      tags: this.normalizeStringArray(query.tags),
      keywords: this.extractKeywords(lookupText),
      lookupText,
    };
  }

  private computeLessonScore(lesson: Lesson, query: NormalizedLessonQuery): number {
    let score = 0;
    if (query.projectPath && lesson.projectPath && query.projectPath === lesson.projectPath) score += 10;
    if (query.targetComponentPath && lesson.targetComponentPath && query.targetComponentPath === lesson.targetComponentPath) score += 12;
    if (query.targetRoute && lesson.targetRoute && query.targetRoute === lesson.targetRoute) score += 8;
    if (query.stage && (lesson.stage === query.stage || lesson.applicableStages?.includes(query.stage))) score += 8;
    if (query.workflowStatus && lesson.workflowStatus === query.workflowStatus) score += 2;
    if (query.runId && lesson.runId === query.runId) score += 1;

    const lessonKeywords = new Set(
      this.extractKeywords(
        [
          lesson.title || "",
          lesson.context,
          lesson.lesson,
          lesson.errorLog || "",
          lesson.rootCause || "",
          lesson.promptPatch || "",
          lesson.projectPath || "",
          lesson.targetRoute || "",
          lesson.targetComponentPath || "",
          lesson.taskObjective || "",
          ...(lesson.tags || []),
          ...(lesson.applicableStages || []),
          lesson.stage || "",
        ].join("\n"),
      ),
    );

    let overlap = 0;
    for (const keyword of query.keywords) {
      if (lessonKeywords.has(keyword)) overlap += keyword.length >= 8 ? 2 : 1;
    }
    score += Math.min(overlap, 14);

    if (lesson.source === "hermes") score += 1.5;
    if (lesson.grade === "F") score += 2;
    if (lesson.grade === "A") score += 1.2;
    if (lesson.grade === "S") score += 0.6;

    const ageDays = Math.max(0, (Date.now() - lesson.timestamp) / 86_400_000);
    score += Math.max(0, 2 - Math.min(ageDays, 14) / 7);

    return score;
  }

  private formatLessonForPrompt(lesson: Lesson): string {
    const stageText = lesson.applicableStages && lesson.applicableStages.length > 0
      ? lesson.applicableStages.join("/")
      : lesson.stage || "SYSTEM";
    const severity = lesson.severity || "medium";
    const title = lesson.title || summarizeText(lesson.context || lesson.lesson) || "经验沉淀";
    const lines = [
      `- [${lesson.grade}/${severity}][${stageText}] ${title}`,
      `  场景: ${summarizeText(lesson.context || "") || "通用场景"}`,
      `  指令: ${summarizeText(lesson.lesson || "")}`,
    ];

    if (lesson.rootCause) {
      lines.push(`  根因: ${summarizeText(lesson.rootCause)}`);
    } else if (lesson.errorLog) {
      lines.push(`  症状: ${summarizeText(lesson.errorLog)}`);
    }

    if (lesson.promptPatch) {
      lines.push(`  Prompt补丁: ${summarizeText(lesson.promptPatch)}`);
    }

    if (lesson.checklist && lesson.checklist.length > 0) {
      lines.push(`  检查项: ${lesson.checklist.slice(0, 3).map((item) => summarizeText(item)).join("；")}`);
    }

    return lines.join("\n");
  }

  private extractKeywords(value: string): string[] {
    const matches = String(value || "")
      .toLowerCase()
      .match(/[\u4e00-\u9fff]{2,}|[a-z0-9_./:-]{3,}/g);
    if (!matches) return [];
    return Array.from(new Set(matches.filter((item) => item.trim().length >= 2))).slice(0, 80);
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    const normalized = String(value || "").trim();
    return normalized ? normalized : undefined;
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(
        value
          .map((item) => String(item || "").trim())
          .filter(Boolean),
      ),
    ).slice(0, 12);
  }

  private normalizeStage(value: unknown): LessonStage | undefined {
    const normalized = String(value || "").trim().toUpperCase() as LessonStage;
    return STAGE_SET.has(normalized) ? normalized : undefined;
  }

  private normalizeStages(value: unknown): LessonStage[] {
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(
        value
          .map((item) => this.normalizeStage(item))
          .filter(Boolean) as LessonStage[],
      ),
    );
  }

  private normalizeGrade(value: unknown): LessonGrade {
    const normalized = String(value || "").trim().toUpperCase();
    if (normalized === "S" || normalized === "A" || normalized === "F") return normalized;
    return "A";
  }

  private normalizeSeverity(value: unknown, grade?: LessonGrade): LessonSeverity {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
    return this.gradeToSeverity(grade || "A");
  }

  private gradeToSeverity(grade: LessonGrade): LessonSeverity {
    if (grade === "F") return "high";
    if (grade === "A") return "medium";
    return "low";
  }
}
