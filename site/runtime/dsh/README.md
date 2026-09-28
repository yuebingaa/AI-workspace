# Controlled official DSH SDK runtime

This directory contains the server-only official SDK carrier and the explicitly
allowlisted browser presentation adapter described below. The earlier in-process
test composition in `scripts/dsh-pilot/` now shares this installation. No website package or
website lock file is changed, and selecting this implementation is owned by the
server execution adapter rather than a browser-supplied option.

## Optional official Web presentation

`/dsh/web` uses the pinned official Web distribution and 22 client faces, through
`web-assets.mjs` and `web-client.mjs`. The latter supplies the public logical RPC
hook and embedded `conversation.content` slot. No official Host, gateway listener,
terminal or unrestricted plugin is started. Prompt/cancel cross a strict parent
window protocol into the existing website's DSH conversation API. Other mutations
are rejected; current integration supports text only. Parent context selection,
tool authorization, Notebook confirmation and native session acceptance remain
authoritative. Display events are not raw SDK execution events.

The document is a trusted same-origin iframe, not an untrusted-code sandbox.
It denies direct network connections, but needs document-scoped `unsafe-eval`
for the unchanged official Cordis shell. Public assets retain MIT notices and are
served by exact allowlist. Official draft/view preference caching is not a second
model history; fresh frame/display identities prevent its recovery over parent
state. See `docs/verification/dsh-official-web-2026-09-26.md` for actual checks and
limits. Portable carrier copying includes both Web modules; no new release is implied.

## Website plugin settings (2026-09-27)

The parent website provides its own DSH-style settings panel and local-only
`/api/settings/dsh-plugins` API; it does not enable the official Host configuration
RPC. The curated catalog distinguishes installed dependencies, integrated task
capabilities and unintegrated/disabled plugins. It is not the entire DSH package
registry. The separate legacy engine-selection API remains compatible.

The persisted `skills` setting defaults to false. When explicitly enabled, each
new task mounts the pinned official `dsh-skill` registry and `dsh-tool-skill`,
plus `builtin-skills.mjs` with two immutable website instruction documents. The
official `skill` tool is the only additional registry entry permitted in this
mode; the broker's business-tool catalogs and their authorization are unchanged.
There is no filesystem discovery, script execution or new data permission.
Reading instructions is not business execution evidence. Disabling removes the
skill tool on the next task. A changed configuration revision rebuilds the next
native model session, preserving visible website history but not reusing the old
plugin-dependent SDK transcript. In-flight configuration writes are rejected.

Terminal, arbitrary file access, context compaction, structured clarification and
community-plugin installation remain unavailable here. SDK fixture validation,
UI acceptance and unverified boundaries are recorded in
[the plugin-settings report](../../docs/verification/dsh-plugin-settings-2026-09-27.md).
Portable carrier copying includes the built-in skill module; no new package or
Release has been produced in this change.

The separate **Official components** tab lazily reads package metadata via the
local-only `/api/settings/dsh-plugins/inventory` GET endpoint. The carrier lists
the selected installation's top-level `@deepseek-ai/dsh*` packages without
importing them. Counts describe package files, not the full Host's global/preset
instances or enabled tools. Missing/invalid metadata produces an explicit partial
result; an unavailable installation is not reported as an empty success. Unknown
integration status remains unknown. See [inventory verification](../../docs/verification/dsh-plugin-inventory-2026-09-27.md).

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
and DSH packages are pinned to `0.1.7-rc.2` (an official release candidate),
with Cordis 4.0.4, Schemastery 3.18.4 and pi-ai 0.85.1. The Windows installation
has 518 packages. The pilot no longer has a separate manifest, lock or dependency tree.
No package installation occurs during a user request.

Each task captures one tree for SDK and child plugin resolution. In-flight tasks
keep their captured tree when the pointer changes. Pointer parsing accepts earlier
release identities to permit upgrades, but runtime resolution still requires the
current exact version. Old trees are removed only after verification and draining
tasks. No pointer permits a version-checked legacy compatibility path,
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
still defaults to Harness for the legacy API; the current conversation UI uses
its independent DSH path and does not expose engine switching. The new plugin
configuration is persisted separately from that legacy process-local selection.

`node scripts/setup-dsh-runtime.mjs --rollback` explicitly selects a compatible
previous tree. Cross-version rollback is rejected; older dependencies cannot run
under the new carrier. After obsolete-tree cleanup there is no previous selection.
Installation is serialized
with an exclusive lock; a crash can leave `.runtime/dsh-runtime-install.lock`.
Verify that no installation is running before manually recovering that one lock;
the script deliberately does not guess that a lock is stale or delete old trees.

`inspectDshRuntime()` verifies the exact SDK/CLI/minimal profile, CLI entry,
and actual SDK loading/export shape. It does not construct the SDK, start a child
or call a model. Settings report only fixed readiness `phase`/`code` values, not
exception text, paths, credentials or provider details. A ready result does not
verify model connectivity or permission to analyze a particular dataset.

`native-loader.cjs` loads the server-owned `driver.mjs?carrier=10` URL using Node's
native import, outside the Vite/RSC runner. The revision propagates through local
policy/installation imports; development HMR cannot mix new code with an old version
constant. In-flight tasks keep their captured module graph.

