// Radio access technology profiles. Values are representative of commercial
// deployments: an LTE macro on band 3, a 5G NR mid-band massive-MIMO site on
// n78 and a 5G mmWave street-level small cell on n258.
export const TECH = {
  LTE: {
    id: 'LTE',
    label: '4G LTE',
    short: '4G',
    node: 'eNB',
    band: 'B3 · 1.8 GHz',
    freqGHz: 1.8,
    txPowerDbm: 46,
    antennaGainDbi: 15,
    bandwidthMHz: 20,
    scsKHz: 15,
    resourceBlocks: 100,
    mimoLayers: 2,
    maxSpectralEff: 5.55,
    model: 'UMa',
    defaultHeight: 42,
    blockageDb: 0,
    shadowCorrM: 50,
    maxUsers: 60,
    externalInterferenceDbm: -101,
    nominalRange: 700,
    color: '#ffb74d',
  },
  NR: {
    id: 'NR',
    label: '5G NR',
    short: '5G',
    node: 'gNB',
    band: 'n78 · 3.5 GHz',
    freqGHz: 3.5,
    txPowerDbm: 46,
    antennaGainDbi: 24,
    bandwidthMHz: 100,
    scsKHz: 30,
    resourceBlocks: 273,
    mimoLayers: 4,
    maxSpectralEff: 7.4,
    model: 'UMa',
    defaultHeight: 34,
    blockageDb: 4,
    shadowCorrM: 37,
    maxUsers: 80,
    externalInterferenceDbm: -103,
    nominalRange: 450,
    color: '#4dd0e1',
  },
  MMW: {
    id: 'MMW',
    label: '5G mmWave',
    short: '5G+',
    node: 'SC',
    band: 'n258 · 26 GHz',
    freqGHz: 26,
    txPowerDbm: 33,
    antennaGainDbi: 30,
    bandwidthMHz: 400,
    scsKHz: 120,
    resourceBlocks: 264,
    mimoLayers: 2,
    maxSpectralEff: 7.4,
    model: 'UMi',
    defaultHeight: 12,
    blockageDb: 18,
    shadowCorrM: 13,
    maxUsers: 40,
    externalInterferenceDbm: -125,
    nominalRange: 180,
    color: '#b388ff',
  },
};

export const TECH_IDS = Object.keys(TECH);

// Handover execution timing in milliseconds: preparation over X2/Xn and the
// user-plane interruption while the UE performs random access on the target.
export const HO_TIMING = {
  intraLTE: { prep: 40, interrupt: 50, label: 'X2 intra-LTE' },
  intraNR: { prep: 30, interrupt: 25, label: 'Xn intra-NR' },
  interFreqNR: { prep: 35, interrupt: 30, label: 'Xn inter-freq NR' },
  interRAT: { prep: 80, interrupt: 70, label: 'Inter-RAT LTE↔NR' },
};

export const TTT_VALUES = [0, 40, 64, 80, 100, 128, 160, 256, 320, 480, 512, 640, 1024, 1280, 2560];

export const DEFAULT_PARAMS = {
  tickMs: 100,
  a3OffsetDb: 3,
  hysteresisDb: 2,
  tttMs: 320,
  // Cell individual offsets per technology; positive values bias the UE
  // towards that layer (e.g. "prefer 5G when it is good enough").
  cioDb: { LTE: 0, NR: 3, MMW: 5 },
  l3FilterK: 4,
  shadowingScale: 1,
  measurementNoiseDb: 1,
  mlbEnabled: false,
  mlbGainDb: 6,
  pingPongWindowMs: 2000,
  tooEarlyWindowMs: 2000,
  qOutDb: -8,
  qInDb: -6,
  t310Ms: 1000,
  reestablishMs: 600,
  minRsrpDbm: -124,
  noiseFigureDb: 7,
  // Receiver impairments (EVM, phase noise) cap the achievable SINR.
  maxSinrDb: 30,
  // Include interference arriving from cells outside the simulated area.
  externalInterference: true,
};

export const UE_KINDS = {
  // bodyLossDb: hand/body loss for phones, vehicle penetration loss for cars.
  pedestrian: { label: 'Pedestrian', icon: 'directions_walk', speed: [1.0, 1.8], bodyLossDb: 3 },
  vehicle: { label: 'Vehicle', icon: 'directions_car', speed: [8, 15], bodyLossDb: 9 },
  express: { label: 'Ring-road', icon: 'speed', speed: [22, 33], bodyLossDb: 9 },
};
