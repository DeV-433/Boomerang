/**
 * Step 9.7: scans log files from a run for personal data and secrets. Prints counts and line
 * numbers only, never the matched text, so the scan itself leaks nothing.
 *   npm run scan:logs -- <file> [<file> ...]
 * Looks for: email addresses, pay-page tokens, bearer tokens, Groq keys, PayPal access tokens,
 * and the literal value of every secret configured in .env (8 characters or longer).
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "@boomerang/core";

const SECRET_KEYS = [
  "PAYPAL_CLIENT_SECRET",
  "PAY_LINK_SECRET",
  "SIM_WEBHOOK_SECRET",
  "OPERATOR_TOKEN",
  "GROQ_API_KEY",
  "GROQ_API_KEYS",
  "GEMINI_API_KEY",
  "DATABASE_URL",
  "RENDER_DATABASE_URL",
  "VITE_AG_GRID_LICENSE_KEY",
  "VITE_BRYNTUM_LICENSE_KEY",
] as const;

loadConfig(); // loads .env into process.env
const secrets = SECRET_KEYS.flatMap((k) =>
  (process.env[k] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length >= 8)
    .map((value) => ({ name: k, value })),
);
const PATTERNS: [string, RegExp][] = [
  ["email address", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ["pay-page token", /\/pay\/(?!\[token\])[^\s/?#"'<>]{12,}/],
  ["bearer token", /Bearer\s+(?!\[redacted\])[\w.~+/=-]{8,}/i],
  ["Groq key", /\bgsk_[A-Za-z0-9]{8,}/],
  ["PayPal access token", /\bA21AA[\w-]{16,}/],
];

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length === 0) throw new Error("give one or more log files");
let lines = 0;
const hits: Record<string, number[]> = {};
for (const file of files) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line) return;
      lines++;
      for (const [name, re] of PATTERNS) if (re.test(line)) (hits[name] ??= []).push(i + 1);
      for (const s of secrets) if (line.includes(s.value)) (hits[`secret ${s.name}`] ??= []).push(i + 1);
    });
}
console.log(
  `scanned ${lines} log lines in ${files.length} files for ${PATTERNS.length} patterns and ${secrets.length} secret values`,
);
if (Object.keys(hits).length === 0) console.log("  none found");
for (const [name, at] of Object.entries(hits))
  console.log(`  ${name}: ${at.length} lines (first at line ${at.slice(0, 5).join(", ")})`);
if (Object.keys(hits).length > 0) process.exitCode = 1;
