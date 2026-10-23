import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { glowTexture } from './textures.js';

const MAX_ARCS = 24;
const MAX_BURSTS = 40;
const MAX_POPUPS = 8;
const ARC_POINTS = 48;
const burstGeo = new THREE.RingGeometry(0.85, 1, 64);

// Short-lived visual effects: X2/Xn signalling arcs between cells,
// expanding bursts at the phone and floating pop-up labels.
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.arcs = [];
    this.bursts = [];
    this.popups = [];
  }

  // Signalling arc from the source cell to the target cell with a glowing
  // message travelling along it.
  arc(from, to, color) {
    if (this.arcs.length >= MAX_ARCS) this.removeArc(this.arcs[0]);
    const mid = from.clone().lerp(to, 0.5);
    mid.y += 40 + from.distanceTo(to) * 0.25;
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    const pts = curve.getPoints(ARC_POINTS);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    line.geometry.setDrawRange(0, 0);
    const spark = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    spark.scale.setScalar(16);
    this.group.add(line, spark);
    this.arcs.push({ line, spark, curve, age: 0, life: 1400 });
  }

  burst(pos, color, { size = 34, life = 900, y = 1 } = {}) {
    if (this.bursts.length >= MAX_BURSTS) this.removeBurst(this.bursts[0]);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(burstGeo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, y, pos.z);
    const flash = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    flash.position.set(pos.x, 9, pos.z);
    // Vertical light pillar
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 2.2, 60, 12, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    pillar.position.set(pos.x, 30, pos.z);
    this.group.add(ring, flash, pillar);
    this.bursts.push({ ring, flash, pillar, age: 0, life, size });
  }

  popup(pos, html, color, height = 22) {
    if (this.popups.length >= MAX_POPUPS) this.removePopup(this.popups[0]);
    // CSS2DRenderer positions the outer element via an inline transform, so
    // the animated pop-up lives in an inner element.
    const el = document.createElement('div');
    const inner = document.createElement('div');
    inner.className = 'popup3d';
    inner.style.setProperty('--c', color);
    inner.innerHTML = html;
    el.appendChild(inner);
    const obj = new CSS2DObject(el);
    obj.position.set(pos.x, height, pos.z);
    this.group.add(obj);
    this.popups.push({ obj, age: 0, life: 1800, follow: pos });
  }

  update(dt) {
    for (const a of [...this.arcs]) {
      a.age += dt;
      const t = a.age / a.life;
      if (t >= 1) {
        this.removeArc(a);
        continue;
      }
      const travel = Math.min(1, t / 0.6);
      const eased = 1 - Math.pow(1 - travel, 3);
      a.line.geometry.setDrawRange(0, Math.max(2, Math.floor(eased * (ARC_POINTS + 1))));
      a.spark.position.copy(a.curve.getPoint(eased));
      const fade = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      a.line.material.opacity = 0.95 * fade;
      a.spark.material.opacity = fade;
      a.spark.scale.setScalar(12 + Math.sin(a.age * 0.02) * 4);
    }
    for (const b of [...this.bursts]) {
      b.age += dt;
      const t = b.age / b.life;
      if (t >= 1) {
        this.removeBurst(b);
        continue;
      }
      const e = 1 - Math.pow(1 - t, 3);
      const r = 2 + e * b.size;
      b.ring.scale.set(r, r, 1);
      b.ring.material.opacity = 1 - t;
      b.flash.scale.setScalar(30 * (1 - t) + 4);
      b.flash.material.opacity = 1 - t;
      b.pillar.material.opacity = 0.5 * (1 - t);
      b.pillar.scale.set(1 + e, 1, 1 + e);
    }
    for (const p of [...this.popups]) {
      p.age += dt;
      if (p.follow) p.obj.position.set(p.follow.x, p.obj.position.y, p.follow.z);
      if (p.age >= p.life) this.removePopup(p);
    }
  }

  removeArc(a) {
    this.group.remove(a.line, a.spark);
    a.line.geometry.dispose();
    a.line.material.dispose();
    a.spark.material.dispose();
    this.arcs.splice(this.arcs.indexOf(a), 1);
  }

  removeBurst(b) {
    this.group.remove(b.ring, b.flash, b.pillar);
    b.ring.material.dispose();
    b.flash.material.dispose();
    b.pillar.geometry.dispose();
    b.pillar.material.dispose();
    this.bursts.splice(this.bursts.indexOf(b), 1);
  }

  removePopup(p) {
    this.group.remove(p.obj);
    p.obj.element.remove();
    this.popups.splice(this.popups.indexOf(p), 1);
  }

  clear() {
    [...this.arcs].forEach((a) => this.removeArc(a));
    [...this.bursts].forEach((b) => this.removeBurst(b));
    [...this.popups].forEach((p) => this.removePopup(p));
  }
}
