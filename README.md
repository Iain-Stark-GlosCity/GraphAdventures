# Graph Adventures — MCP Adventure Engine

An adventure-agnostic MCP server that runs gamebook-style adventure knowledge graphs.
The engine mechanics were built to
[`rust-wind-hills-mcp-spec.md`](rust-wind-hills-mcp-spec.md) (v4) for a single dungeon
crawl — and everything in the spec's rule DSL turned out to be genre-neutral, so the
same graph layout and the same walkers now run four very different worlds. Azure
Functions v4, Node.js 24, Azure Blob Storage for run persistence.

## Hosted adventures

Every asset in [`adventures/manifest.json`](adventures/manifest.json) is loaded, hashed
and validated at startup; the MCP server, the CI content gates and the website all read
this one list, so adding an adventure is: drop the JSON in `adventures/`, add it to the
manifest.

| adventure_id | Title | Genre |
| --- | --- | --- |
| `rust-wind-hills-dungeon` | The Dungeons Below the Rust Wind Hills | Classic fantasy dungeon crawl with a licensing-bureaucracy satire (the original; content revision 0.2.5) |
| `vienna-clearing-house` | The Clearing House | Modern-day spy mystery: dead drops, a mole hunt and one exchange window in Vienna |
| `hollow-market-tithe` | The Tithe of Hollow Market | Urban fantasy: an unseelie fae market under the city, favours for currency, dawn as the clock |
| `dragons-ledger-audit` | The Dragon's Ledger | Comic high fantasy: a guild auditor reconciling a dragon's hoard, where the deadliest thing is the discrepancy |

The point of the extra three is to demonstrate that the platform is adventure-agnostic:
each one re-themes the *same* executable DSL rather than extending the engine. The spy
mystery prices everything in `hours` and runs surveillance pressure as a `heat` stat;
the fae market mints `favours` out of the player's own luck at a broker and rolls tests
against a `glamour` stat; the audit makes `ink` the working resource (discoveries must
be written up to count) and runs the dragon's temperament as a flag machine. All of it
is conditions/effects/costs/tests exactly as the spec defines them.

### The walker contract

The engine is content-agnostic except for a small, deliberate core every adventure must
satisfy (enforced by `test/multi-adventure.test.js`):

- stats must include `skill`, `stamina` (min 0) and `luck` — 2d6 tests, combat rounds
  and the luck-spend rule are wired to those names;
- a terminal `ending_dead` node must exist — the death invariant routes any walk that
  leaves stamina at 0 there, whatever the adventure calls dying (the audit's version is
  "A Reasonable Incineration Event");
- everything else — extra stats, every resource, all flags, items, encounters, endings,
  the whole semantic layer — is the adventure's own business.

**A single HTTP endpoint, `POST /api/mcp`, is the entire MCP server.** It's a plain,
anonymous-auth Azure Function that speaks JSON-RPC 2.0 directly (`initialize`,
`tools/list`, `tools/call`) and dispatches to all four tools from one place — no
per-tool Azure trigger, no system webhook route, no function key. This mirrors the
Difference Engine / llm-library Functions apps' wiring pattern: one function URL,
tools consolidated under it. Every `tools/call` result carries both a `content` text
block and a `structuredContent` object with the same data, so a client doesn't have to
re-parse JSON out of a string to get structured output.

## Layout

