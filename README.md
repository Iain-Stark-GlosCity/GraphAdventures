# Rust Wind Hills — MCP Adventure Engine

An MCP server that runs `rust_wind_hills_adventure_knowledge_graph.json`, built to
[`rust-wind-hills-mcp-spec.md`](rust-wind-hills-mcp-spec.md) (v4). Azure Functions v4,
Node.js 24, Azure Blob Storage for run persistence.

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
rust_wind_hills_adventure_knowledge_graph.json   static adventure asset (hashed byte-exact at startup)
src/
  engine/            pure game engine — no Azure dependencies
    adventure.js       asset loading, sha256 hashing, indexing, startup validation
    conditions.js      condition DSL (11 operators + any-blocks)
    effects.js         effect DSL (9 operators), clamping, knowledge_grants conversion
    dice.js            2d6 via crypto.randomInt (injectable for tests)
    resolve.js         skill/luck test resolution and the combat round loop
    engine.js          the four tools: new_run, get_node, walk, get_log
  storage/
    blobRunStore.js    one blob per run (adventure-runs/run:{run_id}.json), ETag concurrency
    memoryRunStore.js  same contract in memory, for tests
  mcp/
    tools.js           tool manifest: name, description, JSON Schema, handler
    protocol.js         pure JSON-RPC 2.0 / MCP dispatch — no Azure deps, unit tested
  functions/
    mcp.js             the one HTTP trigger: POST /api/mcp, anonymous, all tools live here
    health.js          anonymous GET /api/health readiness probe, used by CI and for ops
scripts/
  validate-adventure.js           audit script (same validation the app runs at startup)
  check-reachability.js           CI gate: deterministic BFS — every node reachable, no
                                   non-terminal dead ends (ignores conditions entirely)
  simulate-playthroughs.js        CI gate: randomised playthroughs — reports soft locks and
                                   ending coverage; only fails CI on an actual engine crash
  verify-functions-entrypoint.js  CI smoke gate: requires every src/functions/*.js file cold
  provision-azure.sh              one-shot resource group + storage + Function App bootstrap
.github/workflows/
  main_func-rust-wind-hills-26487.yml  build, test, validate and Kudu-deploy on push to main
test/                    node:test suite (in-memory store, scripted dice)
```

## Tools

All served from `POST /api/mcp`'s `tools/list` and `tools/call` — see `src/mcp/tools.js`
for the exact JSON Schemas.

| Tool | Arguments | Behaviour |
| --- | --- | --- |
| `new_run` | `adventure_id`, `label?` | Seeds state from the ruleset's `initial` values, applies the entry node's `knowledge_grants`, writes the run blob, returns the unguessable `run_id`. |
| `get_node` | `run_id` | Strictly read-only. Current node, public state, and the routes that pass all four checks (visible, legal, affordable, not consumed). Serves completed runs with an empty route list so the ending can be narrated. |
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
engine changes since the rest of `node.narrative` is already a blanket pass-through. All
of it is verified content-safe — no route or node narrative field reveals a hidden
destination, failure branch, or visibility condition.

What's exposed today, computed fresh on every call (never adding to what's persisted):

- **`node.read_aloud`** — the engine tracks visit count per node per run
  (`state.visited_nodes`, engine bookkeeping like `consumed_routes`, stripped from
  `publicState`) and picks exactly one text itself: `read_aloud_revisit` on a return
  visit if the node has one, explicit `read_aloud` otherwise, `narrative.arrival_text` as
  the last resort either way. `read_aloud_revisit` is no longer exposed raw alongside
  it — earlier revisions returned both and left the caller to guess which applied from
  conversation memory; the node projection now also reports `visit_count` and
  `presentation` (`"first_visit"` or `"revisit"`) so the choice is explicit rather than
  inferred.
- **`node.narrative`** — the rest of the node's narrative block (`arrival_text` is
  dropped here since it's already folded into `read_aloud`).
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
- **`add_item` effect records** — enriched with the item's `name`/`description`/
  `narrative` (its `narrative_semantics`) at the moment it's picked up, in `walk`'s live
  `effects_applied` only. `get_log` still sees the lean `{ op, item }` shape the spec
  documents — narrative flavour belongs at the moment of acquisition, not repeated on
  every later read of the inventory.

Still unexposed, a deliberate scope boundary rather than an oversight: the whole
top-level `semantic_layer` (world history, factions, named characters, motifs, dramatic
threads, the rumour/knowledge/condition catalogues) and region-level `narrative`. Both
are large, mostly static reference material better suited to a separate, dedicated tool
than repeated on every `get_node`/`walk` call — a real follow-up if wanted, not something
this covers.

Exposing the data is only half of it — the MCP `instructions` string returned in
`initialize` (see `SERVER_INFO` in `src/functions/mcp.js`) explicitly directs the calling
LLM to render every response as immersive second-person narrative prose, not surface the
structured output as data: open a node with `read_aloud`, weave in `narrative` where it
deepens the scene, voice route choices through `hook`/`stakes` rather than listing them,
let a combat's `narrative` (desire/fear/misconception/voice) drive how it fights rather
than just reporting stamina numbers, and narrate an item's `origin`/`symbolic_role` at
the moment it's picked up. Raw ids, dice math, and JSON field names are for the caller's
own reasoning, never for the player to see.

## Configuration

| Setting | Purpose |
| --- | --- |
| `ADVENTURE_STORAGE_CONNECTION_STRING` | Blob storage connection string (falls back to `AzureWebJobsStorage`). Never hardcoded, never a tool parameter. |
| `ADVENTURE_ASSET_PATH` | Optional override for the adventure JSON path. |
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
npm test                     # engine + protocol test suite (no Azure needed)
npm run validate             # audit the adventure asset
npm run check:reachability   # every node reachable, no non-terminal dead ends
npm run simulate             # 300 random playthroughs — soft locks, ending coverage
cp local.settings.sample.json local.settings.json
npm start                    # func start — needs Azure Functions Core Tools + Azurite
```

Once running, `POST http://localhost:7071/api/mcp` with a JSON-RPC body speaks MCP
directly — e.g. `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` returns all four tools.
`GET http://localhost:7071/api/health` reports readiness.

The static asset is validated at application start (broken references, unsupported
DSL operators) and the app refuses to boot on any error — games never fail
mid-walk on bad content.

## Content notes

The shipped graph is content revision 0.2.3. 0.2.0 was a purely additive narrative
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
