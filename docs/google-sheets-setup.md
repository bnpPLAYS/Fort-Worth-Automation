# Google Sheets Roster Setup

The bot updates your roster when a promotion message is posted in channel `1499207295895339048`.

## Message format

```
Roleplay Name: John Smith
Current Callsign: 1A-12
New Rank: Sergeant
```

## Required sheet layout

Use one tab named **Roster** (or set `GOOGLE_ROSTER_SHEET_NAME` in `.env`).

| Rank | Callsign | Name | Division |
|------|----------|------|----------|
| Officer | 1A-01 | | Patrol |
| Officer | 1A-02 | Jane Doe | Patrol |
| Sergeant | 2A-01 | | Patrol |
| Sergeant | 2A-02 | | Traffic |

**Rules:**
- Row 1 must be the header: `Rank`, `Callsign`, `Name`, `Division`
- **Open slot** = callsign is filled in, **Name** cell is empty
- Promotion clears the member's old **Name** cell and fills the first open **Name** in the new rank

## Google Cloud setup (one time)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (e.g. `Fort-Worth-Automation`)
3. **APIs & Services → Enable APIs** → enable **Google Sheets API**
4. **APIs & Services → Credentials → Create Credentials → Service account**
5. Create the account, then open it → **Keys → Add key → JSON**
6. Save the downloaded file as:
   ```
   credentials/google-service-account.json
   ```
7. Copy the service account email (looks like `something@project-id.iam.gserviceaccount.com`)
8. Open your Google Sheet → **Share** → add that email as **Editor**

## Bot `.env` settings

```env
GOOGLE_SHEETS_SPREADSHEET_ID=your_spreadsheet_id_from_url
GOOGLE_SERVICE_ACCOUNT_PATH=./credentials/google-service-account.json
GOOGLE_ROSTER_SHEET_NAME=Roster
```

Spreadsheet ID is the long string in the URL:
`https://docs.google.com/spreadsheets/d/THIS_PART/edit`

## Optional: Google Apps Script (sheet-side)

You do **not** need Apps Script for the Discord bot to work. The bot uses the Google Sheets API directly.

Optional script ideas if you want extra sheet automation:

### Log promotions on a second tab

1. In the sheet: **Extensions → Apps Script**
2. Paste:

```javascript
function onEdit(e) {
  const sheet = e.source.getSheetByName('Roster');
  if (!sheet || e.range.getSheet().getName() !== 'Roster') return;
  if (e.range.getColumn() !== 3) return; // column C = Name

  const log = e.source.getSheetByName('PromotionLog') || e.source.insertSheet('PromotionLog');
  if (log.getLastRow() === 0) {
    log.appendRow(['Timestamp', 'Row', 'Name', 'Callsign', 'Rank']);
  }

  const row = e.range.getRow();
  log.appendRow([
    new Date(),
    row,
    sheet.getRange(row, 3).getValue(),
    sheet.getRange(row, 2).getValue(),
    sheet.getRange(row, 1).getValue(),
  ]);
}
```

3. **Triggers** (clock icon) → Add trigger → `onEdit` → From spreadsheet

### Protect roster columns

Use **Data → Protect sheets and ranges** so only the service account and admins can edit Rank/Callsign columns, while the bot still updates Name cells via API.

## Install bot dependency

After pulling the latest code:

```bash
npm install
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| Could not find member at callsign | Name or callsign typo; check sheet |
| No open slot for rank | Add a row with that rank + callsign, leave Name blank |
| Google Sheets not configured | Add JSON key + `.env` values |
| Permission denied | Share sheet with service account email as Editor |
