# Official DSH offline kernel pilot

This is a test composition of the official Cordis, LLM, Session,
SessionProjection, SystemPrompt, Tools, Agent and AgentLoop packages. It is not
the production SDK launcher or a model-quality test.

Since September 26 it resolves the same verified installation as
`runtime/dsh/`: DSH **0.1.7-rc.2**, Cordis **4.0.4**. There is no independent pilot
manifest or lock. The old 0.1.6-alpha.2 / Cordis 4.0.2 installation and its
25-package test results belong to the historical September 22 report.

## Setup and checks

Use Node 24+ and run from `site/`:

```text
node scripts/setup-dsh-runtime.mjs
node --test scripts/dsh-pilot/runner.test.mjs
node scripts/dsh-notebook-pilot.mjs
```

Missing or mismatched dependencies fail explicitly; user requests never install
packages. The seven runner checks cover real tool evidence, tool failure,
unknown shell denial, fetch denial/restoration, in-flight cancellation/drain,
timeout/drain and rejection of a pre-cancelled caller. New tool failures are read
from `ToolResultMessage.isError`. Reports identify the exact release tag instead
of the previous release's commit.

## Boundary and interface

`runDshFixture({ tools, actions, signal?, instruction?, sessionId?, timeoutMs? })`
executes the official loop against a fixed, non-network model adapter. Each tool
supplies `name`, `description`, JSON Schema `parameters`, and
`execute(args, { signal, callId })`. The bridge validates raw arguments and
enforces authorization. Returned events are real DSH session events;
`finalResponse` is a fixed test answer.

No CLI/profile, shell, filesystem, PTC, subagent, network model, persistence or
HTTP listener is mounted. Dependency presence does not activate a plugin. The
runner does not read project `.env` files and stores sessions only in memory.
Tool callbacks are trusted code with their explicitly provided capabilities.

The process-local fetch guard is not an OS network sandbox. Runs must be serial.
Cancellation propagates to the Agent and tool signal, waits for quiescence, then
disposes the handle/context; callbacks must honor the signal. It cannot forcibly
terminate uncooperative same-process code. Timeout is a test bound.

Browser rendering, a live model, the production SDK subprocess, persistence and
new-machine packaging require separate checks. Current upgrade evidence is in
[the September 26 report](../../docs/verification/dsh-upgrade-2026-09-26.md).
