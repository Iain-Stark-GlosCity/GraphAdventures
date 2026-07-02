# Rust Wind Hills — MCP Build Spec (v4, final)

Build-ready. This closes the last schema mismatch and two implementation clarifications on top of
v3. No further architecture changes are justified after this.

## Runtime and hosting

- Azure Functions v4, Node.js, Windows.
- Node version: 24.
- Azure Blob Storage for run persistence.
- Connection string read from an environment variable (e.g. `AzureWebJobsStorage` or a dedicated
  `ADVENTURE_STORAGE_CONNECTION_STRING`) — never hardcoded, never passed as a tool parameter.
- Follows the same `func-*` MCP wiring pattern as the existing Difference Engine / llm-library
  Functions apps: one Function app exposing the MCP surface, tools implemented as the four
  functions below.


## Field mapping — read these directly from the static asset, don't invent names

Pseudocode throughout this spec is illustrative, not literal — the actual implementation is
Node.js on Azure Functions v4, not Python. Translate directly (e.g. `hashlib.sha256` →
Node's `crypto.createHash("sha256")`, `secrets.randbelow` → `crypto.randomInt`).

```python
adventure_id      = adventure["graph"]["id"]              # "rust-wind-hills-dungeon"
adventure_version = adventure["schema"]["version"]        # "0.1.0"
adventure_hash    = f"sha256:{sha256(adventure_file.read_bytes()).hexdigest()}"

# player_state defaults are under "initial", not "default"
state["stats"][name]     = definition["initial"]
state["resources"][name] = definition["initial"]
state["flags"][name]     = definition["initial"]

# read collection starting values from source rather than assuming they're always empty
state["inventory"]  = list(adventure["ruleset"]["player_state"]["collections"]["inventory"]["initial"])
state["conditions"] = list(adventure["ruleset"]["player_state"]["collections"]["conditions"]["initial"])
state["knowledge"]  = list(adventure["ruleset"]["player_state"]["collections"]["knowledge"]["initial"])
```

**`route.kind` is descriptive metadata only — it never controls availability.** 13 routes are
`kind: "secret"`, but only 5 of those have an actual `visibility` block; the other 8 (e.g. the
maintenance grille, impossible map line, forge conduit) are meant to be visible once you reach
their originating node. The only thing that hides a route is a `visibility` block whose conditions
don't pass. Do not add a rule that hides anything tagged `kind: "secret"`.

**`knowledge_grants` is an array of strings, not effect objects**:
```json
"knowledge_grants": ["rumour_crown_ember_salt", "rumour_ninth_lock"]
```
The runtime converts each string into a synthetic log record — the JSON never contains
`{"op": "add_knowledge", ...}` shapes at node level, only at route-effect level. Conversion:
```python
for fact in destination_node.get("knowledge_grants", []):
    if fact not in state["knowledge"]:
        state["knowledge"].append(fact)
        arrival_effects_applied.append({
            "op": "add_knowledge", "fact": fact, "source": destination_node["id"]
        })
```
Same conversion applies in `new_run` for the entry node.

## Storage

One blob container (`adventure-runs`), one blob per run: `run:{run_id}.json`

```json
{
  "schema_version": "1.0",
  "run_id": "abc123",
  "label": null,
  "adventure_id": "rust-wind-hills-dungeon",
  "adventure_version": "0.1.0",
  "adventure_hash": "sha256:...",
  "revision": 0,
  "status": "active",
  "created_at": "2026-07-02T17:00:00Z",
  "updated_at": "2026-07-02T17:00:00Z",
  "state": {
    "current_node": "barrowgate_square",
    "stats": { "skill": 8, "stamina": 16, "luck": 8, "reputation": 0 },
    "resources": { "gold": 15, "provisions": 3, "torch_turns": 12 },
    "inventory": [],
    "conditions": [],
    "knowledge": [],
    "consumed_routes": [],
    "flags": {
      "permit_status": "none",
      "registrar_alerted": false,
      "rat_king_dead": false,
      "ninth_lock_open": false,
      "crown_claimed": false,
      "crown_attunement": "none"
    }
  },
  "log": []
}
```

Hash is exact deployed file bytes, not canonicalised JSON — formatting-only edits invalidate runs,
intentionally. `get_node`/`walk` hard-stop on mismatch; `get_log` still returns the log with
`{"adventure_mismatch": true, "run_adventure_hash": ..., "deployed_adventure_hash": ...}`.

## Effect application

No `test.effects` exist anywhere in the graph — only `test.failure_effects`.
```
effects = route.get("effects", []) if success else test.get("failure_effects", [])
```
A route without a `test` is an automatic success and applies `route.effects` directly.

## Tools

### `new_run(adventure_id, label=None)`
Seeds `state` from `ruleset.player_state["initial"]` values and `graph.entry_node`. Applies the
entry node's `knowledge_grants` (converted per above) before the blob is written. `run_id` is a
cryptographically unguessable token; `label` stored as given or `null`.

### `get_node(run_id)` — strictly read-only, no mutation, no revision bump, no ETag write
May be called when `status == "completed"` — not just `"active"`. In that case it returns the
current terminal node, current state, and an empty `available_routes` array; it's still subject to
the adventure-hash check. Only `walk` requires an active run. Without this, the caller has no way
to retrieve and narrate the ending after the final `walk` call sets `status` to `"completed"`.

Evaluates every outgoing route through four checks, returns only what passes all four:
- `visible` — passes if no `visibility` block, or its `conditions` pass
- `legal` — ordinary `conditions` / `any` blocks
- `affordable` — `costs` payable without going negative
- `not_consumed` — `route.id` not in `state.consumed_routes`

Never expose `failure_to`, `failure_effects`, or `visibility` details for filtered-out routes.

```json
{
  "run_id": "abc123",
  "revision": 7,
  "state": { "stats": {}, "resources": {}, "inventory": [], "conditions": [], "knowledge": [], "flags": {} },
  "node": { "id": "barrowgate_square", "title": "Barrowgate", "summary": "...", "read_aloud": "..." },
  "available_routes": [
    { "id": "r015", "label": "Purchase a standard licence",
      "costs": [ { "resource": "gold", "amount": 6 } ], "test": null }
  ]
}
```

### `walk(run_id, route_id, expected_revision)`

1. Load run + blob ETag.
2. Verify `adventure_id`/`adventure_version`/`adventure_hash`; reject on mismatch.
3. Confirm `status == "active"`.
4. Confirm `expected_revision == revision`; reject with conflict otherwise.
5. Resolve `route_id`; confirm `route.from == state.current_node`.
6. Check `visibility`. 7. Check `conditions`/`any`. 8. Check not consumed. 9. Check affordability.
   **Steps 5–9 all fail into the same generic `route_unavailable` error.** The server may log the
   precise internal reason, but the MCP response itself must never distinguish unknown route ID,
   wrong-node, hidden, illegal, consumed, or unaffordable from each other — an implementation that
   returns a distinct "route not found" for a guessed secret route leaks exactly what it's meant
   to hide.
10. Deduct costs (spent on the attempt, before the test resolves).
11. If `one_time`, add `route_id` to `consumed_routes` now.
12. Resolve `test` if present: read `test.stat` (don't infer from `test.type` — r063 is typed
    `skill`, tests `luck`); `target = state.stats[test.stat] + test.modifier` (missing `modifier`
    treated as 0); `success = roll_total <= target`; if `test.stat == "luck"`, reduce
    `state.stats.luck` by 1 regardless of outcome. `combat` uses the round loop below. No `test` →
    automatic success.
13. Apply `route.effects` on success, `test.failure_effects` on failure.
14. Destination = `route.to` on success, `test.failure_to` on failure.
15. Clamp stats to declared `min`/`max`; resources never go below zero; item/fact adds and removes
    are idempotent no-ops when already in/absent from state.
16. Death invariant: if `stamina <= 0`, override destination to `ending_dead`, `status = "completed"`.
17. Set `current_node` = destination.
18. Apply destination node's `knowledge_grants` (string→record conversion above), recorded in
    `arrival_effects_applied`.
19. If destination in `graph.terminal_nodes`, `status = "completed"`.
20. Increment `revision`.
21. Construct the step (shape below) with `revision_after`, `state_after`, `committed_at` timestamp.
22. Append to `log`.
23. Save with `If-Match: <etag>`. **On a failed write (ETag conflict), discard the resolution
    entirely — do not append or return an uncommitted roll as though it happened.** Return a
    conflict error; the caller re-fetches via `get_node` and retries.
24. Return the committed step, identical to what's in `log`.

Dice inline:
```python
def roll(dice="2d6"):
    count, sides = map(int, dice.split("d"))
    return [secrets.randbelow(sides) + 1 for _ in range(count)]
```

Skill/luck: `{ "type": "skill", "rolls": [3,4], "total": 7, "target": 8, "success": true }`

Combat (baseline algorithm, fills a content gap — `special` text stays descriptive-only in v1):
```python
player_rolls = roll("2d6"); enemy_rolls = roll("2d6")
player_attack = state["stats"]["skill"] + sum(player_rolls)
enemy_attack  = encounter["skill"] + sum(enemy_rolls)
# lower attack loses 2 stamina; tie = no damage; repeat until either stamina <= 0
```
```json
{
  "type": "combat", "encounter_id": "rat_king", "success": true,
  "rounds": [
    { "player_rolls": [4,3], "enemy_rolls": [2,5], "player_attack": 15, "enemy_attack": 14,
      "damage_to": "enemy", "damage": 2, "player_stamina_after": 16, "enemy_stamina_after": 6 }
  ]
}
```

Step shape (returned == logged):
```json
{
  "step_id": "9f2a1c",
  "revision_before": 7,
  "revision_after": 8,
  "status_after": "active",
  "committed_at": "2026-07-02T17:03:11Z",
  "from": "barrowgate_square",
  "route_id": "r012",
  "costs_applied": [ { "resource": "torch_turns", "amount": -2 } ],
  "resolution": { "...": "..." },
  "to": "licensing_hall",
  "effects_applied": [ { "op": "add_item", "item": "standard_delver_licence" } ],
  "arrival_effects_applied": [],
  "state_after": { "...": "..." }
}
```

Generic error for any unavailable route:
```json
{ "code": "route_unavailable", "message": "That route is not available from the current position." }
```

### `get_log(run_id)`
Full `log` array; exempt from the hash hard-stop, returns with `adventure_mismatch: true` if
content has moved on.

## Static asset loading (startup, not a tool)

- Index nodes, routes, and encounters by ID once at load time rather than scanning arrays per call.
- Validate the asset once at application start — broken references, unsupported DSL operators —
  and fail startup rather than failing mid-game. This is internal validation, not another MCP tool;
  the manual audit script stays a script.

## Still deliberately simple

Single blob, full state snapshot per log step, dice inline in `walk`, no separate services, no
RDF/rules-admin/Overwatch surfaces, no split containers for state vs. log.

## Known content bugs to fix in the JSON, not the runtime

- `torchbearer_contract` has no mechanical hook anywhere — costs gold, does nothing. Wire it up or cut it.
- `registrar_alerted`, `rat_king_dead`, `ninth_lock_open`, `crown_claimed`, `crown_attunement` are
  set but never checked by any route condition. The crown pair is arguably fine as ending-flavour;
  `registrar_alerted`/`rat_king_dead` read like they were meant to gate something later.
