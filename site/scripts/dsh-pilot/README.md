# Official DSH offline kernel pilot

This is an isolated **test composition**, not a production DSH launcher and not
an enabled replacement for the website Agent. It mounts the official Cordis,
LLM, Session, SessionProjection, SystemPrompt, Tools, Agent and AgentLoop packages.
It follows the upstream `packages/core/agent-loop/tests/loop.spec.ts` composition
at commit `ddefc45fbc7f8e46dd73185e68295696d1297887`.

All DSH packages are fixed to `0.1.6-alpha.2`. Cordis is `4.0.2`; the independent
lock file fixes the complete 25-package installation. Website dependencies and
its lock file are not changed. Node 24 or later is required for this pilot.

## Installation

From `site/`, use a fresh isolated target. The following PowerShell refuses to
overwrite an existing installation. Do not run `npm install` in this source
directory or in the website root for the pilot.

```powershell
$pilotTarget = Join-Path (Get-Location) '.runtime/dsh-pilot-deps'
if (Test-Path -LiteralPath $pilotTarget) { throw 'Pilot target already exists; preserve it.' }
New-Item -ItemType Directory -Path $pilotTarget | Out-Null
Copy-Item -LiteralPath 'scripts/dsh-pilot/package.json' -Destination $pilotTarget
Copy-Item -LiteralPath 'scripts/dsh-pilot/package-lock.json' -Destination $pilotTarget
npm ci --prefix .runtime/dsh-pilot-deps --ignore-scripts --no-audit --no-fund
```

An already installed target can run the tests directly. Missing dependencies are
an explicit failure, never silently installed at execution time.

```text
node --test scripts/dsh-pilot/runner.test.mjs
node scripts/dsh-notebook-pilot.mjs
```

The seven runner checks cover real tool evidence, tool failure, unknown shell
denial, fetch denial/restoration, in-flight cancellation/drain, timeout/drain,
and rejection of a pre-cancelled caller.

The first installation on 2026-09-22 used the same manifest with `npm install
--prefix .runtime/dsh-pilot-deps --ignore-scripts --no-audit --no-fund` to generate
the included lock. It installed 25 packages. An explicit `npm audit --prefix
.runtime/dsh-pilot-deps --json` reported zero known vulnerabilities at that time;
this is not a security audit of DSH. No `audit fix` was run.

## Boundary and interface

`runDshFixture({ tools, actions, signal?, instruction?, sessionId?, timeoutMs? })`
executes the official loop against a fixed, non-network model adapter. Each tool
supplies `name`, `description`, JSON Schema `parameters`, and
`execute(args, { signal, callId })`. The bridge must validate its raw tool
arguments and enforce existing authorization. Optional `outputSchema` defaults
to a JSON object. Action arguments may be a function of prior validated tool
results. Returned `events` are real canonical DSH session events, not fabricated
UI progress. `finalResponse` is a fixed test answer, not evidence of model quality.

No CLI/profile, shell, filesystem, PTC, subagent, network model, persistence or
HTTP listener is mounted. Dependency presence is not plugin activation. The
runner does not read project `.env` files and stores sessions only in memory.
The supplied tool callbacks remain trusted code and may use their explicitly
provided local business capabilities.

The process-local `fetch` denial is a regression check, **not an OS network
sandbox**. Runs must be serial. Cancellation propagates to the official Agent
and tool signal, waits for quiescence, then disposes the handle and context;
callbacks must honor the signal. It cannot forcibly terminate uncooperative
same-process code. Timeout is a test bound, not a new website model quota.

No browser interface, live model, production SDK transport, persistent DSH
session migration or public API replacement is validated here. The existing
website execution path, human adoption/confirmation flow and managed services
remain unchanged. A production application should use a reviewed official
launch path rather than treating this test composition as its deployment API.
