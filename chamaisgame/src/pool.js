// Pool game: keep the pool balanced by following the house rules (gate closed,
// cover on, weekly test, photo to Gijs, chemicals only when he says so). The
// rules are real; every number (ranges, drift, cups, score) is invented.

const RULES = {
  ph: [7.2, 7.6],       // invented: the usual pool range
  cl: [1.0, 3.0],       // invented: free chlorine, ppm
  level: [0.35, 0.65],  // 0.5 = half-way up the skimmer (real target), band invented
  pump: [9, 17],        // "after 09:00" is real, the stop time is invented
  testValidDays: 7,     // weekly test is real
  replyMinutes: 20,     // invented
  mixHours: 4,          // invented window for "never mix chemicals"
};

const PH_CARD = [[6.8, '#f4d03f'], [7.2, '#f0a23a'], [7.6, '#e8643c'], [7.8, '#d93b55'], [8.2, '#a8327e']];
const CL_CARD = [[0.5, '#fbf6c8'], [1, '#f7ec8f'], [1.5, '#f2de55'], [2, '#edcf2b'], [3, '#e3b419'], [5, '#d08a12']];

function cardColour(card, v) {
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  if (v <= card[0][0]) return card[0][1];
  for (let i = 1; i < card.length; i++) {
    if (v <= card[i][0]) {
      const t = (v - card[i - 1][0]) / (card[i][0] - card[i - 1][0]);
      const a = hex(card[i - 1][1]), b = hex(card[i][1]);
      return '#' + a.map((c, k) => Math.round(c + (b[k] - c) * t).toString(16).padStart(2, '0')).join('');
    }
  }
  return card[card.length - 1][1];
}

