import { useState, useEffect, useRef, useCallback } from 'react';
import './index.css';

/* ==============================
   SVG Icon 组件
   ============================== */
const Icon = {
  Activity: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  MessageSquare: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  History: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  Settings: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  Play: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  Loader: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
      <line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" />
      <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" /><line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
      <line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" /><line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
    </svg>
  ),
  Check: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  Square: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    </svg>
  ),
  Brain: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.14" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.14" />
    </svg>
  ),
  Tool: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  Judge: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
  Alert: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
};

/* ==============================
   类型定义
   ============================== */
interface StepData {
  name: string;
  status: 'waiting' | 'processing' | 'done' | 'error';
}

// 日志条目类型，用于差异化渲染
type LogType = 'thought' | 'action' | 'result' | 'judge' | 'system' | 'error' | 'evolution';

interface LogEntry {
  kind: 'log';
  id: number;
  type: LogType;
  content: string;
  ts: string;
}

interface PhaseSummaryEntry {
  kind: 'summary';
  id: number;
  phase: string;
  title: string;
  summary: string;
  highlights: string[];
  stats: string[];
  ts: string;
}

type StreamItem = LogEntry | PhaseSummaryEntry;
type QaEnvPreference = 'auto' | 'local' | 'dev' | 'pre' | 'release' | 'production';

interface PhaseSummaryPayload {
  phase?: string;
  title?: string;
  summary?: string;
  highlights?: string[];
  stats?: string[];
}

interface LiveTickerLine {
  id: number;
  text: string;
}

const HARNESS_PHASES = [
  '意图解析 & 预检',
  '需求深度解析',
  '接口合约对接',
  '实施方案规划',
  '代码系统集成',
  '自动化 QA'
];

const PHASE_LABEL_MAP: Record<string, string> = {
  INTENT: '意图解析 & 预检',
  PRD: '需求深度解析',
  API: '接口合约对接',
  PLAN: '实施方案规划',
  CODING: '代码系统集成',
  VERIFY: '自动化 QA',
  DONE: '全部完成',
  ERROR: '异常终止',
};

const makeInitialSteps = (): StepData[] =>
  HARNESS_PHASES.map(name => ({ name, status: 'waiting' }));

const nowTs = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const LIVE_TICKER_LIMIT = 12;
const LIVE_TICKER_CHAR_LIMIT = 92;

/* ==============================
   日志分类器：根据内容推断日志类型
   ============================== */
function classifyLog(content: string): LogType {
  if (content.startsWith('[Action]') || content.startsWith('[Args]')) return 'action';
  if (content.startsWith('[Result]')) return 'result';
  if (content.startsWith('[Judge]')) return 'judge';
  if (content.startsWith('[系统]') || content.startsWith('[Harness]') || content.startsWith('✅ 意图')) return 'system';
  if (content.startsWith('[错误]') || content.startsWith('[熔断]')) return 'error';
  if (content.includes('EVOLUTION') || content.startsWith('[进化]')) return 'evolution';
  return 'thought';
}

