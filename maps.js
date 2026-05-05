// CS2 Premier active duty maps. Scales come from each map's
// resource/overviews/<map>.txt file in the game data — they describe
// "how many world units fit into one pixel of the (1024px) radar PNG".
// We use them to convert a player's max running speed (game units/sec)
// into pixels on the rendered mini-map for the pin radius.
const MAPS = {
  de_ancient:  { name: "Ancient",  scale: 5.00 },
  de_anubis:   { name: "Anubis",   scale: 5.22 },
  de_dust2:    { name: "Dust 2",   scale: 4.40 },
  de_inferno:  { name: "Inferno",  scale: 4.90 },
  de_mirage:   { name: "Mirage",   scale: 5.00 },
  de_nuke:     { name: "Nuke",     scale: 7.00 },
  de_overpass: { name: "Overpass", scale: 5.20 },
  de_train:    { name: "Train",    scale: 4.70 },
};

// CS2 Premier player-tag colours.
const PLAYER_COLORS = [
  { id: "yellow", name: "Yellow", hex: "#FFEE00" },
  { id: "purple", name: "Purple", hex: "#A050FF" },
  { id: "green",  name: "Green",  hex: "#3CDC2E" },
  { id: "blue",   name: "Blue",   hex: "#4F8AFF" },
  { id: "orange", name: "Orange", hex: "#FF8C00" },
];

// Canonical native size of CS2/CS:GO radar PNGs that the scale values
// were calibrated against. (Higher-res PNGs still use the same scale,
// so this number is what we divide by to get a fraction of the map.)
const NATIVE_MAP_PX = 1024;

// Scout has the highest weapon-out running speed in CS2: 260 u/s.
// Knife/grenade out: 250 u/s. We use the highest as worst case.
const MAX_PLAYER_SPEED = 260;

// Pin lifetime before turning into a "?" marker.
const PIN_TIMER_SECONDS = 10;
