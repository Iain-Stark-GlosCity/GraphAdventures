// The website that walks the adventure. Plays the graph directly through
// web/engine.mjs (the browser port of the game engine) — every scene is the
// content's own read_aloud/exposition/rumour text and the engine's dice,
// with no LLM narrator in the loop. The run document autosaves to
// localStorage after every step so a delve survives a page reload.

import { indexAdventure, newRun, getNode, walk, EngineError } from "./engine.mjs";

const ASSET_URL = "../rust_wind_hills_adventure_knowledge_graph.json";

let adventure;
let runDoc = null;

const $ = (id) => document.getElementById(id);

// DOM builder: children that are strings become text nodes, so all content
// text is inert — nothing from the asset is ever parsed as HTML.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const prettify = (id) =>
  String(id)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

function saveKey() {
  return `rust-wind-hills:run:${adventure.version}`;
}

function saveRun() {
  try {
    localStorage.setItem(saveKey(), JSON.stringify(runDoc));
  } catch {
    // Private browsing / full storage: the game still plays, it just won't
    // survive a reload.
  }
}

function loadSavedRun() {
  try {
    const raw = localStorage.getItem(saveKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSavedRun() {
  try {
    localStorage.removeItem(saveKey());
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------ rendering ----

function storyAppend(...nodes) {
  const story = $("story");
  story.append(...nodes);
  nodes.at(-1)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function knowledgeTitle(fact) {
  return adventure.doc.semantic_layer?.knowledge_revelations?.[fact]?.title ?? prettify(fact);
}

function itemName(id) {
  return adventure.itemsById.get(id)?.name ?? prettify(id);
}

// Player-facing scene card for a node. Narrator-only subtext in the data —
// narrative.hidden_truth, a revelation's meaning — is deliberately never
// shown; this page has no narrator to hand it to.
function sceneCard(node, { arrivalEffects = [] } = {}) {
  const card = el("article", { class: "scene card" });
  card.append(
    el("p", { class: "kicker", text: node.presentation === "revisit" ? "Returning to" : "" }),
    el("h2", { text: node.title })
  );
  if (node.read_aloud) {
    for (const para of String(node.read_aloud).split(/\n{2,}/)) {
      card.append(el("p", { class: "read-aloud", text: para }));
    }
  }
  if (node.mandatory_exposition?.text) {
    card.append(el("p", { class: "exposition", text: node.mandatory_exposition.text }));
  }
  for (const rumour of node.rumour_delivery ?? []) {
    card.append(
      el(
        "blockquote",
        { class: "rumour" },
        el("p", { text: `“${rumour.text}”` }),
        el("footer", { text: `— ${rumour.speaker}` })
      )
    );
  }
  const closer = lookCloser(node.narrative);
  if (closer) card.append(closer);
  const learned = (arrivalEffects ?? []).filter((e) => e.op === "add_knowledge");
  for (const fact of learned) {
    card.append(knowledgeNote(fact));
  }
  return card;
}

// Optional flavour the narrator would normally weave in, offered as an
// expandable aside instead. hidden_truth stays hidden.
function lookCloser(narrative) {
  if (!narrative) return null;
  const parts = [];
  if (narrative.present_tension) parts.push(el("p", { text: narrative.present_tension }));
  if (narrative.local_history) parts.push(el("p", { text: narrative.local_history }));
  const sensory = narrative.sensory_details ?? [];
  if (sensory.length > 0) {
    parts.push(el("ul", {}, sensory.map((s) => el("li", { text: s }))));
  }
  if (parts.length === 0) return null;
  return el("details", { class: "look-closer" }, el("summary", { text: "Look closer" }), ...parts);
}

function knowledgeNote(effect) {
  const title = effect.title ?? knowledgeTitle(effect.fact);
  return el(
    "div",
    { class: "note knowledge-note" },
    el("p", { class: "note-title", text: `You learn: ${title}` }),
    effect.player_text ? el("p", { text: effect.player_text }) : null
  );
}

function itemNote(effect) {
  return el(
    "div",
    { class: "note item-note" },
    el("p", { class: "note-title", text: `You take: ${effect.name ?? prettify(effect.item)}` }),
    effect.description ? el("p", { text: effect.description }) : null
  );
}

function statDelta(effect) {
  const sign = effect.amount > 0 ? "+" : "";
  return `${prettify(effect.stat ?? effect.resource)} ${sign}${effect.amount}`;
}

// The between-scenes card: what you attempted, how the dice fell, what it
// cost you and what changed.
function stepCard(step, chosenRoute) {
  const card = el("div", { class: "step card" });
  card.append(el("p", { class: "step-action", text: `▸ ${chosenRoute?.label ?? step.route_label ?? prettify(step.route_id)}` }));

  for (const cost of step.costs_applied ?? []) {
    card.append(
      el("p", { class: "dice", text: `You pay ${-cost.amount} ${prettify(cost.resource)}.` })
    );
  }

  const res = step.resolution;
  if (res && res.type !== "combat") {
    const statName = chosenRoute?.test?.stat ?? "skill";
    const outcome = res.success ? "Success" : "Failure";
    card.append(
      el("p", {
        class: `dice ${res.success ? "success" : "failure"}`,
        text: `${prettify(statName)} test — you roll ${res.rolls.join(" + ")} = ${res.total} against ${res.target}. ${outcome}.`,
      })
    );
    if (statName === "luck") {
      card.append(el("p", { class: "dice-note", text: "Tested or not, luck spent is luck gone (luck −1)." }));
    }
  } else if (res && res.type === "combat") {
    card.append(combatReport(res));
  }

  if (step.route_resolution) {
    card.append(el("p", { class: "resolution", text: step.route_resolution }));
  }

  const deltas = [];
  for (const effect of step.effects_applied ?? []) {
    if (effect.op === "add_item") card.append(itemNote(effect));
    else if (effect.op === "remove_item")
      card.append(el("p", { class: "dice-note", text: `You give up: ${itemName(effect.item)}.` }));
    else if (effect.op === "add_knowledge") card.append(knowledgeNote(effect));
    else if (effect.op === "modify_stat" || effect.op === "modify_resource") deltas.push(statDelta(effect));
    else if (effect.op === "add_condition")
      card.append(el("p", { class: "dice-note", text: `You are now: ${prettify(effect.condition)}.` }));
    else if (effect.op === "remove_condition")
      card.append(el("p", { class: "dice-note", text: `No longer: ${prettify(effect.condition)}.` }));
  }
  if (deltas.length > 0) {
    card.append(el("p", { class: "dice-note", text: deltas.join(" · ") }));
  }
  return card;
}

function combatReport(res) {
  const wrap = el("div", { class: "combat" });
  const rounds = res.rounds ?? [];
  const dealt = rounds.filter((r) => r.damage_to === "enemy").length * 2;
  const taken = rounds.filter((r) => r.damage_to === "player").length * 2;
  const outcome = res.success
    ? `You prevail after ${rounds.length} round${rounds.length === 1 ? "" : "s"}`
    : `You fall after ${rounds.length} round${rounds.length === 1 ? "" : "s"}`;
  wrap.append(
    el("p", {
      class: `dice ${res.success ? "success" : "failure"}`,
      text: `Combat — ${res.encounter_name}. ${outcome} (you deal ${dealt}, you take ${taken}).`,
    })
  );
  const table = el(
    "table",
    {},
    el(
      "tr",
      {},
      ["Round", "Your attack", "Their attack", "Blow lands on"].map((h) => el("th", { text: h }))
    ),
    rounds.map((r, i) =>
      el(
        "tr",
        {},
        el("td", { text: String(i + 1) }),
        el("td", { text: `${r.player_rolls.join("+")} → ${r.player_attack}` }),
        el("td", { text: `${r.enemy_rolls.join("+")} → ${r.enemy_attack}` }),
        el("td", { text: r.damage_to === "enemy" ? "them (−2)" : r.damage_to === "player" ? "you (−2)" : "no one" })
      )
    )
  );
  wrap.append(el("details", { class: "rounds" }, el("summary", { text: "Blow by blow" }), table));
  return wrap;
}

// ------------------------------------------------------------- choices ----

function renderChoices(view) {
  document.querySelector(".choices")?.remove();

  if (view.status !== "active") {
    storyAppend(endingCard(view));
    return;
  }
  if (view.available_routes.length === 0) {
    storyAppend(
      el(
        "div",
        { class: "choices card stuck" },
        el("h3", { text: "No way on" }),
        el("p", {
          text:
            "Every path from here needs something you no longer have. The hills keep what the hills catch — this delve ends here.",
        }),
        el("button", { class: "primary-button", id: "stuck-restart", text: "Start a new delve" })
      )
    );
    $("stuck-restart").addEventListener("click", () => restart(false));
    return;
  }

  const box = el("div", { class: "choices" }, el("h3", { text: "What do you do?" }));
  for (const route of view.available_routes) {
    const badges = [];
    for (const cost of route.costs ?? []) {
      badges.push(el("span", { class: "badge cost", text: `−${cost.amount} ${prettify(cost.resource)}` }));
    }
    if (route.test?.type === "combat") {
      badges.push(el("span", { class: "badge test", text: `Fight: ${route.test.encounter_name}` }));
    } else if (route.test) {
      const mod = route.test.modifier ? ` ${route.test.modifier > 0 ? "+" : ""}${route.test.modifier}` : "";
      badges.push(el("span", { class: "badge test", text: `${prettify(route.test.stat)} test${mod}` }));
    }
    const button = el(
      "button",
      { class: "choice", "data-route": route.id },
      el("span", { class: "choice-label", text: route.label }),
      route.hook ? el("span", { class: "choice-hook", text: route.hook }) : null,
      route.stakes ? el("span", { class: "choice-stakes", text: route.stakes }) : null,
      badges.length > 0 ? el("span", { class: "choice-badges" }, ...badges) : null
    );
    button.addEventListener("click", () => choose(route));
    box.append(button);
  }
  storyAppend(box);
}

function endingCard(view) {
  const kind = view.node.id === "ending_dead" ? "You did not come back." : "The delve is over.";
  const card = el(
    "div",
    { class: "choices card ending" },
    el("h3", { text: kind }),
    el("p", { text: view.node.title }),
    el("button", { class: "primary-button", id: "ending-restart", text: "Start a new delve" })
  );
  card.querySelector("#ending-restart").addEventListener("click", () => restart(false));
  return card;
}

// --------------------------------------------------------------- sheet ----

function renderSheet(state) {
  const ps = adventure.doc.ruleset.player_state;
  const sheet = $("sheet");
  sheet.replaceChildren(el("h3", { text: "Your delver" }));

  const stats = el("div", { class: "stat-block" });
  for (const [name, def] of Object.entries(ps.stats)) {
    const value = state.stats[name];
    const row = el(
      "div",
      { class: "stat-row" },
      el("span", { class: "stat-name", text: prettify(name) }),
      el("span", { class: "stat-value", text: typeof def.max === "number" ? `${value} / ${def.max}` : String(value) })
    );
    if (typeof def.max === "number" && def.max > 0) {
      const span = def.max - Math.min(0, def.min ?? 0);
      const pct = Math.max(0, Math.min(1, (value - Math.min(0, def.min ?? 0)) / span));
      const bar = el("div", { class: `bar bar-${name}` }, el("div", { class: "bar-fill" }));
      bar.firstChild.style.width = `${Math.round(pct * 100)}%`;
      row.append(bar);
    }
    stats.append(row);
  }
  sheet.append(stats);

  const resources = el("div", { class: "stat-block" });
  for (const name of Object.keys(ps.resources)) {
    resources.append(
      el(
        "div",
        { class: "stat-row" },
        el("span", { class: "stat-name", text: prettify(name) }),
        el("span", { class: "stat-value", text: String(state.resources[name]) })
      )
    );
  }
  sheet.append(el("h4", { text: "Purse & supplies" }), resources);

  sheet.append(el("h4", { text: "Pack" }));
  if (state.inventory.length === 0) {
    sheet.append(el("p", { class: "empty", text: "Nothing but your clothes and nerve." }));
  } else {
    sheet.append(
      el(
        "ul",
        { class: "pack" },
        state.inventory.map((id) => {
          const item = adventure.itemsById.get(id);
          return el(
            "li",
            {},
            el("details", {}, el("summary", { text: item?.name ?? prettify(id) }), el("p", { text: item?.description ?? "" }))
          );
        })
      )
    );
  }

  sheet.append(el("h4", { text: "What you know" }));
  if (state.knowledge.length === 0) {
    sheet.append(el("p", { class: "empty", text: "Only the rumours that brought you here." }));
  } else {
    sheet.append(
      el(
        "ul",
        { class: "knowledge" },
        state.knowledge.map((fact) => {
          const rev = adventure.doc.semantic_layer?.knowledge_revelations?.[fact];
          return el(
            "li",
            {},
            rev?.player_text
              ? el("details", {}, el("summary", { text: rev.title ?? prettify(fact) }), el("p", { text: rev.player_text }))
              : el("span", { text: rev?.title ?? prettify(fact) })
          );
        })
      )
    );
  }

  if (state.conditions.length > 0) {
    sheet.append(
      el("h4", { text: "Conditions" }),
      el("ul", { class: "conditions" }, state.conditions.map((c) => el("li", { text: prettify(c) })))
    );
  }

  const flags = Object.entries(state.flags).filter(([, v]) => v !== false && v !== "none");
  if (flags.length > 0) {
    sheet.append(
      el("h4", { text: "Standing" }),
      el("ul", { class: "conditions" }, flags.map(([k, v]) => el("li", { text: v === true ? prettify(k) : `${prettify(k)}: ${prettify(String(v))}` })))
    );
  }

  const journal = el("details", { class: "journal" }, el("summary", { text: `Journal (${runDoc?.log.length ?? 0} steps)` }));
  const list = el("ol");
  for (const step of runDoc?.log ?? []) {
    const outcome = step.resolution ? (step.resolution.success ? " ✓" : " ✗") : "";
    list.append(el("li", { text: `${prettify(step.from)} → ${prettify(step.to)}${outcome}` }));
  }
  journal.append(list);
  sheet.append(journal);
}

// ---------------------------------------------------------------- flow ----

let lastStepAt = 0;

function choose(route) {
  // New choices render instantly, often under the pointer that just chose —
  // swallow the second half of a double-click instead of walking twice.
  if (Date.now() - lastStepAt < 350) return;
  lastStepAt = Date.now();
  document.querySelectorAll(".choices .choice").forEach((b) => (b.disabled = true));
  let step;
  try {
    step = walk(adventure, runDoc, route.id);
  } catch (e) {
    document.querySelectorAll(".choices .choice").forEach((b) => (b.disabled = false));
    if (e instanceof EngineError) {
      // State and the page disagree (e.g. an old tab): re-sync from the run.
      document.querySelector(".choices")?.remove();
      renderChoices(getNode(adventure, runDoc));
      return;
    }
    throw e;
  }
  saveRun();
  document.querySelector(".choices")?.remove();
  storyAppend(stepCard(step, route), sceneCard(step.node, { arrivalEffects: step.arrival_effects_applied }));
  renderSheet(step.state);
  renderChoices(step);
}

function beginNewRun() {
  const { doc, result } = newRun(adventure);
  runDoc = doc;
  saveRun();
  showGame();
  $("story").replaceChildren();
  if (result.opening_context) {
    storyAppend(el("div", { class: "scene card opening" }, ...String(result.opening_context).split(/\n{2,}/).map((p) => el("p", { text: p }))));
  }
  storyAppend(sceneCard(result.node, { arrivalEffects: result.arrival_effects_applied }));
  renderSheet(result.state);
  renderChoices(result);
}

function resumeRun(saved) {
  runDoc = saved;
  showGame();
  const view = getNode(adventure, runDoc);
  $("story").replaceChildren(
    el("div", { class: "scene card opening" }, el("p", { text: `You pick your delve back up where you left it, ${runDoc.log.length} step${runDoc.log.length === 1 ? "" : "s"} in. The journal on your character sheet remembers the way you came.` }))
  );
  storyAppend(sceneCard(view.node));
  renderSheet(view.state);
  renderChoices(view);
}

function restart(confirmFirst = true) {
  if (confirmFirst && runDoc?.status === "active" && runDoc.log.length > 0) {
    if (!window.confirm("Abandon this delve and start over?")) return;
  }
  clearSavedRun();
  beginNewRun();
}

function showGame() {
  $("start-screen").hidden = true;
  $("game").hidden = false;
  $("restart-button").hidden = false;
}

function showStartScreen(saved) {
  $("intro-text").textContent =
    adventure.doc.graph.opening_context?.player_facing_introduction ?? adventure.doc.graph.narrative_premise ?? "";
  $("start-screen").hidden = false;
  $("continue-button").hidden = !saved;
  if (saved) {
    $("begin-button").textContent = "Begin a fresh delve";
    $("continue-button").addEventListener("click", () => resumeRun(saved));
  }
  $("begin-button").addEventListener("click", () => {
    clearSavedRun();
    beginNewRun();
  });
}

async function boot() {
  try {
    const response = await fetch(ASSET_URL);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    adventure = indexAdventure(await response.json());
  } catch (e) {
    $("loading").hidden = true;
    const err = $("load-error");
    err.hidden = false;
    err.textContent = `Could not load the adventure asset (${e.message}). Serve this page from the repository — e.g. npm run web — so ${ASSET_URL} resolves.`;
    return;
  }
  $("loading").hidden = true;
  $("adventure-title").textContent = adventure.title;
  $("adventure-subtitle").textContent = adventure.subtitle ?? "";
  document.title = adventure.title;
  $("restart-button").addEventListener("click", () => restart(true));

  const saved = loadSavedRun();
  showStartScreen(saved && saved.status === "active" ? saved : null);
}

boot();
