import { createRequire } from "module";
const require = createRequire("/opt/node22/lib/node_modules/");
const { chromium } = require("playwright");
const V = process.argv[2];
const b = await chromium.launch();
// 1) login field boxes (same viewport as the screenshots)
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.77, isMobile: true, hasTouch: true, colorScheme: "light" });
  await ctx.addInitScript(() => { sessionStorage.setItem("shayyek.splash", "1"); localStorage.setItem("hsn_theme", "light"); });
  const p = await ctx.newPage();
  await p.goto("http://127.0.0.1:8787/#/"); await p.waitForSelector("input"); await p.waitForTimeout(800);
  const boxes = await p.evaluate(() => [...document.querySelectorAll("input")].filter((i) => i.offsetParent).map((i) => { const r = i.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, i.type]; }));
  const btn = await p.getByRole("button", { name: /تسجيل الدخول/ }).first().boundingBox();
  console.log(JSON.stringify({ boxes, btn }));
  await ctx.close();
}
// 2) the logo animation on a transparent background
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 693 }, deviceScaleFactor: 1080 / 390, colorScheme: "light" });
  await ctx.addInitScript(() => {
    localStorage.setItem("hsn_theme", "light");
    const st = window.setTimeout; window.setTimeout = (f, d, ...x) => (d >= 5000 ? 0 : st(f, d, ...x)); // no real-time safety exit while capturing
    let now = 0; let q = []; let id = 0;
    performance.now = () => now;
    window.requestAnimationFrame = (cb) => { q.push([++id, cb]); return id; };
    window.cancelAnimationFrame = (i) => { q = q.filter(([k]) => k !== i); };
    window.__step = (dt) => { now += dt; const cur = q; q = []; for (const [, cb] of cur) cb(now); };
  });
  const p = await ctx.newPage();
  await p.goto("http://127.0.0.1:8787/#/"); await p.waitForTimeout(1500);
  await p.evaluate(() => {
    const ov = [...document.querySelectorAll("body *")].find((e) => getComputedStyle(e).position === "fixed" && /255, 255, 255/.test(getComputedStyle(e).backgroundColor) && e.querySelector("svg"));
    ov.style.background = "transparent";
    document.documentElement.style.background = "transparent"; document.body.style.background = "transparent";
    for (const el of document.body.children) if (!el.contains(ov)) el.style.visibility = "hidden";
    let n = ov; while (n.parentElement && n.parentElement !== document.body) { for (const s of n.parentElement.children) if (s !== n) s.style.visibility = "hidden"; n = n.parentElement; }
  });
  await p.evaluate(() => window.__step(0));
  for (let i = 0; i <= 164; i++) {
    await p.evaluate(() => window.__step(1000 / 60));
    await p.screenshot({ path: `${V}/page2/p${String(i).padStart(3, "0")}.png`, omitBackground: true });
  }
  // The app fades the intro out here; for the video the glow settles instead and the logo stays.
  for (let i = 165; i <= 180; i++) {
    await p.evaluate((t) => {
      const g = [...document.querySelectorAll("img")].find((e) => /blur/.test(e.style.filter));
      g.style.opacity = String(0.45 * Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 2.2) / 0.8)))));
    }, i / 60);
    await p.screenshot({ path: `${V}/page2/p${String(i).padStart(3, "0")}.png`, omitBackground: true });
  }
  await ctx.close();
}
await b.close();
