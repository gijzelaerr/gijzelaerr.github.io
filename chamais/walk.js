// Chamais walk: the V8 plan model, nothing else. Walk around it on a computer
// or in a VR headset (Meta Quest 3: WebXR in the Quest browser). live.js adds
// the other people, shared sketches and voice pins on top of this.
//
// Physics (capsule, step-up, collision BVH) is the same as in ../game/src/main.js.
// The rig: the camera sits inside `rig`. On a computer the camera is at eye
// height above the rig; in VR the headset moves the camera inside the rig and
// we keep the player's collision capsule under the head, so physical walking
// in the room and stick walking both collide with walls.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { Sky } from 'three/addons/objects/Sky.js';
import { sunPosition, localToUtcMs, sunDirectionModel } from './sun.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (s) => document.querySelector(s);
const canvas = $('#view');
const params = new URLSearchParams(location.search);

// Blender (x east, y north, z up) -> three.js (x, y up, z = -north)
const b2t = (x, y, z) => new THREE.Vector3(x, z, -y);
const t2b = (v) => [v.x, -v.z, v.y];

// ── Renderer, scene, light ───────────────────────────────────────────
// No logarithmic depth buffer: it writes depth per pixel, which is slow on the
// Quest's tiled GPU. Near/far are kept to a ratio the 24-bit depth can carry.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // nothing moves: render the shadows once per change
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 25000);
camera.rotation.order = 'YXZ';
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

const sky = new Sky();
sky.scale.setScalar(20000);
scene.add(sky);
sky.material.uniforms.turbidity.value = 4;
sky.material.uniforms.rayleigh.value = 1.6;
sky.material.uniforms.mieCoefficient.value = 0.004;
sky.material.uniforms.mieDirectionalG.value = 0.8;

const HOUSE_CENTRE = b2t(18, -1, 5);
const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x8a6a48, 1);
const sun = new THREE.DirectionalLight(0xfff2dd, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 260 });
sun.target.position.copy(HOUSE_CENTRE);
const fill = new THREE.PointLight(0xfff0dc, 0, 14, 1.2); // a soft lamp with the viewer, so rooms are not black
camera.add(fill);
scene.add(hemi, sun, sun.target);

const today = new Date().toISOString().slice(0, 10);
let hours = parseFloat(params.get('t')) || 16.5;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function applySun() {
  const s = sunPosition(localToUtcMs(today, hours));
  const dir = b2t(...sunDirectionModel(s.az, s.el));
  sky.material.uniforms.sunPosition.value.copy(dir);
  sun.position.copy(HOUSE_CENTRE).addScaledVector(dir, 130);
  const day = smooth(-4, 8, s.el), low = smooth(0, 25, s.el);
  sun.intensity = 3.4 * smooth(-1, 12, s.el);
  sun.color.setRGB(1, 0.62 + 0.36 * low, 0.36 + 0.58 * low);
  hemi.intensity = 0.15 + 0.95 * day;
  fill.intensity = 4 + 7 * day;
  renderer.toneMappingExposure = 0.2 + 0.3 * day;
  sun.castShadow = s.el > 0.5;
  renderer.shadowMap.needsUpdate = true;
  const hh = Math.floor(hours), mm = Math.floor((hours % 1) * 60);
  $('#clock').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  $('#hour').value = hours;
}

// ── Loading ──────────────────────────────────────────────────────────
const loader = new GLTFLoader();
const COLLIDE = new Set(['terrain', 'house', 'carport', 'context_near']);
const NO_SHADOW = new Set(['geo_terrain', 'geo_houses', 'geo_roads', 'vegetation']);

function tuneMaterial(m, group) {
  const n = (m.name || '').toLowerCase();
  if (/glaz|glass/.test(n)) {
    m.transparent = true;
    m.opacity = /frost/.test(n) ? 0.75 : 0.28;
    m.roughness = 0.08;
    m.metalness = 0;
    m.depthWrite = false;
  }
  // roads and the houses around lie on the far terrain: pull them forward so
  // they do not flicker without a logarithmic depth buffer
  if (group === 'geo_roads' || group === 'geo_houses') { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2; }
  if (m.map) m.map.anisotropy = 4;
}

async function loadGlb(url, label) {
  const gltf = await loader.loadAsync(url, (e) => {
    if (e.total) $('#loadmsg').textContent = `Loading ${label}… ${Math.round(100 * e.loaded / e.total)}%`;
  });
  const groups = {};
  const seen = new Set();
  // patches (live.py patch) name their groups patch_furniture, patch_house.001, ...
  const groupName = (n) => n.replace(/^patch_/, '').replace(/\.\d+$/, '');
  for (const node of gltf.scene.children) groups[groupName(node.name)] = node;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    let g = o;
    while (g.parent && g.parent !== gltf.scene) g = g.parent;
    const gn = groupName(g.name);
    o.userData.group = gn;
    o.castShadow = !NO_SHADOW.has(gn) && gn !== 'pool_water';
    o.receiveShadow = gn !== 'geo_houses' && gn !== 'geo_roads';
    for (const m of [].concat(o.material)) if (!seen.has(m)) { seen.add(m); tuneMaterial(m, gn); }
  });
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { o.matrixAutoUpdate = false; });
  return { root: gltf.scene, groups };
}

