// Chamais: the game. Viewer core: loads the exported house, walk and overview
// cameras, the Windhoek sun, the game clock and the panel the mini-games use.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshBVH } from 'three-mesh-bvh';
import { Sky } from 'three/addons/objects/Sky.js';
import { SITE, sunPosition, localToUtcMs, sunDirectionModel } from './sun.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#view');

// Blender (x east, y north, z up) -> three.js (x, y up, z = -north)
export const b2t = (x, y, z) => new THREE.Vector3(x, z, -y);
export const t2b = (v) => [v.x, -v.z, v.y];

// ── Renderer and scene ───────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.08, 60000);
camera.rotation.order = 'YXZ';

const sky = new Sky();
sky.scale.setScalar(45000);
scene.add(sky);
Object.assign(sky.material.uniforms.turbidity, { value: 4 });
sky.material.uniforms.rayleigh.value = 1.6;
sky.material.uniforms.mieCoefficient.value = 0.004;
sky.material.uniforms.mieDirectionalG.value = 0.8;

const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x8a6a48, 1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
Object.assign(sun.shadow.camera, { left: -42, right: 42, top: 42, bottom: -42, near: 1, far: 260 });
scene.add(sun, sun.target);
const HOUSE_CENTRE = b2t(18, -1, 5);
sun.target.position.copy(HOUSE_CENTRE);
// a soft lamp that travels with the camera, so rooms are not black inside
const fill = new THREE.PointLight(0xfff0dc, 0, 16, 1.2);
camera.add(fill);
scene.add(camera);
const moon = new THREE.DirectionalLight(0x8fa6d8, 0);
moon.position.set(-40, 80, 30);
scene.add(moon);

// ── State ────────────────────────────────────────────────────────────
const state = {
  mode: 'walk',
  variant: 'plan',
  day: '2026-11-11',
  hours: 16.5,
  speed: 0, // game hours per real second
  sun: { az: 0, el: 0 },
  roofs: true,
  ready: false,
};
const variants = {}; // name -> { root, site, octree, groups }
let context = null;
const listeners = { tick: [], variant: [], frame: [] };
const hotspots = []; // { id, pos:[x,y,z] blender, radius, label, action, when }
const modules = [];
let activeTab = null;

// ── Loading ──────────────────────────────────────────────────────────
const loader = new GLTFLoader();
const COLLIDE = new Set(['terrain', 'house', 'carport', 'context_near']);
const NO_SHADOW = new Set(['geo_terrain', 'geo_houses', 'geo_roads']);
const NO_RECEIVE = new Set(['geo_houses', 'geo_roads']);

function tuneMaterial(m) {
  const n = (m.name || '').toLowerCase();
  if (/glaz|glass/.test(n)) {
    m.transparent = true;
    m.opacity = /frost/.test(n) ? 0.75 : 0.28;
    m.roughness = 0.08;
    m.metalness = 0;
    m.depthWrite = false;
  }
  if (m.map) m.map.anisotropy = 8;
}

async function loadGlb(url, onProgress) {
  const gltf = await loader.loadAsync(url, onProgress);
  const groups = {};
  const seen = new Set();
  for (const node of gltf.scene.children) groups[node.name] = node;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    let g = o;
    while (g.parent && g.parent !== gltf.scene) g = g.parent;
    const name = g.name;
    o.userData.group = name;
    o.castShadow = !NO_SHADOW.has(name) && name !== 'pool_water';
    o.receiveShadow = !NO_RECEIVE.has(name);
    for (const m of [].concat(o.material)) if (!seen.has(m)) { seen.add(m); tuneMaterial(m); }
  });
  return { root: gltf.scene, groups };
}

// ── Collision: one BVH over the merged walkable geometry ─────────────
class Capsule {
  constructor(start, end, radius) { this.start = start; this.end = end; this.radius = radius; }
  clone() { return new Capsule(this.start.clone(), this.end.clone(), this.radius); }
  copy(c) { this.start.copy(c.start); this.end.copy(c.end); this.radius = c.radius; return this; }
  translate(v) { this.start.add(v); this.end.add(v); return this; }
}
const _box = new THREE.Box3(), _seg = new THREE.Line3(), _tp = new THREE.Vector3(), _cp = new THREE.Vector3();

