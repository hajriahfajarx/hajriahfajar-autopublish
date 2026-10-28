import { google } from "googleapis";

const SHEET_NAME = "Sheet1";
const HEADER = [
  "date",
  "status",
  "category",
  "title_id",
  "title_en",
  "target_keyword",
  "post_url",
  "reason",
  "window",
  "content_html",
  "alt_text",
  "thumbnail_prompt",
];
const RANGE_ALL = `${SHEET_NAME}!A1:L1`;

export async function ensureHeaderRow(auth, sheetId) {
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: RANGE_ALL,
  });
  const firstRow = data.values?.[0];
  if (!firstRow || firstRow.join("|") !== HEADER.join("|")) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: RANGE_ALL,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  }
}

function rowToValues(row) {
  return [
    row.date,
    row.status,
    row.category,
    row.titleId,
    row.titleEn,
    row.targetKeyword,
    row.postUrl || "",
    row.reason || "",
    row.window || "",
    row.contentHtml || "",
    row.altText || "",
    row.thumbnailPrompt || "",
  ];
}

export async function readLogRows(auth, sheetId) {
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A2:L`,
  });
  const rows = data.values || [];
  return rows.map((row, i) => ({
    // 1-based sheet row number (row 1 is the header, data starts at row 2).
    rowIndex: i + 2,
    date: row[0] || "",
    status: row[1] || "",
    category: row[2] || "",
    titleId: row[3] || "",
    titleEn: row[4] || "",
    targetKeyword: row[5] || "",
    postUrl: row[6] || "",
    reason: row[7] || "",
    // Older rows (from before multi-window support) have no window column;
    // they were all from the single evening window, so default to that.
    window: row[8] || "evening",
    contentHtml: row[9] || "",
    altText: row[10] || "",
    thumbnailPrompt: row[11] || "",
  }));
}

export async function appendLogRow(auth, sheetId, row) {
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A:L`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [rowToValues(row)] },
  });
}

/**
 * Updates an existing row in place (identified by its absolute sheet row
 * number, from readLogRows' `rowIndex`) instead of appending a new one --
 * used to flip a queued `ready` row to `done` once it's actually published,
 * without disturbing any other row.
 */
export async function updateRow(auth, sheetId, rowIndex, row) {
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A${rowIndex}:L${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [rowToValues(row)] },
  });
}
