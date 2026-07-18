import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.CODEX_METER_PORT ?? 8787);
const HOST = process.env.CODEX_METER_HOST ?? "127.0.0.1";
const POLL_MS = Number(process.env.CODEX_METER_POLL_MS ?? 15_000);
const LIVE_POLL_MS = Number(process.env.CODEX_METER_LIVE_POLL_MS ?? 60_000);
const QUOTA_RETENTION_DAYS = 30;
const QUOTA_RETENTION_MS = QUOTA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const SCHEMA_VERSION = "5";
const USAGE_INDEX_VERSION = "lifetime-v1";
const CODEX_HOME = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const DB_PATH = resolve(process.env.CODEX_METER_DB ?? join(process.cwd(), ".data", "codex-meter.sqlite"));

function latestStateDatabasePath() {
  if (!existsSync(CODEX_HOME)) return null;
  return readdirSync(CODEX_HOME)
    .filter((file) => /^state_\d+\.sqlite$/.test(file))
    .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))
    .map((file) => join(CODEX_HOME, file))[0] ?? null;
}

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("CREATE TABLE IF NOT EXISTS meter_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");

let codexStateDb = null;
try {
  const statePath = latestStateDatabasePath();
  if (statePath) codexStateDb = new DatabaseSync(statePath, { readOnly: true });
} catch {
  codexStateDb = null;
}