class Collider {
  constructor(root, pick = (o) => COLLIDE.has(o.userData.group), within = Infinity) {
    const chunks = [];
    let count = 0;
    const p = new THREE.Vector3();
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh || !pick(o)) return;
      const pos = o.geometry.attributes.position, idx = o.geometry.index;
      const n = idx ? idx.count : pos.count;
      const out = new Float32Array(n * 3);
      let k = 0;
      for (let i = 0; i + 2 < n; i += 3) {
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
    const all = new Float32Array(count);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(all, 3));
    this.triangles = count / 9;
    this.bvh = new MeshBVH(geo);
  }

  /** Push a capsule out of the geometry. Returns { normal, depth } or null (same shape as three's Octree). */
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

  sphereIntersect(s) {
    return this.capsuleIntersect({ start: s.center, end: s.center, radius: s.radius });
  }
}

const waterMaterial = new THREE.MeshStandardMaterial({ color: 0x2aa7c9, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.86 });

async function loadVariant(name) {
  if (variants[name]) return variants[name];
  const t0 = performance.now();
  const msg = $('#loadmsg');
  const [glb, site] = await Promise.all([
    loadGlb(`assets/${name}.glb`, (e) => { if (e.total) msg.textContent = `Loading the house (${name})… ${Math.round(100 * e.loaded / e.total)}%`; }),
    fetch(`assets/${name}.site.json`).then((r) => r.json()),
  ]);
  const t1 = performance.now();
  console.info(`[chamais] ${name}: loaded and parsed in ${Math.round(t1 - t0)} ms`);
  const v = { name, site, ...glb };
  if (v.groups.doors) v.groups.doors.visible = false; // glazed doors stand open: not drawn, no collision
  if (v.groups.pool_water) v.groups.pool_water.traverse((o) => { if (o.isMesh) o.material = waterMaterial; });
  v.octree = new Collider(v.root);
  console.info(`[chamais] ${name}: collider of ${v.octree.triangles} triangles built in ${Math.round(performance.now() - t1)} ms`);
  v.root.visible = false;
  scene.add(v.root);
  variants[name] = v;
  return v;
}

// ── Places to jump to (Blender coordinates of the feet) ──────────────
const PLACES = {
  today: {
    'Street': [-6.5, -2, 0.4, 90], 'Living room': [12.5, 0.5, 4.2, 90], 'Pool deck': [20.1, 5.4, 4.6, 180],
    'Bedroom wing': [5.2, -1.0, 3.2, 270], 'On the mountain': [34, 2, 13, 270],
  },
  plan: {
    'Street': [-6.5, -2, 0.4, 90], 'Living room': [12.5, 0.5, 4.2, 90], 'Pool deck': [20.1, 6.2, 5.35, 180],
    'Master bedroom': [13.2, -0.6, 7.45, 300], 'Sundowner deck': [33.5, 3.8, 11.75, 270], 'Carport': [-0.5, 6.2, 0.3, 270],
  },
};

// ── Player ───────────────────────────────────────────────────────────
const R = 0.28, EYE = 1.58, TOP = 1.12; // eye height; the collision capsule tops out at 1.40 m so low
// spots in the model (1.78 m under the stair cupboard) stay passable
const player = {
  collider: new Capsule(new THREE.Vector3(0, R, 0), new THREE.Vector3(0, TOP, 0), R),
  vel: new THREE.Vector3(), onFloor: false, grounded: 0, yaw: 0, pitch: 0, lastSafe: null,
};
const keys = new Set();

