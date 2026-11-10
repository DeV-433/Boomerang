// Step 10.3: records the fallback demo video by walking the demo script (docs/demo.md) in headless
// Chromium against a running dashboard and API, then encoding the frames with ffmpeg.
//   npm run demo:reset && node scripts/record-demo.mjs [--dashboard http://127.0.0.1:5173]
//     [--api http://localhost:3000] [--out docs/demo/boomerang-demo.mp4]
// Needs chromium (or google-chrome) and ffmpeg on PATH, and OPERATOR_TOKEN in .env.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const DASH = arg("dashboard", "http://127.0.0.1:5173");
const API = arg("api", env.VITE_API_URL ?? "http://localhost:3000");
const OUT = arg("out", "docs/demo/boomerang-demo.mp4");
const TOKEN = env.OPERATOR_TOKEN;
const W = 1280;
const H = 800;
const FPS = 2;

const work = mkdtempSync(join(process.env.SHORT_TMP ?? tmpdir(), "rec-"));
const browser = ["chromium", "google-chrome", "chrome"].find((b) => spawnSync("which", [b]).status === 0);
if (!browser) throw new Error("no chromium or chrome on PATH");
const chrome = spawn(
  browser,
  [
    "--headless=new",
    "--remote-debugging-port=9334",
    `--user-data-dir=${join(work, "profile")}`,
    "--hide-scrollbars",
    `--window-size=${W},${H}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(300);
  try {
    target = (await (await fetch("http://127.0.0.1:9334/json")).json()).find((t) => t.type === "page");
  } catch {
    /* not up yet */
  }
}
if (!target) throw new Error("chromium did not start");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const js = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result
    ?.value;

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: W,
  height: H,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: DASH });
await sleep(1500);
await js(`sessionStorage.setItem("boomerang.operatorToken", ${JSON.stringify(TOKEN)})`);

let frame = 0;
const framesDir = join(work, "frames");
mkdirSync(framesDir);
/** Holds the current screen for `seconds`, one captured frame per 1/FPS second. */
async function hold(seconds) {
  for (let i = 0; i < seconds * FPS; i++) {
    const { result } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      join(framesDir, `${String(frame++).padStart(5, "0")}.png`),
      Buffer.from(result.data, "base64"),
    );
    await sleep(1000 / FPS / 2);
  }
}
async function go(path, wait = 3000) {
  await send("Page.navigate", { url: path.startsWith("http") ? path : DASH + path });
  await sleep(wait);
}
const scroll = (y) => js(`window.scrollTo({ top: ${y}, behavior: "instant" })`);
const click = (text, selector = "button") =>
  js(
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (el) { el.click(); return true; } return false; })()`,
  );
const caption = (text) =>
  js(
    `(() => { let c = document.getElementById("__cap"); if (!c) { c = document.createElement("div"); c.id = "__cap"; c.style.cssText = "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#1c1c1c;color:#fff;padding:10px 18px;border-radius:999px;font:500 15px Inter,system-ui,sans-serif;z-index:99999;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:90%;text-align:center"; document.body.appendChild(c); } c.textContent = ${JSON.stringify(text)}; })()`,
  );

const apiGet = async (path) =>
  (await fetch(API + path, { headers: { authorization: `Bearer ${TOKEN}` } })).json();

// 1. The at-risk batch and the result.
await go("/");
await caption(
  "1 · A batch of 300 overdue invoices and failed subscriptions, split into control and treatment",
);
await hold(5);
await caption("5 · Result against control: recovered dollars, uplift and its 95% interval");
await hold(5);
await scroll(560);
await caption("Across 5 seeds × 12 simulator settings the uplift ranges widely: shown, not hidden");
await hold(6);
await scroll(0);
// 2. The run: cases being worked.
await go("/cases");
await caption("2 · The run: every case gets a diagnosed cause and a gated next action");
await hold(5);
// 3. Approve one case.
await go("/approvals");
await caption("3 · The gate held a $4,500 reminder for a person (rule 9). Approve it.");
await hold(5);
await click("Approve and send");
await sleep(1500);
await caption("Approved: sent (dry run here), recorded in the audit trail");
await hold(4);
// 4. A stopping rule.
const optOut = (await apiGet("/api/cases?q=INV2-DEMO-0000-0000-0120&limit=1")).rows?.[0];
await go("/audit");
await caption("4 · Stopping rules: a customer opted out, so gate rule 3 stopped every contact");
await hold(5);
if (optOut) {
  await js(
    `(() => { const i = document.querySelector('input[type="search"]'); if (!i) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "0120"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
  await sleep(1500);
  await hold(4);
}
// 6. Audit trail and trust.
await go("/trust");
await caption("6 · The audit log is hash-chained: verify it");
await click("Verify");
await sleep(800);
await hold(4);
await click("Run tamper demo");
await sleep(1200);
await caption("★ Tamper demo: one edited entry breaks the chain; the real log is untouched");
await hold(5);
await click("Run attack");
await sleep(1500);
await scroll(300);
await caption("★ A hostile reply cannot talk the agent into a refund: contained by the gate");
await hold(5);
await scroll(0);
// What-if.
await go("/whatif", 4000);
await caption("★ What-if: change the policy and replay the batch, with intervals");
await hold(4);
await click("Reminders carry the self-serve pay page", "label");
await sleep(2500);
await caption("Reminders now carry the self-serve pay page: the replay shows what changes");
await hold(5);
// Timeline.
await go("/timeline", 5000);
await caption("Every case on one time axis: messages, promises, payments and stops");
await hold(5);
// Customer pay page.
const payCase = (await apiGet("/api/cases?q=INV2-DEMO-0000-0000-0075&limit=1")).rows?.[0];
if (payCase) {
  const { link } = await apiGet(`/api/cases/${payCase.id}/paylink`);
  await go(link, 2000);
  await caption("★ The customer's own page: pay now, or promise a date (signed link, no login)");
  await hold(6);
}

ws.close();
chrome.kill();
mkdirSync(dirname(OUT), { recursive: true });
const enc = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-framerate",
    String(FPS),
    "-i",
    join(framesDir, "%05d.png"),
    "-vf",
    `fps=${FPS},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "28",
    "-movflags",
    "+faststart",
    OUT,
  ],
  { stdio: "inherit" },
);
rmSync(work, { recursive: true, force: true });
if (enc.status !== 0) throw new Error("ffmpeg failed");
console.log(`recorded ${frame} frames (${(frame / FPS).toFixed(0)} s) to ${OUT}`);