// ── Collision: BVHs over the walkable geometry ───────────────────────
class Capsule {
  constructor(start, end, radius) { this.start = start; this.end = end; this.radius = radius; }
  clone() { return new Capsule(this.start.clone(), this.end.clone(), this.radius); }
  copy(c) { this.start.copy(c.start); this.end.copy(c.end); this.radius = c.radius; return this; }
  translate(v) { this.start.add(v); this.end.add(v); return this; }
}
const _box = new THREE.Box3(), _seg = new THREE.Line3(), _tp = new THREE.Vector3(), _cp = new THREE.Vector3();

class Collider {
  /** pick(mesh) chooses meshes; skip (Set of object ids) leaves those objects out (removed in a sketch). */
  constructor(root, pick, within = Infinity, skip = null) {
    const chunks = [];
    let count = 0;
    const p = new THREE.Vector3();
    root.traverse((o) => {
      if (!o.isMesh || !pick(o)) return;
      const pos = o.geometry.attributes.position, idx = o.geometry.index;
      const oid = skip && skip.size ? o.geometry.attributes._oid : null;
      const n = idx ? idx.count : pos.count;
      const out = new Float32Array(n * 3);
      let k = 0;
      for (let i = 0; i + 2 < n; i += 3) {
        const v0 = idx ? idx.getX(i) : i;
        if (oid && skip.has(Math.round(oid.getX(v0)))) continue;
        let keep = true;
        for (let j = 0; j < 3; j++) {
          p.fromBufferAttribute(pos, idx ? idx.getX(i + j) : i + j).applyMatrix4(o.matrixWorld);
          if (j === 0 && Math.hypot(p.x - HOUSE_CENTRE.x, p.z - HOUSE_CENTRE.z) > within) { keep = false; break; }
          out[k + j * 3] = p.x; out[k + j * 3 + 1] = p.y; out[k + j * 3 + 2] = p.z;
        }
        if (keep) k += 9;
      }
      chunks.push(out.subarray(0, k));
      count += k;
    });
    const all = new Float32Array(Math.max(count, 9));
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(all, 3));
    this.triangles = count / 9;
    this.bvh = new MeshBVH(geo);
  }

  capsuleIntersect(c, anyHit = false) {
    _seg.start.copy(c.start); _seg.end.copy(c.end);
    _box.makeEmpty().expandByPoint(c.start).expandByPoint(c.end).expandByScalar(c.radius);
    let hit = false;
    this.bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_box),
      intersectsTriangle: (tri) => {
        const dist = tri.closestPointToSegment(_seg, _tp, _cp);
        if (dist >= c.radius) return false;
        hit = true;
        if (anyHit) return true;
        const depth = c.radius - dist;
        const dir = _cp.sub(_tp).normalize();
        _seg.start.addScaledVector(dir, depth);
        _seg.end.addScaledVector(dir, depth);
        return false;
      },
    });
    if (!hit) return null;
    if (anyHit) return true;
    const normal = _seg.start.clone().sub(c.start);
    const depth = normal.length();
    if (depth < 1e-10) return null;
    return { normal: normal.divideScalar(depth), depth };
  }

  sphereIntersect(s) { return this.capsuleIntersect({ start: s.center, end: s.center, radius: s.radius }); }
}
const col = { house: null, ctx: null, sketch: null };
let colliders = [];
const refreshColliders = () => { colliders = [col.house, col.ctx, col.sketch].filter(Boolean); };

// ── The house (plan.glb), reloadable when the model changes ──────────
const house = { root: null, groups: {}, objects: [], byName: new Map(), version: 1, pickables: [], patches: new Map(), patchGroups: {}, patchHide: [] };
const waterMaterial = new THREE.MeshStandardMaterial({ color: 0x2aa7c9, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.86 });
const hooks = { frame: [], house: [], click: [], move: [] };

// A named version (tools/model.py publish) lives in v/<id>/ and never changes;
// the old numbered houses are assets/plan.glb?v=<n>.
const assetBase = (version) => (typeof version === 'string' ? `v/${encodeURIComponent(version)}/` : 'assets/');
// ?v=<id> shows that version and stays on it (people, sketches and pins stay live)
const pinnedVersion = /^[\w.-]{1,40}$/.test(params.get('v') || '') ? params.get('v') : null;
async function loadHouse(version = 1, label = 'the house') {
  if (pinnedVersion) version = pinnedVersion;
  const q = typeof version === 'number' && version > 1 ? `?v=${version}` : '';
  const at = assetBase(version);
  const [glb, objs] = await Promise.all([
    loadGlb(`${at}plan.glb${q}`, label),
    fetch(`${at}plan.objects.json${q}`).then((r) => (r.ok ? r.json() : { objects: [] })).catch(() => ({ objects: [] })),
  ]);
  if (glb.groups.doors) glb.groups.doors.visible = false; // glazed doors stand open
  if (glb.groups.pool_water) glb.groups.pool_water.traverse((o) => { if (o.isMesh) o.material = waterMaterial; });
  const pickables = [];
  glb.root.traverse((o) => {
    if (!o.isMesh || o.userData.group === 'doors') return;
    o.geometry.computeBoundsTree(); // fast pointing (and it fixes the triangle order once, before sketches touch it)
    pickables.push(o);
  });
  if (house.root) {
    scene.remove(house.root);
    house.root.traverse((o) => { if (o.isMesh) { o.geometry.disposeBoundsTree?.(); o.geometry.dispose(); } });
  }
  scene.add(glb.root);
  const byName = new Map();
  (objs.objects || []).forEach((o, i) => { const l = byName.get(o[0]); if (l) l.push(i); else byName.set(o[0], [i]); });
  Object.assign(house, { root: glb.root, groups: glb.groups, objects: objs.objects || [], byName, version, pickables,
    patches: new Map(), patchGroups: {}, patchHide: [] });
  rebuildHouseCollider();
  renderer.shadowMap.needsUpdate = true;
  for (const f of hooks.house) f(house);
  // another version has its own surroundings (V5 has no new street or neighbours)
  if (context.root && context.base !== assetBase(house.version)) {
    try { await loadContext(house.version); } catch (err) { console.warn('context.glb', err); }
  }
  return house;
}

