import { TECH, HO_TIMING, DEFAULT_PARAMS, UE_KINDS } from './config.js';
import { createRng } from './rng.js';
import { generateCity } from './city.js';
import { UE } from './ue.js';
import { medianRsrp, shadowSigma, noisePerReDbm, sinrDb, throughputMbps, loadFactor } from './radio.js';
import { SCENARIOS } from './scenarios.js';

const RATE_WINDOW_MS = 60_000;
const MAX_TICKS_PER_ADVANCE = 400;

function mergeParams(...sources) {
  const out = structuredClone(DEFAULT_PARAMS);
  for (const src of sources) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...out[k], ...v } : v;
    }
  }
  return out;
}

export function handoverType(fromTech, toTech) {
  if (fromTech === toTech) return fromTech === 'LTE' ? 'intraLTE' : fromTech === 'NR' ? 'intraNR' : 'interFreqNR';
  if (fromTech === 'LTE' || toTech === 'LTE') return 'interRAT';
  return 'interFreqNR';
}

function emptyMetrics() {
  return {
    attempts: 0,
    success: 0,
    failures: 0,
    pingPong: 0,
    rejected: 0,
    rlf: 0,
    causes: { 'too-late': 0, 'too-early': 0, 'wrong-cell': 0, 'coverage-hole': 0, 'cell-outage': 0 },
    byType: { intraLTE: 0, intraNR: 0, interFreqNR: 0, interRAT: 0 },
    recentSuccess: [],
    recentFail: [],
    series: [],
  };
}

// The network simulation: towers, UEs, radio measurements, the A3 handover
// state machine, radio link monitoring and KPI collection. It has no
// dependency on the renderer and runs the same in a browser or in Node.
export class Simulation {
  constructor({ scenario = 'urban', seed, params, ueCount } = {}) {
    this.listeners = new Map();
    this.load(scenario, { seed, params, ueCount });
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }

  emit(type, payload) {
    const set = this.listeners.get(type);
    if (set) for (const fn of set) fn(payload);
    const all = this.listeners.get('*');
    if (all) for (const fn of all) fn(type, payload);
  }

  load(scenarioId, { seed, params, ueCount } = {}) {
    const sc = SCENARIOS[scenarioId] ?? SCENARIOS.urban;
    this.scenario = sc;
    this.seed = seed ?? sc.seed;
    this.rng = createRng(this.seed);
    this.params = mergeParams(sc.params, params);
    this.city = generateCity({
      seed: this.seed,
      parks: sc.parks,
      clearings: sc.towers.map((t) => [t.x, t.z, t.tech === 'MMW' ? 6 : 16]),
    });
    this.time = 0;
    this.acc = 0;
    this.nextTowerNum = { LTE: 1, NR: 1, MMW: 1 };
    this.nextUeNum = 1;
    this.towers = new Map();
    this.ues = new Map();
    this.metrics = emptyMetrics();
    this.mix = { ...sc.mix };
    for (const t of sc.towers) this.addTower(t, { silent: true });
    this.setUeCount(ueCount ?? sc.ueCount, { silent: true });
    this.emit('reset', this);
  }

  reset() {
    this.load(this.scenario.id, { seed: this.seed, params: this.params, ueCount: this.ues.size });
  }

  setParams(patch) {
    this.params = mergeParams(this.params, patch);
    this.emit('params', this.params);
  }

  // ---------------------------------------------------------------- towers

  addTower({ tech, x, z, height, enabled = true }, { silent = false } = {}) {
    const profile = TECH[tech];
    const num = this.nextTowerNum[tech]++;
    const host = this.city.buildingAt(x, z);
    const tower = {
      id: `${tech}-${num}`,
      name: `${profile.node}-${num}`,
      tech,
      x,
      z,
      // Sites dropped inside a building become rooftop installations.
      height: height ?? (host ? host.h + Math.max(6, profile.defaultHeight * 0.3) : profile.defaultHeight),
      hostBuilding: host ? host.id : -1,
      enabled,
      users: 0,
      load: 0,
      throughput: 0,
    };
    this.towers.set(tower.id, tower);
    if (!silent) this.emit('tower-added', tower);
    return tower;
  }