function teleport(x, y, z, headingDeg) {
  const p = b2t(x, y, z);
  player.collider.start.set(p.x, p.y + R, p.z);
  player.collider.end.set(p.x, p.y + TOP, p.z);
  player.vel.set(0, 0, 0);
  if (headingDeg !== undefined) { player.yaw = -headingDeg * Math.PI / 180; player.pitch = 0; }
  player.lastSafe = [x, y, z];
}
// heading: compass-style in the model frame, 0 = +Y (north-ish), 90 = +X (uphill/east)
function goPlace(name) {
  const p = PLACES[state.variant][name] || Object.values(PLACES[state.variant])[0];
  teleport(p[0], p[1], p[2], p[3]);
  setMode('walk');
}

let ctxOctree = null; // real terrain around the plot, from context.glb
function hitTest(capsule) {
  return variants[state.variant].octree.capsuleIntersect(capsule, true) || (ctxOctree && ctxOctree.capsuleIntersect(capsule, true));
}
const footProbe = new THREE.Sphere(new THREE.Vector3(), R * 0.85);
function onGround() {
  // A slimmer sphere just under the feet, so a wall the capsule leans on does not count.
  footProbe.center.copy(player.collider.start).y -= R * 0.15 + 0.04;
  for (const tree of [variants[state.variant].octree, ctxOctree]) {
    const hit = tree && tree.sphereIntersect(footProbe);
    if (hit && hit.normal.y > 0.35) return true;
  }
  return false;
}
function playerCollide() {
  for (const tree of [variants[state.variant].octree, ctxOctree]) {
    const hit = tree && tree.capsuleIntersect(player.collider);
    if (!hit || hit.depth < 1e-10) continue;
    if (hit.normal.y > 0.7) {
      // walkable ground: push straight up, so standing on a slope does not creep downhill
      player.collider.translate(new THREE.Vector3(0, hit.depth / hit.normal.y, 0));
    } else {
      if (hit.normal.y < 0.35) player.vel.addScaledVector(hit.normal, -hit.normal.dot(player.vel));
      player.collider.translate(hit.normal.multiplyScalar(hit.depth));
    }
  }
  player.onFloor = onGround();
  if (player.onFloor && player.vel.y < 0) player.vel.y = 0;
}

// Step up: lift the feet over a riser, keep the head where it is, then set
// the feet down again as low as they go.
const STEP = 0.30; // highest riser the player climbs; the model's stairs are 0.17 to 0.19 m, the street slab 0.25 m
function stepUp(before, d) {
  // A wall contact has already taken the speed away, so advance at least 8 mm
  // per substep (about 2.4 m/s) in the direction the player is pushing.
  const len = Math.hypot(d.x, d.z), adv = Math.max(len, 0.008) / len;
  const trial = before.clone();
  trial.translate(new THREE.Vector3(d.x * adv, 0, d.z * adv));
  trial.start.y += STEP;
  if (hitTest(trial)) return; // a wall, not a step
  let lo = 0, hi = STEP; // lo = drop known to be free
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
  if (hitTest(trial)) return; // no headroom on the step
  player.collider.copy(trial);
  player.vel.y = 0;
  player.onFloor = true;
  player.grounded = 0;
}

