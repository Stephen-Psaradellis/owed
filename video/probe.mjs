// One-off DOM probe: run the demo headless and print the selectors the recorder needs.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/snpsa/node_modules/playwright");

const URL = process.env.OWED_URL || "http://127.0.0.1:3000/";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(URL);
await page.click("#btn-reset").catch(() => {});
await page.waitForTimeout(800);
await page.fill("#chat-input", "Built a landing page for Fernhill Yoga, $950, due in 10 days, contact mia@fernhillyoga.test");
await page.click("#chat-send");
await page.waitForTimeout(2500);
const buttons = await page.$$eval("button", bs => bs.map(b => (b.id ? "#" + b.id + " " : "") + b.innerText.trim()).filter(Boolean));
console.log("BUTTONS after brief:", JSON.stringify(buttons));
await page.click("#btn-demo");
await page.waitForTimeout(4000);
const rows = await page.$$eval("#ledger-body tr", rs => rs.map(r => (r.className || "") + " | " + r.innerText.replace(/\s+/g, " ").slice(0, 120)));
console.log("ROWS:", JSON.stringify(rows, null, 1));
const ev = await page.$$eval(".b-sch-event-wrap, .b-sch-event", es => es.slice(0, 30).map(e => e.className.slice(0, 80) + " | " + (e.innerText || e.getAttribute("data-event-id") || "").trim().slice(0, 40)));
console.log("EVENTS:", JSON.stringify(ev, null, 1));
const samples = await page.$$eval("#samples button, #samples *", s => s.map(x => x.tagName + ":" + x.innerText.trim()).slice(0, 10));
console.log("SAMPLES:", JSON.stringify(samples));
await page.screenshot({ path: process.env.SHOT || "probe.png", fullPage: true });
await browser.close();