  moveTower(id, x, z) {
    const t = this.towers.get(id);
    if (!t) return;
    const profile = TECH[t.tech];
    const host = this.city.buildingAt(x, z);
    t.x = x;
    t.z = z;
    t.hostBuilding = host ? host.id : -1;
    t.height = host ? host.h + Math.max(6, profile.defaultHeight * 0.3) : profile.defaultHeight;
    this.emit('tower-changed', t);
  }

  setTowerEnabled(id, enabled) {
    const t = this.towers.get(id);
    if (!t) return;
    t.enabled = enabled;
    this.emit('tower-changed', t);
  }

  removeTower(id) {
    const t = this.towers.get(id);
    if (!t) return;
    t.enabled = false;
    // Let connected UEs detect the outage before the tower disappears.
    for (const ue of this.ues.values()) {
      if (ue.serving === id || ue.ho?.to === id) this.radioLinkFailure(ue, 'cell-outage');
      ue.meas.delete(id);
      ue.shadow.delete(id);
      ue.ttt.delete(id);
    }
    this.towers.delete(id);
    this.emit('tower-removed', t);
  }

  cio(tower) {
    const p = this.params;
    const base = p.cioDb[tower.tech] ?? 0;
    return p.mlbEnabled ? base - p.mlbGainDb * tower.load : base;
  }

  // ------------------------------------------------------------------- UEs

  pickKind() {
    const { pedestrian = 0, vehicle = 0, express = 0 } = this.mix;
    const r = this.rng.next() * (pedestrian + vehicle + express || 1);
    if (r < pedestrian) return 'pedestrian';
    if (r < pedestrian + vehicle) return 'vehicle';
    return 'express';
  }

  addUe(kind = this.pickKind(), { silent = false } = {}) {
    const id = `UE-${String(this.nextUeNum++).padStart(3, '0')}`;
    const ue = new UE({ id, kind, city: this.city, rng: this.rng });
    this.ues.set(id, ue);
    if (!silent) this.emit('ue-added', ue);
    return ue;
  }

  removeUe(id) {
    const ue = this.ues.get(id);
    if (!ue) return;
    this.ues.delete(id);
    this.emit('ue-removed', ue);
  }

  setUeCount(n, opts = {}) {
    while (this.ues.size < n) this.addUe(undefined, opts);
    const ids = [...this.ues.keys()];
    while (this.ues.size > n) this.removeUe(ids.pop());
  }

  // ------------------------------------------------------------ main loop

  // Run exactly `ms` of simulated time (headless use).
  run(ms) {
    const ticks = Math.floor(ms / this.params.tickMs);
    for (let i = 0; i < ticks; i++) this.tick();
  }

  // Real-time stepping for the browser: carries the remainder between frames
  // and caps the work per call so a slow frame cannot spiral.
  advance(ms) {
    const tick = this.params.tickMs;
    this.acc += ms;
    let n = 0;
    while (this.acc >= tick && n < MAX_TICKS_PER_ADVANCE) {
      this.tick();
      this.acc -= tick;
      n++;
    }
    if (n === MAX_TICKS_PER_ADVANCE) this.acc = 0;
    return n;
  }

  // Interpolation factor between the previous and current tick, for smooth rendering.
  get alpha() {
    return Math.min(1, this.acc / this.params.tickMs);
  }

  tick() {
    const dt = this.params.tickMs;
    this.time += dt;

    for (const ue of this.ues.values()) {
      ue.step(dt / 1000);
      this.measure(ue);
    }

    this.updateCellLoad();

    for (const ue of this.ues.values()) {
      switch (ue.state) {
        case 'idle':
          this.initialAttach(ue);
          break;
        case 'connected':
          this.updateLink(ue);
          if (ue.state === 'connected') this.evaluateA3(ue);
          break;
        case 'executing':
          this.progressHandover(ue);
          break;
        case 'reestablishing':
          this.progressReestablishment(ue);
          break;
      }
      ue.record(this.time);
    }

    if (this.time % 1000 === 0) this.sample();
  }

