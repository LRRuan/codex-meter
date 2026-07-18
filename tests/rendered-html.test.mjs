import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Codex Meter shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>Codex Meter · 本地额度看板<\/title>/i);
  assert.match(html, /LOCAL TELEMETRY/);
  assert.match(html, /正在重建去重后的本地用量/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/i);
});

test("keeps the P0 data guarantees in collector and UI", async () => {
  const [collector, page, readme] = await Promise.all([
    readFile(new URL("../server/collector.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);

  assert.match(collector, /"usage-v3"/);
  assert.match(collector, /cumulative\.input/);
  assert.match(collector, /account\/rateLimits\/read/);
  assert.match(collector, /account\/usage\/read/);
  assert.match(collector, /bucket:\s*5 \* 60_000/);
  assert.match(collector, /tokenTotal:\s*bucket\.total/);
  assert.match(collector, /quotaUsed:\s*carriedQuota/);
  assert.match(collector, /resetJumps/);
  assert.match(page, /0% · 预计耗尽/);
  assert.match(page, /CODEX ACCOUNT USAGE · OFFICIAL/);
  assert.match(page, /预测点位/);
  assert.match(page, /实际点位/);
  assert.match(page, /余量 \{selected\.remaining\.toFixed\(1\)\}%/);
  assert.match(page, /全部 Session/);
  assert.match(page, /SESSION USAGE/);
  assert.match(page, /actualSegments/);
  assert.match(page, /额度余量与耗尽预测/);
  assert.match(page, /空窗消耗记为 0，额度沿用最近采样/);
  assert.match(readme, /跨文件去重/);
});
