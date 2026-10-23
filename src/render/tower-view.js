import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { TECH } from '../sim/config.js';
import { glowTexture } from './textures.js';

const steel = new THREE.MeshStandardMaterial({ color: 0x8a96a8, metalness: 0.85, roughness: 0.35 });
const darkSteel = new THREE.MeshStandardMaterial({ color: 0x2a3446, metalness: 0.7, roughness: 0.45 });
const concrete = new THREE.MeshStandardMaterial({ color: 0x1e2838, roughness: 0.9 });
const offColor = new THREE.Color(0x4a5466);
const offBeacon = new THREE.Color(0xff5252);

const ringGeo = new THREE.RingGeometry(0.96, 1, 96);
const selGeo = new THREE.RingGeometry(14, 16, 64);

// A cell site: mast, sector antennas, beacon, expanding radio pulses,
// optional coverage dome and a floating label.
export class TowerView {
  constructor(tower, city) {
    this.id = tower.id;
    this.tech = TECH[tower.tech];
    this.color = new THREE.Color(this.tech.color);
    this.group = new THREE.Group();
    this.group.userData = { kind: 'tower', id: tower.id };
    this.city = city;
    this.blinkPhase = Math.random() * Math.PI * 2;
    this.labelTimer = 0;
    this.build(tower);
    this.sync(tower);
  }

