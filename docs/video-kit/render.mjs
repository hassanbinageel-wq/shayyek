import { createRequire } from "module";
const require = createRequire("/opt/node22/lib/node_modules/");
const { chromium } = require("playwright");
const [page, out, mode, ...ts] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: Number(process.env.VW || 1080), height: Number(process.env.VH || 1920) } });
await p.goto("file://" + page); await p.waitForTimeout(800);
await p.evaluate(() => document.fonts.ready);
const total = await p.evaluate(() => window.TOTAL);
if (mode === "stills") {
  for (const t of ts) { await p.evaluate((t) => window.render(t), Number(t)); await p.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete || !i.naturalWidth).map((i) => i.decode().catch(() => undefined)))); await p.waitForTimeout(80); await p.screenshot({ path: `${out}/still-${t}.png` }); }
} else {
  const FPS = Number(process.env.FPS || 30), n = Math.ceil(total * FPS);
  for (let i = 0; i < n; i++) {
    await p.evaluate((t) => window.render(t), i / FPS);
    await p.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete || !i.naturalWidth).map((i) => i.decode().catch(() => undefined))));
    if (i % FPS === 0) await p.waitForTimeout(60); // let swapped images decode
    await p.screenshot({ path: `${out}/f${String(i).padStart(5, "0")}.png`, type: "png" });
  }
  console.log("frames", n, "total", total);
}
await b.close();
