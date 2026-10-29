import { createRequire } from "module";
const require = createRequire("/opt/node22/lib/node_modules/");
const { chromium } = require("playwright");
const [out, phase] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: "light" });
await ctx.addInitScript(() => { sessionStorage.setItem("shayyek.splash", "1"); localStorage.setItem("hsn_theme", "light"); });
const p = await ctx.newPage();
const info = {};
await p.goto("http://127.0.0.1:8787/#/"); await p.waitForSelector("input"); await p.waitForTimeout(900);
if (phase === "out") {
  await p.screenshot({ path: `${out}/d1-login.png` });
  info.fields = await p.evaluate(() => [...document.querySelectorAll("input")].filter((i) => i.offsetParent).map((i) => { const r = i.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
  info.loginBtn = await p.getByRole("button", { name: /تسجيل الدخول/ }).first().boundingBox();
}
const inputs = await p.$$("input"); await inputs[0].fill("admin"); await inputs[1].fill("a-very-strong-password");
await p.keyboard.press("Enter"); await p.waitForTimeout(3000);
if (phase === "out") {
  await p.screenshot({ path: `${out}/d2-home.png` });
  const link = p.locator("aside a, aside button").filter({ hasText: /^الربط$/ }).first();
  await link.scrollIntoViewIfNeeded(); await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}/d2-home.png` });
  info.navLink = await link.boundingBox();
  await p.goto("http://127.0.0.1:8787/#/connection"); await p.waitForTimeout(2500);
  await p.screenshot({ path: `${out}/d3-connection.png` });
  info.connectBtn = await p.getByRole("button", { name: /ربط عبر Instagram/ }).first().boundingBox();
} else {
  await p.goto("http://127.0.0.1:8787/#/connection"); await p.waitForTimeout(2500);
  await p.screenshot({ path: `${out}/d4-connected.png` });
  info.active = await p.getByText("فعّال", { exact: true }).first().boundingBox();
}
console.log(JSON.stringify(info));
await b.close();
