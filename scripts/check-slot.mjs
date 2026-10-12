// Zero-dependency gate that decides whether THIS particular cron trigger
// should do the real work today. Runs BEFORE `npm ci` in the workflow so a
// "not my turn" run costs only a few seconds of billable runner time instead
// of sleeping (which would burn real GitHub Actions minutes for no reason —
// the mistake this script replaces).
//
// How it works: there are several fixed cron triggers spread across the
// publish window (one every SLOT_MINUTES). Each day, a deterministic hash of
// today's date picks exactly one of those slots as "today's real slot". Every
// trigger checks the cron expression GitHub says fired it (github.event.schedule)
// against a static slot map; only the one matching today's chosen slot proceeds.
//
// Keep this file dependency-free (Node builtins only) so it can run before
// `npm ci`.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Must match the `schedule:` entries in .github/workflows/daily-post.yml.
// Index = slot number (0-based), spaced SLOT_MINUTES apart starting at
// PUBLISH_WINDOW_START (19:00 WIB = 12:00 UTC by default).
const CRON_TO_SLOT = {
  "0 12 * * *": 0, // 19:00 WIB
  "15 12 * * *": 1, // 19:15 WIB
  "30 12 * * *": 2, // 19:30 WIB
  "45 12 * * *": 3, // 19:45 WIB
  "0 13 * * *": 4, // 20:00 WIB
  "15 13 * * *": 5, // 20:15 WIB
};
const SLOT_COUNT = Object.keys(CRON_TO_SLOT).length;

function todayDateString(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function chosenSlotForToday(timeZone) {
  const dateStr = todayDateString(timeZone);
  const hash = createHash("sha256").update(dateStr).digest();
  return { dateStr, slot: hash[0] % SLOT_COUNT };
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
} else {
  const { dateStr, slot: chosenSlot } = chosenSlotForToday(timezone);
  const thisSlot = CRON_TO_SLOT[scheduleCron];

  if (thisSlot === undefined) {
    console.log(`Unrecognized schedule cron "${scheduleCron}" — proceeding to be safe.`);
    writeOutput("proceed", "true");
  } else {
    const proceed = thisSlot === chosenSlot;
    console.log(`Date ${dateStr}: today's chosen slot is ${chosenSlot}/${SLOT_COUNT - 1}, this trigger is slot ${thisSlot} ("${scheduleCron}"). Proceed: ${proceed}`);
    writeOutput("proceed", String(proceed));
  }
}