const storedVersion = db.prepare("SELECT value FROM meter_meta WHERE key = 'schema_version'").get()?.value;
if (storedVersion !== SCHEMA_VERSION) {
  db.exec("DROP TABLE IF EXISTS usage_events");
  db.exec("DROP TABLE IF EXISTS quota_samples");
  db.exec("DROP TABLE IF EXISTS file_state");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    source_file TEXT NOT NULL,
    model TEXT,
    service_tier TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_credits REAL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS usage_events_ts_idx ON usage_events(ts);
  CREATE TABLE IF NOT EXISTS quota_samples (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    used_percent REAL NOT NULL,
    window_minutes INTEGER NOT NULL,
    resets_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    plan_type TEXT,
    credits_balance TEXT,
    reset_credits INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS quota_samples_ts_idx ON quota_samples(ts);
  CREATE INDEX IF NOT EXISTS quota_samples_reset_idx ON quota_samples(resets_at, ts);
  CREATE TABLE IF NOT EXISTS account_usage_daily (
    day TEXT PRIMARY KEY,
    tokens INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS account_usage_summary (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sample_at INTEGER NOT NULL,
    lifetime_tokens INTEGER,
    peak_daily_tokens INTEGER,
    longest_running_turn_sec INTEGER,
    current_streak_days INTEGER,
    longest_streak_days INTEGER
  ) STRICT;
  CREATE TABLE IF NOT EXISTS file_state (
    path TEXT PRIMARY KEY,
    offset INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    current_model TEXT,
    service_tier TEXT,
    cumulative_input INTEGER NOT NULL DEFAULT 0,
    cumulative_cached INTEGER NOT NULL DEFAULT 0,
    cumulative_output INTEGER NOT NULL DEFAULT 0,
    cumulative_reasoning INTEGER NOT NULL DEFAULT 0,
    cumulative_total INTEGER NOT NULL DEFAULT 0
  ) STRICT;
`);
db.prepare(`
  INSERT INTO meter_meta(key, value) VALUES ('schema_version', ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(SCHEMA_VERSION);

const storedUsageIndexVersion = db.prepare("SELECT value FROM meter_meta WHERE key = 'usage_index_version'").get()?.value;
if (storedUsageIndexVersion !== USAGE_INDEX_VERSION) {
  // Token rows and offsets are derived indexes. Rebuild them once so upgrades from
  // the old 30-day policy recover every event still present in local Codex logs.
  db.exec("DELETE FROM usage_events; DELETE FROM file_state;");
  db.prepare(`
    INSERT INTO meter_meta(key, value) VALUES ('usage_index_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(USAGE_INDEX_VERSION);
}

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO usage_events (
    id, ts, source_file, model, service_tier, input_tokens, cached_input_tokens,
    output_tokens, reasoning_tokens, total_tokens, estimated_credits
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertQuota = db.prepare(`
  INSERT OR IGNORE INTO quota_samples (
    id, ts, used_percent, window_minutes, resets_at, source,
    plan_type, credits_balance, reset_credits
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const upsertAccountDay = db.prepare(`
  INSERT INTO account_usage_daily(day, tokens, synced_at) VALUES (?, ?, ?)
  ON CONFLICT(day) DO UPDATE SET tokens = excluded.tokens, synced_at = excluded.synced_at
`);
const upsertAccountSummary = db.prepare(`
  INSERT INTO account_usage_summary(
    id, sample_at, lifetime_tokens, peak_daily_tokens, longest_running_turn_sec,
    current_streak_days, longest_streak_days
  ) VALUES (1, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    sample_at = excluded.sample_at,
    lifetime_tokens = excluded.lifetime_tokens,
    peak_daily_tokens = excluded.peak_daily_tokens,
    longest_running_turn_sec = excluded.longest_running_turn_sec,
    current_streak_days = excluded.current_streak_days,
    longest_streak_days = excluded.longest_streak_days
`);
const readState = db.prepare("SELECT * FROM file_state WHERE path = ?");
const writeState = db.prepare(`
  INSERT INTO file_state(
    path, offset, size, mtime_ms, current_model, service_tier,
    cumulative_input, cumulative_cached, cumulative_output,
    cumulative_reasoning, cumulative_total
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET
    offset = excluded.offset,
    size = excluded.size,
    mtime_ms = excluded.mtime_ms,
    current_model = excluded.current_model,
    service_tier = excluded.service_tier,
    cumulative_input = excluded.cumulative_input,
    cumulative_cached = excluded.cumulative_cached,
    cumulative_output = excluded.cumulative_output,
    cumulative_reasoning = excluded.cumulative_reasoning,
    cumulative_total = excluded.cumulative_total
`);
const purgeQuota = db.prepare("DELETE FROM quota_samples WHERE ts < ?");

let scanInProgress = false;
let lastScanAt = 0;
let lastScanError = null;
let importedThisRun = 0;
let livePollInProgress = false;
let lastLiveAt = 0;
let lastLiveError = null;
let liveBackoffMs = LIVE_POLL_MS;
let liveTimer = null;

const CREDIT_RATES = {
  "gpt-5.6-sol": [125, 12.5, 750],
  "gpt-5.6-terra": [62.5, 6.25, 375],
  "gpt-5.6-luna": [25, 2.5, 150],
  "gpt-5.5": [125, 12.5, 750],
  "gpt-5.4": [62.5, 6.25, 375],
  "gpt-5.4-mini": [18.75, 1.875, 113],
};

function estimateCredits(model, input, cached, output) {
  const rates = CREDIT_RATES[model];
  if (!rates) return null;
  const uncached = Math.max(0, input - cached);
  return (uncached * rates[0] + cached * rates[1] + output * rates[2]) / 1_000_000;
}

function hashId(...parts) {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function walkJsonl(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  return files;
}

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readCumulative(usage) {
  return {
    input: number(usage?.input_tokens),
    cached: number(usage?.cached_input_tokens),
    output: number(usage?.output_tokens),
    reasoning: number(usage?.reasoning_output_tokens),
    total: number(usage?.total_tokens),
  };
}

function deltaUsage(state, payload) {
  const cumulative = readCumulative(payload.info?.total_token_usage);
  const last = readCumulative(payload.info?.last_token_usage);
  const previous = {
    input: state.cumulativeInput,
    cached: state.cumulativeCached,
    output: state.cumulativeOutput,
    reasoning: state.cumulativeReasoning,
    total: state.cumulativeTotal,
  };

  let delta;
  if (previous.total > 0 && cumulative.total === previous.total) {
    delta = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
  } else if (
    previous.total > 0 &&
    cumulative.total > previous.total &&
    cumulative.input >= previous.input &&
    cumulative.cached >= previous.cached &&
    cumulative.output >= previous.output &&
    cumulative.reasoning >= previous.reasoning
  ) {
    delta = {
      input: cumulative.input - previous.input,
      cached: cumulative.cached - previous.cached,
      output: cumulative.output - previous.output,
      reasoning: cumulative.reasoning - previous.reasoning,
      total: cumulative.total - previous.total,
    };
  } else {
    delta = last;
  }

  state.cumulativeInput = cumulative.input;
  state.cumulativeCached = cumulative.cached;
  state.cumulativeOutput = cumulative.output;
  state.cumulativeReasoning = cumulative.reasoning;
  state.cumulativeTotal = cumulative.total;
  return { delta, cumulative };
}

function ingestLine(line, sourceFile, state) {
  if (!line.includes('"turn_context"') && !line.includes('"token_count"')) return 0;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return 0;
  }

  if (entry.type === "turn_context") {
    state.currentModel = entry.payload?.model ?? state.currentModel;
    state.serviceTier = entry.payload?.service_tier ?? state.serviceTier;
    return 0;
  }

  if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") return 0;
  const ts = Date.parse(entry.timestamp);
  if (!Number.isFinite(ts)) return 0;

  const payload = entry.payload;
  const { delta, cumulative } = deltaUsage(state, payload);
  let imported = 0;
  if (delta.total > 0) {
    const credits = estimateCredits(state.currentModel, delta.input, delta.cached, delta.output);
    const result = insertEvent.run(
      hashId(
        "usage-v3",
        cumulative.input,
        cumulative.cached,
        cumulative.output,
        cumulative.reasoning,
        cumulative.total,
        delta.input,
        delta.cached,
        delta.output,
        delta.reasoning,
        delta.total,
      ),
      ts,
      sourceFile,
      state.currentModel,
      state.serviceTier,
      delta.input,
      delta.cached,
      delta.output,
      delta.reasoning,
      delta.total,
      credits,
    );
    imported += Number(result.changes);
  }

  const rate = payload.rate_limits?.primary;
  if (ts >= Date.now() - QUOTA_RETENTION_MS && rate && Number.isFinite(Number(rate.used_percent))) {
    insertQuota.run(
      hashId(
        "quota-log-v2",
        rate.used_percent,
        rate.window_minutes,
        rate.resets_at,
        payload.rate_limits?.plan_type,
      ),
      ts,
      Number(rate.used_percent),
      Number(rate.window_minutes),
      Number(rate.resets_at) * 1000,
      "log",
      payload.rate_limits?.plan_type ?? null,
      payload.rate_limits?.credits?.balance ?? null,
      null,
    );
  }
  return imported;
}

function stateFromRow(row) {
  return {
    offset: number(row?.offset),
    currentModel: row?.current_model ?? null,
    serviceTier: row?.service_tier ?? null,
    cumulativeInput: number(row?.cumulative_input),
    cumulativeCached: number(row?.cumulative_cached),
    cumulativeOutput: number(row?.cumulative_output),
    cumulativeReasoning: number(row?.cumulative_reasoning),
    cumulativeTotal: number(row?.cumulative_total),
  };
}

async function processFile(path) {
  const stats = statSync(path);
  const row = readState.get(path);
  const state = stateFromRow(row);
  if (stats.size < state.offset) Object.assign(state, stateFromRow(null));
  if (stats.size === state.offset) return 0;

  let pending = Buffer.alloc(0);
  let imported = 0;
  for await (const chunk of createReadStream(path, { start: state.offset })) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      const lineBuffer = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      imported += ingestLine(lineBuffer.toString("utf8"), path, state);
    }
  }

  state.offset = stats.size - pending.length;
  writeState.run(
    path,
    state.offset,
    stats.size,
    Math.round(stats.mtimeMs),
    state.currentModel,
    state.serviceTier,
    state.cumulativeInput,
    state.cumulativeCached,
    state.cumulativeOutput,
    state.cumulativeReasoning,
    state.cumulativeTotal,
  );
  return imported;
}

async function scan() {
  if (scanInProgress) return;
  scanInProgress = true;
  lastScanError = null;
  try {
    const quotaCutoff = Date.now() - QUOTA_RETENTION_MS;
    const roots = [join(CODEX_HOME, "sessions"), join(CODEX_HOME, "archived_sessions")];
    const files = roots.flatMap(walkJsonl).sort();
    let imported = 0;
    for (const file of files) imported += await processFile(file);
    importedThisRun += imported;
    purgeQuota.run(quotaCutoff);
    lastScanAt = Date.now();
  } catch (error) {
    lastScanError = error instanceof Error ? error.message : String(error);
  } finally {
    scanInProgress = false;
  }
}

function readLiveAccountSnapshot() {
  return new Promise((resolveResult, reject) => {
    const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    let settled = false;
    const results = { rateLimits: null, accountUsage: null };
    let responses = 0;
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolveResult(result);
    };
    const timer = setTimeout(() => finish(new Error("live quota request timed out")), 12_000);
    child.on("error", finish);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 0 && message.result) {
          send({ method: "initialized", params: {} });
          send({ method: "account/rateLimits/read", id: 2 });
          send({ method: "account/usage/read", id: 3 });
        } else if (message.id === 2 || message.id === 3) {
          responses += 1;
          if (message.id === 2 && !message.error) results.rateLimits = message.result;
          if (message.id === 3 && !message.error) results.accountUsage = message.result;
          if (responses === 2) {
            if (!results.rateLimits) finish(new Error(message.error?.message ?? "live quota request failed"));
            else finish(null, results);
          }
        }
      }
    });
    send({
      method: "initialize",
      id: 0,
      params: { clientInfo: { name: "codex_meter", title: "Codex Meter", version: "0.5.0" } },
    });
  });
}

