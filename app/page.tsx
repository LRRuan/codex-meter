"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type RangeValue = "24h" | "7d" | "30d";
type ForecastWindow = "6h" | "24h" | "72h";
type ChartMetric = "tokens" | "credits";
type Confidence = "low" | "medium" | "high";

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
    selectedSession: string;
    selectedRepository: string;
    repositories: {
      key: string;
      label: string;
      sessionCount: number;
      totalTokens: number;
      credits: number;
      lastAt: number;
    }[];
    sessions: {
      key: string;
      sessionId: string;
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

const RANGE_LABELS: Record<RangeValue, string> = {
  "24h": "24 小时",
  "7d": "7 天",
  "30d": "30 天",
};

const CONFIDENCE_LABELS: Record<Confidence, string> = {
  low: "低置信度",
  medium: "中置信度",
  high: "高置信度",
};

function apiBase() {
  if (typeof window === "undefined") return "http://127.0.0.1:8787";
  return `${window.location.protocol}//${window.location.hostname}:8787`;
}

function formatCompact(value?: number | null, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(digits)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(digits)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value >= 100 ? Math.round(value).toLocaleString("zh-CN") : value.toFixed(value >= 10 ? 1 : 2);
}

function formatDateTime(value?: number | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function formatAxisTime(value: number, range: RangeValue) {
  return new Intl.DateTimeFormat("zh-CN",
    range === "24h"
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : { month: "numeric", day: "numeric" },
  ).format(value);
}

function relativeSample(value?: number | null) {
  if (!value) return "暂无";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function linePath(points: { x: number; y: number }[]) {
  return points.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

function areaPath(points: { x: number; y: number }[], bottom: number) {
  if (!points.length) return "";
  return `${linePath(points)} L ${points.at(-1)?.x} ${bottom} L ${points[0].x} ${bottom} Z`;
}

function Gauge({ value }: { value: number }) {
  const safe = Math.min(100, Math.max(0, value));
  return (
    <div className="gauge" aria-label={`额度已使用 ${safe.toFixed(0)}%`}>
      <svg viewBox="0 0 240 140" role="img">
        <title>当前额度使用率</title>
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

function QuotaProjection({ data }: { data: DashboardData }) {
  const [selected, setSelected] = useState<null | { ts: number; remaining: number; projected: boolean; x: number; y: number }>(null);
  const quota = data.quotaWindow;
  if (!quota) return <div className="chart-empty">等待额度样本</div>;

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
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
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
        aria-label="额度实际余量与预计耗尽轨迹；悬停可查看点位数值"
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
            >0% · 预计耗尽 {formatDateTime(exhaustMarker.ts)}</text>
          </g>
        ) : null}
        <line className="now-line" x1={nowX} x2={nowX} y1={padding.top} y2={padding.top + chartHeight} />
        <text className="axis-label" x={padding.left} y={height - 7}>{formatDateTime(quota.startAt)}</text>
        <text className="axis-label axis-center" x={nowX} y={height - 7}>现在</text>
        <text className="axis-label axis-end" x={width - padding.right} y={height - 7}>{formatDateTime(quota.endAt)}</text>
      </svg>
      {selected ? (
        <div
          className="chart-tooltip quota-tooltip"
          style={{
            left: `${Math.min(84, Math.max(16, (selected.x / width) * 100))}%`,
            top: `${Math.min(66, Math.max(8, (selected.y / height) * 100 - 12))}%`,
          }}
        >
          <span>{selected.projected ? "预测点位" : "实际点位"} · {formatDateTime(selected.ts)}</span>
          <strong>余量 {selected.remaining.toFixed(1)}%</strong>
          <small>已用 {(100 - selected.remaining).toFixed(1)}%</small>
        </div>
      ) : null}
      <div className="chart-legend" aria-label="图例">
        <span><i className="legend-line actual" /> 实际余量</span>
        <span><i className="legend-line projected" /> 速度不变时的预计余量</span>
        {resetJumps.length ? <span><i className="legend-line reset" /> 实际刷新跳变</span> : null}
      </div>
      <p className="forecast-method">按百分比突然回到满额识别实际刷新；预测只使用最近一次实际刷新后的数据，图表仍保留刷新前窗口。</p>
    </div>
  );
}

function UsageChart({ data, range, metric }: { data: SeriesPoint[]; range: RangeValue; metric: ChartMetric }) {
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
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    setSelected(Math.round(ratio * (data.length - 1)));
  };

  return (
    <div className="chart-frame token" ref={frame} onPointerMove={onPointerMove} onPointerLeave={() => setSelected(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={metric === "tokens" ? "Token 用量时间序列，空窗记为零" : "估算 credits 消耗时间序列，空窗记为零"}>
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
        <text className="axis-label" x={padding.left} y={height - 7}>{formatAxisTime(minTs, range)}</text>
        <text className="axis-label axis-center" x={width / 2} y={height - 7}>{formatAxisTime((minTs + maxTs) / 2, range)}</text>
        <text className="axis-label axis-end" x={width - padding.right} y={height - 7}>{formatAxisTime(maxTs, range)}</text>
      </svg>
      {selectedPoint ? (
        <div className="chart-tooltip" style={{ left: `${Math.min(82, Math.max(18, (points[selected ?? 0]?.x / width) * 100))}%` }}>
          <span>{formatDateTime(selectedPoint.ts)}</span>
          <strong>{metric === "tokens" ? `${formatCompact(selectedValue)} tokens` : `${formatCompact(selectedValue)} credits`}</strong>
        </div>
      ) : null}
    </div>
  );
}

export default function Home() {
  const [range, setRange] = useState<RangeValue>("24h");
  const [forecastWindow, setForecastWindow] = useState<ForecastWindow>("24h");
  const [chartMetric, setChartMetric] = useState<ChartMetric>("tokens");
  const [repositoryKey, setRepositoryKey] = useState("all");
  const [sessionKey, setSessionKey] = useState("all");
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ range, forecast: forecastWindow });
      if (repositoryKey !== "all") query.set("repository", repositoryKey);
      if (sessionKey !== "all") query.set("session", sessionKey);
      const response = await fetch(`${apiBase()}/api/dashboard?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as DashboardData;
      setData(payload);
      if (payload.scope.selectedRepository !== repositoryKey) setRepositoryKey(payload.scope.selectedRepository);
      if (payload.scope.selectedSession !== sessionKey) setSessionKey(payload.scope.selectedSession);
      setError(null);
    } catch {
      setError("本地采集服务未连接");
    } finally {
      setLoading(false);
    }
  }, [range, forecastWindow, repositoryKey, sessionKey]);

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
    if (!data || data.forecast.status === "insufficient") return "样本不足，暂不预测";
    if (data.forecast.status === "stable") return `按当前速度，${data.forecast.window?.toUpperCase() ?? "当前窗口"} 内不会耗尽`;
    return `预计 ${formatDateTime(data.forecast.exhaustAt)} 耗尽`;
  }, [data]);

  const status = !online
    ? { className: "offline", text: "当前离线 · 使用本地回溯" }
    : error
      ? { className: "error", text: error }
      : data?.collector.live
        ? { className: "online", text: "线上额度 · 本地 Token" }
        : { className: "offline", text: "线上额度暂不可用 · 本地回退" };

  const used = data?.latest?.quotaUsed ?? 0;
  const remaining = data?.latest?.remaining ?? 100;
  const uncachedInput = Math.max(0, (data?.totals.input ?? 0) - (data?.totals.cached ?? 0));
  const coverage = (data?.credits.coverage ?? 0) * 100;
  const latestOfficialDay = data?.accountUsage?.daily.at(-1);
  const selectedSession = data?.scope.sessions.find((session) => session.key === data.scope.selectedSession) ?? null;
  const selectedRepository = data?.scope.repositories.find((repository) => repository.key === data.scope.selectedRepository) ?? null;
  const visibleSessions = data?.scope.sessions.filter((session) => repositoryKey === "all" || session.repositoryKey === repositoryKey) ?? [];

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true" />
          <div><p className="eyebrow">LOCAL TELEMETRY</p><h1>Codex Meter</h1></div>
        </div>
        <div className={`status-pill ${status.className}`}><span aria-hidden="true" />{status.text}</div>
      </header>

      {loading && !data ? (
        <section className="loading-state" aria-live="polite">正在重建去重后的本地用量…</section>
      ) : (
        <>
          <section className="quota-panel" aria-labelledby="quota-title">
            <div className="quota-summary">
              <Gauge value={used} />
              <div className="quota-copy">
                <p className="section-kicker cyan">AUTHORITATIVE QUOTA</p>
                <div className="quota-number"><strong>{used.toFixed(0)}</strong><span>%</span></div>
                <p className="remaining"><b>{remaining.toFixed(0)}%</b> 本周额度剩余</p>
                <dl className="quota-meta">
                  <div><dt>计划</dt><dd>{data?.latest?.planType?.toUpperCase() ?? "—"}</dd></div>
                  <div><dt>接口计划刷新</dt><dd>{formatDateTime(data?.latest?.resetAt)}</dd></div>
                  <div><dt>额度来源</dt><dd>{data?.latest?.source === "live" ? "线上实时接口" : "本地最近记录"}</dd></div>
                  <div><dt>Full reset</dt><dd>{data?.latest?.resetCredits ?? "—"}</dd></div>
                  <div><dt>最近实际刷新</dt><dd>{formatDateTime(data?.latest?.observedResetAt)}</dd></div>
                </dl>
              </div>
            </div>

            <div className="quota-forecast">
              <div className="panel-heading compact">
                <div>
                  <p className="section-kicker cyan">REMAINING TRAJECTORY</p>
                  <h2 id="quota-title">额度余量与耗尽预测</h2>
                </div>
                <Segmented<ForecastWindow>
                  label="预测观察窗口"
                  value={forecastWindow}
                  onChange={setForecastWindow}
                  options={[{ value: "6h", label: "6H" }, { value: "24h", label: "24H" }, { value: "72h", label: "72H" }]}
                />
              </div>
              <div className="forecast-summary">
                <strong>{forecastText}</strong>
                <span>
                  {data?.forecast.ratePerHour != null ? `${data.forecast.ratePerHour.toFixed(2)}% / 小时` : "等待额度变化"}
                  {data?.forecast.confidence ? ` · ${CONFIDENCE_LABELS[data.forecast.confidence]}` : ""}
                  {data?.forecast.sampleCount ? ` · ${data.forecast.sampleCount} 个采样` : ""}
                  {data?.forecast.spanHours != null ? ` · 有效回看 ${data.forecast.spanHours.toFixed(1)}h` : ""}
                </span>
              </div>
              {data ? <QuotaProjection data={data} /> : null}
            </div>
          </section>

          <section className="credit-strip" aria-label="credits 估算">
            <div><span>本周估算已用</span><strong>{formatCompact(data?.credits.currentWindowCredits)} credits</strong></div>
            <div><span>推算本周总额度</span><strong>{formatCompact(data?.credits.impliedBudgetCredits)} credits</strong></div>
            <div><span>估算剩余</span><strong>{formatCompact(data?.credits.remainingCredits)} credits</strong></div>
            <div><span>按当前结构约剩</span><strong>{formatCompact(data?.credits.mixedRemainingTokens)} tokens</strong></div>
            <p>基于官方模型权重与当前 {coverage.toFixed(0)}% 可识别 Token 推算，并非账户返回的官方 credits 余额。</p>
          </section>

          <section className="token-panel" aria-labelledby="token-title">
            <div className="panel-heading">
              <div>
                <p className="section-kicker violet">{selectedSession ? "SESSION USAGE" : selectedRepository ? "REPOSITORY USAGE" : "DEDUPED LOCAL USAGE"}</p>
                <h2 id="token-title">
                  {RANGE_LABELS[range]}处理量
                  {selectedSession ? ` · ${selectedSession.title}` : selectedRepository ? ` · ${selectedRepository.label}` : ""}
                </h2>
              </div>
              <div className="panel-actions">
                <label className="session-filter repository-filter">
                  <span>仓库</span>
                  <select
                    value={repositoryKey}
                    onChange={(event) => {
                      setRepositoryKey(event.target.value);
                      setSessionKey("all");
                    }}
                  >
                    <option value="all">全部仓库</option>
                    {data?.scope.repositories.map((repository) => (
                      <option key={repository.key} value={repository.key}>
                        {repository.label} · {repository.sessionCount} sessions
                      </option>
                    ))}
                  </select>
                </label>
                <label className="session-filter">
                  <span>SESSION</span>
                  <select value={sessionKey} onChange={(event) => setSessionKey(event.target.value)}>
                    <option value="all">全部 Session</option>
                    {visibleSessions.map((session) => (
                      <option key={session.key} value={session.key}>
                        {session.title} · {session.repositoryLabel} · {formatCompact(session.totalTokens)}
                      </option>
                    ))}
                  </select>
                </label>
                <Segmented<ChartMetric>
                  label="图表指标"
                  value={chartMetric}
                  onChange={setChartMetric}
                  options={[{ value: "tokens", label: "TOKENS" }, { value: "credits", label: "CREDITS" }]}
                />
                <Segmented<RangeValue>
                  label="图表时间范围"
                  value={range}
                  onChange={setRange}
                  options={[{ value: "24h", label: "24H" }, { value: "7d", label: "7D" }, { value: "30d", label: "30D" }]}
                />
              </div>
            </div>

            <dl className="token-stats">
              <div className="primary-stat"><dt>本地回溯 Token（估算）</dt><dd>{formatCompact(data?.totals.total)}</dd><small>非订阅额度；输入含缓存 + 输出</small></div>
              <div><dt>非缓存输入</dt><dd>{formatCompact(uncachedInput)}</dd></div>
              <div><dt>缓存输入</dt><dd>{formatCompact(data?.totals.cached)}</dd></div>
              <div><dt>输出</dt><dd>{formatCompact(data?.totals.output)}</dd></div>
              <div><dt>推理明细</dt><dd>{formatCompact(data?.totals.reasoning)}</dd><small>已包含在输出中</small></div>
            </dl>

            <section className="official-token-strip" aria-label="Codex 官方账户 Token 汇总">
              <div className="official-token-heading">
                <span>CODEX ACCOUNT USAGE · OFFICIAL</span>
                <small>账户级全局数据；不随 Session 筛选变化</small>
              </div>
              <div><span>Lifetime</span><strong>{formatCompact(data?.accountUsage?.lifetimeTokens)}</strong></div>
              <div><span>历史单日峰值</span><strong>{formatCompact(data?.accountUsage?.peakDailyTokens)}</strong></div>
              <div><span>最近完整日</span><strong>{latestOfficialDay ? `${latestOfficialDay.day} · ${formatCompact(latestOfficialDay.tokens)}` : "—"}</strong></div>
            </section>

            <UsageChart data={data?.series ?? []} range={range} metric={chartMetric} />

            <p className="metric-explainer">
              {chartMetric === "credits"
                ? `Credits 按模型对非缓存输入、缓存输入和输出分别加权；当前范围可计价覆盖 ${((data?.credits.rangeCoverage ?? 0) * 100).toFixed(0)}%，曲线不会与原始 Token 等比例。`
                : "Token 曲线是从本机会话日志回溯出的细粒度估算；提示词、聊天历史、文件和工具结果会在多次模型调用中反复计入。账户总量请以 OFFICIAL 汇总为准。"}
            </p>

            <footer className="data-footer">
              <span>空窗消耗记为 0，额度沿用最近采样</span>
              <span>
                {selectedSession
                  ? `${selectedSession.eventCount.toLocaleString("zh-CN")} 个 Session 事件`
                  : selectedRepository
                    ? `${selectedRepository.sessionCount.toLocaleString("zh-CN")} 个仓库 Session`
                    : `${data?.collector.sampleCount.toLocaleString("zh-CN") ?? 0} 个去重 Token 事件`}
              </span>
              <span>{data?.collector.quotaSampleCount.toLocaleString("zh-CN") ?? 0} 个额度采样</span>
              <span>本地扫描 {relativeSample(data?.collector.lastScanAt)}</span>
              <span>线上额度 {relativeSample(data?.collector.lastLiveAt)}</span>
            </footer>
          </section>
        </>
      )}
    </main>
  );
}
