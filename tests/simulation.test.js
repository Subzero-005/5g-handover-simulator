import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, SCENARIO_IDS } from '../src/sim/index.js';

test('every scenario runs and keeps UEs on the map', () => {
  for (const id of SCENARIO_IDS) {
    const sim = new Simulation({ scenario: id });
    sim.run(60_000);
    const k = sim.kpis();
    assert.ok(k.success > 0, `${id}: handovers happen`);
    assert.ok(k.successRate > 0.8, `${id}: success rate ${k.successRate}`);
    for (const ue of sim.ues.values()) {
      assert.ok(Math.abs(ue.x) < sim.city.half + 20 && Math.abs(ue.z) < sim.city.half + 20, `${ue.id} off map`);
    }
  }
});

test('same seed gives identical results', () => {
  const a = new Simulation({ scenario: 'urban', seed: 5 });
  const b = new Simulation({ scenario: 'urban', seed: 5 });
  a.run(30_000);
  b.run(30_000);
  assert.deepEqual(a.kpis(), b.kpis());
});

test('UEs never walk through buildings', () => {
  const sim = new Simulation({ scenario: 'urban' });
  for (let s = 0; s < 120; s++) {
    sim.run(1000);
    for (const ue of sim.ues.values()) assert.equal(sim.city.buildingAt(ue.x, ue.z), null, `${ue.id} inside a building`);
  }
});

test('longer time-to-trigger reduces ping-pong', () => {
  const run = (tttMs) => {
    const sim = new Simulation({ scenario: 'urban', params: { tttMs, hysteresisDb: 0, a3OffsetDb: 1 } });
    sim.run(180_000);
    return sim.kpis();
  };
  const fast = run(0);
  const slow = run(1280);
  assert.ok(slow.pingPong < fast.pingPong, `ping-pong ${slow.pingPong} vs ${fast.pingPong}`);
  assert.ok(slow.success < fast.success);
});

test('adding, moving and removing towers at runtime', () => {
  const sim = new Simulation({ scenario: 'urban' });
  const t = sim.addTower({ tech: 'MMW', x: -75, z: -225 });
  sim.run(5000);
  sim.moveTower(t.id, 75, -225);
  assert.equal(sim.towers.get(t.id).x, 75);
  sim.removeTower(t.id);
  assert.equal(sim.towers.has(t.id), false);
  sim.run(5000);
  for (const ue of sim.ues.values()) assert.notEqual(ue.serving, t.id);
});

test('towers dropped on a building become rooftop sites', () => {
  const sim = new Simulation({ scenario: 'urban' });
  const b = sim.city.buildings[0];
  const t = sim.addTower({ tech: 'NR', x: b.cx, z: b.cz });
  assert.ok(t.height > b.h);
  assert.equal(t.hostBuilding, b.id);
});