SDK loading uses Node 24's native `createRequire` from the captured installation
manifest. The pinned SDK has a synchronous ESM graph; this keeps its dependency
resolution outside Vite/RSC dynamic-import rewriting and failure caching.
An SDK update that adds top-level await requires revisiting this compatibility
boundary; there is no alternate-loader or previous-executor fallback.

## One task, one process

The dedicated website conversation endpoint selects the server-owned
`conversation` profile. It permits an empty business-tool catalog when no
Notebook capability is available, so ordinary replies need no draft. The default
`notebook` profile retains its previous catalog requirements. Both the broker
and child plugin verify the chosen profile; it is not a public request flag.
Available tools keep the same authorization and human-adoption boundaries.
This does not enable arbitrary DSH plugins or the official Web host. When private
`STUDIO_LOCAL_STATE_DIR` is configured, the dedicated conversation endpoint now
uses accepted native SDK session logs; otherwise it retains website continuity.

### Accepted native sessions

`session-server.mjs` replaces only the owned prompt dispatch using the public
agent create/resume API and official notification peer. Each turn still gets a
fresh process, model configuration, authorized tool catalog and broker token.
`nativeSession: { root, mode }` is a server-only driver option; `root` is a staged
log directory, never the runtime home/configuration folder. Explicit flush,
Agent disposal and confirmed child exit are all required for `persisted:true`.
That receipt is not a business success: the website performs final verification
and authorization before accepting a generation for later resume.

The website store hashes owner/project, conversation and page identity under
`STUDIO_LOCAL_STATE_DIR/dsh-native-sessions`. Scope changes retire the old head;
failed or cancelled candidates never become history. Old website transcripts are
not automatically bootstrapped into a native session. Clear revokes continuity,
not the physical bytes. Logs may contain user text and bounded tool results;
configuration API keys and broker tokens are not persisted. This is not a general
PII scrubber, encrypted storage or an operating-system sandbox. Failed stages and
old generations are retained privately with explicit capacity protection; crash
locks require operator review, not automatic takeover. See the
[architecture](../../docs/architecture/agent-architecture.md) and
[verification](../../docs/verification/dsh-native-conversation-2026-09-26.md).

`runDshSession()` starts the official `DeepSeekHarness` SDK, which launches the
official `dsh --profile sdk-minimal --patch ...` subprocess. The task owns a fresh
home and empty working directory under `.runtime/dsh-runtime-sessions/`. Child
environment is an explicit allowlist, not inherited credentials or project
`.env` files. The model key and temporary broker token are held only in process
memory/environment, never written to the task files or CLI arguments.

The patch disables default shell, terminal, subprocess, jobs, MCP, model,
persistence (except the explicitly staged native-session backend) and request-extension plugins. Our plugin verifies those rows are
disabled and verifies its complete tool registry exactly matches the task catalog.
Every catalog must include these four business tools:

```text
cellSearch / editNotebookCells / runNotebookCells / submitNotebookDraft
```

Only `getKernelPackagesInfo`, `inspectEdsRawWorkbook`, `readEdsRawRows` and
`inspectConnectionSchema` may additionally appear, when the parent has composed
and authorized those capabilities. Unknown, duplicate, missing-required and
not-exposed optional tools are rejected. The optional official `skill` instruction
tool described above is separate from this business catalog. Python and database queries still run
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

DSH 0.1.7's direct DeepSeek adapter only accepts Messages. `chat-adapter.mjs`
instead uses the official `@deepseek-ai/dsh-llm-pi-ai` adapter and pi-ai's public
Chat Completions protocol for the existing website API contract. Only the current
task's exact model and API key are registered, without ambient credentials,
provider discovery, automatic retries or extra plugins. Required catalog price
placeholders are not billing evidence; only provider token usage is reported.
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
tool had previously submitted a draft. No other website or DSH task process is stopped.
Task-scoped sessions are memory-only except the accepted native conversation path
described above; unrelated DSH homes/configuration directories remain local evidence,
not a second source of persistent conversation truth.

## Dependency patch and remaining boundaries

The September 22 legacy audit found six moderate entries for one underlying
`fflate <0.8.3` malformed ZIP64 denial-of-service advisory. This upgrade retains
the scoped `@deepseek-ai/libreoffice-kit` override to `fflate 0.8.3` and regenerates
only the isolated DSH lock for the new exact SDK release. Its September 26 audit
reported zero known vulnerabilities; this is not a security guarantee. The website
lock is unchanged, and Office plugins and the standalone Web Host remain disabled.
The optional allowlisted Web client presentation above does not enable that Host. Advisory:
https://github.com/advisories/GHSA-px8p-9vwx-vf98.

The driver tests cover actual SDK subprocess success, required/optional
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

The current upgrade, protocol/error-event migration, cleanup and checks are
recorded in [the September 26 report](../../docs/verification/dsh-upgrade-2026-09-26.md).
In 0.1.7 tool failure evidence is `ToolResultMessage.isError`, not a nested block flag.

Settings now reuse the pinned official Web shell and inventory modules via the
separate `surface=settings` document and `web-settings.mjs`. The vendor bundles
are unchanged; website configuration stays in the existing versioned API. The
inventory is a labelled installed/configured snapshot, not a live Host fiber tree.
Unknown Host writes and capabilities remain unsupported. See
[the settings reuse report](../../docs/verification/dsh-native-settings-2026-09-27.md).
