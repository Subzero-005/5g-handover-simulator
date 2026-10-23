import * as THREE from 'three';
import { createRng } from '../sim/rng.js';
import { groundTexture, windowTextures } from './textures.js';

let facades = null;

export function buildCityView(city) {
  const group = new THREE.Group();
  group.name = 'city';
  const rng = createRng(city.seed + 101);

  // Outer ground fading into the fog
  const outer = new THREE.Mesh(
    new THREE.CircleGeometry(4200, 64),
    new THREE.MeshStandardMaterial({ color: 0x060a12, roughness: 1 }),
  );
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.2;
  outer.receiveShadow = true;
  group.add(outer);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(city.size, city.size),
    new THREE.MeshStandardMaterial({ map: groundTexture(city), roughness: 0.92, metalness: 0.05 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  group.add(ground);

  // Buildings
  facades ??= windowTextures(4);
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x1a2436, roughness: 0.8, metalness: 0.2 });
  const tints = [0x9fb3cc, 0xb6c4d8, 0x8ea6c4, 0xc2cde0];
  const edgePos = [];

  for (const b of city.buildings) {
    const v = rng.int(0, facades.length - 1);
    const face = (w) => {
      const map = facades[v].map.clone();
      const em = facades[v].emissive.clone();
      map.repeat.set(Math.max(1, Math.round(w / 32)), Math.max(1, Math.round(b.h / 56)));
      em.repeat.copy(map.repeat);
      return new THREE.MeshStandardMaterial({
        color: tints[v],
        map,
        emissive: 0xffffff,
        emissiveMap: em,
        emissiveIntensity: 0.5,
        roughness: 0.55,
        metalness: 0.35,
      });
    };
    const sideX = face(b.d);
    const sideZ = face(b.w);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), [sideX, sideX, roofMat, roofMat, sideZ, sideZ]);
    mesh.position.set(b.cx, b.h / 2, b.cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { kind: 'building', id: b.id };
    group.add(mesh);

    // Roof outline + vertical edges for the "digital twin" look
    const { minX: x0, maxX: x1, minZ: z0, maxZ: z1, h } = b;
    const top = [
      [x0, h, z0, x1, h, z0],
      [x1, h, z0, x1, h, z1],
      [x1, h, z1, x0, h, z1],
      [x0, h, z1, x0, h, z0],
    ];
    for (const seg of top) edgePos.push(...seg);
    for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) edgePos.push(x, 0, z, x, h, z);

    // Rooftop details on taller buildings
    if (b.h > 50 && rng.chance(0.7)) {
      const hw = b.w * rng.range(0.2, 0.4);
      const hd = b.d * rng.range(0.2, 0.4);
      const hh = rng.range(3, 8);
      const box = new THREE.Mesh(new THREE.BoxGeometry(hw, hh, hd), roofMat);
      box.position.set(b.cx + rng.range(-0.2, 0.2) * b.w, b.h + hh / 2, b.cz + rng.range(-0.2, 0.2) * b.d);
      box.castShadow = true;
      group.add(box);
      if (rng.chance(0.5)) {
        const light = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff5252 }));
        light.position.set(box.position.x, b.h + hh + 1, box.position.z);
        light.userData.blink = rng.next() * 6;
        group.add(light);
      }
    }
  }

  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
  const edges = new THREE.LineSegments(
    edgeGeo,
    new THREE.LineBasicMaterial({ color: 0x6fdcff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  group.add(edges);

  // Trees in parks
  const trees = [];
  for (const p of city.parks) {
    const count = rng.int(14, 24);
    for (let k = 0; k < count; k++) {
      const x = rng.range(p.minX + 8, p.maxX - 8);
      const z = rng.range(p.minZ + 8, p.maxZ - 8);
      // keep footpaths (diagonals) clear
      const u = (x - p.minX) / (p.maxX - p.minX);
      const w = (z - p.minZ) / (p.maxZ - p.minZ);
      if (Math.abs(u - w) < 0.08 || Math.abs(u + w - 1) < 0.08) continue;
      trees.push([x, z, rng.range(0.7, 1.4)]);
    }
  }
  if (trees.length) {
    const crown = new THREE.InstancedMesh(
      new THREE.ConeGeometry(4, 11, 7),
      new THREE.MeshStandardMaterial({ color: 0x1f6f5c, roughness: 0.8, emissive: 0x0b3a30, emissiveIntensity: 0.6 }),
      trees.length,
    );
    const trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.5, 0.7, 3, 6),
      new THREE.MeshStandardMaterial({ color: 0x3b2f2a }),
      trees.length,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    trees.forEach(([x, z, s], i) => {
      m.compose(new THREE.Vector3(x, 3 * s + 5.5 * s, z), q, new THREE.Vector3(s, s, s));
      crown.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, 1.5 * s, z), q, new THREE.Vector3(s, s, s));
      trunk.setMatrixAt(i, m);
    });
    crown.castShadow = true;
    group.add(crown, trunk);
  }

  return { group, ground };
}
