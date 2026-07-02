# Rust Wind Hills — MCP Adventure Engine

An MCP server that runs `rust_wind_hills_adventure_knowledge_graph.json`, built to
[`rust-wind-hills-mcp-spec.md`](rust-wind-hills-mcp-spec.md) (v4). Azure Functions v4,
Node.js 24, Azure Blob Storage for run persistence, following the same `func-*` MCP
wiring pattern as the Difference Engine / llm-library Functions apps.

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
  functions/
    mcpTools.js        Azure Functions MCP tool triggers wiring the engine to the host
    health.js          anonymous GET /api/mcp readiness probe, used by CI and for ops
scripts/
  validate-adventure.js         manual audit script (same validation the app runs at startup)
  verify-functions-entrypoint.js  CI smoke gate: requires every src/functions/*.js file cold
  provision-azure.sh            one-shot resource group + storage + Function App bootstrap
.github/workflows/
  main_func-rust-wind-hills-26487.yml  build, test, zip and Kudu-deploy on push to main
test/                    node:test suite (in-memory store, scripted dice)
```

## Tools

| Tool | Arguments | Behaviour |
| --- | --- | --- |
| `new_run` | `adventure_id`, `label?` | Seeds state from the ruleset's `initial` values, applies the entry node's `knowledge_grants`, writes the run blob, returns the unguessable `run_id`. |
| `get_node` | `run_id` | Strictly read-only. Current node, public state, and the routes that pass all four checks (visible, legal, affordable, not consumed). Serves completed runs with an empty route list so the ending can be narrated. |
| `walk` | `run_id`, `route_id`, `expected_revision` | Optimistically-concurrent step: costs spent on the attempt, test rolled, effects applied, stats clamped, death invariant enforced, step committed with `If-Match` and returned exactly as logged. |
| `get_log` | `run_id` | Full step log; exempt from the adventure-hash hard-stop (flagged `adventure_mismatch` instead). |

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
it ships), runs the test suite, prunes dev dependencies, zips the runtime files, then
uploads via Kudu `zipdeploy`, syncs triggers, and polls the anonymous `/api/mcp` health
endpoint (retrying with a host restart once if it doesn't come up). Auth is the Function
App's publish profile, stored as the `AZUREAPPSERVICE_PUBLISHPROFILE_...` GitHub secret
(get it with `az functionapp deployment list-publishing-profiles --xml`).

Because the app is deployed with `WEBSITE_RUN_FROM_PACKAGE=1`, each deploy is an atomic,
read-only mount of the new zip rather than a file-by-file extraction over the running
app — no partial-deploy window, no file locks.

## Running locally

```bash
npm install
npm test            # engine test suite (no Azure needed)
npm run validate    # audit the adventure asset
cp local.settings.sample.json local.settings.json
npm start           # func start — needs Azure Functions Core Tools + Azurite
```

The MCP tool trigger comes from the experimental extension bundle pinned in
`host.json` (`Microsoft.Azure.Functions.ExtensionBundle.Experimental`). The wiring
supports both `app.mcpTool` and the older generic `mcpToolTrigger` registration, so
it tracks whichever `@azure/functions` release is installed.

The static asset is validated at application start (broken references, unsupported
DSL operators) and the app refuses to boot on any error — games never fail
mid-walk on bad content.

## Content notes

The shipped graph is content revision 0.1.1, which already wires up the
torchbearer contract and the previously dangling flags called out in the spec's
"known content bugs" section.

Random-playthrough simulation (300 runs) surfaces two *content* soft-locks the
runtime deliberately does not paper over: a player can reach `vault_antechamber`
(all three exits need items) or `gate_of_tithes` (all four exits need a permit,
a supplies pack, or 3 gold) without the means to leave. Per the spec, content
fixes belong in the JSON, not the engine.
