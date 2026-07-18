#!/usr/bin/env node

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const env = {
  ...process.env,
  CODEX_METER_DB: process.env.CODEX_METER_DB ?? join(homedir(), ".codex-meter", "codex-meter.sqlite"),
};
const children = [
  spawn(process.execPath, [join(packageRoot, "server", "collector.mjs")], { cwd: packageRoot, env, stdio: "inherit" }),
  spawn(npmCommand, ["run", "start"], { cwd: packageRoot, env, stdio: "inherit" }),
];

console.log("\nCodex Meter is starting at http://localhost:3000\n");

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 400).unref();
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!stopping && code && signal == null) stop(code);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