// The street, the neighbours and the mountains (context.glb), per version.
const context = { root: null, base: null };
async function loadContext(version) {
  const base = assetBase(version);
  const ctx = await loadGlb(`${base}context.glb`, 'the street and the mountains');
  if (context.root) {
    scene.remove(context.root);
    context.root.traverse((o) => { if (o.isMesh) { o.geometry.disposeBoundsTree?.(); o.geometry.dispose(); } });
  }
  scene.add(ctx.root);
  Object.assign(context, { root: ctx.root, base });
  col.ctx = new Collider(ctx.root, (o) => o.userData.group === 'geo_terrain' || o.userData.group === 'context_near', 160);
  refreshColliders();
  renderer.shadowMap.needsUpdate = true;
}

// ── Patches: quick changes on top of the house (live.py patch) ───────
// A patch is a small GLB of new objects (vertex attribute _oid counts from 0
// within the patch) plus its object table. Its objects are appended to
// house.objects, so pointing, painting and removing work on them; `hide` names
// objects of the house before it that the change retired. The next full
// export replaces the patches it contains (the server drops them).
let patchChain = Promise.resolve();
function applyPatches(list) {
  patchChain = patchChain.then(() => applyPatchesNow(list)).catch((e) => console.warn('patches', e));
  return patchChain;
}
async function applyPatchesNow(list) {
  const want = (list || []).filter((p) => p.ready);
  let changed = false;
  for (const [id, p] of house.patches) {
    if (want.some((w) => w.id === id)) continue;
    p.root.removeFromParent(); house.patches.delete(id); changed = true;
  }
  for (const p of want) {
    if (house.patches.has(p.id)) continue;
    const version = house.version;
    let glb;
    try { glb = await loadGlb(`${liveBase()}/live/patch/${p.id}.glb`, p.label || 'a change'); } catch (e) { console.warn('patch', p.id, e); continue; }
    if (house.version !== version || house.patches.has(p.id)) continue; // the house was reloaded meanwhile
    const base = house.objects.length;
    glb.root.traverse((o) => {
      if (!o.isMesh) return;
      const a = o.geometry.attributes._oid;
      if (a) { for (let i = 0; i < a.count; i++) a.setX(i, a.getX(i) + base); a.needsUpdate = true; }
      o.geometry.computeBoundsTree();
      house.pickables.push(o);
    });
    for (const [g, node] of Object.entries(glb.groups)) (house.patchGroups[g] ||= []).push(node);
    (p.objects || []).forEach((o, i) => {
      house.objects.push(o);
      const l = house.byName.get(o[0]); if (l) l.push(base + i); else house.byName.set(o[0], [base + i]);
    });
    house.patchHide.push({ base, names: p.hide || [] });
    house.root.add(glb.root);
    glb.root.updateMatrixWorld(true);
    house.patches.set(p.id, { root: glb.root, base });
    changed = true;
  }
  if (!changed) return false;
  rebuildHouseCollider();
  renderer.shadowMap.needsUpdate = true;
  for (const f of hooks.house) f(house);
  return true;
}
function rebuildHouseCollider(skip = null) {
  col.house = new Collider(house.root, (o) => COLLIDE.has(o.userData.group), Infinity, skip);
  refreshColliders();
}
/** Walls and other solid sketches: one collider over everything in `group`. */
function setSketchCollider(group) {
  col.sketch = group && group.children.length ? new Collider(group, () => true) : null;
  refreshColliders();
}
/** First walkable surface along a ray (three.js world), or null. */
function castWalkable(ray, far = 40) {
  let best = null;
  for (const c of colliders) {
    const h = c.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (h && h.distance <= far && (!best || h.distance < best.distance)) best = h;
  }
  return best;
}

// ── Places (Blender coordinates of the feet, heading: 0 = +Y, 90 = +X uphill) ──
const PLACES = {
  'Street': [-6.5, -2, 0.4, 90],
  'Living room': [12.5, 0.5, 4.2, 90],
  'Pool deck': [20.1, 6.2, 5.35, 180],
  'Master bedroom': [11.6, 0.3, 7.35, 300], // beside the bed, not on it
  'Sundowner deck': [33.0, 2.5, 11.6, 270], // a clear patch between the loungers and the table
  'Carport': [-0.5, 6.2, 0.3, 270],
};
const placeNames = Object.keys(PLACES);
let placeIndex = 0;

