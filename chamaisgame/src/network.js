// Network defence: visitors walk up the street, each carrying one log line
// (Suricata IDS or OpenCanary honeypot). Decide before they reach the gate.
// The rules are in network-profile.js: a generic home setup, all events invented.

import P from './network-profile.js';
const { CONFIG, NAS, CANARY, SURICATA } = P;

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const extIp = () => `${pick(['203.0.113', '198.51.100'])}.${2 + rnd(250)}`;
const stamp = (world) => `${world.state.day}T${String(Math.floor(world.state.hours)).padStart(2, '0')}:${String(rnd(60)).padStart(2, '0')}:${String(rnd(60)).padStart(2, '0')}`;

function makeEvent(world, forceIp) {
  const r = Math.random();
  if (r < 0.5) {
    const [signature, severity, category, port, src, dest] = pick(SURICATA);
    return {
      source: 'suricata',
      raw: {
        timestamp: stamp(world) + '.000000+0200', event_type: 'alert',
        src_ip: forceIp || (src === 'ext' ? extIp() : src), src_port: 30000 + rnd(30000),
        dest_ip: dest || NAS, dest_port: port, proto: port === 161 || port === 53 ? 'UDP' : 'TCP',
        alert: { action: 'allowed', signature_id: 2000000 + rnd(40000), signature, category, severity },
      },
    };
  }
  if (r < 0.57) { // a Suricata line that is not an alert at all
    return { source: 'suricata', raw: { timestamp: stamp(world) + '.000000+0200', event_type: pick(['flow', 'dns', 'tls']), src_ip: P.lanClient, src_port: 50000 + rnd(9000), dest_ip: '198.51.100.20', dest_port: 443, proto: 'TCP' } };
  }
  if (r < 0.63) { // honeypot start-up message
    return { source: 'opencanary', raw: { dst_host: '', dst_port: -1, local_time: stamp(world), logdata: { msg: { logdata: 'Canary running!!!' } }, logtype: 1001, node_id: 'opencanary-1', src_host: '', src_port: -1, utc_time: stamp(world) } };
  }
  const lt = Number(pick(Object.keys(CANARY)));
  const own = !forceIp && Math.random() < 0.12;
  const logdata = lt === 4002 || lt === 6001 || lt === 2000 || lt === 8001 ? { USERNAME: pick(['root', 'admin', 'pi', 'ubnt', 'support']), PASSWORD: '<not shown>' } : lt === 3001 ? { USERAGENT: pick(['Mozilla/5.0 zgrab/0.x', 'curl/8.5.0', 'python-requests/2.32']), PATH: '/index.html' } : {};
  return {
    source: 'opencanary',
    raw: { dst_host: NAS, dst_port: CANARY[lt][1], local_time: stamp(world), logdata, logtype: lt, node_id: 'opencanary-1', src_host: forceIp || (own ? P.ownDevice : extIp()), src_port: 30000 + rnd(30000), utc_time: stamp(world) },
  };
}

