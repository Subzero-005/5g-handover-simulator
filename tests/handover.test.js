import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, handoverType } from '../src/sim/index.js';

// Build a simulation with a single stationary UE and hand-written
// measurements so the A3 state machine can be checked in isolation.
function rig(params = {}) {
  const sim = new Simulation({ scenario: 'urban', ueCount: 1, params: { shadowingScale: 0, measurementNoiseDb: 0, ...params } });
  const ue = [...sim.ues.values()][0];
  const towers = [...sim.towers.values()].filter((t) => t.tech === 'LTE');
  const [a, b] = towers;
  ue.step = () => {}; // freeze mobility
  ue.moved = 0;
  sim.measure = (u) => {
    for (const [id, f] of Object.entries(sim.fake)) u.meas.set(id, { raw: f, f, los: true });
  };
  sim.fake = { [a.id]: -80, [b.id]: -100 };
  for (const t of sim.towers.values()) if (t !== a && t !== b) t.enabled = false;
  sim.tick();
  return { sim, ue, a, b };
}

test('UE attaches to the strongest cell', () => {
  const { ue, a } = rig();
  assert.equal(ue.serving, a.id);
  assert.equal(ue.state, 'connected');
});

test('A3 fires only after the neighbour stays offset+hysteresis better for TTT', () => {
  const { sim, ue, a, b } = rig({ a3OffsetDb: 3, hysteresisDb: 2, tttMs: 320 });
  // 4 dB better: below offset + hysteresis (5 dB) → no trigger.
  sim.fake = { [a.id]: -90, [b.id]: -86 };
  for (let i = 0; i < 10; i++) sim.tick();
  assert.equal(ue.state, 'connected');
  assert.equal(ue.serving, a.id);

  // 6 dB better: entering condition met; must hold for 320 ms.
  sim.fake = { [a.id]: -90, [b.id]: -84 };
  sim.tick();
  sim.tick();
  assert.equal(ue.state, 'connected', 'TTT not yet expired');
  // The timer starts on the first of those ticks; 300 ms later the condition
  // has not yet held for 320 ms, at 400 ms the handover starts.
  sim.tick();
  sim.tick();
  assert.equal(ue.state, 'connected');
  sim.tick();
  assert.equal(ue.state, 'executing');
  assert.equal(ue.ho.to, b.id);
  sim.tick(); // 40 ms prep + 50 ms interruption fits in one 100 ms tick
  assert.equal(ue.state, 'connected');
  assert.equal(ue.serving, b.id);
  assert.equal(sim.metrics.success, 1);
});

test('TTT timer resets when the condition drops out', () => {
  const { sim, ue, a, b } = rig({ a3OffsetDb: 0, hysteresisDb: 1, tttMs: 320 });
  for (let round = 0; round < 5; round++) {
    sim.fake = { [a.id]: -90, [b.id]: -85 };
    sim.tick();
    sim.tick();
    sim.fake = { [a.id]: -90, [b.id]: -95 };
    sim.tick();
  }
  assert.equal(ue.serving, a.id);
  assert.equal(sim.metrics.attempts, 0);
});

test('a quick return to the previous cell is counted as ping-pong', () => {
  const { sim, ue, a, b } = rig({ a3OffsetDb: 0, hysteresisDb: 0, tttMs: 0, pingPongWindowMs: 2000 });
  sim.fake = { [a.id]: -90, [b.id]: -80 };
  for (let i = 0; i < 4; i++) sim.tick();
  assert.equal(ue.serving, b.id);
  sim.fake = { [a.id]: -80, [b.id]: -90 };
  for (let i = 0; i < 4; i++) sim.tick();
  assert.equal(ue.serving, a.id);
  assert.equal(sim.metrics.pingPong, 1);
});

test('switching off the serving cell causes RLF and re-establishment elsewhere', () => {
  const { sim, ue, a, b } = rig();
  sim.setTowerEnabled(a.id, false);
  delete sim.fake[a.id];
  ue.meas.delete(a.id);
  sim.tick();
  assert.equal(ue.state, 'reestablishing');
  assert.equal(sim.metrics.causes['cell-outage'], 1);
  for (let i = 0; i < 8; i++) sim.tick();
  assert.equal(ue.state, 'connected');
  assert.equal(ue.serving, b.id);
});

test('admission control rejects handover into a full cell', () => {
  const { sim, ue, a, b } = rig({ a3OffsetDb: 0, hysteresisDb: 0, tttMs: 0 });
  sim.updateCellLoad = () => {
    a.users = 1;
    b.users = 999;
  };
  sim.fake = { [a.id]: -90, [b.id]: -80 };
  sim.tick();
  assert.equal(ue.serving, a.id);
  assert.ok(sim.metrics.rejected >= 1);
});

test('handover types', () => {
  assert.equal(handoverType('LTE', 'LTE'), 'intraLTE');
  assert.equal(handoverType('NR', 'NR'), 'intraNR');
  assert.equal(handoverType('NR', 'MMW'), 'interFreqNR');
  assert.equal(handoverType('LTE', 'MMW'), 'interRAT');
});