  measure(ue) {
    const p = this.params;
    const bodyLoss = UE_KINDS[ue.kind].bodyLossDb;
    for (const tower of this.towers.values()) {
      if (!tower.enabled) {
        ue.meas.delete(tower.id);
        continue;
      }
      const tech = TECH[tower.tech];
      const m = medianRsrp(tower, ue.x, ue.z, this.city);

      // Spatially correlated log-normal shadowing (Gudmundson AR(1) model).
      const sigma = shadowSigma(tech, m.los) * p.shadowingScale;
      let s = ue.shadow.get(tower.id);
      if (s === undefined) s = sigma * this.rng.gauss();
      else {
        const a = Math.exp(-ue.moved / tech.shadowCorrM);
        s = a * s + Math.sqrt(1 - a * a) * sigma * this.rng.gauss();
      }
      ue.shadow.set(tower.id, s);

      const raw = m.rsrp - bodyLoss - s + p.measurementNoiseDb * this.rng.gauss();
      // Layer-3 filtering as in TS 38.331: F = (1 - a) F + a M, a = 1/2^(k/4).
      const prev = ue.meas.get(tower.id);
      const a = 1 / Math.pow(2, p.l3FilterK / 4);
      const f = prev ? prev.f + a * (raw - prev.f) : raw;
      ue.meas.set(tower.id, { raw, f, los: m.los });
    }
  }

  updateCellLoad() {
    for (const t of this.towers.values()) t.users = 0;
    for (const ue of this.ues.values()) {
      if ((ue.state === 'connected' || ue.state === 'executing') && ue.serving) {
        const t = this.towers.get(ue.serving);
        if (t) t.users++;
      }
    }
    for (const t of this.towers.values()) {
      t.load = t.users / TECH[t.tech].maxUsers;
      t.throughput = 0;
    }
  }

  sinrFor(ue, tower) {
    const m = ue.meas.get(tower.id);
    if (!m) return -30;
    const interferers = [];
    for (const other of this.towers.values()) {
      if (other === tower || !other.enabled || other.tech !== tower.tech) continue;
      const om = ue.meas.get(other.id);
      if (om) interferers.push({ rsrp: om.raw, load: loadFactor(other.users) });
    }
    const tech = TECH[tower.tech];
    const p = this.params;
    if (p.externalInterference) interferers.push({ rsrp: tech.externalInterferenceDbm, load: 1 });
    return sinrDb(m.raw, interferers, noisePerReDbm(tech, p.noiseFigureDb), p.maxSinrDb);
  }

  bestCell(ue, { withCio = false, exclude = null } = {}) {
    let best = null;
    let bestScore = -Infinity;
    for (const [id, m] of ue.meas) {
      if (id === exclude || m.f < this.params.minRsrpDbm) continue;
      const tower = this.towers.get(id);
      if (!tower?.enabled) continue;
      const score = m.f + (withCio ? this.cio(tower) : 0);
      if (score > bestScore) {
        bestScore = score;
        best = tower;
      }
    }
    return best;
  }

  initialAttach(ue) {
    const best = this.bestCell(ue, { withCio: true });
    if (!best) return;
    ue.serving = best.id;
    ue.state = 'connected';
    this.emit('attach', { ue, tower: best });
  }

