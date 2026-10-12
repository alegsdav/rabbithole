/**
 * DO FIRST: routing on ~20 sample queries against a fixed set of lanes.
 * Run: npm run eval:routing   (needs GEMINI_API_KEY and GEMINI_MODEL in .env.local)
 *
 * Each case names the lane it should land in, or "create" when no lane fits.
 * Prints each decision, accuracy, how many would auto-route (>= 0.7) and latency.
 */
import { decide } from "../src/server/router";
import { makeClient, routeQuery, type LaneBrief } from "../src/server/llm";

const lanes: LaneBrief[] = [
  { id: "arch", name: "Software Architecture", description: "System design, distributed systems, backend engineering and programming talks" },
  { id: "espresso", name: "Espresso", description: "Home espresso, grinders, coffee brewing and latte art" },
  { id: "gaming", name: "Gaming", description: "Video game reviews, playthroughs, speedruns and game design" },
  { id: "fitness", name: "Fitness", description: "Strength training, running, mobility and nutrition" },
  { id: "music", name: "Music Production", description: "Synths, mixing, DAWs and making electronic music" },
  { id: "cooking", name: "Cooking", description: "Recipes, kitchen technique and food science" },
];

const cases: { query: string; expect: string }[] = [
  { query: "event sourcing vs CRUD", expect: "arch" },
  { query: "kafka consumer groups explained", expect: "arch" },
  { query: "designing a rate limiter", expect: "arch" },
  { query: "how to dial in espresso", expect: "espresso" },
  { query: "niche zero vs df64", expect: "espresso" },
  { query: "latte art heart tutorial", expect: "espresso" },
  { query: "elden ring boss guide", expect: "gaming" },
  { query: "zelda speedrun world record", expect: "gaming" },
  { query: "game design of hollow knight", expect: "gaming" },
  { query: "5x5 stronglifts progress", expect: "fitness" },
  { query: "zone 2 running explained", expect: "fitness" },
  { query: "how to sidechain compress a kick", expect: "music" },
  { query: "moog subsequent 37 patch ideas", expect: "music" },
  { query: "ableton warping tutorial", expect: "music" },
  { query: "perfect pan pizza at home", expect: "cooking" },
  { query: "sous vide steak temperature", expect: "cooking" },
  { query: "cold brew concentrate ratio", expect: "espresso" },
  { query: "hand plane sharpening for beginners", expect: "create" },
  { query: "orbital mechanics kerbal explained", expect: "gaming" },
  { query: "restoring a vintage watch movement", expect: "create" },
];

async function main() {
  const client = makeClient({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL });
  let correct = 0;
  let auto = 0;
  const latencies: number[] = [];
  for (const c of cases) {
    const t0 = performance.now();
    let label: string;
    let line: string;
    try {
      const out = await routeQuery(client, { query: c.query, lanes, corrections: [] });
      const d = decide(out, lanes.map((l) => l.id), "#0090ff");
      label = d.kind === "assign" ? d.laneId : d.kind;
      if (d.kind === "assign" && d.autoRouted) auto++;
      line = d.kind === "create" ? `create "${d.newLane.name}"` : d.kind === "assign" ? `${d.laneId}${d.autoRouted ? "" : " (ask)"}` : "ask";
      line += ` conf=${out.confidence.toFixed(2)}`;
    } catch (err) {
      label = "error";
      line = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const ms = performance.now() - t0;
    latencies.push(ms);
    const ok = label === c.expect;
    if (ok) correct++;
    console.log(`${ok ? "PASS" : "MISS"}  ${c.query.padEnd(40)} -> ${line}  (${Math.round(ms)} ms, expected ${c.expect})`);
  }
  latencies.sort((a, b) => a - b);
  console.log(`\nAccuracy: ${correct}/${cases.length}   auto-routed: ${auto}   median latency: ${Math.round(latencies[Math.floor(latencies.length / 2)]!)} ms`);
  process.exitCode = correct / cases.length >= 0.85 ? 0 : 1;
}

void main();
