"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type RangeValue = "24h" | "7d" | "30d";
type ForecastWindow = "6h" | "24h" | "72h";
type ChartMetric = "tokens" | "credits";
type Confidence = "low" | "medium" | "high";
type Locale = "zh" | "en";

type SeriesPoint = {
  ts: number;
  tokenTotal: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  creditsUsed: number;
  quotaUsed: number | null;
  resetAt: number | null;
};

type DashboardData = {
  generatedAt: number;
  range: RangeValue;
  retentionDays: number;
  series: SeriesPoint[];
  totals: {
    input: number;
    cached: number;
    output: number;
    reasoning: number;
    total: number;
    credits: number;
    rated_tokens: number;
  };
  scope: {
    selectedThread: string;
    selectedRepository: string;
    repositories: {
      key: string;
      label: string;
      threadCount: number;
      totalTokens: number;
      credits: number;
      lastAt: number;
    }[];
    threads: {
      key: string;
      threadId: string;
      title: string;
      repositoryKey: string;
      repositoryLabel: string;
      firstAt: number;
      lastAt: number;
      eventCount: number;
      totalTokens: number;
      credits: number;
    }[];
  };
  credits: {
    rangeCredits: number;
    currentWindowCredits?: number;
    impliedBudgetCredits?: number | null;
    remainingCredits?: number | null;
    mixedRemainingTokens?: number | null;
    coverage: number;
    rangeCoverage: number;
    cacheHitRate?: number;
  };
  latest: null | {
    sampleAt: number;
    quotaUsed: number;
    remaining: number;
    windowMinutes: number;
    resetAt: number;
    observedResetAt: number | null;
    source: "live" | "log";
    planType: string | null;
    creditsBalance: string | null;
    resetCredits: number | null;
  };
  forecast: {
    status: "ready" | "stable" | "insufficient";
    window?: ForecastWindow;
    confidence: Confidence;
    ratePerHour?: number;
    exhaustAt?: number;
    withinWindow?: boolean;
    sampleCount?: number;
    spanHours?: number;
    baselineAt?: number;
    baselineUsed?: number;
    lastObservedResetAt?: number | null;
  };
  quotaWindow: null | {
    startAt: number;
    now: number;
    endAt: number;
    resetJumps: { ts: number; fromUsed: number; toUsed: number }[];
    points: { ts: number; actual: number | null; projected: number | null }[];
  };
  accountUsage: null | {
    sampleAt: number;
    lifetimeTokens: number | null;
    peakDailyTokens: number | null;
    longestRunningTurnSec: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
    daily: { day: string; tokens: number }[];
  };
  collector: {
    running: boolean;
    scanning: boolean;
    lastScanAt: number;
    lastError: string | null;
    importedThisRun: number;
    sampleCount: number;
    quotaSampleCount: number;
    lastLiveAt: number;
    lastLiveError: string | null;
    live: boolean;
  };
};

const RANGE_LABELS: Record<Locale, Record<RangeValue, string>> = {
  zh: { "24h": "24 小时", "7d": "7 天", "30d": "30 天" },
  en: { "24h": "24 hours", "7d": "7 days", "30d": "30 days" },
};

const CONFIDENCE_LABELS: Record<Locale, Record<Confidence, string>> = {
  zh: { low: "低置信度", medium: "中置信度", high: "高置信度" },
  en: { low: "low confidence", medium: "medium confidence", high: "high confidence" },
};

