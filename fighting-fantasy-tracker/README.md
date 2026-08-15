# Fighting Fantasy Gamebook Tracker

An offline-first companion PWA for playing a physical Fighting Fantasy
gamebook at the table. It is not the book — there's no book text here,
just a dice roller, combat tracker, character sheet and section tracker
that live on your phone home screen and never need a signal.

Opens straight to **Dice / Combat**. Tabs:

1. **Dice / Combat** — 2d6/1d6 roller with a recent-rolls log, Test Your
   Luck, and a combat tracker that fights a sequence of enemies against
   your character sheet's live SKILL/STAMINA (attack rounds are
   2d6+SKILL vs 2d6+SKILL, loser takes 2 STAMINA, with Test Your Luck
   available to swing the damage on the last round).
2. **Character** — SKILL/STAMINA/LUCK steppers (current + initial),
   inventory, Gold and Provisions, and a "Roll New Character" button
   using the standard FF chargen formulas.
3. **Sections** — current section, notes, a choice list with
   back-navigation history and a visited-sections list, for
   backtracking through the book's branching structure.

Save state autosaves to IndexedDB. Multiple save slots are supported
(💾 button, top right) along with JSON export/import per slot.

## Stack

- Vite + vanilla JS, no framework
- `vite-plugin-pwa` (generateSW) for the manifest and a fully
  precaching service worker — zero runtime network dependency
- `idb` for IndexedDB save-state persistence
- Hand-rolled PNG icon generator (`scripts/generate-icons.mjs`) since
  the build has no other image dependencies

## Develop

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview   # serve dist/ locally to sanity-check the SW
```

Regenerate icons (only needed if you change the design in
`scripts/generate-icons.mjs`):

```bash
npm run icons
```

## Deploy — GitHub Pages

This repo's GitHub Pages site is what actually hosts the tracker.
`.github/workflows/pages-deploy-ff-tracker.yml` builds this folder
(`npm ci && npm run build`) and publishes `dist/` via
`actions/upload-pages-artifact` + `actions/deploy-pages` on every push
to `main` that touches `fighting-fantasy-tracker/**` (or on-demand via
`workflow_dispatch`).

**One-time manual step required**: the repo's Pages source needs to be
switched from the classic "Deploy from a branch" method to "GitHub
Actions" — GitHub Settings → Pages → Build and deployment → Source →
**GitHub Actions**. Until that's flipped, the workflow will build and
upload successfully but nothing goes live. This replaces whatever the
repo's Pages site was serving before (it previously published the raw
repo root, including `web/`); the tracker becomes the entire published
site.

Once live:

1. Vite's `base: './'` (see `vite.config.js`) makes the build fully
   relative, so it works unmodified at the project-pages subpath
   (`https://<owner>.github.io/GraphAdventures/`) with no extra config.
2. GitHub Pages serves over HTTPS by default, which is required for
   both service worker registration and offline "Add to Home Screen"
   support on iOS.
3. On the iPhone: Safari → Share → **Add to Home Screen**.
4. Turn on Airplane Mode and relaunch from the home screen before
   trusting it at the table — that's the real test.

### Alternative — Azure Static Web Apps

Not currently used, but the app is portable there too if that ever
changes: create a free-tier Static Web App pointed at this repo with
**App location** `fighting-fantasy-tracker`, **Output location**
`dist`, **Build command** `npm run build` (the portal wizard commits
its own deploy workflow). `staticwebapp.config.json` in this folder
already handles the SPA fallback routing that setup needs.

## Data model

Save data is plain JSON (`GameState`: character sheet, current section,
history, section nodes, combat log) — see `src/state/defaults.js` for
the exact shape. Export/import round-trips this JSON per save slot.
