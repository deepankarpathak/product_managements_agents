#!/usr/bin/env node
// Read-only Trino runner for /investigate. Reuses the dashboards' Trino client and credentials
// (prd-agent/.env), so the same service account, source tag and concurrency cap apply.
//
//   node scripts/trino-run.mjs "SELECT ..."                 # print rows as JSON
//   node scripts/trino-run.mjs --out artifacts/data/x/q1.json "SELECT ..."
//   echo "SELECT ..." | node scripts/trino-run.mjs -
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");

for (const f of [path.join(root, "backend", ".env"), path.join(root, ".env")]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
process.env.TRINO_SOURCE ||= "premium-investigate";

const { runTrino } = await import(path.join(root, "backend", "trinoClient.js"));

const args = process.argv.slice(2);
let out = null;
const oi = args.indexOf("--out");
if (oi >= 0) out = args.splice(oi, 2)[1];
let sql = args.join(" ").trim();
if (sql === "-") sql = fs.readFileSync(0, "utf8").trim();
if (!sql) {
  console.error('usage: node scripts/trino-run.mjs [--out file.json] "SELECT ..."');
  process.exit(2);
}
// Read-only guard: one statement, SELECT / WITH / SHOW / DESCRIBE only.
const bare = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/;\s*$/, "");
if (bare.includes(";") || !/^(select|with|show|describe)\b/i.test(bare)) {
  console.error("Refused: only a single read-only SELECT / WITH / SHOW / DESCRIBE statement is allowed.");
  process.exit(3);
}

try {
  const rows = await runTrino(bare, { timeoutMs: 300000 });
  const json = JSON.stringify(rows, null, 2);
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
    console.log(`${rows.length} rows → ${out}`);
  } else {
    console.log(json);
  }
} catch (e) {
  console.error(`Trino error: ${e.message}`);
  process.exit(1);
}
