import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TECH } from '../sim/config.js';
import { glowTexture } from './textures.js';

const phoneGeo = new RoundedBoxGeometry(3.2, 6.4, 0.7, 3, 0.45);
const screenGeo = new THREE.PlaneGeometry(2.7, 5.6);
const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1b2230, metalness: 0.8, roughness: 0.3 });
const carGeo = new THREE.BoxGeometry(2.4, 1.4, 4.8);
const cabinGeo = new THREE.BoxGeometry(2.1, 1.1, 2.4);
const carMats = [0xe8edf5, 0x2b3a55, 0xc0392b, 0x3d6b8f, 0x8e9aab].map(
  (c) => new THREE.MeshStandardMaterial({ color: c, metalness: 0.6, roughness: 0.35 }),
);
const glassMat = new THREE.MeshStandardMaterial({ color: 0x0b1626, metalness: 0.9, roughness: 0.1, emissive: 0x0a2440, emissiveIntensity: 0.6 });
const lightGeo = new THREE.BoxGeometry(0.6, 0.3, 0.1);
const headMat = new THREE.MeshBasicMaterial({ color: 0xfff3d6 });
const tailMat = new THREE.MeshBasicMaterial({ color: 0xff3d3d });
const selGeo = new THREE.RingGeometry(6, 7.4, 48);
const shadowGeo = new THREE.CircleGeometry(3.4, 24);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });

const TECH_COLORS = Object.fromEntries(Object.values(TECH).map((t) => [t.id, new THREE.Color(t.color)]));
const NO_SERVICE = new THREE.Color(0xff5252);
const EXECUTING = new THREE.Color(0xffffff);

