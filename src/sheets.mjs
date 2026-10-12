import { google } from "googleapis";

const SHEET_NAME = "Sheet1";
const HEADER = ["date", "status", "category", "title_id", "title_en", "target_keyword", "post_url", "reason"];

export async function ensureHeaderRow(auth, sheetId) {
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A1:H1`,
  });
  const firstRow = data.values?.[0];
  if (!firstRow || firstRow.join("|") !== HEADER.join("|")) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SHEET_NAME}!A1:H1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  }
}

export async function readLogRows(auth, sheetId) {
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A2:H`,
  });
  const rows = data.values || [];
  return rows.map((row) => ({
    date: row[0] || "",
    status: row[1] || "",
    category: row[2] || "",
    titleId: row[3] || "",
    titleEn: row[4] || "",
    targetKeyword: row[5] || "",
    postUrl: row[6] || "",
    reason: row[7] || "",
  }));
}

export async function appendLogRow(auth, sheetId, row) {
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A:H`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [
        [
          row.date,
          row.status,
          row.category,
          row.titleId,
          row.titleEn,
          row.targetKeyword,
          row.postUrl || "",
          row.reason || "",
        ],
      ],
    },
  });
}
