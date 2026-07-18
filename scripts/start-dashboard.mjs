import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [
  spawn(process.execPath, ["server/collector.mjs"], { stdio: "inherit" }),
  spawn(npmCommand, ["run", "dev"], { stdio: "inherit" }),
];

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
