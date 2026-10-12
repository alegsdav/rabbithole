/**
 * Development only: fills data/demo.db with a demo user and lanes so the UI can
 * be exercised without a Google account, and prints a session token for that
 * user. Run: DATABASE_PATH=./data/demo.db npx tsx --conditions=react-server --env-file=.env.local scripts/dev-seed.ts
 * Then start the app with DATABASE_PATH=./data/demo.db.
 */
import { encode } from "@auth/core/jwt";
import { rmSync } from "node:fs";

import { openDb } from "../src/server/db/client";
import { feedItems, lanes, users } from "../src/server/db/schema";

const file = process.env.DATABASE_PATH ?? "";
if (!file.endsWith("demo.db") || process.env.NODE_ENV === "production") {
  console.error("Refusing to seed: set DATABASE_PATH=./data/demo.db (never the real database).");
  process.exit(1);
}

// Real public videos (checked via oEmbed), used for thumbnails and for playback.
const REAL = [
  ["M7lc1UVf-VE", "YouTube Developers Live: Embedded Web Player Customization", "Google for Developers"],
  ["aqz-KE-bpKQ", "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film", "Blender"],
  ["eRsGyueVLvQ", "Sintel - Open Movie by Blender Foundation", "Blender"],
  ["R6MlUcmOul8", "Tears of Steel - Blender VFX Open Movie", "Blender"],
  ["YE7VzlLtp-4", "Big Buck Bunny", "Blender"],
  ["LXb3EKWsInQ", "COSTA RICA IN 4K 60fps HDR (ULTRA HD)", "Jacob + Katie Schwarz"],
  ["jNQXAC9IVRw", "Me at the zoo", "jawed"],
  ["dQw4w9WgXcQ", "Rick Astley - Never Gonna Give You Up (Official Video)", "Rick Astley"],
] as const;

const LANES = [
  { name: "Software Architecture", color: "#0090ff", description: "System design and distributed systems", words: ["Event sourcing in practice", "Designing a rate limiter", "Kafka consumer groups explained", "Why your microservices are a distributed monolith", "Consistent hashing, visually", "CQRS without the hype"] },
  { name: "Espresso", color: "#f76b15", description: "Home espresso and coffee gear", words: ["Dialing in a light roast", "Flat burrs vs conical burrs", "Latte art: the tulip", "A better way to puck prep", "Is a $2,000 grinder worth it?", "Milk steaming mistakes"] },
  { name: "Gaming", color: "#8e4ec6", description: "Game design and playthroughs", words: ["The level design of Hollow Knight", "Elden Ring: every boss ranked", "Speedrun world record explained", "Why roguelikes are so replayable", "Indie games you missed this year", "The art of game feel"] },
  { name: "Woodworking", color: "#46a758", description: "Hand tools and furniture", words: [] as string[] },
];

async function main() {
  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  const db = openDb(file);
  const now = Date.now();
  db.insert(users).values({ id: "demo-user", googleSub: "demo-sub", name: "Demo", email: "demo@example.test" }).run();

  let n = 0;
  LANES.forEach((lane, laneIndex) => {
    const id = `00000000-0000-4000-8000-00000000000${laneIndex}`;
    db.insert(lanes)
      .values({
        id,
        userId: "demo-user",
        name: lane.name,
        color: lane.color,
        description: lane.description,
        sortOrder: laneIndex,
        lastRefreshedAt: lane.words.length ? now - 5 * 60_000 : now - 60_000,
        lastError: laneIndex === 2 ? "Daily YouTube quota is nearly used up; showing the cached feed." : null,
      })
      .run();
    const count = lane.words.length ? 36 : 0;
    for (let i = 0; i < count; i++) {
      const real = REAL[(i + laneIndex * 3) % REAL.length]!;
      const isFirstReal = laneIndex === 0 && i < REAL.length;
      const videoId = isFirstReal ? REAL[i]![0] : `demo${String(n++).padStart(7, "0")}`;
      db.insert(feedItems)
        .values({
          userId: "demo-user",
          videoId,
          laneId: id,
          title: isFirstReal ? REAL[i]![1] : `${lane.words[i % lane.words.length]}${i >= lane.words.length ? ` (part ${Math.floor(i / lane.words.length) + 1})` : ""}`,
          channelId: `UCdemo${laneIndex}${i % 5}`,
          channelTitle: isFirstReal ? REAL[i]![2] : `${lane.name} Channel ${(i % 5) + 1}`,
          thumbUrl: `https://i.ytimg.com/vi/${isFirstReal ? REAL[i]![0] : real[0]}/mqdefault.jpg`,
          publishedAt: now - (i + 1) * 9 * 3_600_000,
          durationSec: i % 7 === 6 ? 45 : 240 + i * 97,
          viewCount: Math.round(1_500 * Math.pow(1.6, i % 14)),
          isLive: false,
          source: i % 4 === 3 ? "search" : "subscription",
          score: 100 - i,
          fetchedAt: now,
        })
        .run();
    }
  });

  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET missing");
  const token = await encode({ token: { uid: "demo-user", name: "Demo", sub: "demo-user" }, secret, salt: "authjs.session-token" });
  console.log(`Seeded ${file}.`);
  console.log(`SESSION_TOKEN=${token}`);
}

void main();
