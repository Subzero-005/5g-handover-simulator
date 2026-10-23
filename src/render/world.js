import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TECH } from '../sim/config.js';
import { buildCityView } from './city-view.js';
import { TowerView } from './tower-view.js';
import { PhoneView, LinkLayer } from './phone-view.js';
import { Effects } from './effects.js';
import { Heatmap } from './heatmap.js';

const HOME = { pos: new THREE.Vector3(620, 560, 820), target: new THREE.Vector3(0, 0, 40) };
const CAUSE_LABEL = {
  'too-late': 'too late',
  'too-early': 'too early',
  'wrong-cell': 'wrong cell',
  'coverage-hole': 'coverage hole',
  'cell-outage': 'cell outage',
};

// Owns the Three.js scene and keeps it in sync with the simulation.
export class World {
  constructor(container, sim) {
    this.container = container;
    this.sim = sim;
    this.display = { links: true, labels: true, domes: false, popups: true, bloom: true, rotate: false };
    this.tool = 'select';
    this.selected = null; // { kind: 'ue' | 'tower', id }
    this.follow = false;
    this.onSelect = () => {};
    this.onHover = () => {};

    this.initRenderer();
    this.initScene();
    this.initInput();
    this.bindSim();
    this.rebuild();
    this.intro = { t: 0, from: new THREE.Vector3(1500, 1300, 1700) };
    this.camera.position.copy(this.intro.from);
  }

  initRenderer() {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(window.innerWidth, window.innerHeight);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(r.domElement);
    this.renderer = r;

    this.labels = new CSS2DRenderer();
    this.labels.setSize(window.innerWidth, window.innerHeight);
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    this.container.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 2, 9000);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = 1.42;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 2600;
    this.controls.target.copy(HOME.target);
    this.controls.autoRotateSpeed = 0.6;

