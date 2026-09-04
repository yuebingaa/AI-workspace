import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const moduleRequire = createRequire(import.meta.url);
const vitestCliPath = join(dirname(moduleRequire.resolve("vitest/package.json")), "vitest.mjs");
const toolTestPaths = [
  join(scriptDirectory, "eds-browser-acceptance.test.mjs"),
  join(scriptDirectory, "run-offline-tests.test.mjs"),
];

export function runCommand(executable, args) {
  return new Promise((resolveExitCode, rejectLaunch) => {
    const child = spawn(executable, args, { stdio: "inherit", windowsHide: true });
    child.once("error", rejectLaunch);
    child.once("exit", (code, signal) => {
      resolveExitCode(signal ? 1 : (code ?? 1));
    });
  });
}

export async function runOfflineTests(vitestArguments = process.argv.slice(2), commandRunner = runCommand) {
  const forwardedArguments = vitestArguments[0] === "--" ? vitestArguments.slice(1) : vitestArguments;
  const vitestExitCode = await commandRunner(process.execPath, [vitestCliPath, "run", ...forwardedArguments]);
  if (vitestExitCode !== 0) return vitestExitCode;
  return commandRunner(process.execPath, ["--test", ...toolTestPaths]);
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  try {
    process.exitCode = await runOfflineTests();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
