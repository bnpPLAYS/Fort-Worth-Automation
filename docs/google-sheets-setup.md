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

The person being promoted must **already have** a Discord role that matches `New Rank:` (case-insensitive). Prefixes are ignored — `lieutenant` matches a role named `FWPD | Lieutenant`. You cannot request **Chief** unless you have a role that includes **Chief** as the rank name.

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
- Only rows with a **4-digit callsign** or **cadet callsign** (`C-1` … `C-100`) in column C are treated as roster slots
- **Open slot** = rank + callsign filled, **RP NAME** (column B) is empty

### Cadet callsigns (C-1 to C-100)

Add a **CADET** section on the roster tab with rows like:

| RANK | RP NAME | CALLSIGN | ROLLS |
|------|---------|----------|-------|
| CADET | | C-1 | |
| CADET | | C-2 | |
| … | | … | |

When someone clicks **Become Cadet**, the bot assigns the next open `C-N` slot and tells them **not to use it in-game**.

### Ride-along staff buttons

Cadets request ride-alongs with **`/ridealong`** in the ride-along request channel (modal: Roblox username, Discord username, availability). Staff with roles `1484950025472704643` or `1484950653045440532` see **Claim**, **Pass**, and **Fail** in the employee notification channel.

1. **Claim** — take charge of the ride-along; pings the applicant with station instructions (blocky avatar, no unrealistic accessories)
2. **Start Ride Along** — only the claimer; opens a popup to **upload a screenshot** of you and your cadet; supervision reminder; **30-minute** ping to end
3. **Notes** — only the claimer, while the ride-along is in progress; add observations anytime
4. **End Ride Along** — shows all notes, then **Submit Score** (1–10, decimals allowed)
5. **Pass** — score **7.5** or higher; PO roster move, roles, nickname, DM
6. **Fail** — score **below 7.5**; cadet roles removed, roster cleared, **3-day** re-enroll cooldown

### Automatic roster updates

| Event | Bot action |
|-------|------------|
| **Become Cadet** | Assigns next open `C-1` … `C-100` cadet callsign |
| **Fast Pass accepted** | Assigns open slot for the selected rank (e.g. Probationary Officer) + department callsign |
| **Supervisor exam approved** | Moves member from **Lance Corporal** to open **Corporal** slot (`GOOGLE_SUPERVISOR_RANK_NAME`) |
| **Promotion channel message** | Manual rank move (existing flow) |
| **`/rosteradd`** (staff) | First-time roster setup: RP name + Discord member + rank → open callsign, nickname, Discord roles |

### `/rosteradd` (staff only)

Staff with roles `1484950025472704643`, `1484950653045440532`, or `1484949625281712281` (or **Manage Server** / **Administrator**) can run:

```
/rosteradd member:@User roleplay_name:John Smith rank:Probationary Officer
```

For **rank**, start typing — the bot suggests every rank on the sheet that currently has an **open callsign** (up to 25 matches). Labels show how many open slots exist, e.g. `LIEUTENANT (2 open)`.

- Formats the name for the sheet (e.g. **J. Smith**)
- Fails if that RP name is already on the roster
- Assigns the next open callsign for the chosen rank
- Sets Discord nickname to `callsign | J. Smith`
- Assigns the matching Discord rank role(s) (Cadet gets all cadet roles)

Requires open rows on the sheet for the selected rank.

### Discord ↔ roster links (duplicate RP names)

The bot stores a persistent link for each Discord account in `data/roster-links.json` on the server:

- **Discord user ID** → roleplay name, callsign, sheet row number, rank

Links are created or updated whenever someone is added or synced (`/rosteradd`, cadet enroll, Fast Pass, ride-along pass, promotions, `/refresh-callsign`, `/sync-promotions`, demotions, etc.).

**Mass callsign updates** (`/refresh-callsign`) use this link first, then nickname callsign, so two members with the same RP name (e.g. two **J. Smith** rows) are not mixed up.

Use `/info @member` to see whether an account is linked and which sheet row it points to. If someone is unlinked, run `/rosteradd` or any roster sync that touches them.

### `/refresh-callsign` (role `1484949625281712281`)

Runs two steps:

1. **Probationary Officer roster fix** — anyone with the PO Discord role who is still on a **cadet** row (or not on a PO row) is moved to the next open **Probationary Officer** slot on the sheet (clears their old cadet row).
2. **Callsign sync** — members with role `1484951746852818944` get nicknames updated from the sheet using their **stored Discord link** when needed. **DMs are sent only** if their callsign or nickname actually changed.

Use after bulk callsign changes or when ride-along passes could not move people because no PO slots were open.

### Automatic Discord rank sync (every 5 minutes)

The bot also watches **Discord rank role** changes (for example **Cadet** → **Probationary Officer**):

- On role change, it updates the Google roster row, nickname, stored link, and **DMs** the new callsign when it changes.
- Every **5 minutes** it runs a safety pass for members with the roster sync role (`1484951746852818944`).

Manual `/sync-promotions` still works the same way.

### One-time roster layout (Commander / Captain)

On first startup after an update, the bot runs a **one-time** sheet cleanup v2 (tracked in `data/.roster-reorganized.json` on the server):

- Restores **Commander** rank text if a prior run mislabeled rows as Office of the Chief
- **Moves** Commander rows into the **Office of the Chief** section (rank stays Commander)
- **Moves** Captain rows to the **top** of the supervisory section (Patrol Supervisors); other rows shift down

Staff can also run: `node scripts/reorganize-roster-sections.js` (`--dry-run` to preview, `--force` to run again after deleting the marker file).

### `/sync-promotions` (role `1484949249245315302`)

Run **after Discord promotions** (rank roles updated). For every member with role `1484951746852818944`:

1. **Only** members with role `1484951746852818944` are processed (not random server members).
2. **Links** each eligible account to their sheet row using **`callsign | Name`** in their nickname (e.g. `3000 | J. Forman` → callsign `3000` on the roster). Plain numbers in a name without the pipe format are ignored.
3. Reads their **highest matching rank** from Discord role names (compared to ranks on the sheet, top-to-bottom).
4. If that rank differs from their row on the Google roster, clears their old row and assigns the next open **callsign** in the new rank.
5. Updates their Discord nickname and **DMs** them if their callsign changed.

Members **not on the roster** are skipped (use `/rosteradd` first). Use `/info @member` to confirm the link after running this command.

Requires open roster slots for any new ranks. Rank names on Discord roles must loosely match the sheet (e.g. `FWPD | Lieutenant` matches `LIEUTENANT`).

### Member roster roles

When someone is added via **Become Cadet**, **Fast Pass accept**, **ride-along pass**, or **`/rosteradd`**, the bot assigns roles `1484951746852818944` and `1498375617455067387` and DMs their callsign when assigned.

Rank names on the sheet must match Discord role names loosely (e.g. `Probationary Officer`, `LIEUTENANT`).
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