    window.addEventListener('resize', () => this.resize());
  }

  initScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070b14);
    scene.fog = new THREE.FogExp2(0x070b14, 0.00042);
    this.scene = scene;

    // Sky dome with a subtle horizon glow
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(5000, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {},
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
        fragmentShader:
          'varying vec3 vP; void main(){ float h = clamp(vP.y, -0.1, 1.0); vec3 top = vec3(0.02,0.035,0.07); vec3 hor = vec3(0.07,0.11,0.2); vec3 c = mix(hor, top, pow(max(h,0.0), 0.55)); c += vec3(0.05,0.12,0.18) * exp(-abs(h)*14.0); gl_FragColor = vec4(c,1.); }',
      }),
    );
    scene.add(sky);

    // Stars
    const starPos = [];
    for (let i = 0; i < 1400; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * 1.3;
      const r = 4200;
      starPos.push(Math.cos(th) * Math.sin(ph) * r, Math.cos(ph) * r * 0.9 + 200, Math.sin(th) * Math.sin(ph) * r);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x9fb8ff, size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.7 })));

    scene.add(new THREE.HemisphereLight(0x6b8cff, 0x0a0f18, 0.55));
    scene.add(new THREE.AmbientLight(0x22324d, 0.6));
    const moon = new THREE.DirectionalLight(0xbcd2ff, 1.6);
    moon.position.set(-500, 900, 350);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    const sc = moon.shadow.camera;
    sc.left = sc.bottom = -760;
    sc.right = sc.top = 760;
    sc.near = 100;
    sc.far = 2400;
    moon.shadow.bias = -0.0006;
    moon.shadow.normalBias = 0.6;
    scene.add(moon);
    const rim = new THREE.DirectionalLight(0x4dd0e1, 0.35);
    rim.position.set(600, 300, -600);
    scene.add(rim);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.75, 0.55, 0.78);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.effects = new Effects(scene);
    this.links = new LinkLayer();
    scene.add(this.links.group);

    this.dynamic = new THREE.Group();
    scene.add(this.dynamic);
  }

  // ------------------------------------------------------------ building

  rebuild() {
    if (this.cityView) {
      this.scene.remove(this.cityView.group);
      this.cityView.group.traverse((o) => {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          m.map?.dispose();
          m.emissiveMap?.dispose();
          m.dispose();
        }
      });
    }
    this.towerViews?.forEach((v) => {
      this.dynamic.remove(v.group);
      v.dispose();
    });
    this.phoneViews?.forEach((v) => {
      this.dynamic.remove(v.group);
      v.dispose();
    });
    if (this.heatmap) {
      this.scene.remove(this.heatmap.mesh);
      this.heatmap.dispose();
    }
    this.effects.clear();

    const mode = this.heatmap?.mode ?? 'off';
    this.cityView = buildCityView(this.sim.city);
    this.scene.add(this.cityView.group);
    this.blinkers = [];
    this.cityView.group.traverse((o) => o.userData.blink !== undefined && this.blinkers.push(o));
    this.heatmap = new Heatmap(this.sim);
    this.scene.add(this.heatmap.mesh);
    this.heatmap.setMode(mode);

    this.towerViews = new Map();
    this.phoneViews = new Map();
    for (const t of this.sim.towers.values()) this.addTowerView(t);
    for (const ue of this.sim.ues.values()) this.addPhoneView(ue);
    if (this.selected && !this.exists(this.selected)) this.select(null);
  }

  addTowerView(t) {
    const v = new TowerView(t, this.sim.city);
    v.setDome(this.display.domes);
    this.towerViews.set(t.id, v);
    this.dynamic.add(v.group);
  }

  addPhoneView(ue) {
    const v = new PhoneView(ue);
    this.phoneViews.set(ue.id, v);
    this.dynamic.add(v.group);
  }

  exists(sel) {
    return sel.kind === 'ue' ? this.sim.ues.has(sel.id) : this.sim.towers.has(sel.id);
  }

  bindSim() {
    const sim = this.sim;
    sim.on('reset', () => this.rebuild());
    sim.on('tower-added', (t) => {
      this.addTowerView(t);
      this.heatmap.invalidate();
    });
    sim.on('tower-changed', (t) => {
      this.towerViews.get(t.id)?.sync(t);
      this.heatmap.invalidate();
    });
    sim.on('tower-removed', (t) => {
      const v = this.towerViews.get(t.id);
      if (v) {
        this.dynamic.remove(v.group);
        v.dispose();
        this.towerViews.delete(t.id);
      }
      if (this.selected?.id === t.id) this.select(null);
      this.heatmap.invalidate();
    });
    sim.on('ue-added', (ue) => this.addPhoneView(ue));
    sim.on('ue-removed', (ue) => {
      const v = this.phoneViews.get(ue.id);
      if (v) {
        this.dynamic.remove(v.group);
        v.dispose();
        this.phoneViews.delete(ue.id);
      }
      this.links.forget(ue.id);
      if (this.selected?.id === ue.id) this.select(null);
    });
    sim.on('params', () => this.heatmap.mode === 'server' && this.heatmap.invalidate());

    sim.on('handover-start', ({ from, to }) => {
      const a = this.towerViews.get(from.id);
      const b = this.towerViews.get(to.id);
      if (a && b) this.effects.arc(a.top, b.top, TECH[to.tech].color);
    });
    sim.on('handover-complete', ({ ue, from, to, pingPong }) => {
      const v = this.phoneViews.get(ue.id);
      if (!v) return;
      v.pulse();
      this.effects.burst(v.position, TECH[to.tech].color);
      if (this.display.popups && (this.sim.ues.size <= 60 || ue.id === this.selected?.id)) {
        const label = pingPong
          ? `<b>Ping-pong</b> ${to.name}`
          : `${TECH[from?.tech]?.short ?? '?'} → <b>${TECH[to.tech].short}</b> ${to.name}`;
        this.effects.popup(v.position, label, pingPong ? '#ffd180' : TECH[to.tech].color);
      }
    });
    sim.on('handover-failed', ({ ue }) => {
      const v = this.phoneViews.get(ue.id);
      if (!v) return;
      this.effects.burst(v.position, '#ff5252', { size: 44 });
      if (this.display.popups) this.effects.popup(v.position, '<b>HO failure</b>', '#ff5252');
    });
    sim.on('rlf', ({ ue, cause }) => {
      const v = this.phoneViews.get(ue.id);
      if (!v) return;
      this.effects.burst(v.position, '#ff5252', { size: 50, life: 1200 });
      if (this.display.popups) this.effects.popup(v.position, `<b>RLF</b> · ${CAUSE_LABEL[cause]}`, '#ff5252');
    });
    sim.on('reestablished', ({ ue, tower }) => {
      const v = this.phoneViews.get(ue.id);
      if (v) this.effects.burst(v.position, TECH[tower.tech].color, { size: 20, life: 700 });
    });
  }

  // --------------------------------------------------------------- input

  initInput() {
    const el = this.renderer.domElement;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let down = null;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY };
      const hit = this.pick(e);
      if (this.tool === 'select' && hit?.kind === 'tower') {
        this.drag = { id: hit.id, moved: false };
        this.controls.enabled = false;
        el.setPointerCapture(e.pointerId);
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const p = this.groundPoint(e);
        if (!p) return;
        const lim = this.sim.city.half + 60;
        p.x = THREE.MathUtils.clamp(p.x, -lim, lim);
        p.z = THREE.MathUtils.clamp(p.z, -lim, lim);
        this.drag.moved = true;
        this.drag.x = p.x;
        this.drag.z = p.z;
        const v = this.towerViews.get(this.drag.id);
        if (v) v.group.position.set(p.x, 0, p.z);
        this.container.classList.add('dragging');
        return;
      }
      if (e.buttons) return;
      const hit = this.pick(e);
      this.container.classList.toggle('hovering', !!hit && this.tool === 'select');
      this.onHover(hit);
    });

    el.addEventListener('pointerup', (e) => {
      const clicked = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
      down = null;
      this.container.classList.remove('dragging');
      if (this.drag) {
        const d = this.drag;
        this.drag = null;
        this.controls.enabled = true;
        if (d.moved) {
          this.sim.moveTower(d.id, d.x, d.z);
          this.select({ kind: 'tower', id: d.id });
          return;
        }
      }
      if (!clicked) return;
      if (this.tool !== 'select') {
        const p = this.groundPoint(e);
        const lim = this.sim.city.half + 60;
        if (p && Math.abs(p.x) <= lim && Math.abs(p.z) <= lim) {
          const t = this.sim.addTower({ tech: this.tool, x: p.x, z: p.z });
          this.effects.burst(new THREE.Vector3(t.x, 0, t.z), TECH[t.tech].color, { size: 60, life: 1100 });
          this.select({ kind: 'tower', id: t.id });
          this.onPlaced?.(t);
        }
        return;
      }
      this.select(this.pick(e));
    });
  }

  setPointer(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  pick(e) {
    this.setPointer(e);
    const targets = [];
    this.phoneViews.forEach((v) => targets.push(v.hit));
    this.towerViews.forEach((v) => targets.push(v.hit));
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return hit ? { ...hit.object.userData } : null;
  }

  groundPoint(e) {
    this.setPointer(e);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, p) ? p : null;
  }

  select(sel) {
    if (this.selected) {
      const prev = this.selected.kind === 'ue' ? this.phoneViews.get(this.selected.id) : this.towerViews.get(this.selected.id);
      prev?.setSelected(false);
    }
    this.selected = sel && this.exists(sel) ? sel : null;
    if (!this.selected) this.follow = false;
    if (this.selected) {
      const v = this.selected.kind === 'ue' ? this.phoneViews.get(this.selected.id) : this.towerViews.get(this.selected.id);
      v?.setSelected(true);
    }
    this.onSelect(this.selected);
  }

  focusOn(x, z, distance = 260) {
    const target = new THREE.Vector3(x, 0, z);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.flight = {
      t: 0,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      toPos: target.clone().add(dir.multiplyScalar(distance)),
    };
  }

  resetCamera() {
    this.flight = {
      t: 0,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: HOME.target.clone(),
      toPos: HOME.pos.clone(),
    };
  }

  setDisplay(key, value) {
    this.display[key] = value;
    if (key === 'domes') this.towerViews.forEach((v) => v.setDome(value));
    if (key === 'labels') this.container.classList.toggle('labels-hidden', !value);
    if (key === 'rotate') this.controls.autoRotate = value;
  }

  setTool(tool) {
    this.tool = tool;
    this.container.classList.toggle('tool-place', tool !== 'select');
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  // -------------------------------------------------------------- frame

  update(dtMs, nowMs) {
    const t = nowMs / 1000;
    const sim = this.sim;
    const alpha = sim.alpha;

    for (const [id, v] of this.towerViews) v.update(t, dtMs, sim.towers.get(id));
    const camDist = this.camera.position.distanceTo(this.controls.target);
    const zoom = THREE.MathUtils.clamp(camDist / 420, 1, 2.6);
    for (const ue of sim.ues.values()) this.phoneViews.get(ue.id)?.update(ue, alpha, t, dtMs, sim.towers, zoom);
    for (const b of this.blinkers) b.visible = Math.sin(t * 2.4 + b.userData.blink) > 0.6;

    this.links.update(sim, this.phoneViews, this.towerViews, dtMs, this.selected?.kind === 'ue' ? this.selected.id : null, this.display.links);
    this.effects.update(dtMs);
    this.heatmap.step(dtMs);
    this.updateCamera(dtMs);

    if (this.display.bloom) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  updateCamera(dtMs) {
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    if (this.intro) {
      this.intro.t = Math.min(1, this.intro.t + dtMs / 2600);
      const e = ease(this.intro.t);
      this.camera.position.lerpVectors(this.intro.from, HOME.pos, e);
      if (this.intro.t >= 1) this.intro = null;
    } else if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dtMs / 900);
      const e = ease(f.t);
      this.camera.position.lerpVectors(f.fromPos, f.toPos, e);
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, e);
      if (f.t >= 1) this.flight = null;
    } else if (this.follow && this.selected?.kind === 'ue') {
      const v = this.phoneViews.get(this.selected.id);
      if (v) {
        const goal = v.position.clone();
        const delta = goal.sub(this.controls.target).multiplyScalar(Math.min(1, dtMs * 0.006));
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
    this.controls.update();
  }
}