/** What alerter.py does with a line: { alert: bool, why } (rate limit applied by the caller's limiter). */
export function triage(ev, limiter, now) {
  const e = ev.raw;
  let ip;
  if (ev.source === 'suricata') {
    if (e.event_type !== 'alert') return { alert: false, why: `event_type is "${e.event_type}", not an alert: the alerter skips it.` };
    if (e.alert.severity > CONFIG.minSeverity) return { alert: false, why: `Severity ${e.alert.severity} is below the bar (min_severity ${CONFIG.minSeverity}; 1 is the worst).` };
    const pre = CONFIG.ignoreSignatures.find((p) => e.alert.signature.startsWith(p));
    if (pre) return { alert: false, why: `"${pre}…" is on the ignore_signatures list: known noise, still visible in EveBox.` };
    ip = e.src_ip;
  } else {
    if (!(e.logtype >= 2000)) return { alert: false, why: 'OpenCanary 1xxx log types are its own start-up messages, not attacks.' };
    if (!e.src_host) return { alert: false, why: 'No source host: not an attack.' };
    ip = e.src_host;
  }
  if (CONFIG.ignoreIps.includes(ip)) return { alert: false, why: `${ip} is one of our own devices (ignore_ips).` };
  if (limiter && !limiter.allow(ip, now)) return { alert: false, why: `Rate limit: already ${CONFIG.rateLimit.maxPerIp} alerts from ${ip} in the last ${CONFIG.rateLimit.windowSeconds} s. No more pushes for this one.` };
  return {
    alert: true,
    why: ev.source === 'suricata'
      ? `Severity ${e.alert.severity}, not on the ignore list, not our own device: push "IDS Alert: ${e.alert.signature}".`
      : `Nobody has a reason to touch the honeypot: push "Honeypot: ${CANARY[e.logtype][0]}" (always high priority).`,
  };
}

class RateLimiter { // same idea as alerter.py: max N per IP per window
  constructor() { this.seen = new Map(); }
  allow(ip, now) {
    const w = CONFIG.rateLimit.windowSeconds;
    const list = (this.seen.get(ip) || []).filter((t) => now - t < w);
    if (list.length >= CONFIG.rateLimit.maxPerIp) { this.seen.set(ip, list); return false; }
    list.push(now); this.seen.set(ip, list);
    return true;
  }
}

const tag = (ev) => {
  const e = ev.raw;
  if (ev.source === 'suricata') return e.event_type === 'alert' ? e.alert.signature.split(' ').slice(0, 3).join(' ') : `eve: ${e.event_type}`;
  return e.logtype >= 2000 ? `canary: ${CANARY[e.logtype][0]}` : 'canary: status';
};