const fwd = new THREE.Vector3(), side = new THREE.Vector3(), wish = new THREE.Vector3();
function updatePlayer(dt) {
  const v = variants[state.variant];
  if (!v) return;
  const turn = 1.9 * dt;
  if (keys.has('ArrowLeft')) player.yaw += turn;
  if (keys.has('ArrowRight')) player.yaw -= turn;
  if (keys.has('ArrowUp')) player.pitch = Math.min(1.45, player.pitch + turn * 0.7);
  if (keys.has('ArrowDown')) player.pitch = Math.max(-1.45, player.pitch - turn * 0.7);
  fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  side.set(-fwd.z, 0, fwd.x);
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 60 : 28) * (player.onFloor ? 1 : 0.3);
  if (keys.has('KeyW')) player.vel.addScaledVector(fwd, speed * dt);
  if (keys.has('KeyS')) player.vel.addScaledVector(fwd, -speed * dt);
  if (keys.has('KeyA')) player.vel.addScaledVector(side, -speed * dt);
  if (keys.has('KeyD')) player.vel.addScaledVector(side, speed * dt);
  wish.set(0, 0, 0);
  if (keys.has('KeyW')) wish.add(fwd);
  if (keys.has('KeyS')) wish.sub(fwd);
  if (keys.has('KeyA')) wish.sub(side);
  if (keys.has('KeyD')) wish.add(side);
  if (wish.lengthSq() > 0) wish.normalize();
  if (player.onFloor && keys.has('Space')) player.vel.y = 5.2;

  const steps = 5, h = dt / steps;
  for (let i = 0; i < steps; i++) {
    let damp = Math.exp(-9 * h) - 1;
    if (!player.onFloor) { player.vel.y -= 22 * h; damp *= 0.1; }
    player.vel.x += player.vel.x * damp; player.vel.z += player.vel.z * damp;
    if (!player.onFloor) player.vel.y += player.vel.y * damp;
    const before = player.collider.clone();
    if (player.onFloor) player.grounded = 0; else player.grounded += h;
    const d = player.vel.clone().multiplyScalar(h);
    player.collider.translate(d);
    if (wish.lengthSq() > 0 && d.x * wish.x + d.z * wish.z < 1e-4) { d.x = wish.x * 1e-4; d.z = wish.z * 1e-4; }
    playerCollide();
    // Step up: a capsule alone stalls on 170-190 mm risers and open treads.
    const want = Math.hypot(d.x, d.z);
    if (want > 1e-5 && player.grounded < 0.25 && player.vel.y <= 0.5) {
      const got = ((player.collider.start.x - before.start.x) * d.x + (player.collider.start.z - before.start.z) * d.z) / want;
      if (got < 0.5 * want) stepUp(before, d);
    }
  }
  if (player.collider.end.y < -30 && player.lastSafe) teleport(...player.lastSafe);
  camera.position.copy(player.collider.end).y += EYE - TOP;
  camera.rotation.set(player.pitch, player.yaw, 0);
}

export function playerPos() { // Blender coordinates of the feet
  const s = player.collider.start;
  return [s.x, -s.z, s.y - R];
}

// ── Overview camera ──────────────────────────────────────────────────
const orbit = new OrbitControls(camera, canvas);
orbit.enabled = false;
orbit.target.copy(HOUSE_CENTRE);
orbit.maxPolarAngle = Math.PI * 0.495;
orbit.minDistance = 8; orbit.maxDistance = 900;
let orbitPose = { pos: b2t(-22, 34, 30), target: HOUSE_CENTRE.clone() };

function setMode(mode) {
  if (state.mode === 'orbit' && mode !== 'orbit') orbitPose = { pos: camera.position.clone(), target: orbit.target.clone() };
  state.mode = mode;
  orbit.enabled = mode === 'orbit';
  if (mode === 'orbit') { camera.position.copy(orbitPose.pos); orbit.target.copy(orbitPose.target); orbit.update(); }
  else camera.rotation.order = 'YXZ';
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  if (document.pointerLockElement && mode !== 'walk') document.exitPointerLock();
  applyRoofs();
}

function applyRoofs() {
  const v = variants[state.variant];
  if (!v) return;
  const show = state.roofs || state.mode === 'walk';
  for (const g of ['roof', 'ceiling']) if (v.groups[g]) v.groups[g].visible = show;
  $('#roofs').disabled = state.mode === 'walk';
}

async function setVariant(name) {
  $('#status').textContent = 'Loading…';
  const v = await loadVariant(name);
  for (const k in variants) variants[k].root.visible = k === name;
  state.variant = name;
  document.querySelectorAll('#variant button').forEach((b) => b.classList.toggle('on', b.dataset.variant === name));
  const sel = $('#goto');
  sel.innerHTML = '<option value="">Go to…</option>' + Object.keys(PLACES[name]).map((p) => `<option>${p}</option>`).join('');
  applyRoofs();
  // keep the player where they are if there is ground there, otherwise drop them a little
  player.collider.translate(new THREE.Vector3(0, 1.2, 0));
  player.vel.set(0, 0, 0);
  updateStatus();
  for (const f of listeners.variant) f(v);
  return v;
}