// ── Player ───────────────────────────────────────────────────────────
// The capsule tops out at 1.40 m so the low spot under the stair cupboard
// (1.78 m) stays passable; the eye height on a computer is 1.58 m, in VR it
// is your own.
const R = 0.25, EYE = 1.58, TOP = 1.12, STEP = 0.30;
const player = { collider: new Capsule(new THREE.Vector3(0, R, 0), new THREE.Vector3(0, TOP, 0), R), vel: new THREE.Vector3(), onFloor: false, grounded: 0, lastSafe: null };
let yaw = 0, pitch = 0; // rig yaw (both modes), camera pitch (computer only)
const headOff = new THREE.Vector3(), lastHeadOff = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function headOffset(out) { // head position relative to the feet, horizontal, in world axes
  if (!renderer.xr.isPresenting) return out.set(0, 0, 0);
  return out.set(camera.position.x, 0, camera.position.z).applyAxisAngle(UP, yaw);
}
function placeRig() {
  headOffset(headOff);
  const s = player.collider.start;
  rig.position.set(s.x - headOff.x, s.y - R, s.z - headOff.z);
  rig.rotation.set(0, yaw, 0);
  rig.updateMatrixWorld(true);
  lastHeadOff.copy(headOff);
}
function headYawInRig() { // where the headset looks, relative to the rig
  if (!renderer.xr.isPresenting) return 0;
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  return e.y;
}

let banner = null;
/** Feet to Blender (x, y, z); heading in degrees (0 = +Y), or undefined to keep looking the same way. */
function teleport(x, y, z, headingDeg) {
  const p = b2t(x, y, z + 0.3);
  player.collider.start.set(p.x, p.y + R, p.z);
  player.collider.end.set(p.x, p.y + TOP, p.z);
  player.vel.set(0, 0, 0);
  if (headingDeg !== undefined) { yaw = -headingDeg * Math.PI / 180 - headYawInRig(); pitch = 0; }
  player.lastSafe = [x, y, z];
  placeRig();
}
function goPlace(i) {
  placeIndex = (i + placeNames.length) % placeNames.length;
  const name = placeNames[placeIndex];
  teleport(...PLACES[name]);
  $('#goto').value = name;
  showBanner(name);
}
const feet = () => { const s = player.collider.start; return [s.x, -s.z, s.y - R]; };

function hitTest(c) { return colliders.some((t) => t.capsuleIntersect(c, true)); }
const footProbe = new THREE.Sphere(new THREE.Vector3(), R * 0.85);
function onGround() {
  footProbe.center.copy(player.collider.start).y -= R * 0.15 + 0.04;
  return colliders.some((t) => { const h = t.sphereIntersect(footProbe); return h && h.normal.y > 0.35; });
}
function playerCollide() {
  for (const tree of colliders) {
    const hit = tree.capsuleIntersect(player.collider);
    if (!hit || hit.depth < 1e-10) continue;
    if (hit.normal.y > 0.7) {
      player.collider.translate(new THREE.Vector3(0, hit.depth / hit.normal.y, 0));
    } else {
      if (hit.normal.y < 0.35) player.vel.addScaledVector(hit.normal, -hit.normal.dot(player.vel));
      player.collider.translate(hit.normal.multiplyScalar(hit.depth));
    }
  }
  player.onFloor = onGround();
  if (player.onFloor && player.vel.y < 0) player.vel.y = 0;
}
function stepUp(before, d) {
  const len = Math.hypot(d.x, d.z), adv = Math.max(len, 0.008) / len;
  const trial = before.clone();
  trial.translate(new THREE.Vector3(d.x * adv, 0, d.z * adv));
  trial.start.y += STEP;
  if (hitTest(trial)) return;
  let lo = 0, hi = STEP;
  const probe = trial.clone();
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    probe.copy(trial);
    probe.start.y -= mid;
    if (hitTest(probe)) hi = mid; else lo = mid;
  }
  const rise = STEP - lo;
  if (rise < 0.004) return;
  trial.start.y -= lo;
  trial.end.y += rise;
  if (hitTest(trial)) return;
  player.collider.copy(trial);
  player.vel.y = 0;
  player.onFloor = true;
  player.grounded = 0;
}

/** wish: horizontal unit vector (or zero), speed in m/s, extra: horizontal displacement this frame (headset moved in the room). */
const _d = new THREE.Vector3();
function movePlayer(dt, wish, speed, extra) {
  if (Math.hypot(extra.x, extra.z) > 0.6) extra.set(0, 0, 0); // tracking jump or recentre: do not drag the body along
  const steps = 5, h = dt / steps;
  for (let i = 0; i < steps; i++) {
    if (player.onFloor) { player.vel.x = wish.x * speed; player.vel.z = wish.z * speed; player.grounded = 0; }
    else { player.vel.y -= 22 * h; player.grounded += h; }
    const before = player.collider.clone();
    _d.copy(player.vel).multiplyScalar(h);
    _d.x += extra.x / steps; _d.z += extra.z / steps;
    player.collider.translate(_d);
    playerCollide();
    const want = Math.hypot(_d.x, _d.z);
    if (want > 1e-5 && player.grounded < 0.25 && player.vel.y <= 0.5) {
      const got = ((player.collider.start.x - before.start.x) * _d.x + (player.collider.start.z - before.start.z) * _d.z) / want;
      if (got < 0.5 * want) stepUp(before, _d);
    }
  }
  if (player.collider.end.y < -30 && player.lastSafe) teleport(...player.lastSafe);
}