```
rust_wind_hills_adventure_knowledge_graph.json   the original adventure asset (hashed byte-exact at startup)
adventures/
  manifest.json      the one list of hosted assets, read by server, CI and website alike
  *.json             the other adventure assets (spy mystery, fae market, dragon audit)
src/
  engine/            pure game engine — no Azure dependencies
    adventure.js       asset/manifest loading, sha256 hashing, indexing, startup validation
    conditions.js      condition DSL (11 operators + any-blocks)
    effects.js         effect DSL (9 operators), clamping, knowledge_grants conversion
    dice.js            2d6 via crypto.randomInt (injectable for tests)
    resolve.js         skill/luck test resolution and the combat round loop
    engine.js          the five tools: list_adventures, new_run, get_node, walk, get_log
  storage/
    blobRunStore.js    one blob per run (adventure-runs/run:{run_id}.json), ETag concurrency
    memoryRunStore.js  same contract in memory, for tests
  mcp/
    tools.js           tool manifest: name, description, JSON Schema, handler
    protocol.js         pure JSON-RPC 2.0 / MCP dispatch — no Azure deps, unit tested
  functions/
    mcp.js             the one HTTP trigger: POST /api/mcp, anonymous, all tools live here
    health.js          anonymous GET /api/health readiness probe, used by CI and for ops
web/                 static adventure-walking website — plays the graph in the browser
  engine.mjs           browser port of src/engine as one dependency-free ES module
  index.html/app.mjs/style.css   the UI: scenes, choices, dice, character sheet
scripts/
  validate-adventure.js           audit script (same validation the app runs at startup)
  check-reachability.js           CI gate: deterministic BFS — every node reachable, no
                                   non-terminal dead ends (ignores conditions entirely)
  simulate-playthroughs.js        CI gate: randomised playthroughs — reports soft locks and
                                   ending coverage; only fails CI on an actual engine crash
  verify-functions-entrypoint.js  CI smoke gate: requires every src/functions/*.js file cold
  provision-azure.sh              one-shot resource group + storage + Function App bootstrap
  serve-web.js                    zero-dependency static server for the website (npm run web)
.github/workflows/
  main_func-rust-wind-hills-26487.yml  build, test, validate and Kudu-deploy on push to main
test/                    node:test suite (in-memory store, scripted dice)
```

## Tools

All served from `POST /api/mcp`'s `tools/list` and `tools/call` — see `src/mcp/tools.js`
for the exact JSON Schemas.

| Tool | Arguments | Behaviour |
| --- | --- | --- |
| `list_adventures` | — | Catalogue of every hosted adventure: `adventure_id`, title, genre, tone, premise, version, hash and size — enough to choose one (or offer the choice to a player) before `new_run`. |
| `new_run` | `adventure_id`, `label?` | Dispatches on `adventure_id` (unknown ids get an error naming what *is* hosted), seeds state from that adventure's ruleset `initial` values, applies the entry node's `knowledge_grants`, writes the run blob, returns the unguessable `run_id`. |
| `get_node` | `run_id` | Strictly read-only. Resolves the run's own adventure from the run document (runs of different adventures share one store without crossing), then returns the current node, public state, and the routes that pass all four checks (visible, legal, affordable, not consumed). Serves completed runs with an empty route list so the ending can be narrated. |
| `walk` | `run_id`, `route_id`, `expected_revision` | Optimistically-concurrent step: costs spent on the attempt, test rolled, effects applied, stats clamped, death invariant enforced, step committed with `If-Match`. The response is the logged step plus `node` and `available_routes` for the destination, computed from state already in memory (no extra storage read) — the common "walk, then narrate" loop needs no follow-up `get_node` call. |
| `get_log` | `run_id` | Full step log; exempt from the adventure-hash hard-stop (flagged `adventure_mismatch` instead). |

A tool-level failure (unknown tool name, or an `EngineError` like `route_unavailable`)
comes back as a normal `tools/call` result with `isError: true` and the error JSON as
the content text — never a JSON-RPC protocol-level error. That distinction matters:
protocol errors mean "the request itself was malformed"; tool errors mean "the game
rejected the move," which an LLM caller needs to see and react to, not retry blindly.

Spec-mandated behaviours worth knowing when calling:

- Any failure in walk's route checks — unknown id, wrong node, hidden, illegal,
  consumed, unaffordable — returns the same generic
  `{ "code": "route_unavailable", ... }` so guessed secret routes leak nothing.
- `route.kind: "secret"` is descriptive only; a route is hidden solely by a
  `visibility` block whose conditions fail.
- `test.stat` is read, never inferred from `test.type` (r063 is typed `skill` but
  tests luck). Luck tests cost 1 luck whatever the outcome.
