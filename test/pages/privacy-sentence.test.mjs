#!/usr/bin/env node
/*
 * privacy-sentence.test.mjs — XLS-4754 (owner ruling 2026-10-14).
 *
 * The privacy page carries the one data-handling sentence that the xlsx-for-ai connector also
 * states (xlsx-for-ai-server src/mcp/claude-toolset.ts DATA_HANDLING_SENTENCE, pinned by its own
 * test). The two must match word for word: change both together, never one.
 * Also guards against the retired capture wording coming back.
 *
 * Run: node test/pages/privacy-sentence.test.mjs   (npm test runs it too). Exit 0 = pass, 1 = fail.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SENTENCE =
  "Files are processed for your request and not stored; upload handles and download links expire after 60 minutes; file contents are not logged or used for training.";

const html = readFileSync(join(ROOT, "privacy/index.html"), "utf8");
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const failures = [];

if (!text.includes(SENTENCE)) failures.push("privacy page does not carry the connector's data-handling sentence verbatim");
if (!/id="data-handling"/.test(html)) failures.push('the sentence lost its id="data-handling" anchor');
for (const retired of [/redacted copy of the workbook/i, /full_bytes/, /R2 lifecycle/i, /not currently enabled/i]) {
  if (retired.test(text)) failures.push(`retired capture wording is back: ${retired}`);
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("PASS privacy page carries the data-handling sentence; no retired capture wording");