function updateStatus() {
  const v = variants[state.variant];
  if (!v) return;
  $('#status').textContent = state.variant === 'plan'
    ? `The plan: upper floor, bridge, sundowner deck, carport (model ${v.site.source})`
    : `Today: the house as it stands (model ${v.site.source})`;
}

// ── Sun and clock ────────────────────────────────────────────────────
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function applySun() {
  const s = sunPosition(localToUtcMs(state.day, state.hours));
  state.sun = s;
  const [mx, my, mz] = sunDirectionModel(s.az, s.el);
  const dir = b2t(mx, my, mz);
  sky.material.uniforms.sunPosition.value.copy(dir);
  sun.position.copy(HOUSE_CENTRE).addScaledVector(dir, 130);
  const day = smooth(-4, 8, s.el);
  const low = smooth(0, 25, s.el);
  sun.intensity = 3.4 * smooth(-1, 12, s.el);
  sun.color.setRGB(1, 0.62 + 0.36 * low, 0.36 + 0.58 * low);
  hemi.intensity = 0.1 + 0.95 * day;
  fill.intensity = 5 + 9 * day;
  moon.intensity = 0.35 * (1 - day);
  renderer.toneMappingExposure = 0.16 + 0.34 * day;
  sun.castShadow = s.el > 0.5;
  const hh = Math.floor(state.hours) % 24, mm = Math.floor((state.hours % 1) * 60);
  $('#clock').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  $('#sunread').textContent = s.el > 0 ? `sun ${s.el.toFixed(0)}° up, ${compass(s.az)} (${s.az.toFixed(0)}°)` : `sun ${(-s.el).toFixed(0)}° below the horizon`;
  $('#hour').value = state.hours;
  $('#day').value = state.day;
}
const compass = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];

function shiftDay(n) {
  const [y, m, d] = state.day.split('-').map(Number);
  state.day = new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** Move the game clock forward; the mini-games tick with it. */
function advance(dtHours) {
  if (!(dtHours > 0)) return;
  let left = dtHours;
  while (left > 0) { // tick in pieces of at most a quarter hour so rules see the time of day
    const step = Math.min(left, 0.25);
    state.hours += step;
    if (state.hours >= 24) { state.hours -= 24; shiftDay(1); }
    for (const f of listeners.tick) f(step, state);
    left -= step;
  }
  applySun();
}

// ── HUD ──────────────────────────────────────────────────────────────
function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  setTimeout(() => el.remove(), 6200);
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  for (const m of modules) {
    const b = document.createElement('button');
    b.innerHTML = m.title + (m.badge && m.badge() ? '<span class="dot"></span>' : '');
    b.classList.toggle('on', m === activeTab);
    b.onclick = () => { activeTab = m; renderTabs(); renderPanel(); };
    tabs.append(b);
  }
  $('#side').hidden = modules.length === 0;
}
// The panel is rebuilt twice a second. Not while a mouse button is down in it:
// a click whose press and release straddle a rebuild would be lost.
let panelPointerDown = false;
$('#side').addEventListener('pointerdown', () => { panelPointerDown = true; });
window.addEventListener('pointerup', () => { panelPointerDown = false; });
window.addEventListener('pointercancel', () => { panelPointerDown = false; });
function renderPanel() {
  if (activeTab && !panelPointerDown) activeTab.render($('#panel'));
}
function registerModule(m) {
  modules.push(m);
  if (!activeTab) activeTab = m;
  renderTabs(); renderPanel();
}