const COPY = {
  zh: {
    loading: "正在重建去重后的本地用量…", offline: "当前离线 · 使用本地回溯", disconnected: "本地采集服务未连接",
    live: "线上额度 · 本地 Token", fallback: "线上额度暂不可用 · 本地回退", weeklyRemaining: "本周额度剩余",
    plan: "计划", scheduledReset: "接口计划刷新", quotaSource: "额度来源", liveApi: "线上实时接口", localRecord: "本地最近记录", observedReset: "最近实际刷新",
    quotaTitle: "额度余量与耗尽预测", forecastWindow: "预测观察窗口", insufficient: "样本不足，暂不预测", stablePrefix: "按当前速度，", stableSuffix: " 内不会耗尽", exhaustPrefix: "预计 ", exhaustSuffix: " 耗尽", waiting: "等待额度变化", perHour: "% / 小时", samples: "个采样", lookback: "有效回看",
    creditsUsed: "本周估算已用", creditsBudget: "推算本周总额度", creditsRemaining: "估算剩余", tokenEquivalent: "按当前结构约剩", creditNoteA: "基于官方模型权重与当前", creditNoteB: "可识别 Token 推算，并非账户返回的官方 credits 余额。",
    threadUsage: "THREAD USAGE", repoUsage: "REPOSITORY USAGE", localUsage: "DEDUPED LOCAL USAGE", throughput: "处理量",
    repository: "仓库", allRepositories: "全部仓库", thread: "任务", allThreads: "全部任务", threads: "个任务", chartMetric: "图表指标", chartRange: "图表时间范围",
    localTokens: "本地回溯 Token（估算）", notQuota: "非订阅额度；输入含缓存 + 输出", uncached: "非缓存输入", cached: "缓存输入", output: "输出", reasoning: "推理明细", included: "已包含在输出中",
    officialGlobal: "账户级全局数据；不随任务筛选变化", dailyPeak: "历史单日峰值", latestDay: "最近完整日",
    creditsExplainA: "Credits 按模型对非缓存输入、缓存输入和输出分别加权；当前范围可计价覆盖 ", creditsExplainB: "%，曲线不会与原始 Token 等比例。", tokensExplain: "Token 曲线是从本机任务日志回溯出的细粒度估算；提示词、聊天历史、文件和工具结果会在多次模型调用中反复计入。账户总量请以 OFFICIAL 汇总为准。",
    gapRule: "空窗消耗记为 0，额度沿用最近采样", threadEvents: "个任务事件", repositoryThreads: "个仓库任务", tokenEvents: "个去重 Token 事件", quotaSamples: "个额度采样", localScan: "本地扫描", onlineQuota: "线上额度",
    noSample: "暂无", secondsAgo: "秒前", minutesAgo: "分钟前", hoursAgo: "小时前", daysAgo: "天前", now: "现在",
    quotaAria: "额度实际余量与预计耗尽轨迹；悬停可查看点位数值", currentUsage: "当前额度使用率", usedAria: "额度已使用", waitingQuota: "等待额度样本", expectedExhaustion: "预计耗尽", projectedPoint: "预测点位", actualPoint: "实际点位", remaining: "余量", used: "已用", legend: "图例", actualRemaining: "实际余量", projectedRemaining: "速度不变时的预计余量", resetJump: "实际刷新跳变", forecastMethod: "按百分比突然回到满额识别实际刷新；预测只使用最近一次实际刷新后的数据，图表仍保留刷新前窗口。",
    tokenChartAria: "Token 用量时间序列，空窗记为零", creditsChartAria: "估算 credits 消耗时间序列，空窗记为零", creditsAria: "credits 估算", officialAria: "Codex 官方账户 Token 汇总", language: "语言",
  },
  en: {
    loading: "Rebuilding deduplicated local usage…", offline: "Offline · using local history", disconnected: "Local collector is not connected",
    live: "Live quota · local tokens", fallback: "Live quota unavailable · local fallback", weeklyRemaining: "weekly quota remaining",
    plan: "Plan", scheduledReset: "Scheduled API reset", quotaSource: "Quota source", liveApi: "Live account API", localRecord: "Latest local record", observedReset: "Latest observed reset",
    quotaTitle: "Quota remaining & exhaustion forecast", forecastWindow: "Forecast lookback", insufficient: "Not enough samples to forecast", stablePrefix: "At the current rate, quota will not run out within ", stableSuffix: "", exhaustPrefix: "Estimated exhaustion: ", exhaustSuffix: "", waiting: "Waiting for quota movement", perHour: "% / hour", samples: "samples", lookback: "effective lookback",
    creditsUsed: "Estimated weekly used", creditsBudget: "Implied weekly budget", creditsRemaining: "Estimated remaining", tokenEquivalent: "Tokens at current mix", creditNoteA: "Estimated from official model weights with ", creditNoteB: " recognizable token coverage; not an official account credits balance.",
    threadUsage: "THREAD USAGE", repoUsage: "REPOSITORY USAGE", localUsage: "DEDUPED LOCAL USAGE", throughput: " processed",
    repository: "Repository", allRepositories: "All repositories", thread: "Thread", allThreads: "All threads", threads: "threads", chartMetric: "Chart metric", chartRange: "Chart time range",
    localTokens: "Local reconstructed tokens (estimate)", notQuota: "Not subscription quota; input incl. cache + output", uncached: "Uncached input", cached: "Cached input", output: "Output", reasoning: "Reasoning detail", included: "Included in output",
    officialGlobal: "Account-wide data; unaffected by thread filters", dailyPeak: "Peak day", latestDay: "Latest full day",
    creditsExplainA: "Credits weight uncached input, cached input and output by model. Rated coverage in this range: ", creditsExplainB: "%; the curve is not proportional to raw tokens.", tokensExplain: "The token curve is a fine-grained estimate reconstructed from local thread logs. Prompts, chat history, files and tool results can re-enter multiple model calls. Use the OFFICIAL account total as the source of truth.",
    gapRule: "Usage gaps are 0; quota carries the latest sample", threadEvents: "thread events", repositoryThreads: "repository threads", tokenEvents: "deduplicated token events", quotaSamples: "quota samples", localScan: "Local scan", onlineQuota: "Live quota",
    noSample: "none", secondsAgo: "s ago", minutesAgo: "m ago", hoursAgo: "h ago", daysAgo: "d ago", now: "now",
    quotaAria: "Actual quota remaining and forecast trajectory; hover for values", currentUsage: "Current quota usage", usedAria: "Quota used", waitingQuota: "Waiting for quota samples", expectedExhaustion: "est. exhaustion", projectedPoint: "Projected point", actualPoint: "Actual point", remaining: "Remaining", used: "Used", legend: "Legend", actualRemaining: "Actual remaining", projectedRemaining: "Projected remaining at constant rate", resetJump: "Observed reset", forecastMethod: "Observed resets are detected when the percentage suddenly returns to full. Forecasting uses samples after the latest observed reset while the chart retains earlier history.",
    tokenChartAria: "Token usage time series; gaps are zero", creditsChartAria: "Estimated credits time series; gaps are zero", creditsAria: "Credits estimate", officialAria: "Official Codex account token summary", language: "Language",
  },
} as const;

