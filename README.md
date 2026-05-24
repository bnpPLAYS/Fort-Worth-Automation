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
