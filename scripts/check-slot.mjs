// Zero-dependency gate that decides whether THIS particular cron trigger
// should do the real work today. Runs BEFORE `npm ci` in the workflow so a
// "not my turn" run costs only a few seconds of billable runner time instead
// of sleeping (which would burn real GitHub Actions minutes for no reason —
// the mistake this script replaces).
//
// How it works: there are 2 independent daily windows (morning/evening),
// each with several fixed cron triggers spread across it (one every
// SLOT_MINUTES). Each day, a deterministic hash of today's date + window
// name picks exactly one slot per window as "today's real slot" for that
// window. Every trigger checks the cron expression GitHub says fired it
// (github.event.schedule) against a static map; only the one matching
// today's chosen slot for its window proceeds. This spreads posts across the
// day without ever sleeping in the runner.
//
// Keep this file dependency-free (Node builtins only) so it can run before
// `npm ci`.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Must match the `schedule:` entries in .github/workflows/daily-post.yml.
// Each cron maps to {window, slot}. Slot index is 0-based.
//
// IMPORTANT: these times are shifted EARLIER than the actual target WIB
// windows, and use uncommon (:07/:22/:37/:52) minute offsets instead of
// round ones. Observed in practice: GitHub was delivering this account's
// scheduled triggers ~3-4.5h late (likely queuing congestion, since
// everyone's workflows fire on the same popular :00/:15/:30/:45 marks).
// Real target: morning 07:00-09:30 WIB, evening 19:00-20:30 WIB. Configured
// below ~4h earlier (in UTC) to compensate. Re-tune if the observed delay
// pattern changes.
const CRON_MAP = {
  // Morning (compensated): configured 20:00-22:30 UTC (prev. UTC day) for a
  // real-world landing around 00:00-02:30 UTC = 07:00-09:30 WIB.
  "7 20 * * *": { window: "morning", slot: 0 },
  "22 20 * * *": { window: "morning", slot: 1 },
  "37 20 * * *": { window: "morning", slot: 2 },
  "52 20 * * *": { window: "morning", slot: 3 },
  "7 21 * * *": { window: "morning", slot: 4 },
  "22 21 * * *": { window: "morning", slot: 5 },
  "37 21 * * *": { window: "morning", slot: 6 },
  "52 21 * * *": { window: "morning", slot: 7 },
  "7 22 * * *": { window: "morning", slot: 8 },
  "22 22 * * *": { window: "morning", slot: 9 },
  // Evening (compensated): configured 08:00-09:30 UTC for a real-world
  // landing around 12:00-13:30 UTC = 19:00-20:30 WIB.
  "7 8 * * *": { window: "evening", slot: 0 },
  "22 8 * * *": { window: "evening", slot: 1 },
  "37 8 * * *": { window: "evening", slot: 2 },
  "52 8 * * *": { window: "evening", slot: 3 },
  "7 9 * * *": { window: "evening", slot: 4 },
  "22 9 * * *": { window: "evening", slot: 5 },
};
const SLOTS_PER_WINDOW = { morning: 10, evening: 6 };

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
  return hash[0] % SLOTS_PER_WINDOW[windowName];
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
    console.log(`Date ${dateStr}, window "${entry.window}": chosen slot is ${chosenSlot}/${SLOTS_PER_WINDOW[entry.window] - 1}, this trigger is slot ${entry.slot} ("${scheduleCron}"). Proceed: ${proceed}`);
    writeOutput("proceed", String(proceed));
    writeOutput("window", entry.window);
  }
}
