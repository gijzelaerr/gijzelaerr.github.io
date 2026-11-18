// Chamais death match: run through the house, grab weapons, frag each other.
// Loaded by walk.js when you pick "Death match" on the start screen. walk.js keeps
// the house, the collision and the camera; this module takes over the input and
// the movement (Quake-style, walk.js moveQuake) and adds weapons, pickups, other
// players, sound (all synthesised with WebAudio, no sound files) and the HUD.
//
// The server (server/dm_server.py) owns health, armour, frags, pickups and
// respawns. This client moves itself and decides what it hits, so shooting feels
// instant even at 180 ms; the server checks every claim against the weapon's
// fire rate, damage and range.

const WEAPONS = { // must match WEAPONS in server/dm_server.py
  ticker:  { name: 'Ticker',  key: 'Digit1', interval: 0.09, dmg: 8,   pellets: 1,  spread: 0.014, range: 120, ammo: [100, 200], color: 0xffe08a, kind: 'hitscan' },
  scatter: { name: 'Scatter', key: 'Digit2', interval: 0.85, dmg: 6,   pellets: 11, spread: 0.075, range: 60,  ammo: [16, 40],   color: 0xffb36b, kind: 'hitscan' },
  boomer:  { name: 'Boomer',  key: 'Digit3', interval: 0.75, dmg: 110, pellets: 1,  speed: 26, splash: 3.2,  ammo: [8, 25],    color: 0xff6a3d, kind: 'rocket' },
  lancer:  { name: 'Lancer',  key: 'Digit4', interval: 1.35, dmg: 95,  pellets: 1,  spread: 0, range: 220,   ammo: [8, 20],    color: 0x6be4ff, kind: 'beam' },
};
const ORDER = ['ticker', 'scatter', 'boomer', 'lancer'];
const PICKUP_LOOK = {
  scatter: { color: 0xffb36b, label: 'Scatter' }, boomer: { color: 0xff6a3d, label: 'Boomer' }, lancer: { color: 0x6be4ff, label: 'Lancer' },
  health: { color: 0x5dff7a, label: '+25' }, mega: { color: 0x3dd6ff, label: 'Mega' }, armor: { color: 0xffd23d, label: 'Armour' },
};
const INTERP = 0.1; // other players are drawn 100 ms in the past, between two updates
const PLAYER_R = 0.32, PLAYER_H = 1.75; // hit capsule (a bit fatter than the collision one: more fun)

/** Where the game server is: ?dm=<ws url>; this PC when served locally; the home arena at home; online the public one. */
function serverUrl() {
  const p = new URLSearchParams(location.search).get('dm');
  if (p && /^wss?:\/\/[\w.:-]+\/dm\/ws$/.test(p)) return p;
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return 'ws://127.0.0.1:8140/dm/ws';
  if (location.hostname === 'home.invalid') return `wss://${location.host}/dm/ws`; // the home arena (infra: chamais-dm)
  return DM_PUBLIC_URL;
}
const DM_PUBLIC_URL = 'wss://84-32-151-62.sslip.io/dm/ws'; // omalaka (Cherry Servers, Lithuania); see walk/README.md

