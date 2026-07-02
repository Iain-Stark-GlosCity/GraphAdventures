"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { evalCondition, allPass } = require("../src/engine/conditions");

const state = {
  stats: { skill: 8, stamina: 16, luck: 8, reputation: 1 },
  resources: { gold: 15, provisions: 3, torch_turns: 0 },
  inventory: ["standard_delver_licence"],
  conditions: ["soaked"],
  knowledge: ["rumour_red_quill"],
  flags: { permit_status: "licensed", registrar_alerted: false },
};

test("each operator evaluates against state", () => {
  assert.ok(evalCondition({ op: "has_item", item: "standard_delver_licence" }, state));
  assert.ok(!evalCondition({ op: "has_item", item: "counterfeit_permit" }, state));
  assert.ok(evalCondition({ op: "missing_item", item: "counterfeit_permit" }, state));
  assert.ok(evalCondition({ op: "flag_is", flag: "permit_status", value: "licensed" }, state));
  assert.ok(evalCondition({ op: "flag_not", flag: "permit_status", value: "revoked" }, state));
  assert.ok(evalCondition({ op: "stat_at_least", stat: "reputation", value: 1 }, state));
  assert.ok(!evalCondition({ op: "stat_at_least", stat: "reputation", value: 2 }, state));
  assert.ok(evalCondition({ op: "stat_below", stat: "skill", value: 9 }, state));
  assert.ok(!evalCondition({ op: "resource_at_least", resource: "torch_turns", value: 1 }, state));
  assert.ok(evalCondition({ op: "has_condition", condition: "soaked" }, state));
  assert.ok(evalCondition({ op: "missing_condition", condition: "spore_dreams" }, state));
  assert.ok(evalCondition({ op: "knows", fact: "rumour_red_quill" }, state));
  assert.ok(!evalCondition({ op: "not_knows", fact: "rumour_red_quill" }, state));
});

test("any blocks are an OR inside an otherwise all-must-pass list", () => {
  const conds = [
    {
      any: [
        { op: "has_item", item: "counterfeit_permit" },
        { op: "has_item", item: "standard_delver_licence" },
      ],
    },
    { op: "flag_not", flag: "registrar_alerted", value: true },
  ];
  assert.ok(allPass(conds, state));
  assert.ok(
    !allPass(
      [{ any: [{ op: "has_item", item: "counterfeit_permit" }, { op: "knows", fact: "nope" }] }],
      state
    )
  );
});

test("unknown operator throws (caught at startup validation, never mid-game)", () => {
  assert.throws(() => evalCondition({ op: "wat" }, state));
});