- A conflicting blob write discards the whole resolution — no uncommitted rolls are
  ever returned. The caller re-fetches with `get_node` and retries.
- The adventure hash is the sha256 of the exact deployed file bytes; formatting-only
  edits intentionally invalidate existing runs.
- One deliberate deviation from the spec's "return the committed step, identical to
  what's in `log`": walk's response is the step plus `node`/`available_routes`
  appended on top. What actually gets appended to `log` (and what `get_log` returns)
  is still exactly the step, unchanged — the two extra fields are computed for the
  live response only and never persisted, so the audit trail stays exactly as
  specified.

## Narrative content

Content revision 0.2.1 gives every node an explicit `read_aloud`, a `read_aloud_revisit`,
and a `narrative` block (`local_history`, `present_tension`, `hidden_truth`,
`sensory_details`, `semantic_refs`, `narrative_hooks`); every route a `narrative` block
(`player_intent`, `dramatic_role`, `continuity_refs`, `narration_guidance`, and on some
routes `transition_text`/`themes_activated`); every encounter a `narrative_semantics`
block (`desire`, `fear`, `misconception`, `voice`, `non_combat_leverage`, `aftermath`);
and every item a `narrative_semantics` block (`origin`, `symbolic_role`,
`world_revelation`, `linked_threads`, `linked_motifs`). 0.2.2 adds `route.stakes` and
`route.hook` — a player-facing cost/risk/opportunity line and a short flavour line,
meant to sit alongside the short mechanical `label` rather than replace it. 0.2.3 adds
`node.narrative.emotional_undertone` and `node.narrative.sensory_focus`, which need no
engine changes since the rest of `node.narrative` is already a blanket pass-through. 0.2.5
adds `graph.opening_context`, conditional `node.read_aloud_variants`, `node.
mandatory_exposition`, `node.rumour_delivery`, and a `semantic_layer.route_resolutions` /
`semantic_layer.knowledge_revelations` pair — and ships with its own `runtime_contract`
block explicitly documenting how each field is meant to be used, which is what most of
the exposure logic below follows. All of it is verified content-safe — no route or node
narrative field reveals a hidden destination, failure branch, or visibility condition.
Route resolution text is the one exception worth naming: where a `failure_text` names the
failure destination, that destination is already exposed by the same walk response's own
`to`/`node` fields, so it's narration, not a new leak.

What's exposed today, computed fresh on every call (never adding to what's persisted):

- **`node.read_aloud`** — the engine tracks visit count per node per run
  (`state.visited_nodes`, engine bookkeeping like `consumed_routes`, stripped from
  `publicState`) and picks exactly one text itself. Precedence, highest first: a matching
  `node.read_aloud_variant` (see below); `read_aloud_revisit` on a return visit if the node
  has one; explicit `read_aloud`; `narrative.arrival_text` as the last resort. Nothing here
  is exposed raw alongside the choice — earlier revisions returned `read_aloud_revisit`
  unconditionally and left the caller to guess which applied from conversation memory; the
  node projection also reports `visit_count` and `presentation` (`"first_visit"` or
  `"revisit"`) so the choice is explicit rather than inferred.
- **`node.read_aloud_variants`** (0.2.5) — condition-gated read-aloud text (e.g. a gate
  that reacts differently depending on `permit_status`), evaluated with the same condition
  DSL routes use. All matching variants are ranked by `priority`; the highest wins outright
  over the usual first-visit/revisit choice, since a variant is about current state truth,
  not visit history.
- **`node.mandatory_exposition`** (0.2.5) — a separate field, not concatenated into
  `read_aloud`, so the narrator can judge whether it's already implied rather than
  repeating it verbatim (currently on the Warden and the treasure vault).
- **`node.rumour_delivery`** (0.2.5) — per-NPC rumour attribution (speaker/text/
  truth_status) at the Bent Nail Inn. Not mentioned in the content's own `runtime_contract`,
  but the same kind of verified-safe flavour as everything else here.
- **`node.narrative`** — the rest of the node's narrative block (`arrival_text` is
  dropped here since it's already folded into `read_aloud`).
