// Drive Owed scene by scene, timed to the narration clips, and record the browser.
//   node record.mjs [out/]      (Owed must be running; OWED_URL defaults to http://127.0.0.1:3000/)
// Writes out/<hash>.webm (Playwright) and out/timeline.json ({scene: start seconds in the video}).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/snpsa/node_modules/playwright");

const OUT = process.argv[2] || "out";
const APP_URL = process.env.OWED_URL || "http://127.0.0.1:3000/";
const lengths = JSON.parse(readFileSync(join(OUT, "lengths.json"), "utf8"));
const PAD = 0.9; // seconds of quiet after each clip
const BRIEF = "Built a landing page for Fernhill Yoga, $950, due in 10 days, contact mia@fernhillyoga.test";

const browser = await chromium.launch();
const t0 = Date.now();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: 1440, height: 900 } }, colorScheme: "light",
});
const page = await ctx.newPage();
page.on("dialog", d => d.accept());
await page.goto(APP_URL);
await page.click("#btn-reset").catch(() => {});
await page.waitForFunction(() => !document.querySelector("#ledger-empty")?.hidden, null, { timeout: 5000 }).catch(() => console.error("reset did not empty the ledger"));
await page.evaluate(() => { localStorage.setItem("owed-theme", "light"); });
await page.addStyleTag({ content: `
  #rec-cursor{position:fixed;left:0;top:0;width:22px;height:22px;margin:-4px 0 0 -4px;z-index:2147483647;pointer-events:none;
    transition:transform .6s cubic-bezier(.3,.7,.2,1)}
  #rec-cursor svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
  #rec-ring{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #0f766e;
    z-index:2147483646;pointer-events:none;opacity:0}
  #rec-ring.go{animation:ring .5s ease-out}
  @keyframes ring{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(1.4)}}` });
await page.evaluate(() => {
  const c = document.createElement("div"); c.id = "rec-cursor";
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.4L21 11z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  c.style.transform = "translate(720px,450px)";
  const r = document.createElement("div"); r.id = "rec-ring";
  document.body.append(c, r);
});
await page.waitForTimeout(600);

const sleep = ms => page.waitForTimeout(ms);
let cur = { x: 720, y: 450 };
async function moveTo(target, dx = 0, dy = 0) {
  const loc = typeof target === "string" ? page.locator(target).first() : target;
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const b = await loc.boundingBox();
  if (!b) return null;
  const x = b.x + b.width / 2 + dx, y = b.y + b.height / 2 + dy;
  await page.evaluate(([x, y]) => { document.getElementById("rec-cursor").style.transform = `translate(${x}px,${y}px)`; }, [x, y]);
  await page.mouse.move(x, y, { steps: 12 });
  cur = { x, y };
  await sleep(650);
  return { x, y };
}
async function click(target) {
  const p = await moveTo(target);
  if (!p) throw new Error("not found: " + target);
  await page.evaluate(([x, y]) => { const r = document.getElementById("rec-ring"); r.style.left = x + "px"; r.style.top = y + "px";
    r.classList.remove("go"); void r.offsetWidth; r.classList.add("go"); }, [p.x, p.y]);
  await page.mouse.click(p.x, p.y);
  await sleep(300);
}
async function scrollTo(sel) {
  await page.evaluate(s => document.querySelector(s).scrollIntoView({ behavior: "smooth", block: "start" }), sel);
  await sleep(900);
}
async function typeSlow(sel, text) {
  await click(sel);
  await page.keyboard.type(text, { delay: 18 });
}

const scenes = {
  async intro() { await moveTo("#kpi-owed"); await moveTo("#kpi-overdue"); await moveTo("#kpi-paid"); await moveTo("#chat-input"); },
  async brief() { await typeSlow("#chat-input", BRIEF); await click("#chat-send"); await sleep(1600);
    await moveTo(page.getByText("Fernhill Yoga").first()); await moveTo(page.getByText(/Net 10/).first()); await moveTo(page.getByText(/^polite /).first()); },
  async send() { await click(page.getByRole("button", { name: "Create & send via PayPal" })); await sleep(1200);
    await scrollTo("#trace-title"); await moveTo(page.locator("#trace li").filter({ hasText: "create_invoice" }).first());
    await moveTo(page.locator("#trace li").filter({ hasText: "send_invoice" }).first()); },
  async demo() { await scrollTo("body"); await click("#btn-demo"); await sleep(2500);
    await moveTo(page.locator("#ledger-body tr").filter({ hasText: "Brightline" }).first(), 40);
    await moveTo(page.locator("#ledger-body tr").filter({ hasText: "Juniper" }).first(), 40); await moveTo("#kpi-paid"); },
  async plan() { await click(page.locator("#ledger-body tr").filter({ hasText: "Brightline" }).first().locator("td").first());
    await sleep(800); const d = page.getByText(/firm/i).filter({ visible: true }); await moveTo(d.first()).catch(() => {}); },
  async timeline() { await scrollTo("#timeline-title");
    const ev = page.locator(".b-sch-event.owed-reminder").filter({ hasText: "Polite" }).first();
    const p = await moveTo(ev); await sleep(700);
    if (p) { await page.mouse.down(); for (let i = 1; i <= 20; i++) { const x = p.x + i * 4.5;
        await page.evaluate(([x, y]) => { const c = document.getElementById("rec-cursor"); c.style.transition = "none"; c.style.transform = `translate(${x}px,${y}px)`; }, [x, p.y]);
        await page.mouse.move(x, p.y); await sleep(45); }
      await page.mouse.up();
      await page.evaluate(() => { document.getElementById("rec-cursor").style.transition = ""; }); }
    await sleep(900); await moveTo("#toasts").catch(() => {}); },
  async paid() { await scrollTo("body"); await click(page.locator("#ledger-body tr").filter({ hasText: "Northwind" }).first().getByRole("button", { name: "Client pays" }));
    await sleep(1500); await moveTo("#kpi-paid"); await scrollTo("#trace-title"); await moveTo(page.locator("#trace li").filter({ hasText: /PAID|stopped/ }).first()).catch(() => {}); },
  async ask() { await scrollTo("#chat-title"); await click(page.getByRole("button", { name: "Who owes me what?" })); await sleep(1800);
    await typeSlow("#chat-input", "What's overdue?"); await click("#chat-send"); await sleep(1500); },
  async outro() { await scrollTo("body"); await moveTo("#chip-paypal"); await moveTo("#chip-ai");
    await scrollTo("#trace-title"); await click(page.locator("#trace-title").locator("xpath=..").getByRole("button", { name: "PayPal" })).catch(() => {}); },
};

const timeline = {};
const order = JSON.parse(readFileSync(new URL("./scenes.json", import.meta.url), "utf8")).scenes.map(s => s.id);
for (const id of order) {
  const start = Date.now();
  timeline[id] = (start - t0) / 1000;
  try { await scenes[id](); } catch (e) { console.error(`scene ${id}: ${e.message}`); }
  const spent = (Date.now() - start) / 1000;
  const want = (lengths[id] || 5) + PAD;
  if (spent < want) await sleep((want - spent) * 1000);
  else timeline[id + "_overrun_s"] = +(spent - want).toFixed(2);
}
timeline._end = (Date.now() - t0) / 1000;
const video = page.video();
await ctx.close();
const src = await video.path();
const dst = join(OUT, "screen.webm");
renameSync(src, dst);
await browser.close();
writeFileSync(join(OUT, "timeline.json"), JSON.stringify(timeline, null, 1));
console.log(JSON.stringify({ video: dst, ...timeline }));
