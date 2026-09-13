import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export function windowsCsc() {
  if (process.platform !== 'win32') throw new Error('The console-free task host requires Windows.');
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework'].map((folder) => join(windows, 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe')).find(existsSync);
  if (!compiler) throw new Error('Windows .NET Framework C# compiler is unavailable; existing services were not changed.');
  return compiler;
}
export async function compileWindowsExecutable(source, output, target = 'winexe') {
  const compiler = windowsCsc();
  await mkdir(dirname(output), { recursive: true });
  await new Promise((res, rej) => {
    const child = spawn(compiler, ['/nologo', `/target:${target}`, '/optimize+', '/platform:anycpu', `/out:${output}`, source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let outputText = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { outputText = (outputText + chunk).slice(-8000); });
    child.once('error', rej);
    child.once('exit', (code) => code === 0 ? res() : rej(new Error(`Task host compilation failed (${code}): ${outputText}`)));
  });
}
export async function buildTaskHost(outputDirectory) {
  const executable = join(resolve(outputDirectory), 'AgentCanvasHost.exe');
  await compileWindowsExecutable(join(here, 'task-host.cs'), executable);
  const pe = await readFile(executable);
  const peOffset = pe.readUInt32LE(0x3c);
  if (pe.readUInt32LE(peOffset) !== 0x4550 || pe.readUInt16LE(peOffset + 24 + 68) !== 2)
    throw new Error('Task host must be a Windows GUI-subsystem executable (no console).');
  return executable;
}

export async function buildRuntimeHosts(outputDirectory) {
  const host = await buildTaskHost(outputDirectory);
  const watchdog = join(resolve(outputDirectory), 'AgentCanvasWatchdog.exe');
  await compileWindowsExecutable(join(here, 'task-watchdog.cs'), watchdog);
  const pe = await readFile(watchdog);
  if (pe.readUInt16LE(pe.readUInt32LE(0x3c) + 24 + 68) !== 2) throw new Error('Watchdog must not create a console.');
  return { host, watchdog };
}