export class PhoneView {
  constructor(ue) {
    this.id = ue.id;
    this.kind = ue.kind;
    this.group = new THREE.Group();
    this.color = new THREE.Color(0x888888);
    this.flash = 0;

    this.phone = new THREE.Group();
    const body = new THREE.Mesh(phoneGeo, bodyMat);
    this.screenMat = new THREE.MeshBasicMaterial({ color: this.color });
    const screen = new THREE.Mesh(screenGeo, this.screenMat);
    screen.position.z = 0.36;
    const back = new THREE.Mesh(screenGeo, this.screenMat);
    back.position.z = -0.36;
    back.rotation.y = Math.PI;
    back.scale.setScalar(0.5);
    this.phone.add(body, screen, back);
    this.group.add(this.phone);

    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: this.color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.halo.scale.setScalar(16);
    this.group.add(this.halo);

    if (ue.kind !== 'pedestrian') {
      this.car = new THREE.Group();
      const mat = carMats[Math.floor(ue.phase * 10) % carMats.length];
      const body = new THREE.Mesh(carGeo, mat);
      body.position.y = 1.1;
      body.castShadow = true;
      const cabin = new THREE.Mesh(cabinGeo, glassMat);
      cabin.position.set(0, 2.3, -0.2);
      this.car.add(body, cabin);
      for (const sx of [-0.8, 0.8]) {
        const h = new THREE.Mesh(lightGeo, headMat);
        h.position.set(sx, 1.2, 2.42);
        const tl = new THREE.Mesh(lightGeo, tailMat);
        tl.position.set(sx, 1.2, -2.42);
        this.car.add(h, tl);
      }
      this.car.scale.setScalar(1.5);
      if (ue.kind === 'express') this.car.scale.set(1.6, 1.3, 1.9);
      this.group.add(this.car);
    } else {
      const shadow = new THREE.Mesh(shadowGeo, shadowMat);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.3;
      this.group.add(shadow);
    }

    this.sel = new THREE.Mesh(
      selGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.sel.rotation.x = -Math.PI / 2;
    this.sel.position.y = 0.5;
    this.sel.visible = false;
    this.group.add(this.sel);

    // Generous invisible pick target so small phones are easy to click.
    this.hit = new THREE.Mesh(new THREE.SphereGeometry(8, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    this.hit.userData = { kind: 'ue', id: ue.id };
    this.group.add(this.hit);

    this.hover = this.kind === 'pedestrian' ? 9 : 11;
  }

  get position() {
    return this.group.position;
  }

  pulse() {
    this.flash = 1;
  }

  setSelected(on) {
    this.sel.visible = on;
  }

  // `zoom` grows with camera distance so phones stay readable from afar.
  update(ue, alpha, t, dt, towers, zoom = 1) {
    const x = ue.px + (ue.x - ue.px) * alpha;
    const z = ue.pz + (ue.z - ue.pz) * alpha;
    this.group.position.set(x, 0, z);

    const bob = Math.sin(t * 2.2 + ue.phase * 6) * 0.7;
    this.phone.scale.setScalar(1.7 * zoom);
    this.phone.position.y = this.hover + 5 * (zoom - 1) + bob;
    this.phone.rotation.y = t * 0.9 + ue.phase * 6;
    this.halo.position.y = this.phone.position.y;
    this.hit.position.y = this.phone.position.y - 2;
    this.hit.scale.setScalar(zoom);
    if (this.car) {
      // Smoothly rotate the car towards its heading.
      let d = ue.heading - this.car.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.car.rotation.y += d * Math.min(1, dt * 0.012);
    }

    let target;
    if (ue.state === 'connected') target = TECH_COLORS[towers.get(ue.serving)?.tech] ?? NO_SERVICE;
    else if (ue.state === 'executing') target = EXECUTING;
    else target = NO_SERVICE;
    this.color.lerp(target, Math.min(1, dt * 0.01));

    this.flash = Math.max(0, this.flash - dt * 0.0016);
    const blink = ue.state === 'reestablishing' ? (Math.sin(t * 12) > 0 ? 1 : 0.2) : 1;
    this.screenMat.color.copy(this.color).multiplyScalar((1.3 + this.flash * 2) * blink);
    this.halo.material.color.copy(this.color);
    this.halo.material.opacity = (0.55 + this.flash * 0.45) * blink;
    this.halo.scale.setScalar((22 + this.flash * 26) * zoom);

    if (this.sel.visible) {
      const s = 1 + Math.sin(t * 5) * 0.1;
      this.sel.scale.set(s, s, 1);
    }
  }

  dispose() {
    this.screenMat.dispose();
    this.halo.material.dispose();
    this.sel.material.dispose();
    this.hit.geometry.dispose();
  }
}

// All UE→cell radio links in a single draw call, plus a downlink "packet"
// travelling along each link at a rate proportional to throughput.
export class LinkLayer {
  constructor(capacity = 512) {
    this.capacity = capacity;
    this.linePos = new Float32Array(capacity * 6);
    this.lineCol = new Float32Array(capacity * 6);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(
      lg,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.lines.frustumCulled = false;

    this.pktPos = new Float32Array(capacity * 3 * 2);
    this.pktCol = new Float32Array(capacity * 3 * 2);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.pktPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pktCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.packets = new THREE.Points(
      pg,
      new THREE.PointsMaterial({
        size: 7,
        map: glowTexture(),
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.packets.frustumCulled = false;

    // Measurement lines for the selected UE
    this.measPos = new Float32Array(32 * 6);
    this.measCol = new Float32Array(32 * 6);
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(this.measPos, 3).setUsage(THREE.DynamicDrawUsage));
    mg.setAttribute('color', new THREE.BufferAttribute(this.measCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.meas = new THREE.LineSegments(
      mg,
      new THREE.LineDashedMaterial({ vertexColors: true, transparent: true, opacity: 0.8, dashSize: 6, gapSize: 4, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.meas.frustumCulled = false;

    this.group = new THREE.Group();
    this.group.add(this.lines, this.packets, this.meas);
    this.packetPhase = new Map();
    this.tmp = new THREE.Color();
  }

  static sinrColor(sinr, out) {
    // red (poor) → amber → green → cyan (excellent)
    const t = Math.max(0, Math.min(1, (sinr + 5) / 30));
    if (t < 0.33) out.setRGB(1, 0.32 + t * 1.6, 0.3);
    else if (t < 0.66) out.setRGB(1 - (t - 0.33) * 2.2, 0.85, 0.35);
    else out.setRGB(0.27, 0.85 - (t - 0.66) * 0.3, 0.35 + (t - 0.66) * 1.8);
    return out;
  }

  update(sim, phoneViews, towerViews, dtMs, selectedId, showLinks) {
    let n = 0;
    let p = 0;
    const col = this.tmp;
    if (showLinks) {
      for (const ue of sim.ues.values()) {
        if (n >= this.capacity) break;
        const view = phoneViews.get(ue.id);
        const towerId = ue.state === 'connected' ? ue.serving : ue.state === 'executing' && sim.time < ue.ho.prepEnd ? ue.ho.from : null;
        const tv = towerId && towerViews.get(towerId);
        if (!view || !tv) continue;
        const a = view.position;
        const ay = view.phone.position.y;
        const bx = tv.group.position.x;
        const by = tv.height;
        const bz = tv.group.position.z;
        const i = n * 6;
        this.linePos.set([a.x, ay, a.z, bx, by, bz], i);
        LinkLayer.sinrColor(ue.sinr, col);
        const dim = ue.id === selectedId ? 1.4 : 0.75;
        this.lineCol.set([col.r * dim, col.g * dim, col.b * dim, col.r * 0.25, col.g * 0.25, col.b * 0.25], i);
        n++;

        // Packets: speed scales with log throughput.
        const speed = 0.25 + Math.log10(1 + ue.throughput) * 0.35;
        const ph = ((this.packetPhase.get(ue.id) ?? Math.random()) + (dtMs / 1000) * speed) % 1;
        this.packetPhase.set(ue.id, ph);
        if (ue.throughput > 0) {
          for (const off of [0, 0.5]) {
            const f = (ph + off) % 1;
            const j = p * 3;
            this.pktPos[j] = bx + (a.x - bx) * f;
            this.pktPos[j + 1] = by + (ay - by) * f;
            this.pktPos[j + 2] = bz + (a.z - bz) * f;
            col.copy(TECH_COLORS[tv.tech.id]);
            this.pktCol[j] = col.r;
            this.pktCol[j + 1] = col.g;
            this.pktCol[j + 2] = col.b;
            p++;
          }
        }
      }
    }
    this.lines.geometry.setDrawRange(0, n * 2);
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
    this.packets.geometry.setDrawRange(0, p);
    this.packets.geometry.attributes.position.needsUpdate = true;
    this.packets.geometry.attributes.color.needsUpdate = true;

    // Dashed measurement lines from the selected phone to every neighbour it hears.
    let m = 0;
    const ue = selectedId && sim.ues.get(selectedId);
    const view = ue && phoneViews.get(ue.id);
    if (ue && view) {
      for (const [id, meas] of ue.meas) {
        if (id === ue.serving || m >= 32 || meas.f < sim.params.minRsrpDbm) continue;
        const tv = towerViews.get(id);
        if (!tv) continue;
        const a = view.position;
        const i = m * 6;
        this.measPos.set([a.x, view.phone.position.y, a.z, tv.group.position.x, tv.height, tv.group.position.z], i);
        const strength = Math.max(0.12, Math.min(1, (meas.f + 125) / 60));
        col.copy(TECH_COLORS[tv.tech.id]).multiplyScalar(strength);
        this.measCol.set([col.r, col.g, col.b, col.r, col.g, col.b], i);
        m++;
      }
    }
    this.meas.geometry.setDrawRange(0, m * 2);
    this.meas.geometry.attributes.position.needsUpdate = true;
    this.meas.geometry.attributes.color.needsUpdate = true;
    if (m) this.meas.computeLineDistances();
  }

  forget(id) {
    this.packetPhase.delete(id);
  }
}