function normalizeTickerText(content: string): string | null {
  if (!content) return null;

  let text = content
    .replace(/^\[(系统|Harness)\]\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;
  if (text.startsWith('Run ID:')) return null;
  if (text.startsWith('▶ 进入阶段:')) return null;
  if (text.length < 4) return null;

  if (text.length > LIVE_TICKER_CHAR_LIMIT) {
    text = `${text.slice(0, LIVE_TICKER_CHAR_LIMIT)}…`;
  }

  return text;
}

/* ==============================
   主应用组件
   ============================== */
let logIdCounter = 0;
let liveTickerIdCounter = 0;

function App() {
  const [intent, setIntent] = useState('');
  const [steps, setSteps] = useState<StepData[]>(makeInitialSteps());
  const [streamItems, setStreamItems] = useState<StreamItem[]>([]);
  const [activePhaseIndex, setActivePhaseIndex] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [liveTickerLines, setLiveTickerLines] = useState<LiveTickerLine[]>([]);
  const [showLiveTicker, setShowLiveTicker] = useState(false);
  const [qaEnvPreference, setQaEnvPreference] = useState<QaEnvPreference>('auto');
  const [qaBaseUrlOverride, setQaBaseUrlOverride] = useState('');
  const [qaAutoBoot, setQaAutoBoot] = useState(true);

  // 模型配置
  const [provider, setProvider] = useState<'lmstudio' | 'omlx' | 'openai'>('lmstudio');
  const [lmStudioUrl, setLmStudioUrl] = useState('http://127.0.0.1:1234/v1/models');
  const [omlxUrl, setOmlxUrl] = useState('http://127.0.0.1:8000/v1/models');
  const [omlxKey, setOmlxKey] = useState('allen1203');
  const [lmModels, setLmModels] = useState<string[]>([]);
  const [omlxModels, setOmlxModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [openAiUrl, setOpenAiUrl] = useState('https://api.openai.com/v1');
  const [openAiKey, setOpenAiKey] = useState('');
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);

  // 日志区自动滚动
  const logEndRef = useRef<HTMLDivElement>(null);
  const tickerBoxRef = useRef<HTMLDivElement>(null);
  const activeIndexRef = useRef<number>(0);
  const activePhaseCodeRef = useRef<string>('');
  const pendingLogsRef = useRef<Array<{ content: string; forceType?: LogType }>>([]);
  const flushTimerRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);

  // 追加日志（自动分类 + 分行）
  const flushQueuedLogs = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    const queued = pendingLogsRef.current;
    if (queued.length === 0) return;
    pendingLogsRef.current = [];

    setStreamItems(prev => {
      const updated = [...prev];

      queued.forEach(({ content, forceType }) => {
        if (!content) return;
        const type = forceType || classifyLog(content);
        const lines = type === 'thought' ? [content] : content.split('\n').filter(line => line.length > 0);

        lines.forEach(line => {
          const lineType = forceType || classifyLog(line);
          const lastEntry = updated[updated.length - 1];

          if (
            lineType === 'thought' &&
            lastEntry &&
            lastEntry.kind === 'log' &&
            lastEntry.type === 'thought'
          ) {
            updated[updated.length - 1] = {
              ...lastEntry,
              content: lastEntry.content + line,
              ts: nowTs(),
            };
            return;
          }

          updated.push({
            kind: 'log',
            id: ++logIdCounter,
            type: lineType,
            content: line,
            ts: nowTs(),
          });
        });
      });

      return updated;
    });
  }, []);

  const resetLiveTicker = useCallback((phase?: string, seed?: string) => {
    activePhaseCodeRef.current = phase || activePhaseCodeRef.current;
    const initial = normalizeTickerText(seed || '');
    setLiveTickerLines(initial ? [{ id: ++liveTickerIdCounter, text: initial }] : []);
  }, []);

  const appendLiveTicker = useCallback((content: string, phase?: string) => {
    const normalized = normalizeTickerText(content);
    if (!normalized) return;

    if (phase) {
      activePhaseCodeRef.current = phase;
    }

    setLiveTickerLines(prev => {
      if (prev[prev.length - 1]?.text === normalized) return prev;
      return [...prev, { id: ++liveTickerIdCounter, text: normalized }].slice(-LIVE_TICKER_LIMIT);
    });
  }, []);

  const clearLiveTicker = useCallback((phase?: string) => {
    if (phase && activePhaseCodeRef.current && activePhaseCodeRef.current !== phase) return;
    setLiveTickerLines([]);
  }, []);

  const scheduleLogFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      window.requestAnimationFrame(() => flushQueuedLogs());
    }, 96);
  }, [flushQueuedLogs]);

  const appendLog = useCallback((content: string, forceType?: LogType) => {
    if (!content) return;
    pendingLogsRef.current.push({ content, forceType });
    scheduleLogFlush();
  }, [scheduleLogFlush]);

  const appendPhaseSummary = useCallback((payload: PhaseSummaryPayload) => {
    flushQueuedLogs();
    setStreamItems(prev => [
      ...prev,
      {
        kind: 'summary',
        id: ++logIdCounter,
        phase: payload.phase || 'UNKNOWN',
        title: payload.title || `${PHASE_LABEL_MAP[payload.phase || ''] || '阶段'}总结`,
        summary: payload.summary || '该阶段已完成。',
        highlights: Array.isArray(payload.highlights) ? payload.highlights.filter(Boolean).slice(0, 5) : [],
        stats: Array.isArray(payload.stats) ? payload.stats.filter(Boolean).slice(0, 4) : [],
        ts: nowTs(),
      },
    ]);
  }, [flushQueuedLogs]);

  // 自动滚动到日志尾部
  useEffect(() => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
    }
    scrollRafRef.current = requestAnimationFrame(() => {
      logEndRef.current?.scrollIntoView({ behavior: isRunning ? 'auto' : 'smooth', block: 'end' });
    });
  }, [streamItems, isRunning]);

  useEffect(() => {
    if (!showLiveTicker) return;
    const tickerEl = tickerBoxRef.current;
    if (!tickerEl) return;

    const raf = requestAnimationFrame(() => {
      tickerEl.scrollTo({
        top: tickerEl.scrollHeight,
        behavior: 'smooth',
      });
    });

    return () => cancelAnimationFrame(raf);
  }, [liveTickerLines, showLiveTicker]);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  // 拉取 LM Studio / oMLX 模型
  const fetchModels = useCallback(async (type: 'lmstudio' | 'omlx') => {
    setIsLoadingModels(true);
    setModelFetchError(null);
    let targetUrl = type === 'lmstudio' ? lmStudioUrl : omlxUrl;
    
    // 自动补全常见的 API 路径
    if (!targetUrl.endsWith('/models')) {
      if (targetUrl.endsWith('/v1')) targetUrl += '/models';
      else if (!targetUrl.endsWith('/v1/')) targetUrl = targetUrl.replace(/\/$/, '') + '/v1/models';
    }

    try {
      console.log(`[oMLX/LM] 尝试拉取模型列表 (${type}):`, targetUrl);
      const queryApiKey = type === 'omlx' ? omlxKey : 'no-key';
      const res = await fetch(`http://localhost:3000/api/model-proxy?url=${encodeURIComponent(targetUrl)}&apiKey=${queryApiKey}`);
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${res.status}`);
      }
      
      const data = await res.json();
      
      // 兼容多种格式 (data.data, data.models, or data as array)
      const rawList = Array.isArray(data) ? data : (data?.data || data?.models || []);
      if (!Array.isArray(rawList)) {
        console.warn(`[oMLX/LM] 收到非数组响应:`, data);
        throw new Error('无效的响应格式 (预期是模型列表)');
      }
      
      const models = rawList.map((m: unknown) => {
        if (typeof m === 'string') return m;
        if (m && typeof m === 'object') {
          return (m as { id?: string }).id || (m as { name?: string }).name;
        }
        return null;
      }).filter(Boolean) as string[];
      
      if (type === 'lmstudio') setLmModels(models);
      else setOmlxModels(models);
      
      if (models.length > 0) {
        setSelectedModel(prev => prev || models[0]);
      }
      console.log(`[oMLX/LM] 解析到模型列表 (${type}): ${models.length} 个模型`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[oMLX/LM] 获取${type}模型失败:`, errorMessage, targetUrl);
      setModelFetchError(`连接失败: ${errorMessage}`);
    } finally {
      setIsLoadingModels(false);
    }
  }, [lmStudioUrl, omlxUrl, omlxKey]);

  useEffect(() => {
    if (provider === 'lmstudio') fetchModels('lmstudio');
    if (provider === 'omlx') fetchModels('omlx');
  }, [provider, fetchModels]);

  const [pendingRun, setPendingRun] = useState<{
    intent: string,
    modelConfig: {
      type: string,
      baseUrl: string,
      model: string,
      apiKey?: string,
      qaConfig?: {
        envPreference: QaEnvPreference,
        baseUrl: string,
        autoBoot: boolean,
      }
    }
  } | null>(null);

  // SSE 事件监听
  useEffect(() => {
    if (!isRunning) return;

    const es = new EventSource('http://localhost:3000/events');

    // ── 【新增】连接就绪后再触发后端任务 ───────────────────
    es.onopen = () => {
      if (pendingRun) {
        fetch('http://localhost:3000/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            prompt: pendingRun.intent, 
            modelConfig: pendingRun.modelConfig 
          }),
        }).then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(data.error || '启动任务失败');
          }
          if (data.runId) appendLog(`[系统] Run ID: ${data.runId}`);
          setPendingRun(null);
        })
          .catch(err => {
            appendLog(`[错误] 启动请求失败: ${err.message}`);
            setIsRunning(false);
          });
      }
    };

    es.addEventListener('step-start', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      const index = typeof data.index === 'number' ? data.index : 0;
      activeIndexRef.current = index;
      activePhaseCodeRef.current = data.phase || '';
      setActivePhaseIndex(index);
      setShowLiveTicker(true);
      resetLiveTicker(
        data.phase,
        `${PHASE_LABEL_MAP[data.phase] || data.phase || '当前阶段'}已启动，正在生成阶段产出…`
      );
      setSteps(prev => prev.map((s, i) =>
        i === index ? { ...s, status: 'processing' } : s
      ));
      appendLog(`[系统] ▶ 进入阶段: ${PHASE_LABEL_MAP[data.phase] || data.phase}`);
    });

    es.addEventListener('step-progress', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      const phase = data.phase || activePhaseCodeRef.current;
      if (data.thought) {
        appendLog(data.thought, 'thought');
        appendLiveTicker(data.thought, phase);
      }
      if (data.content && data.content !== data.thought) {
        appendLog(data.content, 'system');
        appendLiveTicker(data.content, phase);
      }
    });

    es.addEventListener('phase-summary', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      appendPhaseSummary(data);
      setShowLiveTicker(false);
      clearLiveTicker(data.phase);
    });

    es.addEventListener('step-complete', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      const index = typeof data.index === 'number' ? data.index : 0;
      const nextStatus: StepData['status'] = data.status === 'error' ? 'error' : 'done';
      if (data.status === 'error') {
        setShowLiveTicker(false);
        clearLiveTicker(data.phase);
      }
      setSteps(prev => prev.map((s, i) =>
        i === index ? { ...s, status: nextStatus } : s
      ));
    });

    es.addEventListener('workflow-complete', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      flushQueuedLogs();
      setIsRunning(false);
      setIsComplete(true);
      setShowLiveTicker(false);
      clearLiveTicker();
      
      // 只有成功完成的才保持 done，其他未处理的步骤如果还是 processing 统一转 error
      setSteps(prev => prev.map(s => 
        s.status === 'processing' ? { ...s, status: data.status === 'success' ? 'done' : 'error' } : s
      ));
      
      appendPhaseSummary({
        phase: data.status === 'success' ? 'DONE' : 'ERROR',
        title: data.status === 'success' ? '全部阶段已完成' : '流程提前终止',
        summary: data.status === 'success' ? '本轮任务已经完成，所有阶段均已走通。' : (data.message || '任务在执行过程中被中断。'),
        highlights: data.message ? [data.message] : [],
        stats: data.status === 'success' ? ['工作流完成'] : ['需要复查日志'],
      });
      appendLog(data.status === 'success' ? '[系统] ✅ 工作流任务顺利结束' : '[错误] ❌ 工作流提前终止');
      es.close();
    });

      es.addEventListener('error', (e) => {
        try {
          const message = (e as MessageEvent).data || '与后端连接中断';
          appendLog(`[错误] SSE ${message}`);
        } catch { /* noop */ }
        setIsRunning(false);
        setShowLiveTicker(false);
        clearLiveTicker();
        es.close();
      });

    es.onerror = () => {
      setIsRunning(false);
      setShowLiveTicker(false);
      clearLiveTicker();
      es.close();
    };

    return () => es.close();
  }, [isRunning, appendLog, appendPhaseSummary, appendLiveTicker, clearLiveTicker, flushQueuedLogs, pendingRun, resetLiveTicker]);

  const handleStart = async () => {
    if (!intent.trim()) return;

    // 重置状态
    setSteps(makeInitialSteps());
    setStreamItems([]);
    setActivePhaseIndex(0);
    setIsComplete(false);
    setIsRunning(true);
    setShowLiveTicker(false);
    setLiveTickerLines([]);
    logIdCounter = 0;
    liveTickerIdCounter = 0;
    activePhaseCodeRef.current = '';
    pendingLogsRef.current = [];
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    const modelConfig = provider === 'lmstudio'
      ? { type: 'lmstudio', baseUrl: lmStudioUrl.replace('/models', ''), model: selectedModel }
      : provider === 'omlx'
        ? { type: 'omlx', baseUrl: omlxUrl.replace('/models', ''), model: selectedModel, apiKey: omlxKey }
        : { type: 'openai', baseUrl: openAiUrl, apiKey: openAiKey, model: selectedModel };

    const enrichedModelConfig = {
      ...modelConfig,
      qaConfig: {
        envPreference: qaEnvPreference,
        baseUrl: qaBaseUrlOverride.trim(),
        autoBoot: qaAutoBoot,
      },
    };

    setPendingRun({ intent, modelConfig: enrichedModelConfig });
    setIsRunning(true);
  };

  const handleStop = async () => {
    try { await fetch('http://localhost:3000/stop', { method: 'POST' }); } catch { /* noop */ }
    setIsRunning(false);
    setShowLiveTicker(false);
    clearLiveTicker();
    appendLog('[系统] ⏹ 用户已手动停止任务');
  };

  // 日志类型 → 样式类名
  const logClass = (type: LogType) => {
    const map: Record<LogType, string> = {
      thought: 'log-thought',
      action: 'log-action',
      result: 'log-result',
      judge: 'log-judge',
      system: 'log-system',
      error: 'log-error',
      evolution: 'log-evolution',
    };
    return map[type];
  };

  // 日志类型 → 前缀图标
  const logIcon = (type: LogType) => {
    if (type === 'action') return <Icon.Tool />;
    if (type === 'judge') return <Icon.Judge />;
    if (type === 'thought') return <Icon.Brain />;
    if (type === 'error') return <span>⚡</span>;
    if (type === 'evolution') return <span>🧬</span>;
    return null;
  };

  const currentPhaseLabel =
    activePhaseIndex !== null
      ? steps[activePhaseIndex]?.name || '执行中'
      : isComplete
        ? '已完成'
        : '待命中';

  return (
    <div className="app-layout">
      {/* ===== 侧边栏 ===== */}
      <nav className="sidebar">
        <div className="sidebar-logo"><Icon.Activity /></div>
        <div className="sidebar-nav">
          <button className="sidebar-btn active" title="工作台"><Icon.MessageSquare /></button>
          <button className="sidebar-btn" title="执行历史"><Icon.History /></button>
          <button
            className={`sidebar-btn ${showSettings ? 'active' : ''}`}
            title="设置模型"
            onClick={() => setShowSettings(!showSettings)}
          >
            <Icon.Settings />
          </button>
        </div>
        <div className="sidebar-avatar">
          <img
            src="https://ui-avatars.com/api/?name=A&background=006766&color=fff&size=72"
            alt="用户头像"
          />
        </div>
      </nav>

      {/* ===== 主内容区：两栏布局 ===== */}
      <main className="main-content agent-layout">

        {/* ── 左栏：意图输入 + 阶段进度 ── */}
        <aside className="agent-sidebar-left">
          <header className="header">
            <h1 className="header-title">飞书产研 Agent</h1>
            <div className="header-status">
              <span className={`status-dot ${isRunning ? 'pulsing' : ''}`} />
              {isRunning ? '运行中...' : isComplete ? '已完成' : 'MCP Hub 已连接'}
            </div>
          </header>

          {/* 意图输入区 */}
          <div className="intent-input-area">
            <div className="intent-label">🚀 任务意图</div>
            <textarea
              className="intent-textarea"
              placeholder={"输入任务指令...\n可直接粘贴飞书 PRD 链接和本地项目路径\n例如：PRD→https://xxx.feishu.cn/... 项目在 /Users/xxx/my-app 请实现登录功能"}
              value={intent}
              onChange={e => setIntent(e.target.value)}
              disabled={isRunning}
              rows={5}
            />
            <div className="intent-actions">
              {isRunning ? (
                <button className="btn-stop" onClick={handleStop}>
                  <Icon.Square /> 停止
                </button>
              ) : (
                <button className="btn-start" onClick={handleStart} disabled={!intent.trim()}>
                  <Icon.Play /> 开始执行
                </button>
              )}
            </div>
          </div>

          {/* 设置面板 */}
          {showSettings && (
            <div className="settings-panel">
              <div className="settings-header"><h3>模型配置</h3></div>
              <div className="provider-tabs">
                <div className={`provider-tab ${provider === 'lmstudio' ? 'active' : ''}`}
                  onClick={() => { setProvider('lmstudio'); setSelectedModel(lmModels[0] || ''); }}>
                  LM Studio
                </div>
                <div className={`provider-tab ${provider === 'omlx' ? 'active' : ''}`}
                  onClick={() => { setProvider('omlx'); setSelectedModel(omlxModels[0] || ''); }}>
                  oMLX 服务器
                </div>
                <div className={`provider-tab ${provider === 'openai' ? 'active' : ''}`}
                  onClick={() => { setProvider('openai'); setSelectedModel('gpt-4-turbo'); }}>
                  OpenAI / 兼容
                </div>
              </div>
              <div className="settings-body">
                {provider === 'lmstudio' && (
                  <div className="settings-form">
                    <div className="input-group">
                      <label>Models API 端点</label>
                      <div className="input-wrap">
                        <input value={lmStudioUrl} onChange={e => setLmStudioUrl(e.target.value)} />
                      </div>
                    </div>
                    <div className="input-group">
                      <label>选择模型 {modelFetchError && <span className="error-hint">({modelFetchError})</span>}</label>
                      <div className="input-wrap select-wrap">
                        {isLoadingModels ? (
                          <div className="loading-text">正在拉取...</div>
                        ) : (
                          <>
                            <select 
                              value={lmModels.includes(selectedModel) ? selectedModel : ''} 
                              onChange={e => setSelectedModel(e.target.value)}
                              className={lmModels.length > 0 ? '' : 'hidden-select'}
                            >
                              <option value="">-- 选择模型 --</option>
                              {lmModels.map(m => <option key={m} value={m}>{m}</option>)}
                            </select>
                            <input 
                              placeholder="或手动输入模型..." 
                              value={selectedModel} 
                              onChange={e => setSelectedModel(e.target.value)} 
                              className={lmModels.length > 0 ? 'inline-input' : 'full-input'}
                            />
                          </>
                        )}
                        <button className="refresh-btn" onClick={() => fetchModels('lmstudio')}>↻</button>
                      </div>
                    </div>
                  </div>
                )}
                {provider === 'omlx' && (
                  <div className="settings-form">
                    <div className="input-group">
                      <label>oMLX Server 端点</label>
                      <div className="input-wrap">
                        <input value={omlxUrl} onChange={e => setOmlxUrl(e.target.value)} />
                      </div>
                    </div>
                    <div className="input-group">
                      <label>API Key (默认已填)</label>
                      <div className="input-wrap">
                        <input type="password" value={omlxKey} onChange={e => setOmlxKey(e.target.value)} />
                      </div>
                    </div>
                    <div className="input-group">
                      <label>选择模型 {modelFetchError && <span className="error-hint">({modelFetchError})</span>}</label>
                      <div className="input-wrap select-wrap">
                        {isLoadingModels ? (
                          <div className="loading-text">正在拉取...</div>
                        ) : (
                          <>
                            <select 
                              value={omlxModels.includes(selectedModel) ? selectedModel : ''} 
                              onChange={e => setSelectedModel(e.target.value)}
                              className={omlxModels.length > 0 ? '' : 'hidden-select'}
                            >
                              <option value="">-- 选择模型 --</option>
                              {omlxModels.map(m => <option key={m} value={m}>{m}</option>)}
                            </select>
                            <input 
                              placeholder="或手动输入模型..." 
                              value={selectedModel} 
                              onChange={e => setSelectedModel(e.target.value)} 
                              className={omlxModels.length > 0 ? 'inline-input' : 'full-input'}
                            />
                          </>
                        )}
                        <button className="refresh-btn" onClick={() => fetchModels('omlx')}>↻</button>
                      </div>
                    </div>
                  </div>
                )}
                {provider === 'openai' && (
                  <div className="settings-form">
                    <div className="input-group">
                      <label>Base URL</label>
                      <div className="input-wrap">
                        <input value={openAiUrl} onChange={e => setOpenAiUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
                      </div>
                    </div>
                    <div className="input-group">
                      <label>API Key</label>
                      <div className="input-wrap">
                        <input type="password" value={openAiKey} onChange={e => setOpenAiKey(e.target.value)} placeholder="sk-..." />
                      </div>
                    </div>
                    <div className="input-group">
                      <label>模型名称</label>
                      <div className="input-wrap">
                        <input value={selectedModel} onChange={e => setSelectedModel(e.target.value)} placeholder="gpt-4-turbo" />
                      </div>
                    </div>
                  </div>
                )}
                <div className="settings-divider" />
                <div className="settings-form">
                  <div className="settings-section-title">自动化 QA</div>
                  <div className="input-group">
                    <label>环境偏好</label>
                    <div className="input-wrap">
                      <select value={qaEnvPreference} onChange={e => setQaEnvPreference(e.target.value as QaEnvPreference)}>
                        <option value="auto">自动匹配</option>
                        <option value="local">local</option>
                        <option value="dev">dev</option>
                        <option value="pre">pre</option>
                        <option value="release">release</option>
                        <option value="production">production</option>
                      </select>
                    </div>
                  </div>
                  <div className="input-group">
                    <label>Base URL 覆盖</label>
                    <div className="input-wrap">
                      <input
                        value={qaBaseUrlOverride}
                        onChange={e => setQaBaseUrlOverride(e.target.value)}
                        placeholder="例如 http://127.0.0.1:5173"
                      />
                    </div>
                  </div>
                  <label className="qa-toggle">
                    <input
                      type="checkbox"
                      checked={qaAutoBoot}
                      onChange={e => setQaAutoBoot(e.target.checked)}
                    />
                    <span>未探测到站点时，自动读取 package.json 并启动目标项目</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* 阶段进度轨道 */}
          <div className="phase-track">
            <div className="phase-track-title">Agent 执行进度</div>
            {steps.map((step, idx) => (
              <div key={step.name} className={`phase-item ${step.status} ${activePhaseIndex === idx ? 'active-phase' : ''}`}>
                <div className="phase-dot">
                  {step.status === 'done' ? <Icon.Check /> :
                   step.status === 'processing' ? <Icon.Loader /> :
                   <span className="phase-num">{idx + 1}</span>}
                </div>
                <div className="phase-info">
                  <div className="phase-name">{step.name}</div>
                  <div className="phase-status-text">
                    {step.status === 'done' ? '✓ 完成' :
                     step.status === 'processing' ? '执行中...' : '等待'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* ── 右栏：实时思维流 ── */}
        <section className="agent-stream-panel">
          <div className="stream-header">
            <div className="stream-header-main">
              <div className="stream-title">
                <Icon.Brain />
                <span>实时执行流</span>
                {isRunning && <span className="stream-pulse">●</span>}
              </div>
              <div className="stream-phase-badge">
                <span className="stream-phase-label">当前阶段</span>
                <span className="stream-phase-name">{currentPhaseLabel}</span>
              </div>
            </div>
            <div className="stream-legend">
              <span className="legend-item thought">💭 思考</span>
              <span className="legend-item action">🔧 工具调用</span>
              <span className="legend-item result">📦 工具结果</span>
              <span className="legend-item summary">📌 阶段总结</span>
              <span className="legend-item judge">📊 评分</span>
            </div>
          </div>

          <div className="stream-body" id="stream-body">
            {isRunning && showLiveTicker && (
              <section className="live-ticker-card">
                <div className="live-ticker-head">
                  <div className="live-ticker-title">
                    <span className="live-ticker-dot" />
                    <span>LLM 正在工作</span>
                  </div>
                  <div className="live-ticker-phase">{currentPhaseLabel}</div>
                </div>
                <div className="live-ticker-window" ref={tickerBoxRef}>
                  {liveTickerLines.length === 0 ? (
                    <div className="live-ticker-placeholder">正在整理上下文、准备阶段产出…</div>
                  ) : (
                    liveTickerLines.map((line, idx) => (
                      <div
                        key={line.id}
                        className={`live-ticker-line ${idx === liveTickerLines.length - 1 ? 'is-latest' : ''}`}
                      >
                        <span className="live-ticker-line-mark">·</span>
                        <span>{line.text}</span>
                      </div>
                    ))
                  )}
                </div>
              </section>
            )}
            {streamItems.length === 0 ? (
              <div className="stream-empty">
                <div className="stream-empty-icon">🤖</div>
                <div className="stream-empty-text">Agent 待命中</div>
                <div className="stream-empty-hint">输入任务指令后，这里将实时显示 Agent 的思考过程、工具调用和执行结果</div>
              </div>
            ) : (
              streamItems.map(entry => (
                entry.kind === 'summary' ? (
                  <section key={entry.id} className="summary-card">
                    <div className="summary-card-head">
                      <div className="summary-card-phase">{PHASE_LABEL_MAP[entry.phase] || entry.phase}</div>
                      <div className="summary-card-ts">{entry.ts}</div>
                    </div>
                    <div className="summary-card-title">{entry.title}</div>
                    <div className="summary-card-text">{entry.summary}</div>
                    {entry.stats.length > 0 && (
                      <div className="summary-chip-list">
                        {entry.stats.map((chip, idx) => (
                          <span key={`${entry.id}-chip-${idx}`} className="summary-chip">{chip}</span>
                        ))}
                      </div>
                    )}
                    {entry.highlights.length > 0 && (
                      <div className="summary-highlight-list">
                        {entry.highlights.map((item, idx) => (
                          <div key={`${entry.id}-item-${idx}`} className="summary-highlight">
                            <span className="summary-highlight-dot" />
                            <span>{item}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                ) : (
                  <div key={entry.id} className={`stream-entry ${logClass(entry.type)}`}>
                    <span className="stream-ts">{entry.ts}</span>
                    <span className="stream-icon">{logIcon(entry.type)}</span>
                    <span className="stream-content">{entry.content}</span>
                  </div>
                )
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </section>

      </main>
    </div>
  );
}

export default App;
