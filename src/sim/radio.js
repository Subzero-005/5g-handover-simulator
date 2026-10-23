import { TECH } from './config.js';

const log10 = Math.log10;

export const dbmToMw = (dbm) => Math.pow(10, dbm / 10);
export const mwToDbm = (mw) => 10 * log10(mw);

// 3GPP TR 38.901 path loss. UMa for macro sites, UMi street canyon for small
// cells. Returns both the LOS and NLOS loss in dB (NLOS is floored at LOS as
// the spec requires).
export function pathLoss(model, dist2D, hBS, hUT, fcGHz) {
  const d3 = Math.max(10, Math.hypot(dist2D, hBS - hUT));
  const lf = log10(d3);
  if (model === 'UMi') {
    const los = 32.4 + 21 * lf + 20 * log10(fcGHz);
    const nlos = 22.4 + 35.3 * lf + 21.3 * log10(fcGHz) - 0.3 * (hUT - 1.5);
    return { los, nlos: Math.max(los, nlos) };
  }
  const los = 28.0 + 22 * lf + 20 * log10(fcGHz);
  const nlos = 13.54 + 39.08 * lf + 20 * log10(fcGHz) - 0.6 * (hUT - 1.5);
  return { los, nlos: Math.max(los, nlos) };
}

// RSRP is power per resource element, so the total transmit power is spread
// over 12 subcarriers per resource block.
export const reSpreadDb = (tech) => 10 * log10(12 * tech.resourceBlocks);

export const noisePerReDbm = (tech, noiseFigureDb = 7) => -174 + 10 * log10(tech.scsKHz * 1000) + noiseFigureDb;

export function shadowSigma(tech, los) {
  if (tech.model === 'UMi') return los ? 4 : 7.82;
  return los ? 4 : 6;
}

// Median RSRP (no shadowing, no fast fading) from a tower at a ground point.
export function medianRsrp(tower, x, z, city, hUT = 1.5) {
  const tech = TECH[tower.tech];
  const d = Math.hypot(x - tower.x, z - tower.z);
  const blocked = city ? city.blockers(tower.x, tower.z, tower.height, x, z, hUT, tower.hostBuilding ?? -1) : 0;
  const pl = pathLoss(tech.model, d, tower.height, hUT, tech.freqGHz);
  const loss = blocked === 0 ? pl.los : pl.nlos + tech.blockageDb * Math.min(blocked, 3);
  return {
    rsrp: tech.txPowerDbm + tech.antennaGainDbi - reSpreadDb(tech) - loss,
    los: blocked === 0,
    distance: d,
  };
}

// Interference load factor: idle cells still radiate reference signals,
// busier cells radiate on more resource elements.
export const loadFactor = (users) => Math.min(1, 0.2 + users * 0.08);

export function sinrDb(signalDbm, interferers, noiseDbm, maxSinrDb = Infinity) {
  let i = dbmToMw(noiseDbm);
  for (const it of interferers) i += dbmToMw(it.rsrp) * it.load;
  const raw = signalDbm - mwToDbm(i);
  if (!Number.isFinite(maxSinrDb)) return raw;
  // Combine with the impairment ceiling: 1/SINR = 1/SINR_raw + 1/SINR_max.
  return -10 * log10(Math.pow(10, -raw / 10) + Math.pow(10, -maxSinrDb / 10));
}

// Downlink user throughput in Mbit/s from a truncated, attenuated Shannon
// bound. MIMO rank ramps up with SINR and the cell is shared round-robin.
export function throughputMbps(tech, sinr, shareUsers = 1) {
  if (sinr < -6.5) return 0;
  const lin = Math.pow(10, sinr / 10);
  const se = Math.min(tech.maxSpectralEff, 0.75 * Math.log2(1 + lin));
  const rankRamp = Math.min(1, Math.max(0, (sinr - 5) / 15));
  const layers = 1 + (tech.mimoLayers - 1) * rankRamp;
  return (tech.bandwidthMHz * 0.85 * se * layers) / Math.max(1, shareUsers);
}
