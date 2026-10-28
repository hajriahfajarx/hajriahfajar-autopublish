// Shared by run.mjs (morning's real-time pick) and generate.mjs (the
// evening batch) -- both need to check a freshly-picked topic against
// everything already covered (past Sheet rows, plus whatever's already been
// chosen earlier in the same generate batch, when the caller passes a
// combined/growing list).
export function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isLikelyDuplicate(topic, pastLog) {
  const normTitleId = normalize(topic.titleId);
  const normKeyword = normalize(topic.targetKeyword);
  return pastLog.some((row) => {
    return normalize(row.titleId) === normTitleId || normalize(row.targetKeyword) === normKeyword;
  });
}