async function pollLiveQuota() {
  if (livePollInProgress) return;
  livePollInProgress = true;
  try {
    const snapshot = await readLiveAccountSnapshot();
    const result = snapshot.rateLimits;
    const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
    const primary = bucket?.primary;
    if (!primary) throw new Error("live quota response had no Codex bucket");
    const ts = Date.now();
    insertQuota.run(
      hashId("live", ts, primary.usedPercent, primary.resetsAt),
      ts,
      Number(primary.usedPercent),
      Number(primary.windowDurationMins),
      Number(primary.resetsAt) * 1000,
      "live",
      bucket.planType ?? null,
      bucket.credits?.balance ?? null,
      Number(result?.rateLimitResetCredits?.availableCount ?? 0),
    );
    if (snapshot.accountUsage?.summary) {
      const summary = snapshot.accountUsage.summary;
      upsertAccountSummary.run(
        ts,
        summary.lifetimeTokens ?? null,
        summary.peakDailyTokens ?? null,
        summary.longestRunningTurnSec ?? null,
        summary.currentStreakDays ?? null,
        summary.longestStreakDays ?? null,
      );
      for (const day of snapshot.accountUsage.dailyUsageBuckets ?? []) {
        upsertAccountDay.run(day.startDate, Number(day.tokens), ts);
      }
    }
    lastLiveAt = ts;
    lastLiveError = null;
    liveBackoffMs = LIVE_POLL_MS;
  } catch (error) {
    lastLiveError = error instanceof Error ? error.message : String(error);
    liveBackoffMs = Math.min(15 * 60_000, Math.max(LIVE_POLL_MS, liveBackoffMs * 2));
  } finally {
    livePollInProgress = false;
    liveTimer = setTimeout(pollLiveQuota, lastLiveError ? liveBackoffMs : LIVE_POLL_MS);
    liveTimer.unref();
  }
}