// ── Fast movement for death match: Quake-style acceleration, friction and
// air control (strafe-jumping and bunny hopping work). Substeps grow with the
// speed so a fast player never moves more than 6 cm per step (walls are 11 cm).
const QUAKE = { maxSpeed: 7.2, accel: 11, friction: 6, stopSpeed: 2.2, airCap: 0.95, airAccel: 11, jump: 5.8, gravity: 19 };
function quakeAccel(wishdir, wishspeed, accel, h, cap = Infinity) {
  const cur = player.vel.x * wishdir.x + player.vel.z * wishdir.z;
  const add = Math.min(wishspeed, cap) - cur;
  if (add <= 0) return;
  const a = Math.min(accel * wishspeed * h, add);
  player.vel.x += a * wishdir.x;
  player.vel.z += a * wishdir.z;
}
/** wishdir: horizontal unit vector or zero; jump: held. Returns {jumped, landed, fall} for sounds. */
function moveQuake(dt, wishdir, jump) {
  const ev = { jumped: false, landed: false, fall: 0 };
  const speedNow = Math.hypot(player.vel.x, player.vel.y, player.vel.z);
  const steps = Math.min(40, Math.max(4, Math.ceil(speedNow * dt / 0.06)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const wasAir = !player.onFloor;
    if (player.onFloor) {
      if (jump) { player.vel.y = QUAKE.jump; player.onFloor = false; ev.jumped = true; } // no friction on the jump: bunny hops keep speed
      else {
        const sp = Math.hypot(player.vel.x, player.vel.z);
        if (sp > 0.001) {
          const drop = Math.max(sp, QUAKE.stopSpeed) * QUAKE.friction * h;
          const k = Math.max(sp - drop, 0) / sp;
          player.vel.x *= k; player.vel.z *= k;
        }
      }
      quakeAccel(wishdir, wishdir.lengthSq() ? QUAKE.maxSpeed : 0, QUAKE.accel, h);
      player.grounded = 0;
    } else {
      quakeAccel(wishdir, wishdir.lengthSq() ? QUAKE.maxSpeed : 0, QUAKE.airAccel, h, QUAKE.airCap);
      player.vel.y -= QUAKE.gravity * h;
      player.grounded += h;
    }
    const vy = player.vel.y;
    const before = player.collider.clone();
    _d.copy(player.vel).multiplyScalar(h);
    player.collider.translate(_d);
    playerCollide();
    if (wasAir && player.onFloor) { ev.landed = true; ev.fall = Math.max(ev.fall, -vy); }
    const want = Math.hypot(_d.x, _d.z);
    if (want > 1e-5 && player.grounded < 0.25 && player.vel.y <= 0.5) {
      const got = ((player.collider.start.x - before.start.x) * _d.x + (player.collider.start.z - before.start.z) * _d.z) / want;
      if (got < 0.5 * want) stepUp(before, _d);
    }
  }
  return ev;
}
/** First solid hit along a ray (three.js world), against the collision BVHs: {point, distance, normal} or null. */
const _ray = new THREE.Ray();
function rayWorld(origin, dir, far = 200) {
  _ray.origin.copy(origin); _ray.direction.copy(dir);
  let best = null;
  for (const c of colliders) {
    const hit = c.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, far);
    if (hit && hit.distance <= far && (!best || hit.distance < best.distance)) best = hit;
  }
  return best && { point: best.point.clone(), distance: best.distance, normal: best.face ? best.face.normal.clone() : null };
}
let driver = null, driverRoll = 0; // dm.js sets these: it then reads input and moves the player

// ── Input: keyboard and mouse ────────────────────────────────────────
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (/^Arrow|Space/.test(e.code)) e.preventDefault();
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
// Drag looks around; a click (less than 6 px of movement) goes to the tools.
// One finger or the mouse only (dragPointer), and deltas from clientX/Y:
// Safari gives no movementX for touches.
let dragging = false, downAt = null, moved = 0, dragPointer = null, lastXY = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || dragging) return;
  dragging = true; dragPointer = e.pointerId; downAt = [e.clientX, e.clientY]; lastXY = [e.clientX, e.clientY]; moved = 0;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerId !== dragPointer) return;
  if (dragging && moved < 6) for (const f of hooks.click) f(e);
  dragging = false; dragPointer = null;
});
canvas.addEventListener('pointercancel', (e) => { if (e.pointerId === dragPointer) { dragging = false; dragPointer = null; } });
canvas.addEventListener('pointermove', (e) => {
  for (const f of hooks.move) f(e);
  if (!dragging || e.pointerId !== dragPointer) return;
  const dx = e.clientX - lastXY[0], dy = e.clientY - lastXY[1];
  lastXY = [e.clientX, e.clientY];
  moved += Math.abs(dx) + Math.abs(dy);
  if (moved < 6 || document.pointerLockElement) return;
  const s = driver ? -1.3 : 1; // death match: drag turns the view the way your finger goes (shooter style)
  yaw += s * dx * 0.0045;
  pitch = Math.max(-1.45, Math.min(1.45, pitch + s * dy * 0.0045)); // walk: dragging pulls the view
});

// ── Input: touch screens (iPhone, iPad, Android) ─────────────────────
// Two on-screen sticks: the left one walks (push it to the rim to run), the
// right one looks around. Dragging elsewhere still looks, a tap uses the tool.
// ?touch=1 / ?touch=0 forces them on or off.
const TOUCH = params.has('touch') ? params.get('touch') === '1'
  : navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches && !/OculusBrowser/.test(navigator.userAgent);
