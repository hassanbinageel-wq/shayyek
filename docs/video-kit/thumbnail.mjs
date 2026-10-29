import { createRequire } from "module";
const require = createRequire("/opt/node22/lib/node_modules/");
const { chromium } = require("playwright");
const [page, out] = process.argv.slice(2);
const b = await chromium.launch();
for (const [q, w, h, name] of [["", 1080, 1920, "thumb-reels.png"], ["?land", 1280, 720, "thumb-youtube.png"]]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.goto("file://" + page + q); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(500);
  await p.screenshot({ path: `${out}/${name}` }); await p.close();
}
await b.close();
