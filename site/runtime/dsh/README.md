# Controlled official DSH SDK runtime

This directory is the server-only official SDK carrier. It is separate from the
earlier in-process test kernel in `scripts/dsh-pilot/`. No website package or
website lock file is changed, and selecting this implementation is owned by the
server execution adapter rather than a browser-supplied option.

## Setup and verification

Use Node 24+. From `site/` run:

```text
node scripts/setup-dsh-runtime.mjs
node --test runtime/dsh/installation.test.mjs scripts/setup-dsh-runtime.test.mjs
node --test runtime/dsh/driver.test.mjs
```

This carrier supports local Node deployment. The Windows x64 complete portable
builder also bundles the locked SDK tree and carrier (see `../../portable/README.md`).
Cloud/edge deployment remains unsupported. Import readiness is not an end-to-end
test; release verification is recorded separately.

Setup uses a fresh staging directory under `.runtime/dsh-runtime-installs/` and
`npm ci --ignore-scripts --no-audit --no-fund`. It verifies the manifests, fixed
SDK/CLI/minimal versions, package resolution and ZIP patch before renaming the
tree into a manifest/lock SHA-256 slot and atomically selecting it in
`.runtime/dsh-runtime-active.json`. Existing matching slots are reused, never
overwritten. Incompatible/partial trees are retained and rejected. The SDK, CLI
and DSH packages remain `0.1.6-alpha.2`; the patched Windows install has 486 packages.
No package installation occurs during a user request.

Each task captures one tree for SDK and child plugin resolution. In-flight tasks
keep their captured tree when the pointer changes. The legacy
`.runtime/dsh-runtime-deps/` is preserved; no pointer means legacy compatibility,
but an invalid pointer fails closed. Paths must stay within managed directories,
and symlinks/junctions in selection paths are rejected. This is not an OS-level
defense against a local operator changing package contents.

Portable builds use the strict selection `{kind:"bundled",id}` with the original
manifest/lock identity and a fixed short directory `.runtime/dsh-bundled`.
The strict `controlled-notebook-v1` profile omits exactly the two LibreOffice
packages plus `sharp` and `@img/sharp-win32-x64`. These Office/native-image
plugins are absent from the website's controlled loading graph and exposed
tools; their corresponding-source distribution was not established for this
release. All other dependencies remain, and the root ZIP dependency is checked
at 0.8.3. This is not a general-purpose all-plugin DSH CLI distribution. Existing
slot/legacy trees and their Office ZIP checks are unchanged. Only manifests and runtime dependencies are shipped;
local session data, previous slots and credentials are excluded. The launcher
sets `AGENTCANVAS_DEFAULT_ENGINE=dsh` at process startup. Normal source deployment
still defaults to Harness; UI switching remains process-local, not persisted.

`node scripts/setup-dsh-runtime.mjs --rollback` explicitly selects the previous
tree. Restoring legacy also restores its known ZIP risk. Installation is serialized
with an exclusive lock; a crash can leave `.runtime/dsh-runtime-install.lock`.
Verify that no installation is running before manually recovering that one lock;
the script deliberately does not guess that a lock is stale or delete old trees.

`inspectDshRuntime()` verifies the exact SDK/CLI/minimal profile, CLI entry,
and actual SDK loading/export shape. It does not construct the SDK, start a child
or call a model. Settings report only fixed readiness `phase`/`code` values, not
exception text, paths, credentials or provider details. A ready result does not
verify model connectivity or permission to analyze a particular dataset.

SDK loading uses Node 24's native `createRequire` from the captured installation
manifest. The pinned SDK has a synchronous ESM graph; this keeps its dependency
resolution outside Vite/RSC dynamic-import rewriting and failure caching.
An SDK update that adds top-level await requires revisiting this compatibility
boundary; there is no alternate-loader or previous-executor fallback.

## One task, one process

`runDshSession()` starts the official `DeepSeekHarness` SDK, which launches the
official `dsh --profile sdk-minimal --patch ...` subprocess. The task owns a fresh
home and empty working directory under `.runtime/dsh-runtime-sessions/`. Child
environment is an explicit allowlist, not inherited credentials or project
`.env` files. The model key and temporary broker token are held only in process
memory/environment, never written to the task files or CLI arguments.

The patch disables default shell, terminal, subprocess, jobs, MCP, model,
persistence and request-extension plugins. Our plugin verifies those rows are
disabled and verifies its complete tool registry exactly matches the task catalog.
Every catalog must include these four business tools:

```text
cellSearch / editNotebookCells / runNotebookCells / submitNotebookDraft
```

Only `getKernelPackagesInfo`, `inspectEdsRawWorkbook`, `readEdsRawRows` and
`inspectConnectionSchema` may additionally appear, when the parent has composed
and authorized those capabilities. Unknown, duplicate, missing-required and
not-exposed optional tools are rejected. Python and database queries still run
inside the application's Notebook services, not native DSH plugins. Attachment
bytes and database credentials never enter this subprocess; initial context has
metadata, while business tool observations contain bounded results.

