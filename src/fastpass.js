const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require("discord.js");

const PANEL_COMMAND = "-panelfastpass";
const BUTTON_CUSTOM_ID = "fastpass_apply";
const MODAL_CUSTOM_ID = "fastpass_modal";

const FORM_FIELDS = [
  {
    id: "reason",
    label: "Why are you requesting Fast Pass?",
    placeholder: "Explain why you need Fast Pass access...",
  },
  {
    id: "experience",
    label: "Relevant experience or background",
    placeholder: "Share any experience that supports your request...",
  },
  {
    id: "additional",
    label: "Additional information",
    placeholder: "Anything else we should know...",
  },
];

function getSubmissionsChannelId() {
  return process.env.FASTPASS_SUBMISSIONS_CHANNEL_ID || "1498803252626718833";
}

function buildPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Fast Pass Application")
    .setDescription(
      "Click the button below to open the application form.\n\n" +
        "You will be asked a few questions — please answer in as much detail as possible.",
    )
    .setFooter({ text: "Fort Worth Automation" });
}

function buildPanelButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_CUSTOM_ID)
      .setLabel("Apply for Fast Pass")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildApplicationModal() {
  const modal = new ModalBuilder()
    .setCustomId(MODAL_CUSTOM_ID)
    .setTitle("Fast Pass Application");

  for (const field of FORM_FIELDS) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(field.id)
          .setLabel(field.label)
          .setPlaceholder(field.placeholder)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000),
      ),
    );
  }

  return modal;
}

function buildSubmissionEmbed(interaction) {
  const user = interaction.user;
  const member = interaction.member;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("New Fast Pass Application")
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "User", value: `${user}`, inline: true },
      { name: "Username", value: user.tag, inline: true },
      { name: "User ID", value: user.id, inline: true },
      {
        name: "Account Created",
        value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`,
        inline: true,
      },
    )
    .setTimestamp();

  if (member?.joinedTimestamp) {
    embed.addFields({
      name: "Joined Server",
      value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`,
      inline: true,
    });
  }

  for (const field of FORM_FIELDS) {
    const answer = interaction.fields.getTextInputValue(field.id);
    embed.addFields({
      name: field.label,
      value: answer.length > 1024 ? answer.slice(0, 1021) + "..." : answer,
    });
  }

  return embed;
}

async function handlePanelCommand(message) {
  if (!message.content.trim().toLowerCase().startsWith(PANEL_COMMAND)) return false;
  if (message.author.bot) return false;

  const permissions = message.member?.permissions;
  if (!permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply("You need **Manage Server** permission to post the Fast Pass panel.");
    return true;
  }

  await message.channel.send({
    embeds: [buildPanelEmbed()],
    components: [buildPanelButton()],
  });

  if (message.deletable) {
    await message.delete().catch(() => {});
  }

  return true;
}

async function handleInteraction(interaction) {
  if (interaction.isButton() && interaction.customId === BUTTON_CUSTOM_ID) {
    await interaction.showModal(buildApplicationModal());
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId === MODAL_CUSTOM_ID) {
    await interaction.deferReply({ ephemeral: true });

    const channelId = getSubmissionsChannelId();
    const submissionsChannel = await interaction.client.channels.fetch(channelId).catch(() => null);

    if (!submissionsChannel?.isTextBased()) {
      await interaction.editReply(
        "Your answers were recorded, but the submissions channel could not be found. Contact an admin.",
      );
      return true;
    }

    await submissionsChannel.send({ embeds: [buildSubmissionEmbed(interaction)] });
    await interaction.editReply("Your Fast Pass application has been submitted. Thank you!");
    return true;
  }

  return false;
}

module.exports = {
  handlePanelCommand,
  handleInteraction,
};
