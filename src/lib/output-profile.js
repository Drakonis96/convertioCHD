const CONSOLE_OPTIONS = [
  { defaultOutputProfile: 'auto', id: 'auto', label: 'Auto detect' },
  { defaultOutputProfile: 'cd', id: 'ps1', label: 'PlayStation' },
  { defaultOutputProfile: 'cd', id: 'saturn', label: 'Sega Saturn' },
  { defaultOutputProfile: 'cd', id: 'dreamcast', label: 'Dreamcast' },
  { defaultOutputProfile: 'cd', id: 'sega-cd', label: 'Sega CD / Mega-CD' },
  { defaultOutputProfile: 'cd', id: 'pc-engine-cd', label: 'PC Engine CD / TurboGrafx-CD' },
  { defaultOutputProfile: 'cd', id: 'neo-geo-cd', label: 'Neo Geo CD' },
  { defaultOutputProfile: 'cd', id: '3do', label: '3DO' },
  { defaultOutputProfile: 'cd', id: 'pc-fx', label: 'PC-FX' },
  { defaultOutputProfile: 'dvd', id: 'ps2', label: 'PlayStation 2' },
  { defaultOutputProfile: 'dvd', id: 'xbox', label: 'Original Xbox' },
];

const MANUAL_OUTPUT_PROFILES = [
  { command: 'createcd', id: 'cd', label: 'CD CHD' },
  { command: 'createdvd', id: 'dvd', label: 'DVD CHD' },
];

const SELECTION_MODES = [
  { id: 'automatic', label: 'Automatic' },
  { id: 'manual', label: 'Manual' },
];

const DEFAULT_CONVERSION_OPTIONS = {
  consoleId: 'auto',
  manualOutputProfile: 'cd',
  selectionMode: 'automatic',
};

const consoleMap = new Map(CONSOLE_OPTIONS.map((entry) => [entry.id, entry]));
const outputProfileMap = new Map(MANUAL_OUTPUT_PROFILES.map((entry) => [entry.id, entry]));
const selectionModeMap = new Map(SELECTION_MODES.map((entry) => [entry.id, entry]));

function normalizeConversionOptions(payload = {}) {
  const selectionMode = selectionModeMap.has(payload.selectionMode)
    ? payload.selectionMode
    : DEFAULT_CONVERSION_OPTIONS.selectionMode;
  const consoleId = consoleMap.has(payload.consoleId) ? payload.consoleId : DEFAULT_CONVERSION_OPTIONS.consoleId;
  const manualOutputProfile = outputProfileMap.has(payload.manualOutputProfile)
    ? payload.manualOutputProfile
    : DEFAULT_CONVERSION_OPTIONS.manualOutputProfile;

  return {
    consoleId,
    consoleLabel: consoleMap.get(consoleId).label,
    manualOutputProfile,
    manualOutputProfileLabel: outputProfileMap.get(manualOutputProfile).label,
    selectionMode,
    selectionModeLabel: selectionModeMap.get(selectionMode).label,
  };
}

function getConsoleDefaultOutputProfile(consoleId) {
  return consoleMap.get(consoleId || DEFAULT_CONVERSION_OPTIONS.consoleId)?.defaultOutputProfile || 'auto';
}

function getOutputProfileEntry(profileId) {
  return outputProfileMap.get(profileId) || outputProfileMap.get(DEFAULT_CONVERSION_OPTIONS.manualOutputProfile);
}

function getConversionOptionsPayload() {
  return {
    consoleOptions: CONSOLE_OPTIONS.map(({ defaultOutputProfile, id, label }) => ({
      defaultOutputProfile,
      id,
      label,
    })),
    manualOutputProfiles: MANUAL_OUTPUT_PROFILES.map(({ command, id, label }) => ({
      command,
      id,
      label,
    })),
    selectionModes: SELECTION_MODES.map(({ id, label }) => ({ id, label })),
  };
}

module.exports = {
  CONSOLE_OPTIONS,
  DEFAULT_CONVERSION_OPTIONS,
  MANUAL_OUTPUT_PROFILES,
  SELECTION_MODES,
  getConsoleDefaultOutputProfile,
  getConversionOptionsPayload,
  getOutputProfileEntry,
  normalizeConversionOptions,
};
