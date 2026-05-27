require("dotenv").config();

const {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const { handlePanelCommand, handleInteraction, MIN_WORDS } = require("./fastpass");
const {
  buildRideAlongCommand,
  handleCadetPanelCommand,
  handleCadetInteraction,
  handleRideAlongMessage,
  handleRideAlongInteraction,
} = require("./cadet");
const { handlePromotionMessage } = require("./promotion-handler");
const { handleRosterCheckCommand } = require("./roster-check");
const {
  buildRosterAddCommand,
  handleRosterAddCommand,
  handleRosterAddAutocomplete,
} = require("./roster-add");
const { buildRefreshCallsignCommand, handleRefreshCallsignCommand } = require("./refresh-callsign");
const { buildSyncPromotionsCommand, handleSyncPromotionsCommand } = require("./sync-promotions");
const {
  handleSupportPanelCommand,
  handleStaffPanelCommand,
  handleSupportInteraction,
  handleSupportMessage,
} = require("./support");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

let isStarting = false;

if (!token) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

if (!clientId) {
  console.error("Missing CLIENT_ID in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Replies with Pong!"),
  new SlashCommandBuilder()
    .setName("staffpanel")
    .setDescription("Open the staff ticket management panel in this ticket channel"),
  new SlashCommandBuilder()
    .setName("rostercheck")
    .setDescription("Test Google Sheets roster connection and configuration")
    .addStringOption((option) =>
      option
        .setName("rank")
        .setDescription("Optional: check if this rank has an open callsign slot")
        .setRequired(false),
    ),
  buildRosterAddCommand(),
  buildRefreshCallsignCommand(),
  buildSyncPromotionsCommand(),
  buildRideAlongCommand(),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("Slash commands registered.");
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Fast Pass Part 2 minimum: ${MIN_WORDS} words per answer`);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await handlePanelCommand(message);
    await handleCadetPanelCommand(message);
    await handleSupportPanelCommand(message);
    await handleSupportMessage(message);
    await handleRideAlongMessage(message);
    await handlePromotionMessage(message);
  } catch (error) {
    console.error("Message handler error:", error);
  }
});

function isBenignInteractionError(error) {
  const code = error?.code;
  return (
    code === 40060 ||
    code === 10062 ||
    code === 10008 ||
    error?.message?.includes("already been acknowledged") ||
    error?.message?.includes("Unknown interaction")
  );
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const handledAutocomplete = await handleRosterAddAutocomplete(interaction);
      if (handledAutocomplete) return;
    }

    let handled = await handleInteraction(interaction);
    if (handled) return;

    handled = await handleCadetInteraction(interaction);
    if (handled) return;

    handled = await handleRideAlongInteraction(interaction);
    if (handled) return;

    handled = await handleSupportInteraction(interaction);
    if (handled) return;

    handled = await handleStaffPanelCommand(interaction);
    if (handled) return;

    handled = await handleRosterCheckCommand(interaction);
    if (handled) return;

    handled = await handleRosterAddCommand(interaction);
    if (handled) return;

    handled = await handleRefreshCallsignCommand(interaction);
    if (handled) return;

    handled = await handleSyncPromotionsCommand(interaction);
    if (handled) return;

    if (interaction.isChatInputCommand() && interaction.commandName === "ping") {
      await interaction.reply("Pong!");
    }
  } catch (error) {
    if (isBenignInteractionError(error)) {
      console.warn("Ignored duplicate or expired interaction:", error.message);
      return;
    }

    console.error("Interaction handler error:", error);

    const reply = { content: "Something went wrong. Please try again.", ephemeral: true };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else if (interaction.isRepliable()) {
        await interaction.reply(reply);
      }
    } catch (replyError) {
      if (!isBenignInteractionError(replyError)) {
        console.error("Failed to send interaction error reply:", replyError);
      }
    }
  }
});

async function main() {
  if (isStarting) {
    console.warn("Bot startup already in progress. Skipping duplicate start.");
    return;
  }

  isStarting = true;
  await registerCommands();
  await client.login(token);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