  updateLink(ue) {
    const tower = this.towers.get(ue.serving);
    if (!tower || !tower.enabled) {
      this.radioLinkFailure(ue, 'cell-outage');
      return;
    }
    const p = this.params;
    ue.sinr = this.sinrFor(ue, tower);
    ue.rsrp = ue.meas.get(tower.id)?.f ?? -140;
    ue.throughput = throughputMbps(TECH[tower.tech], ue.sinr, tower.users);
    tower.throughput += ue.throughput;

    // Radio link monitoring: T310 runs while SINR is below Qout.
    if (ue.sinr < p.qOutDb) {
      if (ue.t310Start === null) ue.t310Start = this.time;
      else if (this.time - ue.t310Start >= p.t310Ms) this.radioLinkFailure(ue);
    } else if (ue.sinr > p.qInDb) {
      ue.t310Start = null;
    }
  }

  // A3 event: neighbour becomes offset better than serving.
  //   entering:  Mn + Ocn - Hys > Ms + Ocs + Off   (held for time-to-trigger)
  evaluateA3(ue) {
    const p = this.params;
    const serving = this.towers.get(ue.serving);
    const ms = ue.meas.get(serving.id)?.f;
    if (ms === undefined) return;
    const ocs = this.cio(serving);

    let best = null;
    for (const [id, m] of ue.meas) {
      if (id === serving.id) continue;
      const tower = this.towers.get(id);
      if (!tower?.enabled || m.f < p.minRsrpDbm) {
        ue.ttt.delete(id);
        continue;
      }
      const ocn = this.cio(tower);
      const entering = m.f + ocn - p.hysteresisDb > ms + ocs + p.a3OffsetDb;
      if (!entering) {
        ue.ttt.delete(id);
        continue;
      }
      if (!ue.ttt.has(id)) ue.ttt.set(id, this.time);
      if (this.time - ue.ttt.get(id) >= p.tttMs) {
        const margin = m.f + ocn - (ms + ocs);
        if (!best || margin > best.margin) best = { tower, margin };
      }
    }
    if (best) this.startHandover(ue, serving, best.tower);
  }

  startHandover(ue, source, target) {
    if (target.users >= TECH[target.tech].maxUsers) {
      this.metrics.rejected++;
      ue.ttt.delete(target.id);
      this.emit('handover-rejected', { ue, from: source, to: target, time: this.time });
      return;
    }
    const type = handoverType(source.tech, target.tech);
    const timing = HO_TIMING[type];
    ue.state = 'executing';
    ue.ho = {
      from: source.id,
      to: target.id,
      type,
      start: this.time,
      prepEnd: this.time + timing.prep,
      end: this.time + timing.prep + timing.interrupt,
    };
    ue.ttt.clear();
    this.metrics.attempts++;
    this.emit('handover-start', { ue, from: source, to: target, type, time: this.time });
  }

  progressHandover(ue) {
    const ho = ue.ho;
    const source = this.towers.get(ho.from);
    if (this.time < ho.prepEnd && source?.enabled) {
      // Still served by the source while the target prepares resources.
      ue.sinr = this.sinrFor(ue, source);
      ue.throughput = throughputMbps(TECH[source.tech], ue.sinr, source.users);
      return;
    }
    ue.throughput = 0; // user-plane interruption during random access
    if (this.time < ho.end) return;

    const target = this.towers.get(ho.to);
    const targetSinr = target?.enabled ? this.sinrFor(ue, target) : -30;
    if (targetSinr < this.params.qOutDb + 1) {
      this.metrics.failures++;
      this.metrics.recentFail.push(this.time);
      ue.failCount++;
      this.emit('handover-failed', { ue, from: source, to: target, type: ho.type, time: this.time, sinr: targetSinr });
      ue.ho = null;
      this.beginReestablishment(ue);
      return;
    }

    ue.serving = target.id;
    ue.state = 'connected';
    ue.sinr = targetSinr;
    ue.t310Start = null;
    ue.hoCount++;
    this.metrics.success++;
    this.metrics.byType[ho.type]++;
    this.metrics.recentSuccess.push(this.time);

    const pingPong =
      ue.lastHo && ue.lastHo.from === target.id && ue.lastHo.to === ho.from && this.time - ue.lastHo.time <= this.params.pingPongWindowMs;
    if (pingPong) this.metrics.pingPong++;
    ue.lastHo = { from: ho.from, to: ho.to, time: this.time };
    ue.ho = null;
    this.emit('handover-complete', { ue, from: source, to: target, type: ho.type, time: this.time, pingPong });
  }

