// Headless deep-extract of checkout/payment call sites from Blinkit chunks.
import { Impit } from "impit";
const impit = new Impit({ browser: "chrome" });
async function txt(u) { const r = await impit.fetch(u); return r.status === 200 ? await r.text() : ""; }

const home = await txt("https://blinkit.com/");
// every js asset referenced anywhere (entry + we add known lazy chunks by scanning main.js chunk map)
let chunks = [...new Set([...home.matchAll(/\/[\w.\/-]+\.js/g)].map((x) => x[0]))];
const main = chunks.find((c) => /scripts\/main\./.test(c));
if (main) {
  const mjs = await txt("https://blinkit.com" + main);
  // webpack chunk filename map: {id:"hash",...} and the name-path template
  // reconstruct: e.u = id => id + ".scripts/..." + {map}[id] + ".js" is hard; instead pull any ".scripts/....js" literals
  for (const m of mjs.matchAll(/[\w.\/-]*\.scripts\/[\w.\/-]+\.js/g)) chunks.push("/" + m[0].replace(/^\//, ""));
}
chunks = [...new Set(chunks)];

const wanted = process.argv.slice(2);
if (!wanted.length) { console.log("usage: node discover-checkout.mjs <term> [term...]"); process.exit(0); }
const W = 160;
for (const c of chunks) {
  const js = await txt("https://blinkit.com" + c);
  if (!js) continue;
  for (const term of wanted) {
    let i = -1, hits = 0;
    while ((i = js.indexOf(term, i + 1)) >= 0 && hits < 2) {
      hits++;
      console.log(`\n### [${term}] @${c.replace(/^\//,"").slice(0, 8)}`);
      console.log(js.slice(Math.max(0, i - W), i + W).replace(/\s+/g, " "));
    }
  }
}