export async function initDM(W) {
  const { THREE, scene, camera, b2t, t2b, keys } = W;
  const $ = (s) => document.querySelector(s);
  const map = await (await fetch('assets/dm-map.json')).json();

  // ── State ──────────────────────────────────────────────────────────
  const me = { id: null, name: '', alive: false, hp: 100, ar: 0, weapon: 'ticker', last: 'ticker', owned: new Set(['ticker']),
    ammo: { ticker: 100, scatter: 0, boomer: 0, lancer: 0 }, nextShot: 0, shotN: 0, frags: 0, deaths: 0, firing: false,
    jumpHeld: false, deadAt: 0, killer: null, lastSafe: null, recoil: 0, bob: 0, stepDist: 0 };
  const others = new Map(); // id -> { name, color, alive, frags, deaths, buf: [], group, label, hp }
  const pickups = new Map(); // id -> { type, at (three), mesh, up, sentAt }
  let ws = null, matchInfo = { state: 'on', left: 600, fraglimit: 25 }, matchClock = 0;
  const effects = []; // { obj, until, update(dt, k) }
  const rockets = []; // { pos, dir, owner, n, mesh, trailT }
  me.name = new URLSearchParams(location.search).get('name') || '';
  try { me.name = me.name || localStorage.getItem('chamais-name') || ''; } catch { /* */ }

  // ── HUD ────────────────────────────────────────────────────────────
  const hud = document.createElement('div');
  hud.id = 'dm';
  hud.innerHTML = `
    <style>
      #dm { position: fixed; inset: 0; pointer-events: none; font: 600 16px/1.2 "Segoe UI", system-ui, sans-serif; color: #fff; text-shadow: 0 1px 3px #000, 0 0 2px #000; user-select: none; }
      #dm .cross { position: absolute; left: 50%; top: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px; }
      #dm .cross::before, #dm .cross::after { content: ''; position: absolute; background: #fff; box-shadow: 0 0 2px #000; }
      #dm .cross::before { left: 10px; top: 2px; width: 2px; height: 18px; } #dm .cross::after { top: 10px; left: 2px; height: 2px; width: 18px; }
      #dm .cross.hit::before, #dm .cross.hit::after { background: #ff3d3d; }
      #dm .stats { position: absolute; left: 22px; bottom: 18px; display: flex; gap: 22px; align-items: flex-end; }
      #dm .stat b { display: block; font-size: 46px; line-height: 1; } #dm .stat small { font-size: 12px; opacity: .8; letter-spacing: .08em; }
      #dm .hp b { color: #fff; } #dm .hp.low b { color: #ff4a3d; } #dm .ar b { color: #ffd23d; }
      #dm .gun { position: absolute; right: 22px; bottom: 18px; text-align: right; }
      #dm .gun b { font-size: 46px; line-height: 1; display: block; } #dm .gun small { font-size: 14px; opacity: .9; }
      #dm .slots { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; }
      #dm .slots span { font-size: 12px; padding: 2px 7px; border-radius: 4px; background: rgba(0,0,0,.45); opacity: .35; }
      #dm .slots span.own { opacity: .85; } #dm .slots span.on { background: #ff6a3d; opacity: 1; }
      #dm .feed { position: absolute; right: 18px; top: 14px; display: grid; gap: 4px; justify-items: end; font-size: 15px; }
      #dm .feed div { background: rgba(0,0,0,.45); padding: 3px 9px; border-radius: 4px; }
      #dm .top { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); text-align: center; font-size: 15px; background: rgba(0,0,0,.35); padding: 4px 12px; border-radius: 6px; }
      #dm .center { position: absolute; left: 50%; top: 32%; transform: translateX(-50%); text-align: center; font-size: 30px; font-weight: 800; letter-spacing: .03em; }
      #dm .center small { display: block; font-size: 16px; font-weight: 600; opacity: .9; margin-top: 6px; }
      #dm .vignette { position: absolute; inset: 0; box-shadow: inset 0 0 160px 40px rgba(255,0,0,.75); opacity: 0; transition: opacity .25s; }
      #dm .board { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); background: rgba(14,10,8,.86); border: 1px solid #6b5640; border-radius: 12px; padding: 16px 22px; min-width: min(420px, 90vw); display: none; }
      #dm .board.show { display: block; } #dm .board h2 { margin: 0 0 10px; font-size: 22px; text-align: center; }
      #dm .board table { width: 100%; border-collapse: collapse; font-size: 16px; } #dm .board td { padding: 4px 8px; } #dm .board td.n { text-align: right; }
      #dm .board tr.me td { color: #ffd23d; }
      #dm .play { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.35); pointer-events: auto; cursor: pointer; }
      #dm .play div { background: rgba(14,10,8,.9); border: 2px solid #ff6a3d; border-radius: 12px; padding: 18px 26px; text-align: center; font-size: 20px; }
      #dm .play small { display: block; font-size: 14px; font-weight: 500; opacity: .85; margin-top: 8px; line-height: 1.5; }
      #dm .play[hidden] { display: none; }
      #dm .touchbtn { position: absolute; pointer-events: auto; touch-action: none; border-radius: 50%; border: 2px solid rgba(255,255,255,.5); background: rgba(255,106,61,.35); display: grid; place-items: center; font-size: 13px; }
      #dm .touchbtn:active, #dm .touchbtn.on { background: rgba(255,106,61,.75); }
      #dm .fire { right: calc(40px + env(safe-area-inset-right)); bottom: calc(197px + env(safe-area-inset-bottom)); width: 92px; height: 92px; font-size: 16px; }
      #dm .jump { right: calc(150px + env(safe-area-inset-right)); bottom: calc(182px + env(safe-area-inset-bottom)); width: 64px; height: 64px; background: rgba(61,214,255,.3); }
      #dm .swap { right: calc(170px + env(safe-area-inset-right)); bottom: calc(262px + env(safe-area-inset-bottom)); width: 56px; height: 56px; background: rgba(255,255,255,.18); }
      body.touch #dm .stats { bottom: calc(182px + env(safe-area-inset-bottom)); } body.touch #dm .gun { bottom: auto; top: 60px; }
      body.touch #dm .stat b, body.touch #dm .gun b { font-size: 32px; }
    </style>
    <div class="vignette"></div>
    <div class="cross"></div>
    <div class="top"></div>
    <div class="feed"></div>
    <div class="center"></div>
    <div class="stats"><div class="stat hp"><b>100</b><small>HEALTH</small></div><div class="stat ar"><b>0</b><small>ARMOUR</small></div></div>
    <div class="gun"><b>100</b><small>TICKER</small><div class="slots"></div></div>
    <div class="board"></div>
    <div class="play"><div>Click to play<small>W A S D move · mouse aims · click shoots · Space jumps (hold it to bunny-hop)<br>1–4 or the wheel switch weapons · Tab shows the scores · Esc lets go of the mouse</small></div></div>`;
  document.body.append(hud);
  const H = (s) => hud.querySelector(s);
  H('.slots').innerHTML = ORDER.map((w, i) => `<span data-w="${w}">${i + 1} ${WEAPONS[w].name}</span>`).join('');
  if (W.TOUCH) {
    H('.play').hidden = true;
    for (const [cls, label] of [['fire', 'FIRE'], ['jump', 'JUMP'], ['swap', 'GUN']]) {
      const b = document.createElement('div');
      b.className = `touchbtn ${cls}`; b.textContent = label;
      hud.append(b);
    }
    const hold = (el, on, off) => {
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.classList.add('on'); on(); audioOn(); });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, () => { el.classList.remove('on'); off?.(); });
    };
    hold(H('.fire'), () => { me.firing = true; }, () => { me.firing = false; });
    hold(H('.jump'), () => { me.jumpHeld = true; }, () => { me.jumpHeld = false; });
    hold(H('.swap'), () => cycle(1));
  }

  let centerUntil = 0;
  function center(text, sub = '', ms = 1600, color = '#fff') {
    H('.center').innerHTML = `<span style="color:${color}">${text}</span>${sub ? `<small>${sub}</small>` : ''}`;
    centerUntil = performance.now() + ms;
  }
  function feed(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    H('.feed').prepend(d);
    while (H('.feed').children.length > 5) H('.feed').lastChild.remove();
    setTimeout(() => d.remove(), 6000);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tag = (id) => { const p = id === me.id ? { name: me.name, color: '#ffd23d' } : others.get(id); return p ? `<span style="color:${p.color}">${esc(p.name)}</span>` : '?'; };
  function drawHud() {
    const hp = H('.hp');
    hp.firstChild.textContent = Math.max(0, me.hp);
    hp.classList.toggle('low', me.hp <= 30);
    H('.ar b').textContent = me.ar;
    const w = WEAPONS[me.weapon];
    H('.gun b').textContent = me.ammo[me.weapon];
    H('.gun small').textContent = w.name.toUpperCase();
    hud.querySelectorAll('.slots span').forEach((s) => { s.classList.toggle('own', me.owned.has(s.dataset.w)); s.classList.toggle('on', s.dataset.w === me.weapon); });
  }
  function scoreRows() {
    const rows = [{ id: me.id, name: me.name, frags: me.frags, deaths: me.deaths }, ...[...others].map(([id, p]) => ({ id, name: p.name, frags: p.frags, deaths: p.deaths }))];
    return rows.sort((a, b) => b.frags - a.frags || a.deaths - b.deaths);
  }
  function showBoard(title, show) {
    const b = H('.board');
    if (!show) { b.classList.remove('show'); return; }
    b.innerHTML = `<h2>${title}</h2><table>${scoreRows().map((r, i) => `<tr class="${r.id === me.id ? 'me' : ''}"><td>${i + 1}</td><td>${tag(r.id)}</td><td class="n">${r.frags}</td><td class="n" style="opacity:.6">${r.deaths}</td></tr>`).join('')}</table>`;
    b.classList.add('show');
  }
  function drawTop() {
    const left = Math.max(0, matchInfo.left - (performance.now() - matchClock) / 1000);
    const lead = scoreRows()[0];
    const t = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    H('.top').innerHTML = matchInfo.state === 'on'
      ? `${t} · ${me.frags} frag${me.frags === 1 ? '' : 's'} · first to ${matchInfo.fraglimit}${lead && lead.frags > 0 ? ` · lead: ${tag(lead.id)} ${lead.frags}` : ''}`
      : 'Next match soon';
  }

  // ── Sound: everything synthesised ──────────────────────────────────
  let ac = null, master = null, noiseBuf = null;
  function audioOn() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      master = ac.createDynamicsCompressor();
      master.connect(ac.destination);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch { ac = null; }
  }
  window.addEventListener('pointerdown', audioOn);
  window.addEventListener('keydown', audioOn);
  const _lp = new THREE.Vector3(), _lf = new THREE.Vector3();
  /** A sound at a world position (three), or at the listener when pos is null. */
  function out(pos, vol = 1) {
    if (!ac) return null;
    const g = ac.createGain();
    g.gain.value = vol;
    if (pos) {
      const p = ac.createPanner();
      p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 2.5; p.rolloffFactor = 1.1;
      if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
      g.connect(p); p.connect(master);
    } else g.connect(master);
    return g;
  }
  function noise(dest, t0, dur, type, f0, f1, q = 1, vol = 1) {
    const s = ac.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const f = ac.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ac.createGain(); g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(t0, Math.random() * 0.5); s.stop(t0 + dur + 0.05);
  }
  function tone(dest, t0, dur, type, f0, f1, vol = 0.5) {
    const o = ac.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ac.createGain(); g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(dest); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  const SFX = {
    ticker: (d, t) => { noise(d, t, 0.06, 'highpass', 3000, 900, 0.7, 0.55); tone(d, t, 0.04, 'square', 900, 300, 0.12); },
    scatter: (d, t) => { noise(d, t, 0.32, 'lowpass', 5000, 200, 0.8, 1); tone(d, t, 0.18, 'sine', 160, 50, 0.6); },
    boomer: (d, t) => { noise(d, t, 0.35, 'bandpass', 600, 2400, 2, 0.6); tone(d, t, 0.12, 'sawtooth', 220, 90, 0.25); },
    lancer: (d, t) => { tone(d, t, 0.45, 'sawtooth', 2600, 180, 0.28); tone(d, t, 0.25, 'sine', 5200, 900, 0.18); noise(d, t, 0.4, 'highpass', 6000, 2000, 1, 0.25); },
    boom: (d, t) => { noise(d, t, 0.9, 'lowpass', 2200, 60, 0.7, 1.2); tone(d, t, 0.6, 'sine', 120, 30, 0.9); },
    hit: (d, t) => { tone(d, t, 0.05, 'square', 1500, 1300, 0.18); },
    hurt: (d, t) => { tone(d, t, 0.2, 'triangle', 220, 90, 0.5); noise(d, t, 0.12, 'lowpass', 900, 200, 1, 0.4); },
    die: (d, t) => { tone(d, t, 0.7, 'sawtooth', 300, 40, 0.35); noise(d, t, 0.5, 'lowpass', 1500, 80, 1, 0.5); },
    frag: (d, t) => { [660, 880, 1320].forEach((f, i) => tone(d, t + i * 0.07, 0.16, 'square', f, f, 0.16)); },
    pick: (d, t) => { [523, 784].forEach((f, i) => tone(d, t + i * 0.06, 0.12, 'triangle', f, f * 1.01, 0.3)); },
    gun: (d, t) => { noise(d, t, 0.08, 'highpass', 4000, 1500, 1, 0.5); [392, 587, 784].forEach((f, i) => tone(d, t + 0.05 + i * 0.05, 0.14, 'square', f, f, 0.14)); },
    jump: (d, t) => { noise(d, t, 0.12, 'bandpass', 500, 900, 1.5, 0.25); },
    land: (d, t) => { noise(d, t, 0.14, 'lowpass', 500, 80, 1, 0.5); },
    step: (d, t) => { noise(d, t, 0.06, 'lowpass', 900 + Math.random() * 300, 200, 1, 0.18); },
    spawn: (d, t) => { tone(d, t, 0.5, 'sine', 300, 1200, 0.3); noise(d, t, 0.5, 'highpass', 2000, 8000, 1, 0.15); },
    empty: (d, t) => { tone(d, t, 0.04, 'square', 200, 180, 0.15); },
  };
  function sfx(name, pos = null, vol = 1) {
    const d = out(pos, vol);
    if (d) SFX[name](d, ac.currentTime + 0.005);
  }
  let lastSay = 0;
  function say(text) { // the announcer: the browser's own speech voice
    if (!window.speechSynthesis || performance.now() - lastSay < 1200) return;
    lastSay = performance.now();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95; u.pitch = 0.6; u.volume = 0.9;
    speechSynthesis.speak(u);
  }

  // ── Visuals: other players, the gun in your hand, effects ──────────
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,255,255,.5)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const bodyGeo = new THREE.CapsuleGeometry(0.27, 0.95, 4, 10);
  const headGeo = new THREE.SphereGeometry(0.2, 14, 10);
  const visorGeo = new THREE.BoxGeometry(0.3, 0.08, 0.12);
  const gunGeo = new THREE.BoxGeometry(0.08, 0.08, 0.5);
  function label(text, color) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g = c.getContext('2d'); g.font = 'bold 34px Segoe UI, sans-serif'; g.textAlign = 'center';
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText(text, 128, 44); g.fillStyle = color; g.fillText(text, 128, 44);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
    s.scale.set(1.2, 0.3, 1); s.renderOrder = 40;
    return s;
  }
  function makeAvatar(p) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.5, metalness: 0.1, emissive: new THREE.Color(p.color), emissiveIntensity: 0.25 });
    const body = new THREE.Mesh(bodyGeo, mat); body.position.y = 0.75;
    const head = new THREE.Mesh(headGeo, mat); head.position.y = 1.55;
    const visor = new THREE.Mesh(visorGeo, new THREE.MeshBasicMaterial({ color: 0x111111 })); visor.position.set(0, 1.57, -0.15);
    const aim = new THREE.Group(); aim.position.y = 1.3;
    const gun = new THREE.Mesh(gunGeo, new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.6, roughness: 0.4 })); gun.position.set(0.22, -0.05, -0.3);
    aim.add(gun);
    const tagSprite = label(p.name, p.color); tagSprite.position.y = 2.1;
    g.add(body, head, visor, aim, tagSprite);
    g.userData = { aim, head, visor };
    g.visible = false;
    scene.add(g);
    return g;
  }
  // the gun in your hand
  const view = new THREE.Group();
  const viewGuns = {};
  for (const w of ORDER) {
    const c = WEAPONS[w].color;
    const grp = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2b30, metalness: 0.7, roughness: 0.35 });
    const glow = new THREE.MeshBasicMaterial({ color: c });
    const len = { ticker: 0.42, scatter: 0.5, boomer: 0.62, lancer: 0.7 }[w];
    const thick = { ticker: 0.06, scatter: 0.09, boomer: 0.13, lancer: 0.07 }[w];
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(thick, thick, len), metal); barrel.position.z = -len / 2;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(thick * 1.05, thick * 0.3, len * 0.6), glow); stripe.position.set(0, thick * 0.5, -len * 0.45);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.07), metal); grip.position.set(0, -0.09, -0.02);
    grp.add(barrel, stripe, grip);
    grp.userData.muzzle = new THREE.Vector3(0, 0, -len);
    grp.visible = false;
    view.add(grp);
    viewGuns[w] = grp;
  }
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffd28a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  flash.scale.set(0.22, 0.22, 1); flash.visible = false; view.add(flash);
  view.scale.setScalar(0.42);
  view.traverse((o) => { o.renderOrder = 50; if (o.material) { o.material.depthTest = false; o.material.depthWrite = false; } });
  camera.add(view);

  // one pooled light for explosions and muzzle flashes (adding lights later would recompile every shader)
  const boomLight = new THREE.PointLight(0xffa050, 0, 9, 1.6);
  scene.add(boomLight);
  let boomLightUntil = 0;

  const add = (obj, ms, update) => { scene.add(obj); effects.push({ obj, born: performance.now(), until: performance.now() + ms, update }); };
  function tracer(a, b, color, width = 1, ms = 90) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    add(new THREE.Line(geo, mat), ms, (o, k) => { o.material.opacity = 0.9 * (1 - k); });
  }
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).rotateX(Math.PI / 2);
  function beam(a, b, color) {
    const len = a.distanceTo(b);
    const mid = a.clone().lerp(b, 0.5);
    for (const [r, op] of [[0.025, 1], [0.09, 0.35]]) {
      const m = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.position.copy(mid); m.scale.set(r, r, len); m.lookAt(b);
      add(m, 600, (o, k) => { o.material.opacity = op * (1 - k); o.scale.x = o.scale.y = r * (1 + k * 2); });
    }
  }
  const sparkGeo = new THREE.SphereGeometry(1, 6, 4);
  function burst(at, color, n = 8, speed = 4, size = 0.05, ms = 400) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color, transparent: true }));
      m.position.copy(at); m.scale.setScalar(size);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random()));
      let last = performance.now();
      add(m, ms * (0.6 + Math.random() * 0.6), (o, k) => {
        const now = performance.now(), dt = (now - last) / 1000; last = now;
        v.y -= 9 * dt; o.position.addScaledVector(v, dt); o.material.opacity = 1 - k;
      });
    }
  }
  function explosion(at) {
    const m = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.copy(at);
    add(m, 450, (o, k) => { o.scale.setScalar(0.3 + k * 3.2); o.material.opacity = 0.9 * (1 - k); o.material.color.setHSL(0.08 - k * 0.07, 1, 0.6 - k * 0.3); });
    burst(at, 0xffc070, 14, 7, 0.07, 500);
    burst(at, 0x555555, 8, 2, 0.16, 900);
    boomLight.position.copy(at); boomLight.intensity = 40; boomLightUntil = performance.now() + 180;
    sfx('boom', at, 1.3);
    const d = camera.getWorldPosition(new THREE.Vector3()).distanceTo(at);
    if (d < 12) shake = Math.max(shake, 0.35 * (1 - d / 12));
  }

  // ── Pickups ────────────────────────────────────────────────────────
  const pickGeo = { weapon: new THREE.BoxGeometry(0.55, 0.14, 0.14), health: new THREE.BoxGeometry(0.34, 0.34, 0.34),
    mega: new THREE.IcosahedronGeometry(0.3, 1), armor: new THREE.CylinderGeometry(0.28, 0.2, 0.36, 6) };
  for (const p of map.pickups) {
    const look = PICKUP_LOOK[p.type];
    const geo = WEAPONS[p.type] ? pickGeo.weapon : pickGeo[p.type];
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: look.color, emissive: new THREE.Color(look.color), emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.3 }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: look.color, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.set(1.1, 1.1, 1);
    const g = new THREE.Group(); g.add(mesh, glow);
    const at = b2t(...p.at); g.position.copy(at).add(new THREE.Vector3(0, 0.75, 0));
    scene.add(g);
    pickups.set(p.id, { ...p, group: g, mesh, base: g.position.y, up: true, sentAt: 0 });
  }
  function setPickup(id, up) { const p = pickups.get(id); if (p) { p.up = up; p.group.visible = up; } }

  // ── Network ────────────────────────────────────────────────────────
  let connected = false;
  // ?lag=<ms>: pretend the server is far away (each way), to try how it plays from abroad
  const LAG = Math.min(500, Math.max(0, +new URLSearchParams(location.search).get('lag') || 0));
  const sendNow = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const send = LAG ? (m) => setTimeout(() => sendNow(m), LAG) : sendNow;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  function connect() {
    ws = new WebSocket(serverUrl());
    ws.onopen = () => { connected = true; sendNow({ t: 'hello', name: me.name || '' }); };
    ws.onclose = () => {
      connected = false;
      center('Lost the server', 'trying again…', 3000, '#ff6a3d');
      for (const p of others.values()) scene.remove(p.group);
      others.clear();
      setTimeout(connect, 2500);
    };
    ws.onmessage = (e) => { const run = () => { try { onMsg(JSON.parse(e.data)); } catch (err) { console.warn('dm message', err); } }; if (LAG) setTimeout(run, LAG); else run(); };
  }
  function addOther(p) {
    if (p.id === me.id || others.has(p.id)) return;
    others.set(p.id, { name: p.name, color: p.color, alive: p.alive, frags: p.frags || 0, deaths: p.deaths || 0, buf: [], group: makeAvatar(p), hp: p.hp });
  }
  function onMsg(m) {
    const now = performance.now() / 1000;
    switch (m.t) {
      case 'welcome':
        me.id = m.id;
        for (const p of m.players) { if (p.id === m.id) me.name = p.name; else addOther(p); }
        for (const [id, back] of Object.entries(m.pickups)) setPickup(id, back <= 0);
        matchInfo = m.match; matchClock = performance.now();
        center('Death match', `${others.size ? `${others.size} other${others.size > 1 ? 's' : ''} in the arena` : 'You are the first one here'}`, 2500);
        break;
      case 'join': addOther(m.player); feed(`${tag(m.player.id)} joined`); break;
      case 'leave': { const p = others.get(m.id); if (p) { feed(`${tag(m.id)} left`); scene.remove(p.group); others.delete(m.id); } break; }
      case 's': {
        const p = others.get(m.id);
        if (!p) break;
        p.buf.push({ t: now, p: b2t(...m.p), y: m.y, a: m.a, w: m.w, v: m.v });
        if (p.buf.length > 30) p.buf.shift();
        break;
      }
      case 'fire': remoteFire(m); break;
      case 'spawn':
        if (m.id === me.id) {
          me.alive = true; me.hp = 100; me.ar = 0; me.owned = new Set(['ticker']); me.ammo = { ticker: 100, scatter: 0, boomer: 0, lancer: 0 };
          me.weapon = 'ticker'; me.killer = null;
          W.teleport(m.at[0], m.at[1], m.at[2], m.at[3] ?? 0);
          W.player.vel.set(0, 0, 0);
          me.lastSafe = m.at;
          sfx('spawn');
          H('.vignette').style.opacity = 0;
          if (matchInfo.state === 'on' && me.deaths === 0 && me.frags === 0) say('Fight');
          drawHud();
        } else {
          const p = others.get(m.id);
          if (p) { p.alive = true; p.hp = 100; p.buf = [{ t: now, p: b2t(...m.at), y: 0, a: 0, w: 'ticker' }]; p.group.visible = true; }
          sfx('spawn', b2t(...m.at), 0.6);
        }
        break;
      case 'hurt':
        if (m.id === me.id) {
          me.hp = m.hp; me.ar = m.ar;
          if (m.by !== me.id || m.dmg > 0) {
            sfx('hurt', null, 0.8);
            H('.vignette').style.opacity = Math.min(0.9, 0.25 + m.dmg / 80);
            setTimeout(() => { if (me.alive) H('.vignette').style.opacity = me.hp < 30 ? 0.3 : 0; }, 260);
            shake = Math.max(shake, Math.min(0.25, m.dmg / 300));
          }
          drawHud();
        } else {
          const p = others.get(m.id);
          if (p) { p.hp = m.hp; const at = renderPos(p); if (at) burst(at.clone().add(new THREE.Vector3(0, 1.1, 0)), 0xb3001b, Math.min(14, 3 + m.dmg / 8), 3, 0.05, 500); }
          if (m.by === me.id) { sfx('hit', null, 0.7); hitMark = performance.now() + 140; }
        }
        break;
      case 'frag': onFrag(m); break;
      case 'pick': {
        setPickup(m.id, false);
        const pk = pickups.get(m.id);
        if (m.by === me.id) {
          me.hp = m.hp; me.ar = m.ar;
          if (m.w) gainWeapon(m.w); else sfx('pick');
          if (pk) feed(`<span style="color:#${PICKUP_LOOK[pk.type].color.toString(16).padStart(6, '0')}">${PICKUP_LOOK[pk.type].label}</span>`);
          drawHud();
        } else if (pk) sfx(m.w ? 'gun' : 'pick', pk.group.position, 0.5);
        break;
      }
      case 'back': setPickup(m.id, true); { const pk = pickups.get(m.id); if (pk) sfx('spawn', pk.group.position, 0.25); } break;
      case 'hp': if (m.id === me.id) { me.hp = m.hp; me.ar = m.ar; drawHud(); } break;
      case 'match':
        matchInfo = m.match; matchClock = performance.now();
        if (m.pickups) for (const [id, back] of Object.entries(m.pickups)) setPickup(id, back <= 0);
        if (m.match.state === 'on' && H('.board').classList.contains('show') && !boardHeld) { showBoard('', false); }
        break;
      case 'end': {
        matchInfo = { ...matchInfo, state: 'break', left: m.next }; matchClock = performance.now();
        for (const s of m.scores) { if (s.id === me.id) { me.frags = s.frags; me.deaths = s.deaths; } else { const p = others.get(s.id); if (p) { p.frags = s.frags; p.deaths = s.deaths; } } }
        const win = m.scores[0];
        showBoard(win ? `${win.id === me.id ? 'You win!' : `${esc(win.name)} wins`}` : 'Match over', true);
        say(win && win.id === me.id ? 'You win' : 'Match over');
        me.frags = 0; me.deaths = 0;
        for (const p of others.values()) { p.frags = 0; p.deaths = 0; }
        break;
      }
    }
  }
  let multi = { n: 0, t: 0 };
  function onFrag(m) {
    const killer = m.killer, victim = m.victim, w = m.w;
    for (const [id, f] of Object.entries(m.frags || {})) { if (id === me.id) me.frags = f; else if (others.has(id)) others.get(id).frags = f; }
    const wn = WEAPONS[w]?.name || (w === 'fall' ? 'the drop' : w);
    if (killer === victim) feed(`${tag(victim)} <span style="opacity:.7">blew themselves up</span>`);
    else feed(`${tag(killer)} <span style="opacity:.7">[${esc(wn)}]</span> ${tag(victim)}`);
    if (victim === me.id) {
      me.alive = false; me.deaths++; me.deadAt = performance.now(); me.killer = killer; me.firing = false;
      sfx('die');
      center(killer === me.id ? 'Oops' : `Fragged by ${esc(others.get(killer)?.name || '?')}`, 'back in a moment…', 2400, '#ff6a3d');
      H('.vignette').style.opacity = 0.6;
      burst(camera.getWorldPosition(new THREE.Vector3()), 0xb3001b, 20, 5, 0.07, 900);
    } else {
      const p = others.get(victim);
      if (p) { p.alive = false; p.deaths++; const at = renderPos(p); if (at) { burst(at.clone().add(new THREE.Vector3(0, 1, 0)), 0xb3001b, 24, 6, 0.08, 1000); sfx('die', at, 0.8); } p.group.visible = false; }
      if (killer === me.id) {
        sfx('frag');
        const t = performance.now();
        multi = t - multi.t < 3000 ? { n: multi.n + 1, t } : { n: 1, t };
        const words = ['', '', 'Double frag!', 'Triple frag!', 'Rampage!'];
        center(`You fragged ${esc(p?.name || '?')}`, multi.n > 1 ? words[Math.min(multi.n, 4)] : '', 1600, '#ffd23d');
        if (multi.n === 2) say('Excellent'); else if (multi.n >= 3) say('Unstoppable');
        else if (w === 'lancer') say('Impressive');
      }
    }
  }

  // ── Weapons ────────────────────────────────────────────────────────
  function gainWeapon(w) {
    const had = me.owned.has(w);
    me.owned.add(w);
    me.ammo[w] = Math.min(WEAPONS[w].ammo[1], me.ammo[w] + WEAPONS[w].ammo[0]);
    sfx('gun');
    if (!had && ORDER.indexOf(w) > ORDER.indexOf(me.weapon)) select(w);
    drawHud();
  }
  function select(w) {
    if (!me.owned.has(w) || w === me.weapon) return;
    me.last = me.weapon; me.weapon = w;
    me.nextShot = Math.max(me.nextShot, performance.now() / 1000 + 0.18);
    drawHud();
  }
  function cycle(dir) {
    const owned = ORDER.filter((w) => me.owned.has(w) && (me.ammo[w] > 0 || w === 'ticker'));
    const i = owned.indexOf(me.weapon);
    select(owned[(i + dir + owned.length) % owned.length]);
  }
  const _eye = new THREE.Vector3(), _dir = new THREE.Vector3(), _q = new THREE.Quaternion(), _tmp = new THREE.Vector3();
  /** Where other player p is drawn (three, feet), or null. */
  function renderPos(p) { return p.group.visible ? p.group.position : (p.buf.length ? p.buf[p.buf.length - 1].p : null); }
  /** Distance along a ray to player p's hit capsule, or Infinity. */
  function rayCapsule(o, d, p) {
    const at = renderPos(p);
    if (!at || !p.alive) return Infinity;
    // closest approach between the ray and the capsule's segment (vertical, feet+R .. feet+H-R)
    const a = _tmp.set(at.x, at.y + PLAYER_R, at.z), segLen = PLAYER_H - 2 * PLAYER_R;
    const w0x = o.x - a.x, w0y = o.y - a.y, w0z = o.z - a.z;
    const b = d.y, dd = w0x * d.x + w0y * d.y + w0z * d.z, e = w0y;
    const denom = 1 - b * b;
    let s = denom > 1e-6 ? (b * e - dd) / denom : 0; // along the ray
    let t = denom > 1e-6 ? (e - b * dd) / denom : e;  // along the segment
    t = Math.max(0, Math.min(segLen, t));
    s = Math.max(0, (t * b) - dd);
    t = Math.max(0, Math.min(segLen, e + s * b)); // the segment point closest to that ray point
    const px = o.x + d.x * s - a.x, py = o.y + d.y * s - (a.y + t), pz = o.z + d.z * s - a.z;
    if (px * px + py * py + pz * pz > PLAYER_R * PLAYER_R) return Infinity;
    return s;
  }
  function shoot(nowS) {
    const w = WEAPONS[me.weapon];
    if (me.ammo[me.weapon] <= 0) { sfx('empty'); me.nextShot = nowS + 0.3; cycle(1); return; }
    me.nextShot = nowS + w.interval;
    me.ammo[me.weapon]--;
    const n = ++me.shotN;
    camera.getWorldPosition(_eye);
    camera.getWorldQuaternion(_q);
    _dir.set(0, 0, -1).applyQuaternion(_q);
    const muzzle = viewGuns[me.weapon].userData.muzzle.clone();
    viewGuns[me.weapon].localToWorld(muzzle);
    send({ t: 'fire', w: me.weapon, n, o: t2b(_eye).map(r3), d: [r3(_dir.x), r3(-_dir.z), r3(_dir.y)] });
    sfx(me.weapon, null, 0.8);
    me.recoil = Math.min(1, me.recoil + (me.weapon === 'ticker' ? 0.25 : 0.8));
    flash.visible = true; flash.position.copy(viewGuns[me.weapon].userData.muzzle); flashUntil = performance.now() + 45;
    if (w.kind === 'rocket') {
      spawnRocket(_eye.clone().addScaledVector(_dir, 0.6), _dir.clone(), me.id, n);
      return;
    }
    const dmgTo = new Map();
    let anyHit = false;
    for (let i = 0; i < w.pellets; i++) {
      const d = _dir.clone();
      if (w.spread) d.add(new THREE.Vector3((Math.random() - 0.5) * 2 * w.spread, (Math.random() - 0.5) * 2 * w.spread, (Math.random() - 0.5) * 2 * w.spread)).normalize();
      const wall = W.rayWorld(_eye, d, w.range);
      let far = wall ? wall.distance : w.range, who = null;
      for (const [id, p] of others) { const s = rayCapsule(_eye, d, p); if (s < far) { far = s; who = id; } }
      const end = _eye.clone().addScaledVector(d, far);
      if (w.kind === 'beam') beam(muzzle, end, w.color);
      else if (i % 3 === 0) tracer(muzzle, end, w.color, 1, 70);
      if (who) { dmgTo.set(who, (dmgTo.get(who) || 0) + w.dmg); anyHit = true; }
      else if (wall) burst(end, 0xffe0b0, me.weapon === 'scatter' ? 2 : 4, 2.5, 0.025, 250);
    }
    for (const [target, dmg] of dmgTo) send({ t: 'hit', n, target, dmg });
    if (anyHit) hitMark = performance.now() + 120;
  }
  function remoteFire(m) {
    const p = others.get(m.id);
    const w = WEAPONS[m.w];
    if (!w || !p) return;
    const o = b2t(...m.o), d = b2t(...m.d).normalize();
    // b2t maps Blender (x,y,z) to three (x, z, -y): a direction comes out the same way
    sfx(m.w, o, 1);
    if (w.kind === 'rocket') { spawnRocket(o.clone().addScaledVector(d, 0.6), d, m.id, m.n); return; }
    const wall = W.rayWorld(o, d, w.range || 100);
    const end = o.clone().addScaledVector(d, wall ? wall.distance : (w.range || 100));
    const from = renderPos(p) ? renderPos(p).clone().add(new THREE.Vector3(0, 1.3, 0)) : o;
    if (w.kind === 'beam') beam(from, end, w.color); else tracer(from, end, w.color, 1, 70);
  }
  const rocketGeo = new THREE.CylinderGeometry(0.05, 0.07, 0.38, 8).rotateX(Math.PI / 2);
  function spawnRocket(pos, dir, owner, n) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(rocketGeo, new THREE.MeshStandardMaterial({ color: 0x555555, emissive: 0xff6a3d, emissiveIntensity: 0.4 })));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffa040, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.set(0.5, 0.5, 1); g.add(glow);
    g.position.copy(pos); g.lookAt(pos.clone().add(dir));
    scene.add(g);
    rockets.push({ pos: pos.clone(), dir: dir.clone(), owner, n, mesh: g, born: performance.now(), trailT: 0 });
  }
  function updateRockets(dt) {
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      const step = WEAPONS.boomer.speed * dt;
      const wall = W.rayWorld(r.pos, r.dir, step);
      let hitAt = wall ? r.pos.clone().addScaledVector(r.dir, wall.distance) : null, direct = null;
      // players (not the one who fired it in the first 0.15 s)
      const cand = [...others].filter(([id]) => id !== r.owner || performance.now() - r.born > 150);
      if (r.owner !== me.id && me.alive) cand.push([me.id, null]);
      for (const [id, p] of cand) {
        const s = p ? rayCapsule(r.pos, r.dir, p) : rayMe(r.pos, r.dir);
        if (s <= (wall ? wall.distance : step)) { hitAt = r.pos.clone().addScaledVector(r.dir, s); direct = id; }
      }
      if (hitAt || performance.now() - r.born > 6000) {
        explode(r, hitAt || r.pos, direct);
        scene.remove(r.mesh); rockets.splice(i, 1);
        continue;
      }
      r.pos.addScaledVector(r.dir, step);
      r.mesh.position.copy(r.pos);
      r.trailT += dt;
      if (r.trailT > 0.03) {
        r.trailT = 0;
        const puff = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.5, depthWrite: false }));
        puff.position.copy(r.pos); puff.scale.setScalar(0.06);
        add(puff, 600, (o, k) => { o.scale.setScalar(0.06 + k * 0.25); o.material.opacity = 0.5 * (1 - k); });
      }
    }
  }
  function rayMe(o, d) {
    const f = W.feet(), at = b2t(...f);
    return rayCapsule(o, d, { alive: true, group: { visible: true, position: at }, buf: [] });
  }
  const _push = new THREE.Vector3();
  function explode(r, at, direct) {
    explosion(at);
    const R = WEAPONS.boomer.splash;
    // knock back: every client pushes only itself, for every rocket it sees explode
    if (me.alive) {
      const myC = b2t(...W.feet()).add(new THREE.Vector3(0, 0.9, 0));
      const d = myC.distanceTo(at);
      if (d < R) {
        _push.subVectors(myC, at).normalize();
        const k = (1 - d / R) * (r.owner === me.id ? 15 : 9);
        W.player.vel.addScaledVector(_push, k);
        W.player.vel.y += k * 0.35;
        W.player.onFloor = false;
      }
    }
    if (r.owner !== me.id) return; // only the shooter reports damage
    const hits = [];
    for (const [id, p] of others) {
      const pos = renderPos(p);
      if (!pos || !p.alive) continue;
      const c = pos.clone().add(new THREE.Vector3(0, 0.9, 0));
      const d = id === direct ? 0 : Math.max(0, c.distanceTo(at) - PLAYER_R);
      if (d < R && (id === direct || !W.rayWorld(at, c.clone().sub(at).normalize(), d))) hits.push([id, Math.round(WEAPONS.boomer.dmg * (1 - d / R))]);
    }
    if (me.alive) {
      const myC = b2t(...W.feet()).add(new THREE.Vector3(0, 0.9, 0));
      const d = Math.max(0, myC.distanceTo(at) - PLAYER_R);
      if (d < R) hits.push([me.id, Math.round(0.5 * WEAPONS.boomer.dmg * (1 - d / R))]);
    }
    for (const [target, dmg] of hits) if (dmg > 0) send({ t: 'hit', n: r.n, target, dmg });
    if (hits.some(([id]) => id !== me.id)) hitMark = performance.now() + 140;
  }

  // ── Input ──────────────────────────────────────────────────────────
  const canvas = W.canvas;
  let boardHeld = false;
  if (!W.TOUCH) {
    H('.play').addEventListener('click', () => { audioOn(); canvas.requestPointerLock?.(); });
    document.addEventListener('pointerlockchange', () => { H('.play').hidden = document.pointerLockElement === canvas; if (!document.pointerLockElement) me.firing = false; });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      // Safari sometimes reports a huge jump (e.g. the first event after locking): cap each event
      const mx = Math.max(-120, Math.min(120, e.movementX || 0)), my = Math.max(-120, Math.min(120, e.movementY || 0));
      W.turn(-mx * 0.0022, -my * 0.0022);
    });
    document.addEventListener('mousedown', (e) => { if (document.pointerLockElement === canvas && e.button === 0) me.firing = true; if (document.pointerLockElement === canvas && e.button === 2) cycle(1); });
    document.addEventListener('mouseup', (e) => { if (e.button === 0) me.firing = false; });
    document.addEventListener('wheel', (e) => { if (document.pointerLockElement === canvas) cycle(e.deltaY > 0 ? 1 : -1); }, { passive: true });
    document.addEventListener('contextmenu', (e) => { if (document.pointerLockElement === canvas) e.preventDefault(); });
  }
  window.addEventListener('keydown', (e) => {
    for (const w of ORDER) if (e.code === WEAPONS[w].key) select(w);
    if (e.code === 'KeyQ') select(me.last);
    if (e.code === 'Tab') { e.preventDefault(); boardHeld = true; showBoard('Scores', true); }
    if (e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Tab') { boardHeld = false; if (matchInfo.state === 'on') showBoard('', false); } });

  // ── The frame (walk.js calls this instead of its own walking) ──────
  let shake = 0, hitMark = 0, flashUntil = 0, lastSend = 0, hudT = 0, footT = 0;
  const wish = new THREE.Vector3(), fwd = new THREE.Vector3(), side = new THREE.Vector3();
  W.setDriver((dt) => {
    const nowMs = performance.now(), nowS = nowMs / 1000;
    const { yaw } = W.view();
    // look on touch: the right stick (the drag is handled by walk.js)
    if (W.TOUCH) W.turn(-W.curve(W.sticks.look.x) * 3.2 * dt, -W.curve(W.sticks.look.y) * 2.2 * dt);
    fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw)); side.set(-fwd.z, 0, fwd.x);
    wish.set(0, 0, 0);
    if (keys.has('KeyW') || keys.has('ArrowUp')) wish.add(fwd);
    if (keys.has('KeyS') || keys.has('ArrowDown')) wish.sub(fwd);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) wish.sub(side);
    if (keys.has('KeyD') || keys.has('ArrowRight')) wish.add(side);
    if (W.TOUCH) { const { x, y } = W.sticks.move; if (Math.hypot(x, y) > 0.15) wish.addScaledVector(fwd, -y).addScaledVector(side, x); }
    if (wish.lengthSq() > 0) wish.normalize();
    const jump = keys.has('Space') || me.jumpHeld;
    if (me.alive) {
      const before = W.feet();
      const ev = W.moveQuake(dt, wish, jump);
      if (ev.jumped) sfx('jump', null, 0.5);
      if (ev.landed && ev.fall > 4) sfx('land', null, Math.min(1, ev.fall / 10));
      const f = W.feet();
      if (W.player.onFloor) {
        me.stepDist += Math.hypot(f[0] - before[0], f[1] - before[1]);
        if (me.stepDist > 1.9) { me.stepDist = 0; sfx('step', null, 0.6); }
      }
      // falling off the world, or far outside the plot
      if (f[2] < -15) send({ t: 'fall' });
      if (f[0] < -40 || f[0] > 80 || f[1] < -45 || f[1] > 40) { if (me.lastSafe) W.teleport(...me.lastSafe); }
      // pickups
      const feetT = b2t(...f);
      for (const [id, p] of pickups) {
        if (!p.up || nowMs - p.sentAt < 400) continue;
        if (feetT.distanceTo(_tmp.copy(p.group.position).setY(p.group.position.y - 0.75)) < 1.25) { p.sentAt = nowMs; send({ t: 'pick', id }); }
      }
      if (me.firing && nowS >= me.nextShot && matchInfo.state === 'on') shoot(nowS);
    } else {
      W.player.vel.set(0, 0, 0);
    }
    // send my state ~20 times a second
    if (connected && me.alive && nowMs - lastSend > 50) {
      lastSend = nowMs;
      const f = W.feet(), v = W.player.vel, { yaw: y, pitch: a } = W.view();
      send({ t: 's', p: f.map(r3), v: [r3(v.x), r3(-v.z), r3(v.y)], y: r3(y), a: r3(a), w: me.weapon });
    }
    // other players: drawn INTERP seconds back, between the two updates around that moment
    const tRender = nowS - INTERP;
    for (const p of others.values()) {
      const b = p.buf;
      if (!p.alive || !b.length) { p.group.visible = false; continue; }
      let i = b.length - 1;
      while (i > 0 && b[i - 1].t > tRender) i--;
      const s1 = b[i], s0 = b[Math.max(0, i - 1)];
      const k = s1.t === s0.t ? 1 : Math.max(0, Math.min(1.5, (tRender - s0.t) / (s1.t - s0.t)));
      p.group.position.lerpVectors(s0.p, s1.p, k);
      p.group.rotation.y = s1.y;
      p.group.userData.aim.rotation.x = s1.a;
      p.group.userData.head.rotation.x = s1.a * 0.5;
      p.group.visible = true;
    }
    updateRockets(dt);
    // effects
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      const k = (nowMs - e.born) / (e.until - e.born);
      if (k >= 1) { scene.remove(e.obj); e.obj.geometry?.dispose(); e.obj.material?.dispose(); effects.splice(i, 1); continue; }
      e.update?.(e.obj, k);
    }
    for (const p of pickups.values()) if (p.up) { p.mesh.rotation.y += dt * 2; p.group.position.y = p.base + Math.sin(nowS * 2.5 + p.base) * 0.08; }
    if (nowMs > boomLightUntil) boomLight.intensity = Math.max(0, boomLight.intensity - dt * 400);
    if (nowMs > flashUntil) flash.visible = false;
    // the gun: recoil, bob, the weapon you hold
    for (const w of ORDER) viewGuns[w].visible = me.alive && w === me.weapon;
    me.recoil = Math.max(0, me.recoil - dt * 6);
    const speed = Math.hypot(W.player.vel.x, W.player.vel.z);
    me.bob += dt * speed * 1.6;
    view.position.set(0.13 + Math.sin(me.bob) * 0.008, -0.12 + Math.abs(Math.cos(me.bob)) * 0.006 - me.recoil * 0.012, -0.24 + me.recoil * 0.04);
    view.rotation.x = me.recoil * 0.12;
    // screen shake
    if (shake > 0) { W.setRoll((Math.random() - 0.5) * shake * 0.12); shake = Math.max(0, shake - dt * 1.5); } else W.setRoll(0);
    // dead: look down at the floor where you fell
    if (!me.alive) W.turn(0, Math.max(-0.02, (-0.9 - W.view().pitch) * dt * 2));
    H('.cross').classList.toggle('hit', nowMs < hitMark);
    if (nowMs > centerUntil) H('.center').innerHTML = '';
    // listener for 3D sound
    if (ac) {
      camera.getWorldPosition(_lp); camera.getWorldDirection(_lf);
      const L = ac.listener;
      if (L.positionX) { L.positionX.value = _lp.x; L.positionY.value = _lp.y; L.positionZ.value = _lp.z; L.forwardX.value = _lf.x; L.forwardY.value = _lf.y; L.forwardZ.value = _lf.z; L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; }
      else { L.setPosition(_lp.x, _lp.y, _lp.z); L.setOrientation(_lf.x, _lf.y, _lf.z, 0, 1, 0); }
    }
    if ((hudT += dt) > 0.2) { hudT = 0; drawTop(); if (boardHeld) showBoard('Scores', true); }
    footT += dt;
  });

  drawHud();
  center('Connecting…', '', 4000);
  connect();
  // for tests in the browser
  window.dm = { me, others, pickups, send, select, shoot: () => shoot(performance.now() / 1000), WEAPONS, map, state: () => ({ id: me.id, hp: me.hp, ar: me.ar, alive: me.alive, frags: me.frags, weapon: me.weapon, ammo: me.ammo, connected, others: others.size }) };
}