- **`graph.opening_context.player_facing_introduction`** (0.2.5) — one-time scene-setting
  text, returned as `opening_context` on `new_run` only, never repeated on `get_node`/`walk`.
- **`route.stakes` / `route.hook`** — on every route in `available_routes`.
- **`route.narrative`** — on every route in `available_routes`, minus `content_role`,
  which is schema documentation about what `label`/`stakes`/`hook` are for, not content
  to narrate.
- **A combat test's `encounter_name`/`encounter_kind`** — shown on the route before it's
  engaged, not just the bare `encounter_id`.
- **A combat resolution's `encounter_name`/`encounter_kind`/`special`/`narrative`** —
  included in `walk`'s `resolution` when a combat test actually resolves. Unlike node/route
  narrative, this one *is* persisted to `log` — it's static per `encounter_id` (nothing new
  is being frozen in that wasn't already fully implied by the id) and bounded to 7
  encounters total, so keeping it as part of "what happened in this fight" strengthens the
  audit trail rather than bloating it.
- **`walk`'s `route_resolution`** (0.2.5) — `semantic_layer.route_resolutions[route_id]`'s
  `success_text` or `failure_text`, whichever branch actually happened. Live-response-only,
  same treatment as node/route narrative, not persisted to `log`.
- **`add_item` effect records** — enriched with the item's `name`/`description`/
  `narrative` (its `narrative_semantics`) at the moment it's picked up, in `walk`'s live
  `effects_applied` only. `get_log` still sees the lean `{ op, item }` shape the spec
  documents — narrative flavour belongs at the moment of acquisition, not repeated on
  every later read of the inventory.
- **`add_knowledge` effect records** (0.2.5) — enriched the same way with
  `semantic_layer.knowledge_revelations[fact]`'s `title`/`player_text`/`meaning`, in both
  `effects_applied` and `arrival_effects_applied` (node `knowledge_grants` on arrival
  synthesises the same shape), live-response-only. `meaning` is narrator subtext — same
  treatment as `node.narrative.hidden_truth` — not something to state outright.

Still unexposed, a deliberate scope boundary rather than an oversight: everything in
`semantic_layer` other than `route_resolutions` and `knowledge_revelations`, which are
resolved server-side into `route_resolution`/enriched knowledge effects rather than
exposed raw. That leaves world history, factions, named characters, motifs, dramatic
threads, the rumour/knowledge/condition catalogues, `narrative_delivery_plan`, and
region-level `narrative`. All of it is large, mostly static reference material better
suited to a separate, dedicated tool than repeated on every `get_node`/`walk` call — a
real follow-up if wanted, not something this covers.

Exposing the data is only half of it — the MCP `instructions` string returned in
`initialize` (see `SERVER_INFO` in `src/functions/mcp.js`) explicitly directs the calling
LLM to render every response as immersive second-person narrative prose, not surface the
structured output as data: open a node with `read_aloud`, weave in `narrative` where it
deepens the scene, voice route choices through `hook`/`stakes` rather than listing them,
let a combat's `narrative` (desire/fear/misconception/voice) drive how it fights rather
than just reporting stamina numbers, and narrate an item's `origin`/`symbolic_role` at
the moment it's picked up. Raw ids, dice math, and JSON field names are for the caller's
own reasoning, never for the player to see.

## Website

`web/` is a static, build-free client that walks the adventures in the browser — the
same graphs, rules and dice, without the LLM narrator layer the MCP server is built
for. It reads `adventures/manifest.json` (the same list the server loads) and opens
with a picker, one card per adventure; saved sessions are kept per adventure, so a
half-finished delve, a half-worked Vienna weekend and a half-audited hoard can all be
resumed independently. Scenes are the content's own text verbatim: `read_aloud` (with the same
variant/first-visit/revisit selection the server does), `mandatory_exposition`,
`rumour_delivery`, route `hook`/`stakes`, `route_resolution` on each step, and
item/knowledge `player_text` at the moment of acquisition. Dice rolls, combat rounds,
costs and stat changes are shown as plain mechanics. What a narrator would treat as
subtext stays hidden from the player: `narrative.hidden_truth` and a knowledge
revelation's `meaning` are never rendered.