The website Notebook profile also supports the existing `transform` cell via
the canonical DataRecipe schema and Notebook executor. This does not extend the
historical CSV-only pilot or authorize extra data sources. Known bridge startup
rejections now return finite preflight codes; unknown initialization errors are
not represented as a confirmed capability/permission problem. Details and
verification: [Transform preflight fix](../../docs/verification/dsh-transform-preflight-2026-09-22.md).

Explicit read-only Notebook questions use either `cellSearch` alone (when the
user prohibits execution), or `cellSearch / runNotebookCells`. These are closed
catalogs: partial write catalogs and optional tools mixed into read-only mode
remain invalid. The engine validates task-owned observations and current-run
result references before accepting a bounded final answer without a draft.
Unknown or positive mutation requests retain the complete draft workflow and
human adoption. Read-only completion does not prove every natural-language
claim; see the [debugging report](../../docs/verification/dsh-readonly-debug-2026-09-22.md).

Simple whole-request file/data analysis retains the complete tool catalog but
may finish with an answer when existing cells suffice: the private attempt
ledger must contain only successful search/run evidence and recovered, trusted
search failures, with valid current-run AI results. Any edit, submit or other
tool attempt (including rejected arguments) requires the normal draft path.
A verified draft always takes priority and still awaits human adoption.
Named inputs must match selected source/attachment metadata; extra objectives
or unknown names retain the draft contract. This is not a general semantic
classifier or proof of every sentence in the model answer.

The plugin calls a task-scoped `127.0.0.1` broker using a temporary bearer token:
`GET /catalog`, `POST /execute`, `POST /authorize`. Authorization is rechecked
before each model dispatch, and the parent revalidates every business tool call.
The broker retains data access, argument validation and existing human-adoption
rules. The DSH subprocess cannot directly apply a Notebook or access the project
through an exposed filesystem/shell tool.

The formal provider uses the official DeepSeek adapter in chat-completions mode.
The child-local wire policy permits only the broker's exact routes and the
configured model's exact chat-completions endpoint, with redirects rejected.
When the existing website has no explicit output cap, the policy removes DSH's
automatically supplied `max_tokens` to preserve that omission. This fetch policy
also preserves the website's explicit disabled thinking and omitted effort.
The adapter's context metadata still follows the selected DSH provider contract;
this is not a claim that every model capability/default is interchangeable.
This fetch policy is defense in depth, **not an OS network/filesystem sandbox**.

The fixture mode is for server-controlled tests only. It is not selectable from
HTTP request data and makes no provider calls. Fixed fixture output does not
measure real model quality. The SDK carries durable Session notifications, not
live provider token chunks; callers must not invent real-time token streaming.

Cancellation closes the task's exclusive SDK runtime and awaits SDK teardown and
process exit. SDK idle is not treated as success: the driver requires exactly
one `turn/end` with `reason.kind = completed`, otherwise it rejects, even if a
tool had previously submitted a draft. No other website or DSH task process is stopped. Sessions are
memory-only; DSH homes/configuration directories are retained as local evidence,
not a new source of persistent conversation truth.

## Dependency patch and remaining boundaries

On 2026-09-22 the legacy tree's audit reported six moderate entries for one
underlying `fflate <0.8.3` malformed ZIP64 denial-of-service advisory. A scoped
`@deepseek-ai/libreoffice-kit` override now selects `fflate 0.8.3`; the isolated lock
only removes the vulnerable nested 0.8.2 record. The activated parallel tree's
audit reports zero known vulnerabilities. No main website lock, SDK version or
unrelated dependency was upgraded and no broad `audit fix` was used. The inactive
legacy tree still has the known risk; zero audit findings are not a security
guarantee. Office/Web plugins remain disabled. Advisory:
https://github.com/advisories/GHSA-px8p-9vwx-vf98.

The eleven driver tests cover actual SDK subprocess success, required/optional
catalog matching, denied shell and non-exposed optional tools, tool
failure, authorization revocation, post-submit model failure, cancellation/reaping,
request-policy behavior, safe parameter feedback and correction, and the official
provider adapter against local mocked SSE. Canonical argument errors retain only
schema-owned field paths and issue codes after authorization revalidation; unknown
or authorization failures remain generic and no rejected input values are forwarded.
The fixture tests alone do not establish real provider compatibility, UI acceptance,
publication, new-machine packaging or persistent-session migration. Real model / owned
PostgreSQL evidence and failures are recorded separately in
`docs/verification/dsh-live-2026-09-22.md`; the subsequent real model/database
success and browser adoption, dashboard editing and save/reopen delivery are in
`docs/verification/dsh-delivery-2026-09-22.md`. These are development-site results,
not a stable-site or portable-package release.