export default function initPool(world) {
  const { THREE } = world;
  const S = {
    ph: 7.5, cl: 1.6, level: 0.46, algae: 0,
    cover: true, gate: true, // gate: true = closed
    test: null,              // { day, hours, phColour, clColour, sent, answer, auth }
    lastDose: {},            // chem -> absolute game hours
    dosedToday: {},          // chem -> cups since the last answer
    streak: 0, best: 0, strikes: 0, strikesToday: 0, days: 0,
    log: [],
    wasNear: false,
    active: false,           // set by the first pool action; days are not judged before that
    absHours: 0,             // game hours since the start
  };
  let spots = {};  // name -> [x, y, z] (Blender)
  let markers = [];
  let coverMesh = null;
  let centre = [20.1, 1.5, 5];
  let zone = null; // [xmin, xmax, ymin, ymax]

  const log = (text, kind = '') => {
    S.log.unshift({ text, kind, at: `${world.state.day.slice(5)} ${clock()}` });
    S.log.length = Math.min(S.log.length, 30);
    world.toast(text, kind);
  };
  const clock = () => `${String(Math.floor(world.state.hours)).padStart(2, '0')}:${String(Math.floor((world.state.hours % 1) * 60)).padStart(2, '0')}`;
  const strike = (text) => { S.strikes++; S.strikesToday++; S.streak = 0; log(text, 'bad'); };
  const pumpOn = () => world.state.hours >= RULES.pump[0] && world.state.hours < RULES.pump[1];
  const inRange = (v, r) => v >= r[0] && v <= r[1];
  const balanced = () => inRange(S.ph, RULES.ph) && inRange(S.cl, RULES.cl) && inRange(S.level, RULES.level) && S.algae < 0.3;

  // ── 3D: cover, water colour, markers ───────────────────────────────
  function place(v) {
    for (const m of markers) world.scene.remove(m);
    markers = [];
    if (coverMesh) world.scene.remove(coverMesh);
    for (let i = world.hotspots.length - 1; i >= 0; i--) if (world.hotspots[i].id.startsWith('pool:')) world.hotspots.splice(i, 1);
    const b = v.site.pool_water;
    if (!b) return;
    const [x0, y0, z] = b.min, [x1, y1] = b.max;
    const deck = z + 0.13;
    centre = [(x0 + x1) / 2, (y0 + y1) / 2, deck];
    zone = [x0 - 1.2, x1 + 1.5, y0 - 1.5, y1 + 3.8];
    spots = {
      gate: [x0 + 0.3, y1 + 3.0, deck],
      kit: [x0 + 0.3, y1 + 0.7, deck],
      cover: [(x0 + x1) / 2 + 0.3, y1 + 0.55, deck],
      outlet: [x1 + 0.4, y1 + 0.25, deck],
      hose: [x1 + 0.5, y1 + 1.7, deck],
      skimmer: [x1 + 0.45, (y0 + y1) / 2, deck],
    };
    const mk = (name, text, color) => markers.push(world.marker(spots[name], text, color));
    mk('gate', 'Pool gate', '#e2675a');
    mk('kit', 'Test kit', '#e0a458');
    mk('cover', 'Cover', '#9fb7c9');
    mk('outlet', 'Outlet (corner)', '#7fc28a');
    mk('hose', 'Garden hose', '#6fb6e0');
    mk('skimmer', 'Skimmer', '#b9ad9c');

    coverMesh = new THREE.Mesh(
      new THREE.BoxGeometry(x1 - x0 + 0.3, 0.05, y1 - y0 + 0.3),
      new THREE.MeshStandardMaterial({ color: 0x30507a, roughness: 0.7 }),
    );
    coverMesh.position.copy(world.b2t(centre[0], centre[1], z + 0.1));
    coverMesh.castShadow = true; coverMesh.receiveShadow = true;
    world.scene.add(coverMesh);

    const hs = (name, label, action) => world.hotspots.push({ id: 'pool:' + name, pos: spots[name], radius: 1.1, label, action: () => { action(); world.showTab('pool'); } });
    hs('gate', () => (S.gate ? 'Open the pool gate' : 'Close the pool gate'), () => act.gate());
    hs('kit', 'Test the water', () => act.test());
    hs('cover', () => (S.cover ? 'Take the cover off' : 'Put the cover back on'), () => act.cover());
    hs('hose', 'Top up with the hose', () => act.topUp());
    hs('outlet', () => pourLabel('at the outlet'), () => act.pour(S.test?.auth?.chem || 'chlorine', 'outlet'));
    hs('skimmer', () => pourLabel('into the skimmer'), () => act.pour(S.test?.auth?.chem || 'chlorine', 'skimmer'));
    paint();
  }
  const pourLabel = (where) => `Pour ${S.test?.auth?.chem || 'chlorine'} ${where}`;

  const clear = new THREE.Color(0x2aa7c9), green = new THREE.Color(0x4f7a2a), milky = new THREE.Color(0x9cc4c9);
  function paint() {
    if (coverMesh) coverMesh.visible = S.cover;
    const c = world.waterMaterial.color.copy(clear).lerp(green, Math.min(1, S.algae));
    if (S.ph > 7.8) c.lerp(milky, Math.min(0.6, (S.ph - 7.8) * 1.5));
    world.waterMaterial.opacity = 0.86 + 0.12 * Math.min(1, S.algae);
  }

  // ── Player position ────────────────────────────────────────────────
  const distTo = (p) => { const q = world.playerPos(); return Math.hypot(q[0] - p[0], q[1] - p[1]); };
  // the pool area: the deck round the water, up to the gate on the north side
  function nearPool() {
    if (world.state.mode !== 'walk' || !zone) return false;
    const [x, y, z] = world.playerPos();
    return x > zone[0] && x < zone[1] && y > zone[2] && y < zone[3] && Math.abs(z - centre[2]) < 1;
  }
  function nearestSpot() {
    let best = null, bd = 1.6;
    for (const k of ['outlet', 'skimmer']) { const d = distTo(spots[k]); if (d < bd) { bd = d; best = k; } }
    return best;
  }

  // ── Actions ────────────────────────────────────────────────────────
  const need = (ok, msg) => { if (!ok) world.toast(msg); return ok; };
  const act = {
    gate() { S.active = true; S.gate = !S.gate; log(S.gate ? 'Pool gate closed.' : 'Pool gate open.'); },
    cover() { S.active = true; S.cover = !S.cover; paint(); log(S.cover ? 'Cover back on.' : 'Cover off.'); },
    topUp() { S.active = true;
      if (!need(!S.cover, 'Take the cover off first.')) return;
      if (S.level >= 0.5) return log('The water is already half-way up the skimmer.');
      S.level = Math.min(0.5, S.level + 0.08);
      world.advance(0.25);
      log(S.level >= 0.5 ? 'Topped up: half-way up the skimmer.' : 'Hose running… the level is rising.');
    },
    test() { S.active = true;
      if (!need(!S.cover, 'Take the cover off first.')) return;
      world.advance(0.1);
      const wob = () => (Math.random() - 0.5) * 0.06;
      S.test = {
        day: S.days, absHours: S.absHours, at: `${world.state.day} ${clock()}`,
        phColour: cardColour(PH_CARD, S.ph + wob()), clColour: cardColour(CL_CARD, S.cl + wob() * 3),
        sent: null, answer: null, auth: null,
      };
      S.dosedToday = {};
      log('Kit filled to the line, 5 drops red left, 5 drops yellow right, shaken. Compare with the card.');
    },
    send() { S.active = true;
      if (!need(S.test && S.test.sent === null, 'Test the water first.')) return;
      S.test.sent = S.absHours;
      log('Photo sent to Gijs on WhatsApp. Wait for his answer before adding anything.');
    },
    pour(chem, where, force) {
      S.active = true;
      if (!force && !need(!S.cover, 'Take the cover off first.')) return;
      const auth = S.test?.auth;
      const other = chem === 'chlorine' ? 'acid' : 'chlorine';
      let effect = 1;
      if (!auth || auth.chem !== chem) strike(`Only when Gijs says so! Nobody told you to add ${chem}.`);
      else if ((S.dosedToday[chem] || 0) >= auth.cups) strike(`Gijs said ${auth.cups} cup${auth.cups > 1 ? 's' : ''} of ${chem}. That was one too many.`);
      if (where === 'skimmer') { strike('Never pour chemicals into the skimmer: it goes straight through the pump.'); effect = 0.4; }
      if (!pumpOn()) { strike('The pump is not running (it runs after 09:00): the chemical just sits in one spot.'); effect = Math.min(effect, 0.4); }
      if (S.lastDose[other] !== undefined && S.absHours - S.lastDose[other] < RULES.mixHours) strike('Never mix chemicals: the other one went in less than four hours ago.');
      if (chem === 'chlorine') { S.cl += 1.0 * effect; S.ph += 0.05 * effect; } else { S.ph -= 0.15 * effect; }
      S.lastDose[chem] = S.absHours;
      S.dosedToday[chem] = (S.dosedToday[chem] || 0) + 1;
      world.advance(0.05);
      log(`One cup of ${chem} ${where === 'outlet' ? 'at the outlet in the corner' : 'into the skimmer'}.`);
      paint();
    },
    sleep() {
      const h = world.state.hours;
      world.advance(h < 8 ? 8 - h : 32 - h);
    },
  };

  function gijsAnswers() {
    const t = S.test;
    let text, auth = null;
    if (S.cl < RULES.cl[0]) {
      const cups = Math.max(1, Math.min(3, Math.round(2 - S.cl)));
      auth = { chem: 'chlorine', cups };
      text = `Chlorine is low (the right side is pale). Add ${cups} cup${cups > 1 ? 's' : ''} of chlorine at the outlet in the corner while the pump runs, after 9. Not in the skimmer.`;
    } else if (S.ph > RULES.ph[1]) {
      const cups = Math.max(1, Math.min(3, Math.round((S.ph - 7.4) / 0.15)));
      auth = { chem: 'acid', cups };
      text = `pH is high (the left side is dark red). Add ${cups} cup${cups > 1 ? 's' : ''} of acid slowly at the outlet in the corner while the pump runs, after 9. Gloves on.`;
    } else if (S.cl > 4) {
      text = 'Chlorine is on the high side. Add nothing, test again in a few days.';
    } else {
      text = 'Looks good, add nothing. Cover on, gate closed. Thanks!';
    }
    if (S.level < RULES.level[0]) text += ' And the water is low: top up with the hose to half-way up the skimmer.';
    t.answer = text; t.auth = auth;
    log('Gijs: ' + text, 'good');
    world.showTab('pool');
  }

  // ── Simulation (all rates invented) ────────────────────────────────
  world.on('tick', (dt, st) => {
    S.absHours += dt;
    const sunUp = Math.max(0, Math.sin(st.sun.el * Math.PI / 180));
    const exposure = S.cover ? 0.05 : 1;
    S.cl = Math.max(0, S.cl - dt * S.cl * (0.002 + 0.09 * sunUp * exposure));
    S.ph += dt * 0.0006;
    S.level = Math.max(0, S.level - dt * (0.0003 + 0.004 * sunUp * exposure));
    if (S.cl < 0.6) S.algae = Math.min(1, S.algae + dt * 0.012 * (0.6 - S.cl) / 0.6 * (1 + sunUp));
    else if (S.cl > 1.2) S.algae = Math.max(0, S.algae - dt * 0.01);
    if (S.test && S.test.sent !== null && !S.test.answer && S.absHours - S.test.sent >= RULES.replyMinutes / 60) gijsAnswers();
    // 18:00: the day is judged
    if (S.active && st.hours >= 18 && st.hours - dt < 18) { // days count from the first thing you do at the pool
      S.days++;
      const why = [];
      if (!inRange(S.ph, RULES.ph)) why.push('pH out of range');
      if (!inRange(S.cl, RULES.cl)) why.push(S.cl < RULES.cl[0] ? 'chlorine too low' : 'chlorine too high');
      if (!inRange(S.level, RULES.level)) why.push('water level off');
      if (S.algae >= 0.3) why.push('the water is turning green');
      if (S.strikesToday) why.push(`${S.strikesToday} rule${S.strikesToday > 1 ? 's' : ''} broken`);
      S.strikesToday = 0;
      if (!S.cover) why.push('cover left off');
      if (!S.gate) why.push('gate left open');
      if (!S.test || S.days - S.test.day > RULES.testValidDays) why.push('no test in the last week');
      if (why.length) { S.streak = 0; log(`Day ${S.days}: not a good pool day (${why.join(', ')}).`, 'bad'); }
      else { S.streak++; S.best = Math.max(S.best, S.streak); log(`Day ${S.days}: pool in balance. Streak ${S.streak}.`, 'good'); }
    }
    paint();
  });

  world.on('frame', () => {
    const near = nearPool();
    if (S.wasNear && !near && world.state.mode === 'walk') {
      if (!S.gate) strike('HOU ALTYD DIE SWEMBAD HEK TOE! You walked off with the pool gate open.');
      if (!S.cover) strike('SIT DIE COVER ONMIDDELLIK OP AS JY KLAAR IS! You left the pool uncovered.');
    }
    S.wasNear = near;
  });
  world.on('variant', place);
  if (world.variant()) place(world.variant());

  // ── Panel ──────────────────────────────────────────────────────────
  const chip = (c) => `<span style="display:inline-block;width:22px;height:22px;border-radius:4px;background:${c};vertical-align:middle;border:1px solid rgba(255,255,255,.3)"></span>`;
  const card = (cardDef) => cardDef.map(([v, c]) => `<span style="display:inline-block;text-align:center;font-size:11px;margin-right:3px">${chip(c)}<br>${v}</span>`).join('');
  const btn = (id, text, cls = '', dis = false) => `<button data-act="${id}" class="${cls}" ${dis ? 'disabled' : ''}>${text}</button>`;

  world.registerModule({
    id: 'pool', title: 'Pool', live: true,
    badge: () => S.algae >= 0.3 || (S.test && S.test.answer && S.test.auth && (S.dosedToday[S.test.auth.chem] || 0) < S.test.auth.cups),
    render(el) {
      const near = nearPool();
      const t = S.test;
      const age = t ? S.days - t.day : null;
      const spot = nearestSpot();
      let h = `<h3>Keep the pool balanced</h3>
        <p class="hint">The real house rules: gate closed, cover on, test weekly, photo to Gijs, and add chemicals only when he says so.</p>
        <dl class="kv">
          <dt>Gate</dt><dd class="${S.gate ? 'good' : 'bad'}">${S.gate ? 'closed' : 'OPEN'}</dd>
          <dt>Cover</dt><dd class="${S.cover ? 'good' : 'warn'}">${S.cover ? 'on' : 'off'}</dd>
          <dt>Pump</dt><dd>${pumpOn() ? 'running' : 'off (runs after 09:00)'}</dd>
          <dt>Water</dt><dd>${S.algae >= 0.3 ? '<span class="bad">turning green</span>' : S.ph > 7.8 ? '<span class="warn">a bit cloudy</span>' : 'clear'}${S.cover ? ' (under the cover)' : ''}</dd>
          <dt>Level</dt><dd><div class="meter" title="the line is half-way up the skimmer" style="position:relative"><i style="width:${Math.round(S.level * 100)}%;background:${inRange(S.level, RULES.level) ? 'var(--good)' : 'var(--bad)'}"></i><b style="position:absolute;left:50%;top:0;bottom:0;width:2px;background:#fff"></b></div></dd>
          <dt>Streak</dt><dd>${S.streak} good day${S.streak === 1 ? '' : 's'} (best ${S.best}) · ${S.strikes} rule${S.strikes === 1 ? '' : 's'} broken</dd>
        </dl>`;
      if (!near) {
        h += `<p class="hint">Walk to the pool to do anything there.</p><div class="row">${btn('go', 'Go to the pool', 'primary')}${btn('sleep', 'Sleep until 08:00')}</div>`;
      } else {
        h += `<div class="row">${btn('gate', S.gate ? 'Open gate' : 'Close gate')}${btn('cover', S.cover ? 'Cover off' : 'Cover on')}${btn('test', 'Test the water', '', S.cover)}${btn('topUp', 'Top up (hose)', '', S.cover)}</div>`;
      }
      if (t) {
        h += `<h3 style="margin-top:10px">Test kit <span class="hint">${age === 0 ? 'today' : age + ' day' + (age === 1 ? '' : 's') + ' ago'}</span></h3>
          <p>Left, pH (red bottle): ${chip(t.phColour)} &nbsp; Right, chlorine (yellow bottle): ${chip(t.clColour)}</p>
          <p class="hint">pH card</p><div>${card(PH_CARD)}</div><p class="hint">Chlorine card (ppm)</p><div>${card(CL_CARD)}</div>`;
        if (t.sent === null) h += `<div class="row">${btn('send', 'Send the photo to Gijs', 'primary')}</div>`;
        else if (!t.answer) h += `<p class="warn">Photo sent. Waiting for Gijs… (do not add anything yet)</p>`;
        else h += `<p class="good">Gijs: ${t.answer}</p>${t.auth ? `<p class="hint">${S.dosedToday[t.auth.chem] || 0} of ${t.auth.cups} cup${t.auth.cups > 1 ? 's' : ''} added.</p>` : ''}`;
      } else {
        h += `<p class="hint">No test yet. The kit is on the pool edge.</p>`;
      }
      if (near) {
        h += `<h3 style="margin-top:10px">Chemicals</h3>
          <p class="hint">${spot ? `You are at the <b>${spot === 'outlet' ? 'outlet in the corner' : 'skimmer'}</b>.` : 'Stand at the outlet (corner) or the skimmer to pour.'}</p>
          <div class="row">${btn('pour:chlorine', 'Pour 1 cup chlorine', '', !spot || S.cover)}${btn('pour:acid', 'Pour 1 cup acid', '', !spot || S.cover)}</div>`;
      }
      h += `<ul class="log">${S.log.slice(0, 8).map((l) => `<li class="${l.kind}"><span class="hint">${l.at}</span> ${l.text}</li>`).join('')}</ul>`;
      if (el.dataset.html !== h) { el.innerHTML = h; el.dataset.html = h; }
      el.onclick = (e) => {
        const a = e.target.dataset?.act;
        if (!a) return;
        if (a === 'go') world.goPlace('Pool deck');
        else if (a.startsWith('pour:')) act.pour(a.slice(5), nearestSpot());
        else act[a]();
        el.dataset.html = '';
        world.renderPanel();
      };
    },
  });

  // debug / test hook
  window.game.pool = { S, act, RULES, spots: () => spots, balanced, nearPool, pumpOn };
}