const sticks = { move: { x: 0, y: 0 }, look: { x: 0, y: 0 } };
function makeStick(side, out) {
  const base = document.createElement('div');
  base.className = `stick ${side}`;
  base.innerHTML = '<div class="knob"></div>';
  document.body.append(base);
  const knob = base.firstChild;
  let id = null, cx = 0, cy = 0, rad = 1;
  const set = (x, y) => {
    let dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (d > rad) { dx *= rad / d; dy *= rad / d; }
    out.x = dx / rad; out.y = dy / rad;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  base.addEventListener('pointerdown', (e) => {
    if (id !== null) return;
    e.preventDefault();
    id = e.pointerId;
    try { base.setPointerCapture(id); } catch { /* synthetic events in tests */ }
    const r = base.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2; rad = r.width / 2 - knob.offsetWidth / 4;
    base.classList.add('on');
    set(e.clientX, e.clientY);
  });
  base.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e.clientX, e.clientY); });
  const release = () => {
    id = null; out.x = 0; out.y = 0;
    knob.style.transform = '';
    base.classList.remove('on');
  };
  const end = (e) => { if (e.pointerId === id) release(); };
  base.addEventListener('pointerup', end);
  base.addEventListener('pointercancel', end);
  base.addEventListener('lostpointercapture', end);
  base.addEventListener('contextmenu', (e) => e.preventDefault());
  stickReleases.push(release);
}
// iOS can take a touch over (the home gesture at the bottom edge, a notification)
// without ever sending pointerup or pointercancel: the stick would stay pushed and
// keep turning or walking. So: no finger on the screen, or the page in the
// background, lets go of every stick.
const stickReleases = [];
const releaseSticks = () => stickReleases.forEach((f) => f());
window.addEventListener('touchend', (e) => { if (!e.touches.length) releaseSticks(); }, { passive: true });
window.addEventListener('touchcancel', (e) => { if (!e.touches.length) releaseSticks(); }, { passive: true });
window.addEventListener('blur', releaseSticks);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseSticks(); });
if (TOUCH) {
  document.body.classList.add('touch');
  // phones: fewer pixels and a smaller shadow map, so Safari keeps the tab alive
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  sun.shadow.mapSize.set(2048, 2048);
  makeStick('left', sticks.move);
  makeStick('right', sticks.look);
  $('#hint').textContent = 'Left circle walks (to the edge runs), right circle looks around. Tap with a tool to use it.';
  setTimeout(() => $('#hint').classList.add('gone'), 9000);
  // iOS Safari ignores user-scalable=no: keep pinches from zooming the page
  for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault());
}
// small stick moves for fine aiming, full deflection for fast turns
const curve = (v, dead = 0.1) => { const a = Math.abs(v); return a < dead ? 0 : Math.sign(v) * ((a - dead) / (1 - dead)) ** 2; };
/** Ray from the camera through a mouse event (three.js world). */
function mouseRay(e) {
  const r = canvas.getBoundingClientRect();
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  return rc.ray;
}

// ── Input: VR controllers ────────────────────────────────────────────
// left stick: walk where you look; right stick: snap turn 30 degrees;
// stick click: run; A / X: next place; B / Y: previous place.
// Triggers and grips belong to live.js (tools, teleport).
const controllers = { left: null, right: null }; // { ray, grip, source }
for (let i = 0; i < 2; i++) {
  const ray = renderer.xr.getController(i), grip = renderer.xr.getControllerGrip(i);
  rig.add(ray, grip);
  ray.addEventListener('connected', (e) => { controllers[e.data.handedness] = { ray, grip, source: e.data }; });
  ray.addEventListener('disconnected', () => { for (const k of ['left', 'right']) if (controllers[k]?.ray === ray) controllers[k] = null; });
}
const pad = { turnArmed: true, run: false, prevButtons: new Map() };
function readControllers() {
  const out = { move: [0, 0], turn: 0, next: false, prev: false };
  const session = renderer.xr.getSession();
  if (!session) return out;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const ax = gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] || 0, gp.axes[1] || 0];
    const pressed = gp.buttons.map((b) => b.pressed);
    const was = pad.prevButtons.get(src) || [];
    const edge = (i) => pressed[i] && !was[i];
    if (src.handedness === 'left') out.move = ax;
    if (src.handedness === 'right') out.turn = ax[0];
    if (edge(3)) pad.run = !pad.run;
    if (edge(4)) out.next = true;
    if (edge(5)) out.prev = true;
    pad.prevButtons.set(src, pressed);
  }
  return out;
}

// ── Floating label in VR (and the place name on screen) ──────────────
function makeBanner() {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 128;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.15), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, depthTest: false }));
  mesh.position.set(0, -0.25, -1.4);
  mesh.renderOrder = 100;
  mesh.visible = false;
  camera.add(mesh);
  return { cv, tex, mesh, until: 0 };
}
function showBanner(text, ms = 2500) {
  if (!banner) banner = makeBanner();
  const ctx = banner.cv.getContext('2d');
  ctx.clearRect(0, 0, 1024, 128);
  let size = 64;
  do { ctx.font = `600 ${size}px Segoe UI, sans-serif`; size -= 4; } while (ctx.measureText(text).width > 960 && size > 28);
  const w = Math.min(1020, ctx.measureText(text).width + 64);
  ctx.fillStyle = 'rgba(28,22,18,.85)';
  ctx.beginPath(); ctx.roundRect((1024 - w) / 2, 8, w, 112, 24); ctx.fill();
  ctx.fillStyle = '#e0a458'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 512, 66);
  banner.tex.needsUpdate = true;
  banner.mesh.visible = renderer.xr.isPresenting;
  banner.until = performance.now() + ms;
  if (!renderer.xr.isPresenting) toast(text);
}
function toast(text) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3500);
}