`web/mcpClient.mjs` talks to the exact same deployed endpoint
(`https://func-rust-wind-hills-26487.azurewebsites.net/api/mcp`) an LLM client uses —
`new_run`/`get_node`/`walk`/`get_log` over JSON-RPC 2.0, no local simulation. A delve
played through the website and one narrated by an LLM are the same run engine, the
same dice and the same Azure Blob-backed run state; both are just different clients
of one server. The browser only keeps a lightweight session (`run_id`, `revision`,
`status`, a cosmetic step journal) in `localStorage` between visits — the adventure
state itself lives entirely server-side. Point it at a different deployment (e.g.
`func start`'s `http://localhost:7071/api/mcp` during local development) with
`?endpoint=...` in the page URL. Because `new_run` doesn't return `available_routes`
(an LLM client is expected to follow it with `get_node`, per the tools' contract —
see below), the website does that same extra round trip once, right after starting a
run. A `revision_conflict` from `walk` (another client moved the run since the last
view) triggers a silent `get_node` re-sync and lets the player choose again, rather
than surfacing a raw error.

Since the endpoint is called directly from browser JavaScript, `src/functions/mcp.js`
answers CORS preflight (`OPTIONS`) and sends `Access-Control-Allow-Origin: *` on every
response — this endpoint is already anonymous, key-free and has no per-caller secret
in its responses, so an open CORS policy doesn't change its access model, only who
can reach it from a browser tab.

`web/engine.mjs` also still exists: a dependency-free ES-module port of `src/engine`,
synchronous and storage-free, mechanically identical to the real engine (costs spent
on the attempt, `test.stat` read rather than inferred, luck tests always costing 1
luck, the death invariant, clamping, `one_time` consumption, the same four
availability checks and content-safety projections). The website no longer calls it
for gameplay — `web/mcpClient.mjs` is the live path — but `test/web-engine.test.js`
keeps it honest by walking scripted-dice playthroughs in lockstep against
`src/engine`, a regression guard on `src/engine` itself that's independent of which
client is wired up to the website at any given time.

```bash
npm run web    # serves the repo root; open http://localhost:8123/web/
```

Any static host that serves the repository as-is (e.g. GitHub Pages) works too —
the page fetches `../rust_wind_hills_adventure_knowledge_graph.json` relative to
`/web/`, so no build step and no copying of the asset. Every run started from the
website lands in the same `adventure-runs` blob container as every other MCP
client's runs — there's no separate "web" run store.

## Configuration

| Setting | Purpose |
| --- | --- |
| `ADVENTURE_STORAGE_CONNECTION_STRING` | Blob storage connection string (falls back to `AzureWebJobsStorage`). Never hardcoded, never a tool parameter. |
| `ADVENTURE_ASSET_PATH` | Optional single-asset override: when set, the server hosts only that adventure JSON instead of everything in `adventures/manifest.json`. |
| `WEBSITE_RUN_FROM_PACKAGE` | Set to `1` on the Function App (see deployment below) so the host mounts the deployed zip read-only instead of extracting it. |

Runs live in one container, `adventure-runs`, one blob per run: `run:{run_id}.json`.

## Deployment

`scripts/provision-azure.sh` creates the resource group, storage account and a
Windows/Node 24 consumption Function App, sets `ADVENTURE_STORAGE_CONNECTION_STRING`,
and sets `WEBSITE_RUN_FROM_PACKAGE=1`.

`.github/workflows/main_func-rust-wind-hills-26487.yml` builds and deploys on every
push to `main` using only `az`/Kudu REST calls in PowerShell — no `Azure/*` third-party
action. It installs, runs `smoke:entrypoint` (loads every `src/functions/*.js` file
cold, same as the Functions worker would, catching a broken asset or bad require before
it ships), runs the test suite, then `validate`/`check:reachability`/`simulate` against
the adventure asset that's actually about to ship, prunes dev dependencies, zips the
runtime files, then uploads via Kudu `zipdeploy`, syncs triggers, and polls the anonymous
`/api/health` endpoint (retrying with a host restart once if it doesn't come up). Auth is
the Function App's publish profile, stored as the `AZUREAPPSERVICE_PUBLISHPROFILE_...`
GitHub secret (get it with `az functionapp deployment list-publishing-profiles --xml`).

Because the app is deployed with `WEBSITE_RUN_FROM_PACKAGE=1`, each deploy is an atomic,
read-only mount of the new zip rather than a file-by-file extraction over the running
app — no partial-deploy window, no file locks.

## Running locally

```bash
npm install
npm test                     # engine + protocol + multi-adventure test suite (no Azure needed)
npm run validate             # audit every adventure asset in the manifest
npm run check:reachability   # every node reachable, no non-terminal dead ends — all adventures
npm run simulate             # 300 random playthroughs per adventure — soft locks, ending coverage
cp local.settings.sample.json local.settings.json
npm start                    # func start — needs Azure Functions Core Tools + Azurite
```

Each content script also takes an explicit asset path to audit just one adventure,
e.g. `npm run validate -- adventures/dragons_ledger_audit_adventure_knowledge_graph.json`.

Once running, `POST http://localhost:7071/api/mcp` with a JSON-RPC body speaks MCP
directly — e.g. `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` returns all five tools.
`GET http://localhost:7071/api/health` reports readiness and every hosted adventure.

Every static asset is validated at application start (broken references, unsupported
DSL operators) and the app refuses to boot on any error — games never fail
mid-walk on bad content.

## Content notes

The three newer adventures (`vienna-clearing-house`, `hollow-market-tithe`,
`dragons-ledger-audit`) ship at content revision 0.1.0 each: full `read_aloud`/
`read_aloud_revisit` coverage, conditional `read_aloud_variants`, `stakes`/`hook` on
every route, `opening_context`, `mandatory_exposition`, `rumour_delivery`, and a
`semantic_layer` carrying `knowledge_revelations` and `route_resolutions` — the two
blocks the engine actually consumes. All three pass the same CI gates as the original:
structural reachability is total, and the randomised simulation reaches all five of each
one's endings with no soft locks.

The original Rust Wind Hills graph is content revision 0.2.5. 0.2.0 was a purely additive narrative
enrichment over 0.1.1 — same 47 nodes, 108 routes, entry node and terminals; every
condition, effect, test and cost byte-identical to 0.1.1 (verified diff, not just a
version bump) — adding a `narrative`/`narrative_semantics` field to every node, route,
item, encounter and region, plus a top-level `semantic_layer` block. 0.2.1 added an
explicit `read_aloud`/`read_aloud_revisit` to every node so the engine could actually
read it (0.2.0's `narrative.arrival_text` existed but nothing consumed `narrative` yet).
0.2.2 added `route.stakes`/`route.hook`. 0.2.3 refined the read-aloud prose with sensory
detail and added `node.narrative.emotional_undertone`/`sensory_focus`. Every revision so
far has been mechanically identical to 0.1.1 — verified by diffing every
condition/effect/test/cost, not inferred from the version bump; see
[Narrative content](#narrative-content) above for exactly what's surfaced.

Two CI-gated scripts watch for regressions on every content update:
`check-reachability.js` (deterministic — every node must be structurally reachable from
the entry node and have an exit or be terminal, ignoring conditions entirely) and
`simulate-playthroughs.js` (a randomised Monte Carlo signal for state-dependent problems,
run 300 times per CI run). Both currently report the same two *content* soft-locks the
runtime deliberately does not paper over, unchanged since 0.1.1: a player can reach
`vault_antechamber` (all three exits need items) or `gate_of_tithes` (all four exits need
a permit, a supplies pack, or 3 gold) without the means to leave. Per the spec, content
fixes belong in the JSON, not the engine — the simulation script deliberately doesn't
fail CI over their continued presence (see the script's own comment for why), so this
stays visible without blocking unrelated content or engine changes.