let currentHotspot = null;
function updatePrompt() {
  currentHotspot = null;
  if (state.mode === 'walk') {
    const [x, y, z] = playerPos();
    let best = Infinity;
    for (const h of hotspots) {
      if (h.when && !h.when()) continue;
      const d = Math.hypot(h.pos[0] - x, h.pos[1] - y, (h.pos[2] - z) * 0.5);
      if (d < h.radius && d < best) { best = d; currentHotspot = h; }
    }
  }
  const el = $('#prompt');
  el.hidden = !currentHotspot;
  if (currentHotspot) {
    const label = typeof currentHotspot.label === 'function' ? currentHotspot.label() : currentHotspot.label;
    const html = `<kbd>E</kbd>${label}`;
    if (el.innerHTML !== html) el.innerHTML = html;
  }
}

// ── Input ────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  if (e.code === 'Tab') { e.preventDefault(); setMode(state.mode === 'walk' ? 'orbit' : 'walk'); return; }
  if (e.code === 'KeyE' && currentHotspot) { currentHotspot.action(); renderPanel(); return; }
  if (e.code === 'KeyL' && state.mode === 'walk') { canvas.requestPointerLock?.(); return; }
  if (/^Arrow|Space/.test(e.code)) e.preventDefault();
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
let dragging = false;
canvas.addEventListener('pointerdown', (e) => { if (state.mode === 'walk' && e.button === 0) { dragging = true; canvas.setPointerCapture(e.pointerId); } });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointermove', (e) => {
  const locked = document.pointerLockElement === canvas;
  if (state.mode !== 'walk' || (!dragging && !locked)) return;
  const k = locked ? 0.0022 : -0.0045; // dragging pulls the view, a locked mouse turns it
  player.yaw -= e.movementX * k;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch - e.movementY * k));
});

$('#mode').addEventListener('click', (e) => e.target.dataset.mode && setMode(e.target.dataset.mode));
$('#variant').addEventListener('click', (e) => e.target.dataset.variant && setVariant(e.target.dataset.variant));
$('#roofs').addEventListener('change', (e) => { state.roofs = e.target.checked; applyRoofs(); });
$('#goto').addEventListener('change', (e) => { if (e.target.value) goPlace(e.target.value); e.target.value = ''; e.target.blur(); });
$('#day').addEventListener('change', (e) => { if (e.target.value) { state.day = e.target.value; applySun(); } });
$('#hour').addEventListener('input', (e) => {
  const h = Math.min(23.99, parseFloat(e.target.value));
  if (h > state.hours) advance(h - state.hours); else { state.hours = h; applySun(); }
});
$('#speed').addEventListener('click', (e) => {
  if (e.target.dataset.speed === undefined) return;
  state.speed = parseFloat(e.target.dataset.speed);
  document.querySelectorAll('#speed button').forEach((b) => b.classList.toggle('on', b === e.target));
});
$('#helpbtn').onclick = () => { $('#help').hidden = !$('#help').hidden; };
$('#helpclose').onclick = () => { $('#help').hidden = true; };

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ── Loop ─────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
let panelTimer = 0;
function runFrame(dt) {
  if (state.speed > 0) advance(state.speed * dt);
  if (state.mode === 'walk') updatePlayer(dt); else orbit.update();
  for (const f of listeners.frame) f(dt, state);
  updatePrompt();
  panelTimer += dt;
  if (panelTimer > 0.5) { panelTimer = 0; renderTabs(); if (activeTab?.live) renderPanel(); }
  renderer.render(scene, camera);
}
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  if (state.ready) runFrame(dt);
  requestAnimationFrame(frame);
}

/** A post with a floating label, at Blender coordinates. Returns the group (remove it from the scene to delete). */
function marker(pos, text, color = '#e0a458', height = 1.1) {
  const g = new THREE.Group();
  g.position.copy(b2t(pos[0], pos[1], pos[2]));
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, height, 8), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 }));
  post.position.y = height / 2;
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  ctx.font = '600 28px Segoe UI, sans-serif';
  cv.width = Math.ceil(ctx.measureText(text).width) + 28; cv.height = 44;
  ctx.font = '600 28px Segoe UI, sans-serif';
  ctx.fillStyle = 'rgba(28,22,18,.85)'; ctx.beginPath(); ctx.roundRect(0, 0, cv.width, cv.height, 10); ctx.fill();
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, 14, 23);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, toneMapped: false }));
  sp.scale.set(cv.width / 44 * 0.15, 0.15, 1);
  sp.position.y = height + 0.16;
  sp.renderOrder = 10;
  g.add(post, sp);
  scene.add(g);
  return g;
}

