# Google Sheets Roster Setup (Fort Worth Employee Roster)

The bot updates your roster when a promotion message is posted in channel `1499207295895339048`.

## Message format

```
Roleplay Name: D. Morgan
Current Callsign: 3005
New Rank: COMMANDER
```

You can also use `RP Name:` instead of `Roleplay Name:`.

Callsigns should be the **4-digit number** from column C (e.g. `3005`, not `30-05`).

## Your sheet layout

Row 1 must be the header row:

| A | B | C | D | E+ |
|---|---|---|---|-----|
| **RANK** | **RP NAME** | **CALLSIGN** | **ROLLS** | Patrol Cert, IA, SWAT, R/A Cert |

- **Blue section rows** (e.g. `OFFICE OF THE CHIEF`, `COMMAND STAFF`) are ignored automatically
- Only rows with a **4-digit callsign** in column C are treated as roster slots
- **Open slot** = rank + callsign filled, **RP NAME** (column B) is empty
- Promotion clears the old **RP NAME** and fills the first open slot in the new rank

Example open slot: `COMMANDER` | *(empty)* | `3008` | `PATROL COMMANDER`

## Tab name in `.env`

Set `GOOGLE_ROSTER_SHEET_NAME` to the **exact tab name** at the bottom of your spreadsheet (the tab that contains the roster).

## Google Cloud setup (one time)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (e.g. `Fort-Worth-Automation`)
3. **APIs & Services → Enable APIs** → enable **Google Sheets API**
4. **APIs & Services → Credentials → Create Credentials → Service account**
5. Create the account → **Keys → Add key → JSON**
6. Save the file as:
   ```
   credentials/google-service-account.json
   ```
7. Copy the service account email (`...@....iam.gserviceaccount.com`)
8. Open your Google Sheet → **Share** → add that email as **Editor**

## Bot `.env` settings

```env
GOOGLE_SHEETS_SPREADSHEET_ID=your_spreadsheet_id_from_url
GOOGLE_SERVICE_ACCOUNT_PATH=./credentials/google-service-account.json
GOOGLE_ROSTER_SHEET_NAME=YourExactTabNameHere
```

Spreadsheet ID is in the URL:
`https://docs.google.com/spreadsheets/d/THIS_PART/edit`

## Optional: Google Apps Script (logging)

Not required for the bot. Optional log when **RP NAME** (column B) changes:

```javascript
function onEdit(e) {
  const sheet = e.source.getActiveSheet();
  if (e.range.getColumn() !== 2) return; // column B = RP NAME

  const log = e.source.getSheetByName('PromotionLog') || e.source.insertSheet('PromotionLog');
  if (log.getLastRow() === 0) {
    log.appendRow(['Timestamp', 'Row', 'RP Name', 'Callsign', 'Rank', 'Rolls']);
  }

  const row = e.range.getRow();
  log.appendRow([
    new Date(),
    row,
    sheet.getRange(row, 2).getValue(),
    sheet.getRange(row, 3).getValue(),
    sheet.getRange(row, 1).getValue(),
    sheet.getRange(row, 4).getValue(),
  ]);
}
```

Add trigger: **Extensions → Apps Script → Triggers → onEdit**

## Install

```bash
npm install
```

Restart the bot after updating `.env`.

## Troubleshooting

| Error | Fix |
|-------|-----|
| Could not find member at callsign | Check RP NAME spelling and 4-digit callsign |
| No open slot for rank | Add a row: rank + 4-digit callsign, leave RP NAME blank |
| Sheet empty or missing | Wrong `GOOGLE_ROSTER_SHEET_NAME` tab name |
| Permission denied | Share sheet with service account as Editor |