  build(tower) {
    const g = this.group;
    const tech = this.tech;
    const isSmall = tech.id === 'MMW';
    this.panelMat = new THREE.MeshStandardMaterial({
      color: 0xdfe6f0,
      emissive: this.color,
      emissiveIntensity: 0.55,
      metalness: 0.3,
      roughness: 0.4,
    });

    this.body = new THREE.Group();
    g.add(this.body);

    // Mast is built at unit height and scaled to the site height in sync().
    this.mast = new THREE.Group();
    this.body.add(this.mast);
    if (isSmall) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 1, 10), darkSteel);
      pole.position.y = 0.5;
      pole.castShadow = true;
      this.mast.add(pole);
    } else {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.7, 1, 10), steel);
      pole.position.y = 0.5;
      pole.castShadow = true;
      this.mast.add(pole);
    }

    this.head = new THREE.Group();
    this.body.add(this.head);
    if (isSmall) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3, 1.4), this.panelMat);
      box.position.set(0, -1, 0.7);
      box.castShadow = true;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 2), darkSteel);
      arm.position.set(0, 0.5, 0.6);
      this.head.add(box, arm);
    } else {
      const platform = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 0.5, 20), darkSteel);
      platform.position.y = -4.5;
      this.head.add(platform);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2;
        const panel = new THREE.Mesh(new THREE.BoxGeometry(1.6, 6, 0.7), this.panelMat);
        panel.position.set(Math.sin(a) * 2.8, -1.5, Math.cos(a) * 2.8);
        panel.rotation.y = a;
        panel.castShadow = true;
        this.head.add(panel);
        const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.5, 14), steel);
        dish.rotation.x = Math.PI / 2;
        dish.rotation.z = a;
        dish.position.set(Math.sin(a + 1) * 1.6, -6.5, Math.cos(a + 1) * 1.6);
        dish.lookAt(dish.position.clone().multiplyScalar(3));
        this.head.add(dish);
      }
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(6, 7, 1.2, 24), concrete);
      pad.position.y = 0.6;
      pad.receiveShadow = true;
      this.body.add(pad);
      this.pad = pad;
    }

    this.beaconMat = new THREE.MeshBasicMaterial({ color: this.color.clone().multiplyScalar(2) });
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(isSmall ? 0.7 : 1.1, 16, 12), this.beaconMat);
    this.head.add(this.beacon);
    this.beacon.position.y = isSmall ? 1.2 : 2;

    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: this.color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.halo.scale.setScalar(isSmall ? 12 : 22);
    this.halo.position.copy(this.beacon.position);
    this.head.add(this.halo);

    // Radio pulses on the ground
    this.pulses = [];
    for (let k = 0; k < 3; k++) {
      const mat = new THREE.MeshBasicMaterial({
        color: this.color,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.6;
      ring.userData.offset = k / 3;
      this.pulses.push(ring);
      g.add(ring);
    }
    this.pulseRadius = Math.min(170, tech.nominalRange * 0.45);

    // Coverage dome
    const r = tech.nominalRange;
    const domeGeo = new THREE.SphereGeometry(r, 48, 18, 0, Math.PI * 2, 0, Math.PI / 2);
    this.dome = new THREE.Group();
    this.dome.add(
      new THREE.Mesh(
        domeGeo,
        new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.018, depthWrite: false, side: THREE.DoubleSide }),
      ),
      new THREE.Mesh(
        domeGeo,
        new THREE.MeshBasicMaterial({ color: this.color, wireframe: true, transparent: true, opacity: 0.035, depthWrite: false }),
      ),
    );
    this.dome.visible = false;
    this.dome.raycast = () => {};
    this.dome.traverse((o) => (o.raycast = () => {}));
    g.add(this.dome);

    // Selection ring
    this.sel = new THREE.Mesh(
      selGeo,
      new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.sel.rotation.x = -Math.PI / 2;
    this.sel.position.y = 0.8;
    this.sel.visible = false;
    g.add(this.sel);

    // Invisible pick target
    this.hit = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 1, 8), new THREE.MeshBasicMaterial({ visible: false }));
    this.hit.userData = { kind: 'tower', id: tower.id };
    g.add(this.hit);

    // Label
    this.labelEl = document.createElement('div');
    this.labelEl.className = 'label3d';
    this.labelEl.style.setProperty('--c', tech.color);
    this.label = new CSS2DObject(this.labelEl);
    g.add(this.label);
  }

  // Apply position, height and enabled state from the simulation.
  sync(tower) {
    const baseY = tower.hostBuilding >= 0 ? (this.city.buildings[tower.hostBuilding]?.h ?? 0) : 0;
    this.baseY = baseY;
    this.height = tower.height;
    this.group.position.set(tower.x, 0, tower.z);
    const mastLen = tower.height - baseY;
    this.mast.position.y = baseY;
    this.mast.scale.set(1, mastLen, 1);
    this.head.position.y = tower.height;
    if (this.pad) this.pad.position.y = baseY + 0.6;
    this.hit.scale.y = tower.height + 6;
    this.hit.position.y = (tower.height + 6) / 2;
    this.label.position.set(0, tower.height + 9, 0);
    this.pulses.forEach((p) => (p.position.y = baseY + 0.6));
    this.dome.position.y = baseY;
    this.enabled = tower.enabled;
    this.panelMat.emissive.copy(tower.enabled ? this.color : offColor);
    this.panelMat.emissiveIntensity = tower.enabled ? 0.55 : 0.1;
    this.halo.material.color.copy(tower.enabled ? this.color : offBeacon);
    this.labelEl.classList.toggle('off', !tower.enabled);
    this.updateLabel(tower);
  }

  updateLabel(tower) {
    const text = tower.enabled ? `${tower.name} <em>${tower.users} UE</em>` : `${tower.name} <em>OFFLINE</em>`;
    if (text !== this.lastLabel) {
      this.labelEl.innerHTML = text;
      this.lastLabel = text;
    }
  }

  get top() {
    return new THREE.Vector3(this.group.position.x, this.height + 1, this.group.position.z);
  }

  setSelected(on) {
    this.sel.visible = on;
  }

  setDome(on) {
    this.dome.visible = on;
  }

  update(t, dt, tower) {
    // Beacon: steady glow with a quick blink; offline sites blink red slowly.
    if (this.enabled) {
      const blink = (Math.sin(t * 3 + this.blinkPhase) + 1) / 2;
      this.beaconMat.color.copy(this.color).multiplyScalar(1.2 + blink * 1.5);
      this.halo.material.opacity = 0.55 + blink * 0.45;
    } else {
      const blink = Math.sin(t * 2 + this.blinkPhase) > 0.3 ? 1 : 0.15;
      this.beaconMat.color.copy(offBeacon).multiplyScalar(blink * 1.5);
      this.halo.material.opacity = blink * 0.8;
    }

    // Pulses run faster on busier cells.
    const rate = 0.35 + Math.min(1, tower?.load ?? 0) * 0.9;
    for (const p of this.pulses) {
      if (!this.enabled) {
        p.material.opacity = 0;
        continue;
      }
      const phase = (t * rate + p.userData.offset) % 1;
      const r = 4 + phase * this.pulseRadius;
      p.scale.set(r, r, 1);
      p.material.opacity = (1 - phase) * (1 - phase) * 0.55;
    }

    if (this.sel.visible) {
      const s = 1 + Math.sin(t * 4) * 0.08;
      this.sel.scale.set(s, s, 1);
      this.sel.rotation.z += dt * 0.0008;
    }

    this.labelTimer -= dt;
    if (tower && this.labelTimer <= 0) {
      this.labelTimer = 400;
      this.updateLabel(tower);
    }
  }

  dispose() {
    this.label.element.remove();
    this.group.traverse((o) => {
      if (o.geometry && o.geometry !== ringGeo && o.geometry !== selGeo) o.geometry.dispose();
      if (o.material && ![steel, darkSteel, concrete].includes(o.material)) o.material.dispose?.();
    });
  }
}
