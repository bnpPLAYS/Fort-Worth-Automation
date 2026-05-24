# Fort-Worth-Automation

Discord bot built with [discord.js](https://discord.js.org/) v14.

## Setup

1. **Get your Bot Token** (not the Client Secret):
   - [Discord Developer Portal](https://discord.com/developers/applications) → your app → **Bot** → copy token

2. **Create `.env`** from the example:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set `DISCORD_TOKEN` to your bot token.

3. **Invite the bot** to your server:
   - Developer Portal → **OAuth2 → URL Generator**
   - Scopes: `bot`, `applications.commands`
   - Permissions: `Send Messages`, `Use Slash Commands`
   - Open the generated URL and add the bot to your server

4. **Install and run**:
   ```bash
   npm install
   npm start
   ```

5. In Discord, type `/ping` — the bot should reply with `Pong!`

## Fast Pass panel

1. In the [Developer Portal](https://discord.com/developers/applications) → **Bot**, enable **Message Content Intent** (required for `-panelfastpass`).
2. Restart the bot: `npm start`
3. In a channel, send `-panelfastpass` (requires **Manage Server** permission).
4. Users click the grey **Fast Pass** button to begin a two-part application. Part 2 requires at least 20 words per answer. Staff can Accept (assign rank) or Deny (4-day cooldown) from the submissions channel.

**Staff review:** Accept/Deny buttons appear on each submission in the submissions channel. Requires **Manage Roles** or **Manage Server**. On accept, assign one of the configured officer ranks. The bot also needs **Server Members Intent** enabled in the Developer Portal for role assignment.

## Assistance Hub / Support Tickets

1. Send `-supportpanel` (requires **Manage Server**) to post the Assistance Hub with a red **Contact Support** button.
2. **FastPass** — opens the existing Fast Pass application UI.
3. **Report** — select a member, describe what happened, opens `{member}-report` in the report category with an Internal Affairs embed. `@here` is pinged after the opener sends their first message (evidence/clips).
4. **Other** — opens `{username}-support` in the general support category with a welcome embed and `@here` ping.
5. Staff use `/staffpanel` inside a ticket channel for **Close Ticket** (DMs reason to opener), **Close Request**, or **Ticket Advance** (escalates category and pings staff role).

The bot needs **Manage Channels** permission and its role must be above ticket categories and the staff role.

## Deploy to VPS

```bash
git clone git@github.com:bnpPLAYS/Fort-Worth-Automation.git
cd Fort-Worth-Automation
npm install --production
# create .env on the server with DISCORD_TOKEN and CLIENT_ID
pm2 start src/index.js --name fort-worth-bot
pm2 save
pm2 startup
```

## Security

- Never commit `.env` or share your Bot Token
- Reset your token in the Developer Portal if it is ever exposed
