"use strict";

/**
 * The tool manifest served by tools/list and dispatched by tools/call.
 * Each handler receives (args, engine) and returns the JSON-serializable
 * result the client sees as the tool's output.
 *
 * The manifest is adventure-agnostic: it takes the hosted adventures only
 * to name them in the tool descriptions, so a caller reading tools/list
 * already knows what adventure_ids new_run accepts.
 */
function buildTools(adventures) {
  const ids = adventures.map((a) => a.id);
  return [
    {
      name: "list_adventures",
      description:
        "Catalogue of every adventure this server hosts: adventure_id, title, genre, tone, premise and size. Call this first to choose what to play (or offer the choice to the player), then pass the chosen adventure_id to new_run.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: (args, engine) => engine.listAdventures(),
    },
    {
      name: "new_run",
      description:
        `Start a new run of one of the hosted adventures (${ids.join(", ")}). Returns the run_id, the entry node and the freshly seeded player state.`,
      inputSchema: {
        type: "object",
        properties: {
          adventure_id: {
            type: "string",
            description: `Adventure to run — one of: ${ids.join(", ")}. See list_adventures for what each one is.`,
          },
          label: {
            type: "string",
            description: "Optional caller-supplied label for the run.",
          },
        },
        required: ["adventure_id"],
      },
      handler: (args, engine) => engine.newRun(args.adventure_id, args.label ?? null),
    },
    {
      name: "get_node",
      description:
        "Read-only view of a run: current node, player state and the routes available right now. Works on completed runs too (with no routes) so the ending can be narrated.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string", description: "The run to inspect." },
        },
        required: ["run_id"],
      },
      handler: (args, engine) => engine.getNode(args.run_id),
    },
    {
      name: "walk",
      description:
        "Take a route from the current node. Requires the run's current revision (from get_node); costs are spent, any test is rolled, effects applied, and the committed step is returned, together with the new node and its available_routes — usually no follow-up get_node call is needed.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string", description: "The run to advance." },
          route_id: {
            type: "string",
            description: "The route to take, chosen from get_node's available_routes.",
          },
          expected_revision: {
            type: "number",
            description: "The revision the caller believes the run is at; mismatches are rejected.",
          },
        },
        required: ["run_id", "route_id", "expected_revision"],
      },
      handler: (args, engine) => engine.walk(args.run_id, args.route_id, args.expected_revision),
    },
    {
      name: "get_log",
      description:
        "Full step log for a run. Still served if the deployed adventure content has changed, flagged with adventure_mismatch.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string", description: "The run whose log to fetch." },
        },
        required: ["run_id"],
      },
      handler: (args, engine) => engine.getLog(args.run_id),
    },
  ];
}

module.exports = { buildTools };