function rangeConfig(value, from = 0, to = 0) {
  if (value === "24h") return { duration: 24 * 60 * 60_000, bucket: 5 * 60_000 };
  if (value === "7d") return { duration: 7 * 24 * 60 * 60_000, bucket: 30 * 60_000 };
  if (value === "30d") return { duration: 30 * 24 * 60 * 60_000, bucket: 2 * 60 * 60_000 };
  const span = Math.max(5 * 60_000, to - from);
  const bucket = Math.max(5 * 60_000, Math.ceil(span / 480 / (5 * 60_000)) * 5 * 60_000);
  return { duration: span, bucket };
}

function forecastWindowMs(value) {
  if (value === "6h") return 6 * 60 * 60_000;
  if (value === "72h") return 72 * 60 * 60_000;
  return 24 * 60 * 60_000;
}

function usageFilter(sourceFiles) {
  const clauses = [];
  const params = [];
  if (sourceFiles != null) {
    if (!sourceFiles.length) clauses.push("0");
    else {
      clauses.push(`source_file IN (${sourceFiles.map(() => "?").join(", ")})`);
      params.push(...sourceFiles);
    }
  }
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

function aggregateUsage(from, to, bucketMs, sourceFiles = null) {
  const count = Math.max(1, Math.ceil((to - from) / bucketMs));
  const buckets = Array.from({ length: count }, (_, index) => ({
    ts: from + index * bucketMs,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    credits: 0,
  }));
  const filter = usageFilter(sourceFiles);
  const usageRows = db.prepare(`
    SELECT ts, input_tokens, cached_input_tokens, output_tokens,
      reasoning_tokens, total_tokens, estimated_credits
    FROM usage_events WHERE ts >= ? AND ts <= ?${filter.sql} ORDER BY ts ASC
  `).all(from, to, ...filter.params);
  for (const row of usageRows) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((row.ts - from) / bucketMs)));
    const bucket = buckets[index];
    bucket.input += row.input_tokens;
    bucket.cached += row.cached_input_tokens;
    bucket.output += row.output_tokens;
    bucket.reasoning += row.reasoning_tokens;
    bucket.total += row.total_tokens;
    bucket.credits += row.estimated_credits ?? 0;
  }

  const quotaRows = db.prepare(`
    SELECT ts, used_percent, resets_at FROM quota_samples
    WHERE ts >= ? AND ts <= ? ORDER BY ts ASC
  `).all(from, to);
  const previousQuota = db.prepare(`
    SELECT used_percent, resets_at FROM quota_samples WHERE ts < ? ORDER BY ts DESC LIMIT 1
  `).get(from);
  let quotaCursor = 0;
  let carriedQuota = previousQuota?.used_percent ?? null;
  let carriedReset = previousQuota?.resets_at ?? null;

  return buckets.map((bucket) => {
    const bucketEnd = bucket.ts + bucketMs;
    while (quotaCursor < quotaRows.length && quotaRows[quotaCursor].ts < bucketEnd) {
      carriedQuota = quotaRows[quotaCursor].used_percent;
      carriedReset = quotaRows[quotaCursor].resets_at;
      quotaCursor += 1;
    }
    return {
      ts: bucket.ts,
      tokenTotal: bucket.total,
      inputTokens: bucket.input,
      cachedInputTokens: bucket.cached,
      outputTokens: bucket.output,
      reasoningTokens: bucket.reasoning,
      creditsUsed: bucket.credits,
      quotaUsed: carriedQuota,
      resetAt: carriedReset,
    };
  });
}

function observedQuotaHistory(from, to) {
  const raw = db.prepare(`
    SELECT ts, used_percent FROM quota_samples
    WHERE ts >= ? AND ts <= ? ORDER BY ts ASC
  `).all(from, to);
  const previous = db.prepare(`
    SELECT ts, used_percent FROM quota_samples
    WHERE ts < ? ORDER BY ts DESC LIMIT 1
  `).get(from);
  if (!raw.length && !previous) return { samples: [], resets: [] };

  let carried = previous?.used_percent ?? raw[0].used_percent;
  let lastResetAt = null;
  const samples = [{ ts: from, used_percent: carried }];
  const resets = [];
  for (const row of raw) {
    const isObservedReset = row.used_percent <= 5 && carried - row.used_percent >= 10;
    const isLikelyStalePreReset = lastResetAt && row.ts - lastResetAt < 10 * 60_000 && row.used_percent - carried >= 20;
    if (isObservedReset) {
      resets.push({ ts: row.ts, fromUsed: carried, toUsed: row.used_percent });
      carried = row.used_percent;
      lastResetAt = row.ts;
      samples.push({ ts: row.ts, used_percent: carried });
    } else if (!isLikelyStalePreReset && row.used_percent >= carried) {
      carried = row.used_percent;
      samples.push({ ts: row.ts, used_percent: carried });
    }
  }
  return { samples, resets };
}

