const { PROBATIONARY_OFFICER_ROLE_ID } = require("./constants");

const CADET_ROLE_IDS = [
  "1495414411840454676",
  "1484951746852818944",
  "1484951786623205516",
];

/** Discord role + sheet rank label pairs used by Fast Pass and /rosteradd */
const RANK_OPTIONS = [
  {
    id: "cadet",
    label: "Cadet",
    discordRoleIds: CADET_ROLE_IDS,
    useCadetCallsign: true,
  },
  {
    id: "probationary",
    label: "Probationary Officer",
    discordRoleIds: [PROBATIONARY_OFFICER_ROLE_ID],
  },
  {
    id: "officer_one",
    label: "Officer One",
    discordRoleIds: ["1484950896864530442"],
  },
  {
    id: "officer_two",
    label: "Officer Two",
    discordRoleIds: ["1484950861716263004"],
  },
  {
    id: "officer_three",
    label: "Officer Three",
    discordRoleIds: ["1484950728647774408"],
  },
];

function getRankOptionById(id) {
  return RANK_OPTIONS.find((rank) => rank.id === id) ?? null;
}

module.exports = {
  CADET_ROLE_IDS,
  RANK_OPTIONS,
  getRankOptionById,
};
