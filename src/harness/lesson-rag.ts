import * as fs from "fs";
import * as path from "path";

export interface Lesson {
  id: string;
  timestamp: number;
  grade: 'S' | 'A' | 'F';
  errorLog?: string;
  lesson: string;
  context: string; // e.g. "UserInfoCard.vue change"
}

export class EvalHarness {
  private lessonsDir: string;

  constructor(private baseDir: string) {
    this.lessonsDir = path.join(this.baseDir, ".harness", "lessons");
    if (!fs.existsSync(this.lessonsDir)) {
      fs.mkdirSync(this.lessonsDir, { recursive: true });
    }
  }

  public async recordLesson(lesson: Omit<Lesson, 'id' | 'timestamp'>) {
    const data: Lesson = {
      ...lesson,
      id: Math.random().toString(36).substring(7),
      timestamp: Date.now()
    };
    
    const fileName = `${data.id}_${data.grade}.json`;
    fs.writeFileSync(path.join(this.lessonsDir, fileName), JSON.stringify(data, null, 2));
    return data;
  }

  public getRelevantLessons(context: string, limit = 3): string {
    try {
      const files = fs.readdirSync(this.lessonsDir);
      const allLessons: Lesson[] = files
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(this.lessonsDir, f), 'utf-8')))
        .filter(l => l.grade !== 'S'); // We learn from mistakes (A/F)

      // Simple keyword matching for context relevance
      const relevant = allLessons
        .filter(l => context.split(' ').some(word => l.context.includes(word)))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);

      if (relevant.length === 0) return "";

      return "### 🎓 历史经验教训 (Evolution Lessons)\n" + 
        relevant.map(l => `- 错误情境: ${l.context}\n- 失败原因: ${l.errorLog || '未知'}\n- 进化指令: ${l.lesson}`).join("\n\n");
    } catch (e) {
      return "";
    }
  }
}
