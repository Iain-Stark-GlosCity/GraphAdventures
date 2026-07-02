#!/usr/bin/env node
"use strict";

// CI smoke gate: requires every file under src/functions/ the same way the
// Azure Functions Node worker would at cold start (package.json's "main"
// glob), with a syntactically valid but non-functional storage connection
// string stubbed in — BlobServiceClient.fromConnectionString only parses
// the string at construction time; it makes no network call until a read,
// create or update, so this stays offline. Failing here means the
// deployed app would fail to start; catching that before the zip ever
// reaches Azure is the whole point.

process.env.ADVENTURE_STORAGE_CONNECTION_STRING =
  process.env.ADVENTURE_STORAGE_CONNECTION_STRING ??
  "DefaultEndpointsProtocol=https;AccountName=stub;AccountKey=c3R1Yg==;EndpointSuffix=core.windows.net";

const fs = require("node:fs");
const path = require("node:path");

const functionsDir = path.join(__dirname, "..", "src", "functions");
const files = fs.readdirSync(functionsDir).filter((f) => f.endsWith(".js"));

let failed = false;
for (const file of files) {
  const full = path.join(functionsDir, file);
  try {
    require(full);
    console.log(`OK: ${file}`);
  } catch (e) {
    failed = true;
    console.error(`FAILED to load ${file}:\n${e.stack ?? e}`);
  }
}

if (failed) {
  console.error("\nOne or more Functions entrypoint files failed to load.");
  process.exit(1);
}
console.log(`\nAll ${files.length} Functions entrypoint file(s) loaded cleanly.`);