// ── Frame ────────────────────────────────────────────────────────────
const wish = new THREE.Vector3(), extra = new THREE.Vector3(), fwd = new THREE.Vector3(), side = new THREE.Vector3();
const clock = new THREE.Clock();
let ready = false, xrFrames = 0;
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  if (!ready) { renderer.render(scene, camera); return; }
  const xr = renderer.xr.isPresenting;
  wish.set(0, 0, 0);
  extra.set(0, 0, 0);
  let speed = 1.6;
  if (xr) {
    const c = readControllers();
    if (c.next) goPlace(placeIndex + 1);
    if (c.prev) goPlace(placeIndex - 1);
    if (Math.abs(c.turn) > 0.6 && pad.turnArmed) {
      yaw -= Math.sign(c.turn) * Math.PI / 6;
      pad.turnArmed = false;
      placeRig(); // pivot about the head: the feet stay under it
    } else if (Math.abs(c.turn) < 0.3) pad.turnArmed = true;
    // the direction you look, flattened
    camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    side.set(-fwd.z, 0, fwd.x);
    const [mx, my] = c.move;
    if (Math.hypot(mx, my) > 0.15) wish.addScaledVector(fwd, -my).addScaledVector(side, mx);
    if (wish.lengthSq() > 1) wish.normalize();
    if (wish.lengthSq() < 0.01) pad.run = false;
    speed = pad.run ? 3.5 : 1.6;
    // the headset moved in the room: move the body with it (walls stop it)
    // (the first frames of a session carry no pose yet: take the head as it is)
    headOffset(headOff);
    if (++xrFrames > 2) extra.subVectors(headOff, lastHeadOff);
  } else if (driver) {
    // death match (dm.js): it reads the input and moves the player itself
    try { driver(dt); } catch (err) { if (!frame.dwarned) { frame.dwarned = true; console.error('driver', err); } }
    camera.position.set(0, EYE, 0);
    camera.rotation.set(pitch, 0, driverRoll);
  } else {
    const turn = 1.9 * dt;
    if (keys.has('ArrowLeft')) yaw += turn;
    if (keys.has('ArrowRight')) yaw -= turn;
    fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    side.set(-fwd.z, 0, fwd.x);
    if (keys.has('KeyW') || keys.has('ArrowUp')) wish.add(fwd);
    if (keys.has('KeyS') || keys.has('ArrowDown')) wish.sub(fwd);
    if (keys.has('KeyA')) wish.sub(side);
    if (keys.has('KeyD')) wish.add(side);
    if (wish.lengthSq() > 0) wish.normalize();
    speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3.5 : 1.6;
    if (TOUCH) {
      yaw -= curve(sticks.look.x) * 2.6 * dt;
      pitch = Math.max(-1.45, Math.min(1.45, pitch - curve(sticks.look.y) * 1.8 * dt));
      const { x: mx, y: my } = sticks.move, mag = Math.hypot(mx, my);
      if (mag > 0.12 && wish.lengthSq() === 0) {
        // the knob's distance sets the pace: slow near the centre, a run at the rim
        wish.addScaledVector(fwd, -my / mag).addScaledVector(side, mx / mag).multiplyScalar(Math.min(1, (mag - 0.12) / 0.6));
        if (mag > 0.92) speed = 3.5;
      }
    }
    camera.position.set(0, EYE, 0);
    camera.rotation.set(pitch, 0, 0);
  }
  if (!driver || xr) movePlayer(dt, wish, speed, extra);
  placeRig();
  for (const f of hooks.frame) {
    try { f(dt); } catch (err) { if (!frame.warned) { frame.warned = true; console.error('frame hook', err); } } // never blank the headset
  }
  if (banner && banner.mesh.visible && performance.now() > banner.until) banner.mesh.visible = false;
  renderer.render(scene, camera);
}

