// Zero-dependency gate that decides whether THIS particular cron trigger
// should do the real work today. Runs BEFORE `npm ci` in the workflow so a
// "not my turn" run costs only a few seconds of billable runner time instead
// of sleeping (which would burn real GitHub Actions minutes for no reason —
// the mistake this script replaces).
//
// How it works: there are 3 independent daily windows (morning/midday/
// evening), each with several fixed cron triggers spread across it (one
// every SLOT_MINUTES). Each day, a deterministic hash of today's date +
// window name picks exactly one slot per window as "today's real slot" for
// that window. Every trigger checks the cron expression GitHub says fired it
// (github.event.schedule) against a static map; only the one matching
// today's chosen slot for its window proceeds. This spreads posts across the
// day (not clustered in one window) without ever sleeping in the runner.
//
// Keep this file dependency-free (Node builtins only) so it can run before
// `npm ci`.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Must match the `schedule:` entries in .github/workflows/daily-post.yml.
// Each cron maps to {window, slot}. Slot index is 0-based, spaced
// SLOT_MINUTES apart starting at that window's start time.
const CRON_MAP = {
  // Morning window: 09:00-10:30 WIB = 02:00-03:30 UTC
  "0 2 * * *": { window: "morning", slot: 0 },
  "15 2 * * *": { window: "morning", slot: 1 },
  "30 2 * * *": { window: "morning", slot: 2 },
  "45 2 * * *": { window: "morning", slot: 3 },
  "0 3 * * *": { window: "morning", slot: 4 },
  "15 3 * * *": { window: "morning", slot: 5 },
  // Midday window: 13:00-14:30 WIB = 06:00-07:30 UTC
  "0 6 * * *": { window: "midday", slot: 0 },
  "15 6 * * *": { window: "midday", slot: 1 },
  "30 6 * * *": { window: "midday", slot: 2 },
  "45 6 * * *": { window: "midday", slot: 3 },
  "0 7 * * *": { window: "midday", slot: 4 },
  "15 7 * * *": { window: "midday", slot: 5 },
  // Evening window: 19:00-20:30 WIB = 12:00-13:30 UTC
  "0 12 * * *": { window: "evening", slot: 0 },
  "15 12 * * *": { window: "evening", slot: 1 },
  "30 12 * * *": { window: "evening", slot: 2 },
  "45 12 * * *": { window: "evening", slot: 3 },
  "0 13 * * *": { window: "evening", slot: 4 },
  "15 13 * * *": { window: "evening", slot: 5 },
};
const SLOTS_PER_WINDOW = 6;

function todayDateString(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function chosenSlotForWindow(dateStr, windowName) {
  const hash = createHash("sha256").update(`${dateStr}:${windowName}`).digest();
  return hash[0] % SLOTS_PER_WINDOW;
}

function writeOutput(name, value) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    appendFileSync(outFile, `${name}=${value}\n`);
  }
  console.log(`${name}=${value}`);
}

const eventName = process.env.EVENT_NAME || "";
const scheduleCron = process.env.SCHEDULE_CRON || "";
const timezone = process.env.PUBLISH_TIMEZONE || "Asia/Jakarta";

if (eventName !== "schedule") {
  console.log(`Event is "${eventName}" (not a scheduled cron) — always proceeding immediately.`);
  writeOutput("proceed", "true");
  writeOutput("window", "manual");
} else {
  const entry = CRON_MAP[scheduleCron];
  const dateStr = todayDateString(timezone);

  if (!entry) {
    console.log(`Unrecognized schedule cron "${scheduleCron}" — proceeding to be safe.`);
    writeOutput("proceed", "true");
    writeOutput("window", "unknown");
  } else {
    const chosenSlot = chosenSlotForWindow(dateStr, entry.window);
    const proceed = entry.slot === chosenSlot;
    console.log(`Date ${dateStr}, window "${entry.window}": chosen slot is ${chosenSlot}/${SLOTS_PER_WINDOW - 1}, this trigger is slot ${entry.slot} ("${scheduleCron}"). Proceed: ${proceed}`);
    writeOutput("proceed", String(proceed));
    writeOutput("window", entry.window);
  }
}