  // Classify the failure the way mobility robustness optimisation does.
  radioLinkFailure(ue, forcedCause = null) {
    const failedCell = ue.ho?.to ?? ue.serving;
    let cause = forcedCause;
    if (!cause) {
      const best = this.bestCell(ue);
      const recentHo = ue.lastHo && this.time - ue.lastHo.time < this.params.tooEarlyWindowMs;
      if (!best || best.id === failedCell) cause = 'coverage-hole';
      else if (!recentHo) cause = 'too-late';
      else if (best.id === ue.lastHo.from) cause = 'too-early';
      else cause = 'wrong-cell';
    }
    this.metrics.rlf++;
    this.metrics.causes[cause]++;
    this.metrics.recentFail.push(this.time);
    ue.failCount++;
    this.emit('rlf', { ue, cell: this.towers.get(failedCell), cause, time: this.time });
    ue.ho = null;
    this.beginReestablishment(ue);
  }

  beginReestablishment(ue) {
    ue.state = 'reestablishing';
    ue.serving = null;
    ue.throughput = 0;
    ue.sinr = -20;
    ue.t310Start = null;
    ue.ttt.clear();
    ue.reest = { start: this.time, end: this.time + this.params.reestablishMs };
  }

  progressReestablishment(ue) {
    ue.throughput = 0;
    if (this.time < ue.reest.end) return;
    const best = this.bestCell(ue);
    if (!best || best.users >= TECH[best.tech].maxUsers) {
      ue.reest.end = this.time + 500; // keep searching
      return;
    }
    ue.serving = best.id;
    ue.state = 'connected';
    ue.reest = null;
    this.emit('reestablished', { ue, tower: best, time: this.time });
  }

  // ---------------------------------------------------------------- KPIs

  sample() {
    const m = this.metrics;
    const cutoff = this.time - RATE_WINDOW_MS;
    while (m.recentSuccess.length && m.recentSuccess[0] < cutoff) m.recentSuccess.shift();
    while (m.recentFail.length && m.recentFail[0] < cutoff) m.recentFail.shift();
    const k = this.kpis();
    m.series.push({
      t: this.time,
      hoPerMin: k.hoPerMin,
      failPerMin: k.failPerMin,
      avgThroughput: k.avgThroughput,
      avgSinr: k.avgSinr,
      share: k.share,
    });
    if (m.series.length > 600) m.series.shift();
    this.emit('sample', k);
  }

  kpis() {
    const m = this.metrics;
    const share = { LTE: 0, NR: 0, MMW: 0, none: 0 };
    let thr = 0;
    let sinr = 0;
    let connected = 0;
    for (const ue of this.ues.values()) {
      const t = ue.state === 'connected' ? this.towers.get(ue.serving) : null;
      if (t) {
        share[t.tech]++;
        connected++;
        sinr += ue.sinr;
      } else share.none++;
      thr += ue.throughput;
    }
    const n = this.ues.size || 1;
    const windowMin = RATE_WINDOW_MS / 60_000;
    return {
      time: this.time,
      ues: this.ues.size,
      towers: this.towers.size,
      attempts: m.attempts,
      success: m.success,
      failures: m.failures,
      rlf: m.rlf,
      pingPong: m.pingPong,
      rejected: m.rejected,
      causes: { ...m.causes },
      byType: { ...m.byType },
      successRate: m.attempts ? m.success / m.attempts : 1,
      pingPongRate: m.success ? m.pingPong / m.success : 0,
      hoPerMin: m.recentSuccess.length / windowMin,
      failPerMin: m.recentFail.length / windowMin,
      avgThroughput: thr / n,
      totalThroughput: thr,
      avgSinr: connected ? sinr / connected : 0,
      share,
    };
  }
}