function resize() {
  if (renderer.xr.isPresenting) return;
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ── VR button ────────────────────────────────────────────────────────
async function setupVR() {
  const btn = $('#vr');
  if (!navigator.xr) {
    btn.textContent = window.isSecureContext ? 'No VR in this browser' : 'VR needs https';
    return;
  }
  const ok = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  if (!ok) { btn.textContent = 'No VR headset found'; return; }
  btn.disabled = false;
  btn.textContent = 'Enter VR';
  let session = null;
  btn.onclick = async () => {
    if (session) { session.end(); return; }
    session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    session.addEventListener('end', () => {
      session = null; btn.textContent = 'Enter VR';
      pitch = 0; resize(); placeRig();
    });
    await renderer.xr.setSession(session);
    btn.textContent = 'Exit VR';
    xrFrames = 0;
  };
}

// What live.js (people, sketches, pins) gets to work with.
const world = {
  THREE, scene, camera, rig, renderer, b2t, t2b, house, hooks, controllers, PLACES,
  teleport, feet, goPlace, showBanner, toast, mouseRay, castWalkable,
  rebuildHouseCollider, setSketchCollider, loadHouse, applyPatches, liveBase,
  isXR: () => renderer.xr.isPresenting,
  pinnedVersion,
  exitVR: () => renderer.xr.getSession()?.end(),
  getHours: () => hours,
  setHours: (h) => { hours = Math.min(20, Math.max(5, h)); applySun(); },
  yawDeg: () => -(yaw + headYawInRig()) * 180 / Math.PI,
  shadows: () => { renderer.shadowMap.needsUpdate = true; },
  // for dm.js (death match)
  player, keys, sticks, TOUCH, curve, EYE, R, TOP, QUAKE, canvas,
  setDriver: (f) => { driver = f; },
  setRoll: (r) => { driverRoll = r; },
  moveQuake, rayWorld,
  turn: (dYaw, dPitch) => { yaw += dYaw; pitch = Math.max(-1.5, Math.min(1.5, pitch + dPitch)); },
  view: () => ({ yaw, pitch }),
  setView: (y, p = 0) => { yaw = y; pitch = p; },
  colliders: () => colliders,
  isPublic: () => PUBLIC,
};

// ── Mode: architect (the walk: people, sketches, pins, the Claude loop) or
// death match (dm.js). The start screen asks while the house loads; ?mode=architect
// or ?mode=dm skips it. On the public site (pythonic.nl) there is no home hub, so
// architect is look-only there.
export const PUBLIC = !/^(quest\.home\.pythonic\.nl|localhost|127\.0\.0\.1)$/.test(location.hostname);
function chooseMode() {
  const given = params.get('mode');
  if (given === 'dm' || given === 'architect') { $('#menu').hidden = true; return Promise.resolve(given); }
  const nameIn = $('#pname');
  try { nameIn.value = localStorage.getItem('chamais-name') || ''; } catch { /* private window */ }
  return new Promise((resolve) => {
    $('#menu').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      const n = nameIn.value.trim().slice(0, 16);
      if (n) { try { localStorage.setItem('chamais-name', n); } catch { /* */ } }
      $('#menu').hidden = true;
      if (!ready) $('#loadmsg').hidden = false;
      resolve(b.dataset.mode);
    });
  });
}

// ── Start ────────────────────────────────────────────────────────────
async function start() {
  resize();
  const modeChosen = chooseMode();
  $('#goto').innerHTML = placeNames.map((p) => `<option>${p}</option>`).join('');
  $('#goto').onchange = (e) => { goPlace(placeNames.indexOf(e.target.value)); e.target.blur(); };
  $('#hour').oninput = (e) => { hours = parseFloat(e.target.value); applySun(); };
  applySun();
  renderer.setAnimationLoop(frame);
  setupVR();

  // the version comes from the live server when it is there, so a reload after
  // Claude changed the model never shows a cached house
  let version = 1;
  if (!PUBLIC) {
    try { version = (await (await fetch(`${liveBase()}/live/health`, { cache: 'no-store' })).json()).model || 1; } catch { /* no live server: walk alone */ }
  }
  await loadHouse(version);
  try {
    await loadContext(house.version);
  } catch (err) {
    console.warn('context.glb missing', err);
  }
  goPlace(0);
  renderer.shadowMap.needsUpdate = true;
  ready = true;
  const mode = await modeChosen;
  $('#loading').hidden = true;
  document.body.dataset.mode = mode;
  if (mode === 'dm') {
    try { (await import('./dm.js')).initDM(world); } catch (err) { console.error('dm.js', err); toast('Death match did not start: ' + err.message); }
  } else if (!PUBLIC) {
    try { (await import('./live.js')).initLive(world); } catch (err) { console.warn('live.js', err); }
  }
}
/** Where the live server is: same site behind Caddy; straight to this PC when served by serve.py. */
export function liveBase() {
  // ?live=http://127.0.0.1:<port>: a test hub on this PC (serve.py only)
  const test = new URLSearchParams(location.search).get('live');
  if (location.port === '8138' && test && /^http:\/\/127\.0\.0\.1:\d+$/.test(test)) return test;
  return location.port === '8138' ? 'https://home.invalid' : ''; // serve.py: the home hub, through Caddy
}

window.walk = { world, scene, THREE, teleport, goPlace, player, colliders: () => colliders, movePlayer, hitTest, Capsule, R, TOP, pos: () => feet().map((n) => +n.toFixed(2)),
  step(seconds, codes = ['KeyW']) { codes.forEach((c) => keys.add(c)); for (let t = 0; t < seconds; t += 1 / 60) { clock.getDelta(); frameStep(1 / 60); } codes.forEach((c) => keys.delete(c)); return this.pos(); },
  look(headingDeg, pitchDeg = 0) { yaw = -headingDeg * Math.PI / 180; pitch = pitchDeg * Math.PI / 180; },
  info: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles }),
  tick: (n = 1) => { for (let i = 0; i < n; i++) frame(); } }; // frames by hand (a hidden tab draws none)
// physics step without rendering, for tests in a background tab
function frameStep(dt) {
  wish.set(0, 0, 0);
  fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw)); side.set(-fwd.z, 0, fwd.x);
  if (keys.has('KeyW')) wish.add(fwd);
  if (keys.has('KeyS')) wish.sub(fwd);
  if (keys.has('KeyA')) wish.sub(side);
  if (keys.has('KeyD')) wish.add(side);
  if (wish.lengthSq() > 0) wish.normalize();
  movePlayer(dt, wish, 1.6, extra.set(0, 0, 0));
  placeRig();
}

start();
