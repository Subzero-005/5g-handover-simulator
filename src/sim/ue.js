import { UE_KINDS } from './config.js';

const HISTORY_LEN = 300; // 30 s at the default 100 ms tick

// A user equipment: position, mobility state, measurements and RRC state.
export class UE {
  constructor({ id, kind, city, rng }) {
    this.id = id;
    this.kind = kind;
    this.city = city;
    this.rng = rng;
    this.phase = rng.next() * Math.PI * 2;

    const [lo, hi] = UE_KINDS[kind].speed;
    this.baseSpeed = rng.range(lo, hi);
    this.speed = this.baseSpeed;
    this.lateral = this.pickLateral();
    this.waitMs = 0;
    this.manual = null; // { vx, vz } when steered by the user

    if (kind === 'express') {
      this.ringIdx = rng.int(0, city.ring.length - 1);
      this.from = city.ring[this.ringIdx];
      this.to = city.ring[(this.ringIdx + 1) % city.ring.length];
    } else {
      this.from = rng.int(0, city.nodes.length - 1);
      this.to = rng.pick(city.nodes[this.from].neighbors);
    }
    this.prevNode = this.from;
    this.progress = rng.range(0, city.blockPitch);

    this.x = 0;
    this.z = 0;
    this.heading = 0;
    this.updatePosition();
    this.px = this.x;
    this.pz = this.z;
    this.moved = 0;

    // Radio / RRC state
    this.state = 'idle'; // idle | connected | executing | reestablishing
    this.serving = null;
    this.meas = new Map(); // towerId -> { raw, f, los }
    this.shadow = new Map(); // towerId -> correlated shadow fading (dB)
    this.ttt = new Map(); // towerId -> time the A3 entering condition started
    this.ho = null;
    this.reest = null;
    this.t310Start = null;
    this.lastHo = null;
    this.sinr = -20;
    this.rsrp = -140;
    this.throughput = 0;
    this.hoCount = 0;
    this.failCount = 0;
    this.history = [];
  }

  pickLateral() {
    const sw = this.city.streetWidth;
    if (this.kind === 'pedestrian') return (this.rng.chance(0.5) ? 1 : -1) * this.rng.range(sw / 2 - 2.5, sw / 2 - 0.5);
    return this.rng.range(2, 5);
  }

  segment() {
    const a = this.city.nodes[this.from];
    const b = this.city.nodes[this.to];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    return { a, b, dx: dx / len, dz: dz / len, len };
  }

  updatePosition() {
    const { a, dx, dz } = this.segment();
    // Drive on the right: offset perpendicular to the direction of travel.
    this.x = a.x + dx * this.progress - dz * this.lateral;
    this.z = a.z + dz * this.progress + dx * this.lateral;
    this.heading = Math.atan2(dx, dz);
  }

  step(dtS) {
    this.px = this.x;
    this.pz = this.z;

    if (this.manual) {
      const lim = this.city.half + 60;
      this.x = Math.max(-lim, Math.min(lim, this.x + this.manual.vx * dtS));
      this.z = Math.max(-lim, Math.min(lim, this.z + this.manual.vz * dtS));
      const v = Math.hypot(this.manual.vx, this.manual.vz);
      if (v > 0.1) this.heading = Math.atan2(this.manual.vx, this.manual.vz);
      this.speed = v;
      this.moved = Math.hypot(this.x - this.px, this.z - this.pz);
      return;
    }

    if (this.waitMs > 0) {
      this.waitMs -= dtS * 1000;
      this.speed = 0;
      this.moved = 0;
      return;
    }

    this.speed = this.baseSpeed;
    let remaining = this.speed * dtS;
    while (remaining > 0) {
      const { len } = this.segment();
      const left = len - this.progress;
      if (remaining < left) {
        this.progress += remaining;
        remaining = 0;
      } else {
        remaining -= left;
        this.advanceNode();
        if (this.waitMs > 0) break;
      }
    }
    this.updatePosition();
    this.moved = Math.hypot(this.x - this.px, this.z - this.pz);
  }

  advanceNode() {
    const city = this.city;
    this.progress = 0;
    if (this.kind === 'express') {
      this.ringIdx = (this.ringIdx + 1) % city.ring.length;
      this.from = city.ring[this.ringIdx];
      this.to = city.ring[(this.ringIdx + 1) % city.ring.length];
      return;
    }
    const prev = this.from;
    this.from = this.to;
    const options = city.nodes[this.from].neighbors.filter((n) => n !== prev);
    this.to = options.length ? this.rng.pick(options) : prev;
    if (this.kind === 'pedestrian' && this.rng.chance(0.25)) this.waitMs = this.rng.range(500, 6000);
    if (this.kind === 'vehicle' && this.rng.chance(0.3)) this.waitMs = this.rng.range(1000, 4000); // traffic light
  }

  takeControl() {
    this.manual = { vx: 0, vz: 0 };
  }

  releaseControl() {
    this.manual = null;
    // Snap back onto the nearest intersection of the road graph.
    let best = null;
    let bestD = Infinity;
    for (const node of this.city.nodes) {
      const d = Math.hypot(node.x - this.x, node.z - this.z);
      if (d < bestD) {
        bestD = d;
        best = node;
      }
    }
    if (this.kind === 'express') {
      const idx = this.city.ring.indexOf(best.id);
      this.ringIdx = idx >= 0 ? idx : 0;
      this.from = this.city.ring[this.ringIdx];
      this.to = this.city.ring[(this.ringIdx + 1) % this.city.ring.length];
    } else {
      this.from = best.id;
      this.to = this.rng.pick(best.neighbors);
    }
    this.progress = 0;
    this.updatePosition();
    this.px = this.x;
    this.pz = this.z;
  }

  record(time) {
    this.history.push({ t: time, rsrp: this.rsrp, sinr: this.sinr, serving: this.serving, thr: this.throughput });
    if (this.history.length > HISTORY_LEN) this.history.shift();
  }
}