// What the mini-games get to work with.
export const world = {
  THREE, scene, camera, state, variants, hotspots, b2t, t2b, playerPos, waterMaterial,
  site: () => variants[state.variant]?.site,
  variant: () => variants[state.variant],
  on: (ev, f) => listeners[ev].push(f),
  advance, toast, registerModule, renderPanel, renderTabs, teleport, goPlace, setMode, setVariant, marker,
  /** Overview camera from a Blender position, looking at a Blender target. */
  lookFrom(pos, target) {
    orbitPose = { pos: b2t(...pos), target: b2t(...target) };
    if (state.mode === 'orbit') { camera.position.copy(orbitPose.pos); orbit.target.copy(orbitPose.target); orbit.update(); } else setMode('orbit');
  },
  activeTabId: () => activeTab?.id,
  showTab(id) { const m = modules.find((x) => x.id === id); if (m) { activeTab = m; renderTabs(); renderPanel(); } },
};

async function start() {
  resize();
  applySun();
  try {
    await setVariant('plan');
  } catch (err) {
    $('#loadmsg').innerHTML = 'Could not load <code>assets/plan.glb</code>. Export the model first (see README.md).<br><small>' + err.message + '</small>';
    throw err;
  }
  // Surroundings: 20 km of real terrain with aerial photos, the houses around,
  // the street and the two neighbours. Shared by both variants.
  $('#loadmsg').textContent = 'Loading the street and the mountains…';
  try {
    const g = await loadGlb('assets/context.glb');
    context = g.root;
    scene.add(context);
    ctxOctree = new Collider(context, (o) => o.userData.group === 'geo_terrain' || o.userData.group === 'context_near', 160);
  } catch (err) {
    toast('Surroundings (context.glb) not found: the street and the far hills are missing.', 'bad');
  }
  goPlace('Street');
  state.ready = true;
  $('#loading').hidden = true;
  frame();
  const games = await Promise.allSettled([import('./pool.js'), import('./network.js'), import('./build.js')]);
  for (const g of games) if (g.status === 'fulfilled') g.value.default(world);
}

// Debug hook: drive the game from the console or a test.
window.game = {
  world, state, player,
  teleport, goPlace, setMode, setVariant, advance,
  setTime(h, day) { if (day) state.day = day; state.hours = h; applySun(); },
  look(headingDeg, pitchDeg = 0) { player.yaw = -headingDeg * Math.PI / 180; player.pitch = pitchDeg * Math.PI / 180; },
  pos: playerPos,
  sunAt(day, h) { return sunPosition(localToUtcMs(day, h)); },
  walk(seconds, code = 'KeyW') { keys.add(code); return new Promise((r) => setTimeout(() => { keys.delete(code); r(playerPos()); }, seconds * 1000)); },
  // run the walk physics for a number of seconds without waiting for frames (tests)
  step(seconds, codes = ['KeyW']) {
    codes.forEach((c) => keys.add(c));
    for (let t = 0; t < seconds; t += 1 / 60) updatePlayer(1 / 60);
    codes.forEach((c) => keys.delete(c));
    return playerPos().map((n) => +n.toFixed(2));
  },
  // one full frame by hand (the browser does not run frames in a hidden tab)
  frame(dt = 1 / 60) { runFrame(dt); renderPanel(); },
  shot() { runFrame(0.001); renderPanel(); },
  // render the 3D view at a given size and return it as a JPEG data URL (for screenshots)
  capture(w = 1600, h = 900) {
    renderer.setPixelRatio(1); renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    runFrame(0.001);
    const url = canvas.toDataURL('image/jpeg', 0.86);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); resize();
    return url;
  },
  info: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles }),
};

start();