export default function initNetwork(world) {
  const { THREE } = world;
  const GATE = [-3.4, -4.8, 0.1];
  const S = { running: false, over: false, wave: 0, score: 0, lives: 3, fatigue: 0, pushes: 0, visitors: [], selected: null, last: null, t: 0, toSpawn: [], spawnIn: 0, limiter: new RateLimiter() };
  const bodyGeo = new THREE.CapsuleGeometry(0.28, 1.1, 4, 10);
  const colours = { pending: 0x8a8f98, alert: 0xe2675a, pass: 0x7fc28a };

  function spawn(ev) {
    const fromNorth = Math.random() < 0.5;
    const start = [-7.2 + Math.random() * 1.6, fromNorth ? 44 : -40, 0.0];
    const g = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ color: colours.pending }));
    body.position.y = 0.85; body.castShadow = true;
    g.add(body);
    const label = world.marker([0, 0, 0], tag(ev), ev.source === 'suricata' ? '#e0a458' : '#c9a0e8', 1.9);
    world.scene.remove(label); label.position.set(0, 0, 0); label.children[0].visible = false;
    label.children[1].scale.multiplyScalar(3.5); label.children[1].position.y = 2.5;
    g.add(label);
    world.scene.add(g);
    const v = { ev, g, body, pos: start, path: [[start[0], GATE[1], 0], GATE], speed: 55 / (34 - Math.min(16, S.wave * 2.5)), id: Math.random().toString(36).slice(2, 8), decided: null };
    S.visitors.push(v);
    if (!S.selected) S.selected = v;
    return v;
  }

  function remove(v) { world.scene.remove(v.g); S.visitors.splice(S.visitors.indexOf(v), 1); if (S.selected === v) S.selected = S.visitors.find((x) => !x.decided) || null; }

  function startWave() {
    if (S.over) Object.assign(S, { over: false, wave: 0, score: 0, lives: 3, fatigue: 0, pushes: 0, limiter: new RateLimiter(), t: 0 });
    S.wave++;
    S.running = true;
    const n = 5 + S.wave * 2;
    S.toSpawn = Array.from({ length: n }, () => makeEvent(world));
    if (S.wave >= 2) { // one noisy scanner: the rate limit should kick in
      const ip = extIp();
      const flood = Array.from({ length: 7 }, () => { let e; do e = makeEvent(world, ip); while (!triage(e).alert); return e; });
      S.toSpawn.splice(2, 0, ...flood);
    }
    S.spawnIn = 0;
    world.toast(`Wave ${S.wave}: ${S.toSpawn.length} log lines on their way up ${P.street}.`);
  }

  function decide(v, alarm) {
    if (!v || v.decided) return;
    const verdict = triage(v.ev, S.limiter, S.t);
    v.decided = alarm ? 'alert' : 'pass';
    v.body.material.color.setHex(colours[v.decided]);
    const right = verdict.alert === alarm;
    if (alarm) S.pushes++;
    if (right) S.score += alarm ? 10 : 5;
    else if (alarm) { S.fatigue++; world.toast('False alarm: the phones buzz for nothing.', 'bad'); }
    else { S.lives--; world.toast('Breach: a real one walked in unnoticed.', 'bad'); }
    S.last = { right, alarm, why: verdict.why, tag: tag(v.ev) };
    if (alarm) { // sent back down the street
      v.leaving = true; v.speed *= 1.6;
      v.path = [[v.pos[0], v.pos[1] > GATE[1] ? 60 : -60, 0]];
    } else v.speed *= 2.2; // waved through
    S.selected = S.visitors.find((x) => !x.decided) || null;
    check();
  }

  function check() {
    if (S.lives <= 0 || S.fatigue >= 5) {
      S.over = true; S.running = false; S.toSpawn = [];
      for (const v of [...S.visitors]) remove(v);
      world.toast(S.lives <= 0 ? 'Game over: three breaches.' : `Game over: five false alarms, ${P.muter} muted the alerts.`, 'bad');
    }
  }

  function tick(dt) {
    if (!S.running) return;
    S.t += dt;
    S.spawnIn -= dt;
    if (S.toSpawn.length && S.spawnIn <= 0) { spawn(S.toSpawn.shift()); S.spawnIn = Math.max(1.6, 5 - S.wave * 0.6) * (0.6 + Math.random() * 0.8); }
    for (const v of [...S.visitors]) {
      const target = v.path[0];
      const dx = target[0] - v.pos[0], dy = target[1] - v.pos[1], d = Math.hypot(dx, dy);
      const stepLen = v.speed * dt;
      if (d <= stepLen) {
        v.pos = [target[0], target[1], 0];
        v.path.shift();
        if (!v.path.length) {
          if (!v.decided) { // reached the gate without a decision: it passes
            const verdict = triage(v.ev, S.limiter, S.t);
            if (verdict.alert) { S.lives--; world.toast('Breach: nobody looked at that one.', 'bad'); S.last = { right: false, alarm: false, why: verdict.why, tag: tag(v.ev) }; }
          }
          remove(v);
          continue;
        }
      } else { v.pos[0] += dx / d * stepLen; v.pos[1] += dy / d * stepLen; }
      v.g.position.copy(world.b2t(v.pos[0], v.pos[1], 0.02));
      v.eta = v.leaving ? Infinity : (Math.abs(v.pos[1] - GATE[1]) + Math.abs(GATE[0] - v.pos[0])) / v.speed;
      v.g.scale.setScalar(v === S.selected ? 1.25 : 1);
    }
    check();
    if (S.running && !S.toSpawn.length && !S.visitors.length) {
      S.running = false; S.score += 20;
      world.toast(`Wave ${S.wave} cleared (+20). ${S.pushes} pushes sent so far.`, 'good');
    }
  }
  world.on('frame', (dt) => tick(dt));

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  world.registerModule({
    id: 'net', title: 'Network', live: true,
    badge: () => S.running && S.visitors.some((v) => !v.decided),
    render(el) {
      const hearts = '♥'.repeat(Math.max(0, S.lives)) + '♡'.repeat(Math.max(0, 3 - S.lives));
      let h = `<h3>Intruders at the gate</h3>
        <p class="hint">Every visitor on the street carries one log line from the home network: Suricata (IDS) or OpenCanary (honeypot). Do what ${P.alerter} would do.</p>
        <dl class="kv"><dt>Wave</dt><dd>${S.wave || '-'}</dd><dt>Score</dt><dd>${S.score}</dd><dt>House</dt><dd class="${S.lives < 3 ? 'warn' : 'good'}">${hearts}</dd>
        <dt>Alert fatigue</dt><dd><div class="meter"><i style="width:${S.fatigue * 20}%;background:var(--bad)"></i></div></dd></dl>`;
      if (!S.running) {
        h += `<div class="row"><button data-act="start" class="primary">${S.over ? 'Start again' : S.wave ? 'Next wave' : 'Start wave 1'}</button><button data-act="watch">Watch the street</button></div>`;
        if (S.over) h += `<p class="bad">Game over with ${S.score} points.</p>`;
      } else {
        const queue = S.visitors.filter((v) => !v.decided).sort((a, b) => a.eta - b.eta);
        h += `<div class="row">${queue.slice(0, 6).map((v) => `<button data-sel="${v.id}" class="${v === S.selected ? 'on' : ''}">${esc(tag(v.ev))} · ${Math.max(0, Math.round(v.eta || 0))}s</button>`).join('') || '<span class="hint">Nobody in sight…</span>'}</div>`;
        const v = S.selected;
        if (v && !v.decided) {
          h += `<div class="row"><button data-act="alarm" class="danger">Raise the alarm</button><button data-act="pass">Let it pass</button><button data-act="watch">Watch the street</button></div>
            <p class="hint">${v.ev.source === 'suricata' ? 'Suricata eve.json' : 'OpenCanary log'} line:</p><pre class="raw">${esc(JSON.stringify(v.ev.raw, null, 1))}</pre>`;
        }
      }
      if (S.last) h += `<p class="${S.last.right ? 'good' : 'bad'}">${S.last.right ? 'Right' : 'Wrong'} (${esc(S.last.tag)}): ${esc(S.last.why)}</p>`;
      h += `<details><summary class="hint">The alerter's rules</summary>
        <p class="hint">Suricata: only <code>event_type: alert</code> with severity 1 or 2. Ignored signature prefixes: ${CONFIG.ignoreSignatures.map(esc).join('; ')}.</p>
        <p class="hint">OpenCanary: every log type from 2000 up is an alert. 1xxx are its own status lines.</p>
        <p class="hint">Never alert on our own devices: ${CONFIG.ignoreIps.join(', ')}. At most ${CONFIG.rateLimit.maxPerIp} alerts per source IP per ${CONFIG.rateLimit.windowSeconds} s.</p></details>`;
      const open = el.querySelector('details')?.open;
      if (el.dataset.html !== h) { el.innerHTML = h; el.dataset.html = h; if (open) el.querySelector('details').open = true; }
      el.onclick = (e) => {
        const d = e.target.dataset || {};
        if (d.sel) S.selected = S.visitors.find((v) => v.id === d.sel) || S.selected;
        else if (d.act === 'start') { startWave(); if (world.state.mode === 'walk' && world.playerPos()[0] > 2) world.lookFrom([-24, -6, 16], [-5, -3, 0]); }
        else if (d.act === 'watch') world.lookFrom([-24, -6, 16], [-5, -3, 0]);
        else if (d.act === 'alarm') decide(S.selected, true);
        else if (d.act === 'pass') decide(S.selected, false);
        else return;
        el.dataset.html = '';
        world.renderPanel();
      };
    },
  });

  window.game.net = { S, CONFIG, startWave, decide, tick, triage, makeEvent: () => makeEvent(world) };
}
