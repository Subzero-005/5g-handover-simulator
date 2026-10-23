import test from 'node:test';
import assert from 'node:assert/strict';
import { pathLoss, sinrDb, throughputMbps, noisePerReDbm, medianRsrp, TECH, generateCity } from '../src/sim/index.js';

test('UMa LOS path loss matches TR 38.901 at 100 m / 3.5 GHz', () => {
  const { los } = pathLoss('UMa', 100, 1.5, 1.5, 3.5);
  // 28 + 22*log10(100) + 20*log10(3.5)
  assert.ok(Math.abs(los - (28 + 44 + 20 * Math.log10(3.5))) < 1e-9);
});

test('NLOS loss is never below LOS loss', () => {
  for (const model of ['UMa', 'UMi']) {
    for (const d of [5, 20, 100, 500, 2000]) {
      const { los, nlos } = pathLoss(model, d, 25, 1.5, 3.5);
      assert.ok(nlos >= los, `${model} at ${d} m`);
    }
  }
});

test('path loss grows monotonically with distance', () => {
  let prev = -Infinity;
  for (let d = 10; d <= 2000; d += 50) {
    const { nlos } = pathLoss('UMa', d, 30, 1.5, 1.8);
    assert.ok(nlos > prev);
    prev = nlos;
  }
});

test('thermal noise per resource element', () => {
  // -174 dBm/Hz + 10log10(15 kHz) + 7 dB NF ≈ -125.2 dBm
  assert.ok(Math.abs(noisePerReDbm(TECH.LTE, 7) - -125.24) < 0.01);
});

test('SINR without interference equals SNR, and interference lowers it', () => {
  const snr = sinrDb(-90, [], -120);
  assert.ok(Math.abs(snr - 30) < 1e-9);
  const withI = sinrDb(-90, [{ rsrp: -95, load: 1 }], -120);
  assert.ok(withI < 6 && withI > 4);
  const capped = sinrDb(-50, [], -120, 30);
  assert.ok(capped < 30 && capped > 29.9);
});

test('throughput is zero below the decoding threshold and capped at peak', () => {
  assert.equal(throughputMbps(TECH.NR, -10), 0);
  const peak = throughputMbps(TECH.NR, 60);
  const expected = TECH.NR.bandwidthMHz * 0.85 * TECH.NR.maxSpectralEff * TECH.NR.mimoLayers;
  assert.ok(Math.abs(peak - expected) < 1e-6);
  assert.ok(Math.abs(throughputMbps(TECH.NR, 60, 4) - peak / 4) < 1e-6);
});

test('buildings block mmWave far more than LTE', () => {
  const city = generateCity({ seed: 1, parks: [] });
  const b = city.buildings.find((x) => x.h > 40);
  // Put the tower on one side of a tall building and the UE on the other.
  const lte = { tech: 'LTE', x: b.minX - 40, z: b.cz, height: 12 };
  const mmw = { tech: 'MMW', x: b.minX - 40, z: b.cz, height: 12 };
  const ux = b.maxX + 20;
  const lteRsrp = medianRsrp(lte, ux, b.cz, city);
  const mmwRsrp = medianRsrp(mmw, ux, b.cz, city);
  assert.equal(lteRsrp.los, false);
  const lteFree = medianRsrp(lte, ux, b.cz, null);
  const mmwFree = medianRsrp(mmw, ux, b.cz, null);
  assert.ok(mmwFree.rsrp - mmwRsrp.rsrp > lteFree.rsrp - lteRsrp.rsrp + 10);
});
