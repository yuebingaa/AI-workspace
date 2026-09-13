import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { stopChild } from "./runtime/common.mjs";

const root = process.cwd();
const children = new Set();
const timers = new Set();
let stopping = false;

function start(name, args, failures = 0) {
  if (stopping) return;
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit" });
  children.add(child);
  const startedAt = Date.now();
  child.on("error", (error) => console.error(`[${name}] ${error.code}`));
  child.on("exit", (code) => {
    children.delete(child);
    if (stopping) return;
    if (Date.now() - startedAt > 60_000) failures = 0;
    const delay = [1000, 2000, 5000, 10000, 30000][Math.min(failures, 4)];
    console.error(`[${name}] exited ${code}; restarting in ${delay}ms`);
    const timer = setTimeout(() => { timers.delete(timer); start(name, args, failures + 1); }, delay);
    timers.add(timer);
  });
  return child;
}

start("capture", ["--env-file-if-exists=.env", "--env-file-if-exists=.env.local", resolve("scripts/playwright-capture-service.mjs")]);
start("website", [resolve("node_modules/vinext/dist/cli.js"), "dev", ...process.argv.slice(2)]);

async function stop() {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearTimeout(timer);
  await Promise.all([...children].map(stopChild));
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