function normalizedQuotaSamples(samples, from, to) {
  if (!samples.length) return [];
  let cursor = 0;
  let carried = samples[0].used_percent;
  while (cursor < samples.length && samples[cursor].ts <= from) {
    carried = samples[cursor].used_percent;
    cursor += 1;
  }
  const points = [];
  for (let ts = from; ts <= to; ts += 60_000) {
    while (cursor < samples.length && samples[cursor].ts <= ts) {
      carried = samples[cursor].used_percent;
      cursor += 1;
    }
    points.push({ ts, used_percent: carried });
  }
  if (points.at(-1)?.ts < to) points.push({ ts: to, used_percent: carried });
  return points;
}

function calculateForecast(latest, windowValue) {
  if (!latest || latest.used_percent == null) return { status: "insufficient", confidence: "low" };
  const now = Date.now();
  const windowMs = forecastWindowMs(windowValue);
  const from = now - windowMs;
  const history = observedQuotaHistory(from, latest.ts);
  const lastReset = history.resets.at(-1);
  const regressionFrom = Math.max(from, lastReset?.ts ?? from);
  const rows = normalizedQuotaSamples(history.samples, regressionFrom, latest.ts);
  const uniqueValues = new Set(rows.map((row) => row.used_percent));
  const spanHours = rows.length > 1 ? (rows.at(-1).ts - rows[0].ts) / 3_600_000 : 0;
  if (rows.length < 3 || uniqueValues.size < 2 || spanHours < 1 / 6) {
    return { status: "insufficient", window: windowValue, confidence: "low", sampleCount: rows.length, spanHours, lastObservedResetAt: lastReset?.ts ?? null };
  }

  const origin = rows[0].ts;
  const points = rows.map((row) => ({ x: (row.ts - origin) / 3_600_000, y: row.used_percent }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const numerator = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const ratePerHour = denominator > 0 ? Math.max(0, numerator / denominator) : 0;
  const last = rows.at(-1);
  const confidence = spanHours >= 6 && uniqueValues.size >= 6 ? "high" : spanHours >= 1 && uniqueValues.size >= 4 ? "medium" : "low";
  if (ratePerHour <= 0.01) {
    return { status: "stable", window: windowValue, confidence, ratePerHour: 0, withinWindow: false, sampleCount: rows.length, spanHours, lastObservedResetAt: lastReset?.ts ?? null };
  }

  const exhaustAt = last.ts + ((100 - last.used_percent) / ratePerHour) * 3_600_000;
  return {
    status: "ready",
    window: windowValue,
    confidence,
    ratePerHour,
    baselineAt: last.ts,
    baselineUsed: last.used_percent,
    exhaustAt,
    withinWindow: exhaustAt <= now + windowMs,
    lastObservedResetAt: lastReset?.ts ?? null,
    sampleCount: rows.length,
    spanHours,
  };
}

function buildQuotaWindow(latest, forecast) {
  if (!latest) return null;
  const now = Date.now();
  const visibleWindow = forecastWindowMs(forecast.window ?? "24h");
  const startAt = now - visibleWindow;
  const endAt = now + visibleWindow;
  const pointCount = 181;
  const step = (endAt - startAt) / (pointCount - 1);
  const history = observedQuotaHistory(startAt, now);
  const rows = history.samples;
  let cursor = 0;
  let carried = rows[0]?.used_percent ?? latest.used_percent;
  const points = [];
  for (let index = 0; index < pointCount; index += 1) {
    const ts = startAt + index * step;
    while (cursor < rows.length && rows[cursor].ts <= ts) {
      carried = rows[cursor].used_percent;
      cursor += 1;
    }
    const actual = ts <= now ? carried : null;
    let projected = null;
    if (ts >= now && forecast.status === "ready") {
      projected = Math.min(100, forecast.baselineUsed + forecast.ratePerHour * ((ts - forecast.baselineAt) / 3_600_000));
    }
    points.push({ ts, actual, projected });
  }
  return { startAt, now, endAt, resetJumps: history.resets, points };
}

function totalsForRange(from, sourceFiles = null) {
  const filter = usageFilter(sourceFiles);
  return db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS input,
      COALESCE(SUM(cached_input_tokens), 0) AS cached,
      COALESCE(SUM(output_tokens), 0) AS output,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
      COALESCE(SUM(total_tokens), 0) AS total,
      COALESCE(SUM(estimated_credits), 0) AS credits,
      COALESCE(SUM(CASE WHEN estimated_credits IS NOT NULL THEN total_tokens ELSE 0 END), 0) AS rated_tokens
    FROM usage_events WHERE ts >= ?${filter.sql}
  `).get(from, ...filter.params);
}

function earliestUsageAt(sourceFiles = null) {
  const filter = usageFilter(sourceFiles);
  return db.prepare(`
    SELECT MIN(ts) AS ts FROM usage_events WHERE 1 = 1${filter.sql}
  `).get(...filter.params)?.ts ?? null;
}

function threadIdFromPath(sourceFile) {
  const file = basename(sourceFile, ".jsonl");
  const match = file.match(/([0-9a-f]{8}-[0-9a-f-]{27})$/i);
  return match?.[1] ?? hashId("thread-id", sourceFile).slice(0, 12);
}

let threadMetadataCachedAt = 0;
let threadMetadataCache = new Map();

function threadMetadataByPath() {
  if (!codexStateDb) return threadMetadataCache;
  if (Date.now() - threadMetadataCachedAt < 15_000) return threadMetadataCache;
  try {
    const rows = codexStateDb.prepare(`
      SELECT id, rollout_path, title, first_user_message, cwd, git_origin_url, source, created_at_ms FROM threads
    `).all();
    threadMetadataCache = new Map(rows.map((row) => [row.rollout_path, row]));
    threadMetadataCachedAt = Date.now();
  } catch {
    // Keep the last readable snapshot while Codex rotates or locks its state DB.
  }
  return threadMetadataCache;
}

function readableTitle(value, fallback) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? `${text.slice(0, 76)}${text.length > 76 ? "…" : ""}` : fallback;
}

function remoteRepository(origin) {
  if (!origin) return null;
  const value = String(origin).trim();
  try {
    const url = new URL(value);
    const slug = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    if (!slug) return null;
    return { identity: `remote:${url.hostname.toLowerCase()}/${slug.toLowerCase()}`, label: slug };
  } catch {
    const match = value.match(/^(?:[^@]+@)?([^:]+):(.+?)(?:\.git)?$/);
    if (!match) return null;
    const slug = match[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return { identity: `remote:${match[1].toLowerCase()}/${slug.toLowerCase()}`, label: slug };
  }
}

function repositoryDescriptor(metadata) {
  const remote = remoteRepository(metadata?.git_origin_url);
  if (remote) return { key: hashId("repository-v1", remote.identity).slice(0, 16), label: remote.label, remote: true };
  const cwd = String(metadata?.cwd ?? "").trim();
  let repositoryPath = cwd ? resolve(cwd) : "";
  if (repositoryPath) {
    let cursor = repositoryPath;
    for (;;) {
      if (existsSync(join(cursor, ".git"))) {
        repositoryPath = cursor;
        break;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  const identity = repositoryPath ? `local:${repositoryPath}` : "local:unknown";
  return {
    key: hashId("repository-v2", identity).slice(0, 16),
    label: repositoryPath || "Unknown repository",
    remote: false,
  };
}

function subagentParentId(thread) {
  if (!thread?.source?.startsWith("{")) return null;
  try {
    return JSON.parse(thread.source)?.subagent?.thread_spawn?.parent_thread_id ?? null;
  } catch {
    return null;
  }
}

function rootThreadMetadata(thread, metadataById) {
  let current = thread;
  const visited = new Set();
  while (current) {
    const parentId = subagentParentId(current);
    if (!parentId || visited.has(parentId)) return current;
    const parent = metadataById.get(parentId);
    if (!parent) return current;
    visited.add(parentId);
    current = parent;
  }
  return thread;
}

function threadOptions(from) {
  const metadata = threadMetadataByPath();
  const metadataById = new Map([...metadata.values()].filter((thread) => thread.id).map((thread) => [thread.id, thread]));
  const rows = db.prepare(`
    SELECT source_file, MIN(ts) AS first_at, MAX(ts) AS last_at,
      COUNT(*) AS event_count, COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(estimated_credits), 0) AS credits
    FROM usage_events WHERE ts >= ?
    GROUP BY source_file ORDER BY last_at DESC
  `).all(from);
  const grouped = new Map();

  for (const row of rows) {
    const sourceMetadata = metadata.get(row.source_file);
    const rootMetadata = rootThreadMetadata(sourceMetadata, metadataById);
    const rootSourceFile = rootMetadata?.rollout_path ?? row.source_file;
    const threadId = rootMetadata?.id ?? threadIdFromPath(rootSourceFile);
    const repository = repositoryDescriptor(rootMetadata ?? sourceMetadata);
    const current = grouped.get(rootSourceFile) ?? {
      key: hashId("thread-key-v1", rootSourceFile).slice(0, 16),
      threadId,
      title: readableTitle(rootMetadata?.title || rootMetadata?.first_user_message, `Thread · ${threadId.slice(-6)}`),
      repositoryKey: repository.key,
      repositoryLabel: repository.label,
      firstAt: Math.min(row.first_at, Number(rootMetadata?.created_at_ms) || row.first_at),
      lastAt: row.last_at,
      eventCount: 0,
      totalTokens: 0,
      credits: 0,
      sourceFiles: new Set(),
      subagentSourceFiles: new Set(),
      subagentTokens: 0,
    };
    const isSubagent = Boolean(sourceMetadata && rootMetadata && sourceMetadata.id !== rootMetadata.id);
    current.firstAt = Math.min(current.firstAt, row.first_at);
    current.lastAt = Math.max(current.lastAt, row.last_at);
    current.eventCount += row.event_count;
    current.totalTokens += row.total_tokens;
    current.credits += row.credits;
    current.sourceFiles.add(row.source_file);
    if (isSubagent) {
      current.subagentSourceFiles.add(row.source_file);
      current.subagentTokens += row.total_tokens;
    }
    grouped.set(rootSourceFile, current);
  }

  return [...grouped.values()]
    .map((thread) => ({
      ...thread,
      sourceFiles: [...thread.sourceFiles],
      subagentSourceFiles: [...thread.subagentSourceFiles],
    }))
    .sort((a, b) => b.lastAt - a.lastAt);
}

function repositoryOptions(threads) {
  const repositories = new Map();
  for (const thread of threads) {
    const current = repositories.get(thread.repositoryKey) ?? {
      key: thread.repositoryKey,
      label: thread.repositoryLabel,
      threadCount: 0,
      totalTokens: 0,
      credits: 0,
      lastAt: 0,
    };
    current.threadCount += 1;
    current.totalTokens += thread.totalTokens;
    current.credits += thread.credits;
    current.lastAt = Math.max(current.lastAt, thread.lastAt);
    repositories.set(thread.repositoryKey, current);
  }
  return [...repositories.values()].sort((a, b) => b.lastAt - a.lastAt);
}

function creditEstimate(latest, rangeTotals, observedResetAt) {
  if (!latest) return { rangeCredits: rangeTotals.credits, coverage: 0 };
  const windowStart = observedResetAt ?? latest.resets_at - latest.window_minutes * 60_000;
  const current = totalsForRange(windowStart);
  const coverage = current.total > 0 ? current.rated_tokens / current.total : 0;
  const usedFraction = latest.used_percent / 100;
  const impliedBudget = usedFraction >= 0.03 && current.credits > 0 ? current.credits / usedFraction : null;
  const remainingCredits = impliedBudget == null ? null : Math.max(0, impliedBudget - current.credits);
  const creditsPerMillionRaw = current.total > 0 ? (current.credits / current.total) * 1_000_000 : null;
  const mixedRemainingTokens = remainingCredits != null && creditsPerMillionRaw > 0
    ? (remainingCredits / creditsPerMillionRaw) * 1_000_000
    : null;
  return {
    rangeCredits: rangeTotals.credits,
    currentWindowCredits: current.credits,
    impliedBudgetCredits: impliedBudget,
    remainingCredits,
    mixedRemainingTokens,
    coverage,
    rangeCoverage: rangeTotals.total > 0 ? rangeTotals.rated_tokens / rangeTotals.total : 0,
    cacheHitRate: current.input > 0 ? current.cached / current.input : 0,
  };
}

function dashboardPayload(rangeValue, forecastWindow, requestedThreadKey = null, requestedRepositoryKey = null) {
  const now = Date.now();
  const earliestGlobalUsageAt = earliestUsageAt();
  const threads = threadOptions(earliestGlobalUsageAt ?? now);
  const repositories = repositoryOptions(threads);
  const selectedThread = threads.find((thread) => thread.key === requestedThreadKey) ?? null;
  const selectedRepository = repositories.find((repository) => repository.key === (selectedThread?.repositoryKey ?? requestedRepositoryKey)) ?? null;
  const selectedSourceFiles = selectedThread
    ? selectedThread.sourceFiles
    : selectedRepository
      ? threads.filter((thread) => thread.repositoryKey === selectedRepository.key).flatMap((thread) => thread.sourceFiles)
      : null;
  const taskHistoryStartAt = selectedThread
    ? selectedThread.firstAt
    : selectedRepository
      ? Math.min(...threads.filter((thread) => thread.repositoryKey === selectedRepository.key).map((thread) => thread.firstAt))
      : threads.length
        ? Math.min(...threads.map((thread) => thread.firstAt))
        : null;
  const tokenHistoryStartAt = taskHistoryStartAt ?? earliestUsageAt(selectedSourceFiles) ?? earliestGlobalUsageAt ?? now;
  const fixedRange = rangeConfig(rangeValue);
  const from = rangeValue === "all" ? tokenHistoryStartAt : now - fixedRange.duration;
  const { bucket } = rangeConfig(rangeValue, from, now);
  const latest = db.prepare(`
    SELECT * FROM quota_samples ORDER BY ts DESC LIMIT 1
  `).get();
  const observedReset = latest ? observedQuotaHistory(now - QUOTA_RETENTION_MS, latest.ts).resets.at(-1) : null;
  const totals = totalsForRange(from, selectedSourceFiles);
  const selectedThreadSubagentTokens = selectedThread
    ? totalsForRange(from, selectedThread.subagentSourceFiles).total
    : null;
  const forecast = calculateForecast(latest, forecastWindow);
  const sampleCount = db.prepare("SELECT COUNT(*) AS count FROM usage_events").get().count;
  const quotaSampleCount = db.prepare("SELECT COUNT(*) AS count FROM quota_samples").get().count;
  const accountUsageSummary = db.prepare("SELECT * FROM account_usage_summary WHERE id = 1").get();
  const accountUsageDays = db.prepare("SELECT day, tokens FROM account_usage_daily ORDER BY day DESC LIMIT 30").all().reverse();

  return {
    generatedAt: now,
    range: rangeValue,
    tokenHistoryStartAt,
    quotaRetentionDays: QUOTA_RETENTION_DAYS,
    series: aggregateUsage(from, now, bucket, selectedSourceFiles),
    totals,
    scope: {
      selectedThread: selectedThread?.key ?? "all",
      selectedThreadSubagentTokens,
      selectedRepository: selectedRepository?.key ?? "all",
      repositories,
      threads: threads.map((thread) => ({
        key: thread.key,
        threadId: thread.threadId,
        title: thread.title,
        repositoryKey: thread.repositoryKey,
        repositoryLabel: thread.repositoryLabel,
        firstAt: thread.firstAt,
        lastAt: thread.lastAt,
        eventCount: thread.eventCount,
        totalTokens: thread.totalTokens,
        credits: thread.credits,
      })),
    },
    credits: creditEstimate(latest, totals, observedReset?.ts ?? null),
    latest: latest
      ? {
          sampleAt: latest.ts,
          quotaUsed: latest.used_percent,
          remaining: Math.max(0, 100 - latest.used_percent),
          windowMinutes: latest.window_minutes,
          resetAt: latest.resets_at,
          observedResetAt: observedReset?.ts ?? null,
          source: latest.source,
          planType: latest.plan_type,
          creditsBalance: latest.credits_balance,
          resetCredits: latest.reset_credits,
        }
      : null,
    forecast,
    quotaWindow: buildQuotaWindow(latest, forecast),
    accountUsage: accountUsageSummary
      ? {
          sampleAt: accountUsageSummary.sample_at,
          lifetimeTokens: accountUsageSummary.lifetime_tokens,
          peakDailyTokens: accountUsageSummary.peak_daily_tokens,
          longestRunningTurnSec: accountUsageSummary.longest_running_turn_sec,
          currentStreakDays: accountUsageSummary.current_streak_days,
          longestStreakDays: accountUsageSummary.longest_streak_days,
          daily: accountUsageDays,
        }
      : null,
    collector: {
      running: true,
      scanning: scanInProgress,
      lastScanAt,
      lastError: lastScanError,
      importedThisRun,
      sampleCount,
      quotaSampleCount,
      lastLiveAt,
      lastLiveError,
      live: Boolean(lastLiveAt && now - lastLiveAt < Math.max(180_000, LIVE_POLL_MS * 3)),
    },
  };
}

function loopbackOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return null;
  try {
    const hostname = new URL(origin).hostname;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname) ? origin : null;
  } catch {
    return null;
  }
}

function sendJson(request, response, status, body) {
  const origin = loopbackOrigin(request);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  });
  response.end(status === 204 ? undefined : JSON.stringify(body));
}

const server = createServer((request, response) => {
  if (request.method === "OPTIONS") return sendJson(request, response, 204, {});
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const requestedRange = url.searchParams.get("range");
    const requestedForecast = url.searchParams.get("forecast");
    const requestedThread = url.searchParams.get("thread") ?? url.searchParams.get("session");
    const requestedRepository = url.searchParams.get("repository");
    const range = ["24h", "7d", "30d", "all"].includes(requestedRange) ? requestedRange : "24h";
    const forecastWindow = ["6h", "24h", "72h"].includes(requestedForecast) ? requestedForecast : "24h";
    return sendJson(request, response, 200, dashboardPayload(range, forecastWindow, requestedThread, requestedRepository));
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(request, response, 200, { ok: true, lastScanAt, lastScanError, lastLiveAt, lastLiveError });
  }
  return sendJson(request, response, 404, { error: "Not found" });
});

await scan();
setInterval(scan, POLL_MS).unref();
setInterval(() => {
  purgeQuota.run(Date.now() - QUOTA_RETENTION_MS);
}, 60 * 60_000).unref();
pollLiveQuota();

server.listen(PORT, HOST, () => {
  console.log(`Codex Meter collector: http://${HOST}:${PORT}`);
  console.log(`Reading: ${CODEX_HOME}`);
  console.log(`Database: ${DB_PATH}`);
});

function shutdown() {
  if (liveTimer) clearTimeout(liveTimer);
  server.close(() => {
    codexStateDb?.close();
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
