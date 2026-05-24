# Google Sheets Roster Setup (Fort Worth Employee Roster)

The bot updates your roster when a promotion message is posted in channel `1499207295895339048`.

## Message format

```
Roleplay Name: D. Morgan
Current Callsign: 3005
New Rank: COMMANDER
```

Works on one line or multiple lines. Each label must stay spelled exactly as shown.

You can also use `RP Name:` instead of `Roleplay Name:`.

Callsigns should be the **4-digit number** from column C (e.g. `3005`, not `30-05`).

### Your own entry only

You can only update **your own** roster row. **Roleplay Name** must appear in your Discord nickname or username (e.g. nickname `3000 | J. Forman` with Roleplay Name `J. Forman`).

If your nickname includes a callsign, **Current Callsign** must match it.

Staff with **Manage Server** or the staff ping role can post promotions for other members.

### Rank eligibility (Discord roles)

The person being promoted must **already have** a Discord role whose name matches `New Rank:` (case-insensitive). For example, you cannot request **Chief** unless you have a **Chief** role in Discord.

Staff with **Manage Server** or the staff ping role can post promotions for others without this check.

### Discord nickname

After a successful promotion, the bot updates the member's nickname:

- `3000 | J. Forman` → `3005 | J. Forman` (replaces the leading callsign)
- If no callsign is in the nickname, it adds one: `3005 | YourName`

The bot needs **Manage Nicknames** and its role must be above the member's highest role.

### Channel cleanup

On a **successful** promotion, the bot reacts with a checkmark on the request message and **deletes that message after 3 minutes**. The bot's reply embed stays in the channel. The bot needs **Add Reactions** and **Manage Messages** in the promotions channel.

## Your sheet layout

Row 1 must be the header row:

| A | B | C | D | E+ |
|---|---|---|---|-----|
| **RANK** | **RP NAME** | **CALLSIGN** | **ROLLS** | Patrol Cert, IA, SWAT, R/A Cert |

Row 1 can be a title (e.g. **FORT WORTH EMPLOYEE ROSTER**). The bot scans the first 30 rows to find the header row with **RANK | RP NAME | CALLSIGN | ROLLS**.

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

## Test connection in Discord

Staff can run:

```
/rostercheck
```

Optional: `/rostercheck rank:Lance Corporal` to see if that rank has an open callsign slot.

The reply is only visible to you (ephemeral). Requires **Manage Server** or the staff ping role.

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