function apiBase() {
  if (typeof window === "undefined") return "http://127.0.0.1:8787";
  return `${window.location.protocol}//${window.location.hostname}:8787`;
}

function formatCompact(value?: number | null, digits = 2, locale: Locale = "zh") {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(digits)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(digits)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value >= 100 ? Math.round(value).toLocaleString(locale === "zh" ? "zh-CN" : "en-US") : value.toFixed(value >= 10 ? 1 : 2);
}

function formatDateTime(value?: number | null, locale: Locale = "zh") {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function formatAxisTime(value: number, range: RangeValue, locale: Locale = "zh") {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US",
    range === "24h"
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : { month: "numeric", day: "numeric" },
  ).format(value);
}

function relativeSample(value: number | null | undefined, locale: Locale) {
  const copy = COPY[locale];
  if (!value) return copy.noSample;
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}${locale === "zh" ? " " : ""}${copy.secondsAgo}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${locale === "zh" ? " " : ""}${copy.minutesAgo}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${locale === "zh" ? " " : ""}${copy.hoursAgo}`;
  return `${Math.floor(hours / 24)}${locale === "zh" ? " " : ""}${copy.daysAgo}`;
}

function linePath(points: { x: number; y: number }[]) {
  return points.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

function areaPath(points: { x: number; y: number }[], bottom: number) {
  if (!points.length) return "";
  return `${linePath(points)} L ${points.at(-1)?.x} ${bottom} L ${points[0].x} ${bottom} Z`;
}

function Gauge({ value, locale }: { value: number; locale: Locale }) {
  const safe = Math.min(100, Math.max(0, value));
  const copy = COPY[locale];
  return (
    <div className="gauge" aria-label={`${copy.usedAria} ${safe.toFixed(0)}%`}>
      <svg viewBox="0 0 240 140" role="img">
        <title>{copy.currentUsage}</title>
        <path className="gauge-track" d="M 30 120 A 90 90 0 0 1 210 120" pathLength="100" />
        <path
          className="gauge-value"
          d="M 30 120 A 90 90 0 0 1 210 120"
          pathLength="100"
          strokeDasharray={`${safe} ${100 - safe}`}
        />
      </svg>
      <div className="gauge-label"><span>WEEKLY USAGE</span></div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function QuotaProjection({ data, locale }: { data: DashboardData; locale: Locale }) {
  const [selected, setSelected] = useState<null | { ts: number; remaining: number; projected: boolean; x: number; y: number }>(null);
  const copy = COPY[locale];
  const quota = data.quotaWindow;
  if (!quota) return <div className="chart-empty">{copy.waitingQuota}</div>;

  const width = 900;
  const height = 250;
  const padding = { left: 44, right: 24, top: 24, bottom: 34 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const xFor = (ts: number) => padding.left + ((ts - quota.startAt) / Math.max(1, quota.endAt - quota.startAt)) * chartWidth;
  const yFor = (remaining: number) => padding.top + chartHeight - (remaining / 100) * chartHeight;
  const actualData = quota.points
    .filter((point) => point.actual != null)
    .map((point) => ({ ts: point.ts, remaining: 100 - (point.actual as number), projected: false }));
  const projectedData = [
    ...(data.latest ? [{ ts: quota.now, remaining: 100 - data.latest.quotaUsed, projected: true }] : []),
    ...quota.points
      .filter((point) => point.projected != null)
      .map((point) => ({ ts: point.ts, remaining: 100 - (point.projected as number), projected: true })),
  ];
  const resetBoundaries = quota.resetJumps.filter((jump) => jump.ts >= quota.startAt && jump.ts <= quota.now);
  const actualSegments = (() => {
    const segments: typeof actualData[] = [];
    let segment: typeof actualData = [];
    let cursor = 0;
    for (const jump of resetBoundaries) {
      while (cursor < actualData.length && actualData[cursor].ts < jump.ts) {
        segment.push(actualData[cursor]);
        cursor += 1;
      }
      segment.push({ ts: jump.ts, remaining: 100 - jump.fromUsed, projected: false });
      if (segment.length) segments.push(segment);
      segment = [{ ts: jump.ts, remaining: 100 - jump.toUsed, projected: false }];
      while (cursor < actualData.length && actualData[cursor].ts === jump.ts) cursor += 1;
    }
    segment.push(...actualData.slice(cursor));
    if (segment.length) segments.push(segment);
    return segments.map((points) => points.map((point) => ({ x: xFor(point.ts), y: yFor(point.remaining) })));
  })();
  const projected = projectedData.map((point) => ({ x: xFor(point.ts), y: yFor(point.remaining) }));
  const hoverPoints = [
    ...actualData,
    ...resetBoundaries.map((jump) => ({ ts: jump.ts, remaining: 100 - jump.toUsed, projected: false })),
    ...projectedData.filter((point) => !actualData.some((actualPoint) => actualPoint.ts === point.ts)),
  ].sort((a, b) => a.ts - b.ts);
  const nowX = xFor(quota.now);
  const resetJumps = quota.resetJumps.map((jump) => ({
    x: xFor(jump.ts),
    fromY: yFor(100 - jump.fromUsed),
    toY: yFor(100 - jump.toUsed),
  }));
  const exhaustAt = data.forecast.status === "ready" ? data.forecast.exhaustAt : null;
  const exhaustMarker = exhaustAt != null && exhaustAt >= quota.startAt && exhaustAt <= quota.endAt
    ? { x: xFor(exhaustAt), y: yFor(0), ts: exhaustAt }
    : null;

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!hoverPoints.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const viewX = ((event.clientX - bounds.left) / bounds.width) * width;
    const ratio = Math.min(1, Math.max(0, (viewX - padding.left) / chartWidth));
    const targetTs = quota.startAt + ratio * (quota.endAt - quota.startAt);
    const nearest = hoverPoints.reduce((best, point) =>
      Math.abs(point.ts - targetTs) < Math.abs(best.ts - targetTs) ? point : best,
    );
    setSelected({ ...nearest, x: xFor(nearest.ts), y: yFor(nearest.remaining) });
  };

  return (
    <div className="quota-chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={copy.quotaAria}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setSelected(null)}
      >
        <defs>
          <linearGradient id="quota-window-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#33e8ff" stopOpacity="0.24" />
            <stop offset="1" stopColor="#33e8ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 25, 50, 75, 100].map((value) => (
          <g key={value}>
            <line className="chart-grid" x1={padding.left} x2={width - padding.right} y1={yFor(value)} y2={yFor(value)} />
            <text className="axis-label" x={padding.left - 10} y={yFor(value) + 4} textAnchor="end">{value}%</text>
          </g>
        ))}
        {actualSegments.map((segment, index) => <path key={`area-${index}`} className="chart-area" d={areaPath(segment, padding.top + chartHeight)} fill="url(#quota-window-fill)" />)}
        {actualSegments.map((segment, index) => <path key={`line-${index}`} className="chart-line quota" d={linePath(segment)} />)}
        {resetJumps.map((jump, index) => <line key={index} className="reset-jump" x1={jump.x} x2={jump.x} y1={jump.fromY} y2={jump.toY} />)}
        {projected.length > 1 ? <path className="forecast-line" d={linePath(projected)} /> : null}
        {selected ? (
          <g className="quota-hover-marker">
            <line x1={selected.x} x2={selected.x} y1={padding.top} y2={padding.top + chartHeight} />
            <circle cx={selected.x} cy={selected.y} r="4.5" />
          </g>
        ) : null}
        {exhaustMarker ? (
          <g className="exhaust-marker">
            <circle cx={exhaustMarker.x} cy={exhaustMarker.y} r="5" />
            <text
              x={exhaustMarker.x + (exhaustMarker.x > width - 180 ? -10 : 10)}
              y={exhaustMarker.y - 12}
              textAnchor={exhaustMarker.x > width - 180 ? "end" : "start"}
            >0% · {copy.expectedExhaustion} {formatDateTime(exhaustMarker.ts, locale)}</text>
          </g>
        ) : null}
        <line className="now-line" x1={nowX} x2={nowX} y1={padding.top} y2={padding.top + chartHeight} />
        <text className="axis-label" x={padding.left} y={height - 7}>{formatDateTime(quota.startAt, locale)}</text>
        <text className="axis-label axis-center" x={nowX} y={height - 7}>{copy.now}</text>
        <text className="axis-label axis-end" x={width - padding.right} y={height - 7}>{formatDateTime(quota.endAt, locale)}</text>
      </svg>
      {selected ? (
        <div
          className="chart-tooltip quota-tooltip"
          style={{
            left: `${Math.min(84, Math.max(16, (selected.x / width) * 100))}%`,
            top: `${Math.min(66, Math.max(8, (selected.y / height) * 100 - 12))}%`,
          }}
        >
          <span>{selected.projected ? copy.projectedPoint : copy.actualPoint} · {formatDateTime(selected.ts, locale)}</span>
          <strong>{copy.remaining} {selected.remaining.toFixed(1)}%</strong>
          <small>{copy.used} {(100 - selected.remaining).toFixed(1)}%</small>
        </div>
      ) : null}
      <div className="chart-legend" aria-label={copy.legend}>
        <span><i className="legend-line actual" /> {copy.actualRemaining}</span>
        <span><i className="legend-line projected" /> {copy.projectedRemaining}</span>
        {resetJumps.length ? <span><i className="legend-line reset" /> {copy.resetJump}</span> : null}
      </div>
      <p className="forecast-method">{copy.forecastMethod}</p>
    </div>
  );
}

function UsageChart({ data, range, metric, locale }: { data: SeriesPoint[]; range: RangeValue; metric: ChartMetric; locale: Locale }) {
  const [selected, setSelected] = useState<number | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const width = 1200;
  const height = 330;
  const padding = { left: 18, right: 18, top: 26, bottom: 34 };
  const values = data.map((point) => metric === "tokens" ? point.tokenTotal : point.creditsUsed);
  const maxValue = Math.max(1, ...values) * 1.15;
  const minTs = data[0]?.ts ?? 0;
  const maxTs = data.at(-1)?.ts ?? 1;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const xFor = (ts: number) => padding.left + ((ts - minTs) / Math.max(1, maxTs - minTs)) * chartWidth;
  const yFor = (value: number) => padding.top + chartHeight - (value / maxValue) * chartHeight;
  const points = data.map((point, index) => ({ x: xFor(point.ts), y: yFor(values[index]) }));
  const selectedPoint = selected == null ? null : data[selected];
  const selectedValue = selected == null ? null : values[selected];

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!frame.current || !data.length) return;
    const bounds = frame.current.getBoundingClientRect();
    const viewX = ((event.clientX - bounds.left) / bounds.width) * width;
    const ratio = Math.min(1, Math.max(0, (viewX - padding.left) / chartWidth));
    setSelected(Math.round(ratio * (data.length - 1)));
  };

  return (
    <div className="chart-frame token" ref={frame} onPointerMove={onPointerMove} onPointerLeave={() => setSelected(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={metric === "tokens" ? COPY[locale].tokenChartAria : COPY[locale].creditsChartAria}>
        <defs>
          <linearGradient id="usage-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#a879ff" stopOpacity="0.3" />
            <stop offset="1" stopColor="#a879ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.33, 0.66, 1].map((ratio) => {
          const y = padding.top + ratio * chartHeight;
          return <line key={ratio} className="chart-grid" x1={padding.left} y1={y} x2={width - padding.right} y2={y} />;
        })}
        <path className="chart-area" d={areaPath(points, padding.top + chartHeight)} fill="url(#usage-area)" />
        <path className="chart-line token" d={linePath(points)} />
        {selected != null ? <line className="chart-cursor" x1={points[selected]?.x} x2={points[selected]?.x} y1={padding.top} y2={padding.top + chartHeight} /> : null}
        <text className="axis-label" x={padding.left} y={height - 7}>{formatAxisTime(minTs, range, locale)}</text>
        <text className="axis-label axis-center" x={width / 2} y={height - 7}>{formatAxisTime((minTs + maxTs) / 2, range, locale)}</text>
        <text className="axis-label axis-end" x={width - padding.right} y={height - 7}>{formatAxisTime(maxTs, range, locale)}</text>
      </svg>
      {selectedPoint ? (
        <div className="chart-tooltip" style={{ left: `${Math.min(82, Math.max(18, (points[selected ?? 0]?.x / width) * 100))}%` }}>
          <span>{formatDateTime(selectedPoint.ts, locale)}</span>
          <strong>{metric === "tokens" ? `${formatCompact(selectedValue, 2, locale)} tokens` : `${formatCompact(selectedValue, 2, locale)} credits`}</strong>
        </div>
      ) : null}
    </div>
  );
}

function demoDashboard(range: RangeValue, forecastWindow: ForecastWindow): DashboardData {
  const now = Date.now();
  const duration = range === "24h" ? 24 * 3_600_000 : range === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
  const bucket = range === "24h" ? 5 * 60_000 : range === "7d" ? 30 * 60_000 : 2 * 3_600_000;
  const count = Math.ceil(duration / bucket);
  const series = Array.from({ length: count }, (_, index) => {
    const active = (index * 17) % 29 < 7;
    const pulse = active ? 280_000 + ((index * 97_531) % 1_400_000) : 0;
    return {
      ts: now - duration + index * bucket,
      tokenTotal: pulse,
      inputTokens: pulse * 0.82,
      cachedInputTokens: pulse * 0.57,
      outputTokens: pulse * 0.18,
      reasoningTokens: pulse * 0.06,
      creditsUsed: pulse / 1_000_000 * 42,
      quotaUsed: null,
      resetAt: null,
    };
  });
  const visible = forecastWindow === "6h" ? 6 * 3_600_000 : forecastWindow === "72h" ? 72 * 3_600_000 : 24 * 3_600_000;
  const quotaPoints = Array.from({ length: 181 }, (_, index) => {
    const ts = now - visible + index * (2 * visible / 180);
    const actual = ts <= now ? Math.max(6, 8 + ((ts - (now - visible)) / visible) * 34) : null;
    const projected = ts >= now ? Math.min(100, 42 + ((ts - now) / 3_600_000) * 1.35) : null;
    return { ts, actual, projected };
  });
  return {
    generatedAt: now,
    range,
    retentionDays: 30,
    series,
    totals: { input: 31_500_000, cached: 22_800_000, output: 6_900_000, reasoning: 2_100_000, total: 38_400_000, credits: 1_284, rated_tokens: 36_900_000 },
    scope: {
      selectedThread: "all",
      selectedRepository: "all",
      repositories: [
        { key: "demo-repo", label: "/Users/alex/Projects/codex-meter-demo", threadCount: 3, totalTokens: 28_100_000, credits: 910, lastAt: now - 12 * 60_000 },
        { key: "demo-api", label: "acme/edge-api", threadCount: 2, totalTokens: 10_300_000, credits: 374, lastAt: now - 92 * 60_000 },
      ],
      threads: [
        { key: "demo-thread-1", threadId: "demo-1", title: "Fix quota reset trajectory", repositoryKey: "demo-repo", repositoryLabel: "/Users/alex/Projects/codex-meter-demo", firstAt: now - 8 * 3_600_000, lastAt: now - 12 * 60_000, eventCount: 184, totalTokens: 12_800_000, credits: 421 },
        { key: "demo-thread-2", threadId: "demo-2", title: "Add bilingual dashboard", repositoryKey: "demo-repo", repositoryLabel: "/Users/alex/Projects/codex-meter-demo", firstAt: now - 20 * 3_600_000, lastAt: now - 2 * 3_600_000, eventCount: 142, totalTokens: 9_600_000, credits: 302 },
        { key: "demo-thread-3", threadId: "demo-3", title: "Improve collector recovery", repositoryKey: "demo-repo", repositoryLabel: "/Users/alex/Projects/codex-meter-demo", firstAt: now - 22 * 3_600_000, lastAt: now - 4 * 3_600_000, eventCount: 96, totalTokens: 5_700_000, credits: 187 },
      ],
    },
    credits: { rangeCredits: 1_284, currentWindowCredits: 1_284, impliedBudgetCredits: 3_057, remainingCredits: 1_773, mixedRemainingTokens: 53_020_000, coverage: 0.96, rangeCoverage: 0.96, cacheHitRate: 0.72 },
    latest: { sampleAt: now, quotaUsed: 42, remaining: 58, windowMinutes: 10_080, resetAt: now + 3 * 86_400_000, observedResetAt: now - 4 * 86_400_000, source: "live", planType: "pro", creditsBalance: null, resetCredits: 1 },
    forecast: { status: "ready", window: forecastWindow, confidence: "high", ratePerHour: 1.35, exhaustAt: now + 42.96 * 3_600_000, withinWindow: forecastWindow === "72h", sampleCount: 61, spanHours: Math.min(24, visible / 3_600_000), baselineAt: now, baselineUsed: 42, lastObservedResetAt: now - 4 * 86_400_000 },
    quotaWindow: { startAt: now - visible, now, endAt: now + visible, resetJumps: [], points: quotaPoints },
    accountUsage: { sampleAt: now, lifetimeTokens: 482_600_000, peakDailyTokens: 46_300_000, longestRunningTurnSec: 812, currentStreakDays: 9, longestStreakDays: 21, daily: [{ day: "2026-07-17", tokens: 31_800_000 }] },
    collector: { running: true, scanning: false, lastScanAt: now - 8_000, lastError: null, importedThisRun: 422, sampleCount: 1_842, quotaSampleCount: 1_105, lastLiveAt: now - 12_000, lastLiveError: null, live: true },
  };
}

export default function Home() {
  const [locale, setLocale] = useState<Locale>("zh");
  const [range, setRange] = useState<RangeValue>("24h");
  const [forecastWindow, setForecastWindow] = useState<ForecastWindow>("24h");
  const [chartMetric, setChartMetric] = useState<ChartMetric>("tokens");
  const [repositoryKey, setRepositoryKey] = useState("all");
  const [threadKey, setThreadKey] = useState("all");
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState(false);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const copy = COPY[locale];

  useEffect(() => {
    const restoreLocale = window.setTimeout(() => {
      const saved = window.localStorage.getItem("codex-meter-locale");
      if (saved === "zh" || saved === "en") setLocale(saved);
    }, 0);
    return () => window.clearTimeout(restoreLocale);
  }, []);

  const changeLocale = (next: Locale) => {
    setLocale(next);
    window.localStorage.setItem("codex-meter-locale", next);
  };

  const load = useCallback(async () => {
    try {
      if (window.location.search.includes("demo=1")) {
        setData(demoDashboard(range, forecastWindow));
        setError(false);
        setLoading(false);
        return;
      }
      const query = new URLSearchParams({ range, forecast: forecastWindow });
      if (repositoryKey !== "all") query.set("repository", repositoryKey);
      if (threadKey !== "all") query.set("thread", threadKey);
      const response = await fetch(`${apiBase()}/api/dashboard?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as DashboardData;
      setData(payload);
      if (payload.scope.selectedRepository !== repositoryKey) setRepositoryKey(payload.scope.selectedRepository);
      if (payload.scope.selectedThread !== threadKey) setThreadKey(payload.scope.selectedThread);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [range, forecastWindow, repositoryKey, threadKey]);

  useEffect(() => {
    const initialStatus = window.setTimeout(() => setOnline(navigator.onLine), 0);
    const handleOnline = () => { setOnline(true); load(); };
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.clearTimeout(initialStatus);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [load]);

  useEffect(() => {
    const initial = window.setTimeout(load, 0);
    const timer = window.setInterval(load, 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  const forecastText = useMemo(() => {
    if (!data || data.forecast.status === "insufficient") return copy.insufficient;
    if (data.forecast.status === "stable") return `${copy.stablePrefix}${data.forecast.window?.toUpperCase() ?? RANGE_LABELS[locale]["24h"]}${copy.stableSuffix}`;
    return `${copy.exhaustPrefix}${formatDateTime(data.forecast.exhaustAt, locale)}${copy.exhaustSuffix}`;
  }, [copy, data, locale]);

  const status = !online
    ? { className: "offline", text: copy.offline }
    : error
      ? { className: "error", text: copy.disconnected }
      : data?.collector.live
        ? { className: "online", text: copy.live }
        : { className: "offline", text: copy.fallback };

  const used = data?.latest?.quotaUsed ?? 0;
  const remaining = data?.latest?.remaining ?? 100;
  const uncachedInput = Math.max(0, (data?.totals.input ?? 0) - (data?.totals.cached ?? 0));
  const coverage = (data?.credits.coverage ?? 0) * 100;
  const latestOfficialDay = data?.accountUsage?.daily.at(-1);
  const selectedThread = data?.scope.threads.find((thread) => thread.key === data.scope.selectedThread) ?? null;
  const selectedRepository = data?.scope.repositories.find((repository) => repository.key === data.scope.selectedRepository) ?? null;
  const visibleThreads = data?.scope.threads.filter((thread) => repositoryKey === "all" || thread.repositoryKey === repositoryKey) ?? [];

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true" />
          <div><p className="eyebrow">LOCAL TELEMETRY</p><h1>Codex Meter</h1></div>
        </div>
        <div className="topbar-actions">
          <Segmented<Locale>
            label={copy.language}
            value={locale}
            onChange={changeLocale}
            options={[{ value: "zh", label: "中文" }, { value: "en", label: "EN" }]}
          />
          <div className={`status-pill ${status.className}`}><span aria-hidden="true" />{status.text}</div>
        </div>
      </header>

      {loading && !data ? (
        <section className="loading-state" aria-live="polite">{copy.loading}</section>
      ) : (
        <>
          <section className="quota-panel" aria-labelledby="quota-title">
            <div className="quota-summary">
              <Gauge value={used} locale={locale} />
              <div className="quota-copy">
                <p className="section-kicker cyan">AUTHORITATIVE QUOTA</p>
                <div className="quota-number"><strong>{used.toFixed(0)}</strong><span>%</span></div>
                <p className="remaining"><b>{remaining.toFixed(0)}%</b> {copy.weeklyRemaining}</p>
                <dl className="quota-meta">
                  <div><dt>{copy.plan}</dt><dd>{data?.latest?.planType?.toUpperCase() ?? "—"}</dd></div>
                  <div><dt>{copy.scheduledReset}</dt><dd>{formatDateTime(data?.latest?.resetAt, locale)}</dd></div>
                  <div><dt>{copy.quotaSource}</dt><dd>{data?.latest?.source === "live" ? copy.liveApi : copy.localRecord}</dd></div>
                  <div><dt>Full reset</dt><dd>{data?.latest?.resetCredits ?? "—"}</dd></div>
                  <div><dt>{copy.observedReset}</dt><dd>{formatDateTime(data?.latest?.observedResetAt, locale)}</dd></div>
                </dl>
              </div>
            </div>

            <div className="quota-forecast">
              <div className="panel-heading compact">
                <div>
                  <p className="section-kicker cyan">REMAINING TRAJECTORY</p>
                  <h2 id="quota-title">{copy.quotaTitle}</h2>
                </div>
                <Segmented<ForecastWindow>
                  label={copy.forecastWindow}
                  value={forecastWindow}
                  onChange={setForecastWindow}
                  options={[{ value: "6h", label: "6H" }, { value: "24h", label: "24H" }, { value: "72h", label: "72H" }]}
                />
              </div>
              <div className="forecast-summary">
                <strong>{forecastText}</strong>
                <span>
                  {data?.forecast.ratePerHour != null ? `${data.forecast.ratePerHour.toFixed(2)}${copy.perHour}` : copy.waiting}
                  {data?.forecast.confidence ? ` · ${CONFIDENCE_LABELS[locale][data.forecast.confidence]}` : ""}
                  {data?.forecast.sampleCount ? ` · ${data.forecast.sampleCount} ${copy.samples}` : ""}
                  {data?.forecast.spanHours != null ? ` · ${copy.lookback} ${data.forecast.spanHours.toFixed(1)}h` : ""}
                </span>
              </div>
              {data ? <QuotaProjection data={data} locale={locale} /> : null}
            </div>
          </section>

          <section className="credit-strip" aria-label={copy.creditsAria}>
            <div><span>{copy.creditsUsed}</span><strong>{formatCompact(data?.credits.currentWindowCredits, 2, locale)} credits</strong></div>
            <div><span>{copy.creditsBudget}</span><strong>{formatCompact(data?.credits.impliedBudgetCredits, 2, locale)} credits</strong></div>
            <div><span>{copy.creditsRemaining}</span><strong>{formatCompact(data?.credits.remainingCredits, 2, locale)} credits</strong></div>
            <div><span>{copy.tokenEquivalent}</span><strong>{formatCompact(data?.credits.mixedRemainingTokens, 2, locale)} tokens</strong></div>
            <p>{copy.creditNoteA} {coverage.toFixed(0)}% {copy.creditNoteB}</p>
          </section>

          <section className="token-panel" aria-labelledby="token-title">
            <div className="panel-heading">
              <div>
                <p className="section-kicker violet">{selectedThread ? copy.threadUsage : selectedRepository ? copy.repoUsage : copy.localUsage}</p>
                <h2 id="token-title">
                  {RANGE_LABELS[locale][range]}{copy.throughput}
                  {selectedThread ? ` · ${selectedThread.title}` : selectedRepository ? ` · ${selectedRepository.label}` : ""}
                </h2>
              </div>
              <div className="panel-actions">
                <label className="session-filter repository-filter">
                  <span>{copy.repository}</span>
                  <select
                    value={repositoryKey}
                    onChange={(event) => {
                      setRepositoryKey(event.target.value);
                      setThreadKey("all");
                    }}
                  >
                    <option value="all">{copy.allRepositories}</option>
                    {data?.scope.repositories.map((repository) => (
                      <option key={repository.key} value={repository.key}>
                        {repository.label} · {repository.threadCount} {copy.threads}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="session-filter">
                  <span>{copy.thread}</span>
                  <select value={threadKey} onChange={(event) => setThreadKey(event.target.value)}>
                    <option value="all">{copy.allThreads}</option>
                    {visibleThreads.map((thread) => (
                      <option key={thread.key} value={thread.key}>
                        {thread.title} · {thread.repositoryLabel} · {formatCompact(thread.totalTokens, 2, locale)}
                      </option>
                    ))}
                  </select>
                </label>
                <Segmented<ChartMetric>
                  label={copy.chartMetric}
                  value={chartMetric}
                  onChange={setChartMetric}
                  options={[{ value: "tokens", label: "TOKENS" }, { value: "credits", label: "CREDITS" }]}
                />
                <Segmented<RangeValue>
                  label={copy.chartRange}
                  value={range}
                  onChange={setRange}
                  options={[{ value: "24h", label: "24H" }, { value: "7d", label: "7D" }, { value: "30d", label: "30D" }]}
                />
              </div>
            </div>

            <dl className="token-stats">
              <div className="primary-stat"><dt>{copy.localTokens}</dt><dd>{formatCompact(data?.totals.total, 2, locale)}</dd><small>{copy.notQuota}</small></div>
              <div><dt>{copy.uncached}</dt><dd>{formatCompact(uncachedInput, 2, locale)}</dd></div>
              <div><dt>{copy.cached}</dt><dd>{formatCompact(data?.totals.cached, 2, locale)}</dd></div>
              <div><dt>{copy.output}</dt><dd>{formatCompact(data?.totals.output, 2, locale)}</dd></div>
              <div><dt>{copy.reasoning}</dt><dd>{formatCompact(data?.totals.reasoning, 2, locale)}</dd><small>{copy.included}</small></div>
            </dl>

            <section className="official-token-strip" aria-label={copy.officialAria}>
              <div className="official-token-heading">
                <span>CODEX ACCOUNT USAGE · OFFICIAL</span>
                <small>{copy.officialGlobal}</small>
              </div>
              <div><span>Lifetime</span><strong>{formatCompact(data?.accountUsage?.lifetimeTokens, 2, locale)}</strong></div>
              <div><span>{copy.dailyPeak}</span><strong>{formatCompact(data?.accountUsage?.peakDailyTokens, 2, locale)}</strong></div>
              <div><span>{copy.latestDay}</span><strong>{latestOfficialDay ? `${latestOfficialDay.day} · ${formatCompact(latestOfficialDay.tokens, 2, locale)}` : "—"}</strong></div>
            </section>

            <UsageChart data={data?.series ?? []} range={range} metric={chartMetric} locale={locale} />

            <p className="metric-explainer">
              {chartMetric === "credits"
                ? `${copy.creditsExplainA}${((data?.credits.rangeCoverage ?? 0) * 100).toFixed(0)}${copy.creditsExplainB}`
                : copy.tokensExplain}
            </p>

            <footer className="data-footer">
              <span>{copy.gapRule}</span>
              <span>
                {selectedThread
                  ? `${selectedThread.eventCount.toLocaleString(locale === "zh" ? "zh-CN" : "en-US")} ${copy.threadEvents}`
                  : selectedRepository
                    ? `${selectedRepository.threadCount.toLocaleString(locale === "zh" ? "zh-CN" : "en-US")} ${copy.repositoryThreads}`
                    : `${data?.collector.sampleCount.toLocaleString(locale === "zh" ? "zh-CN" : "en-US") ?? 0} ${copy.tokenEvents}`}
              </span>
              <span>{data?.collector.quotaSampleCount.toLocaleString(locale === "zh" ? "zh-CN" : "en-US") ?? 0} {copy.quotaSamples}</span>
              <span>{copy.localScan} {relativeSample(data?.collector.lastScanAt, locale)}</span>
              <span>{copy.onlineQuota} {relativeSample(data?.collector.lastLiveAt, locale)}</span>
            </footer>
          </section>
        </>
      )}
    </main>
  );
}
