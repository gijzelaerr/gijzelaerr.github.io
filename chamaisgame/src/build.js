// Building game: put something on the plot and see what the Valco Village
// Aesthetics Committee (VAC) would say.
//
// REAL: every rule below quotes a clause of "VALCO VILLAGE AESTHETICS GUIDELINE
// DOCUMENT REV5 2024-06-03" (../Project Chamais mountain/). The plot boundary
// is the one in the model (from the written dimensions on the 2020 site plan,
// good to about 0.5 m near the house and 1 m on the hill, not a survey). The
// existing roofed area is measured from the model.
// ASSUMED: the guideline only says "the 3 and 5 meter setback lines ... as per
// the COW rules"; this game takes 5 m from the street boundary and 3 m from the
// other boundaries. Check with the City of Windhoek before relying on it.
// INVENTED: the catalogue sizes, and the idea that a verdict is this simple.
// Real approval is a decision by the VAC, the trustees and the City.

const OK = 'ok', NO = 'fail', ASK = 'consent';
const ROOF_COLOURS = { 'Black': OK, 'Dark grey': OK, 'White': OK, 'Red': NO, 'Green': NO };

// option value -> [level, text, clause] (level ok = nothing to report)
const CATALOGUE = [
  {
    id: 'carport', name: 'Carport', w: 5.4, d: 5.5, h: 2.75, roofed: true, colour: 0x556270,
    always: [[ASK, 'Carport designs go to the VAC for approval.', '3.9.3.5']],
    options: {
      Structure: {
        'Steel frame, 5° lean-to, edges concealed': [OK],
        'Shade net': [NO, 'No shade-net carports of any kind are allowed.', '3.9.3.1'],
        'Steel frame, bare sheet edges': [NO, 'All edges of carport roofs are to be concealed.', '3.9.3.2'],
      },
      'Roof colour': 'roofColour',
    },
  },
  {
    id: 'room', name: 'Garden room', w: 4, d: 3.5, h: 3, roofed: true, colour: 0xd9d4c7,
    always: [[ASK, 'Outbuildings must be architecturally coherent with the main building: VAC to judge.', '3.7.2']],
    options: {
      Roof: {
        'Lean-to 7°': [OK],
        'Lean-to 15°': [NO, 'A secondary roof should slope between 5° and 10°.', '3.2.1.2'],
        'Low roof behind a parapet': [OK],
        'Thatch lapa': [NO, 'No thatch lapas are permitted as outbuildings (and no thatch roofs).', '3.7.1, 3.2.1.5'],
      },
      'Roof colour': 'roofColour',
    },
  },
  {
    id: 'block', name: 'Extension block', w: 6, d: 5, h: 6.5, roofed: true, colour: 0xe8e4da,
    always: [[ASK, 'Roof apex heights are judged against the neighbouring roofs.', '2.4']],
    options: {
      Storeys: {
        'Double storey': [OK],
        'Three storeys': [NO, 'All structures are restricted to double storey.', '2.4'],
      },
      Roof: {
        'Pitched 30°': [OK],
        'Pitched 20°': [NO, 'Main roofs must be pitched at a minimum of 30°.', '3.2.1.1'],
        'Mono-pitch 5° as the main roof': [NO, 'A 5° roof over a main block fails the 30° rule (this is the open question on the V6 upper floor).', '3.2.1.1'],
        'Low roof behind parapet walls': [ASK, 'Low-angle roofs behind parapets are for secondary roofs: the VAC must accept this as one.', '3.2.1.2'],
      },
      'Roof colour': 'roofColour',
    },
  },
  {
    id: 'pool', name: 'Plunge pool', w: 3, d: 2, h: 0.15, roofed: false, colour: 0x2aa7c9,
    always: [[ASK, 'Position and size of a swimming pool are to be approved by the VAC.', '3.12.1']],
    options: {
      Cover: {
        'With a pool cover': [OK],
        'No cover': [NO, 'Pool covers must be fitted to all swimming pools.', '3.12.2'],
      },
    },
  },
  {
    id: 'braai', name: 'Braai', w: 1.6, d: 0.9, h: 2.2, roofed: false, colour: 0x8a7f72,
    options: {
      Type: {
        'Built-in braai with chimney': [ASK, 'Any permanent fireplace is to be approved by the VAC.', '3.6.1'],
        'Mobile firepit': [OK, 'Mobile fireplaces are permitted, but are to be stored discreetly.', '3.6.2'],
      },
    },
  },
  {
    id: 'wall', name: 'Boundary wall (6 m)', w: 6, d: 0.22, h: 2, roofed: false, colour: 0xf2efe8, noSetback: true,
    options: {
      Type: {
        '220 mm brick, plastered and painted': [OK],
        'Welded steel fencing': [ASK, 'Welded steel fencing must match an existing design on the estate: VAC approval.', '3.3.1.3'],
        'Pre-cast concrete': [NO, 'Pre-cast concrete walls are excluded.', '3.3.2.1'],
        'Wire mesh': [NO, 'Wire mesh fencing is excluded.', '3.3.2.2'],
        'Gabion': [NO, 'Gabion walls are excluded.', '3.3.2.3'],
        'Standard palisade': [NO, 'Standard palisade fencing is excluded.', '3.3.2.4'],
      },
      Height: {
        '2.0 m': [OK],
        '2.5 m': [NO, 'Boundary walls between houses are to be 2000 mm from natural ground level.', '3.3.1.1'],
      },
    },
  },
  {
    id: 'shed', name: 'Garden structure', w: 3, d: 2.4, h: 2.3, roofed: true, colour: 0x9aa58a,
    options: {
      Type: {
        'Wendy house': [ASK, 'Temporary structures, including Wendy houses, need prior approval of the VAC.', '3.8.2'],
        'Vegetable tunnel': [NO, 'Vegetable tunnels, shacks and plastic covered structures are not permitted.', '3.8.1'],
      },
    },
  },
  {
    id: 'tank', name: 'Water tank', w: 1.9, d: 1.9, h: 2.4, roofed: false, colour: 0x4f6b4a,
    always: [[ASK, 'Tanks may not protrude above the roofline or stand out against the horizon.', '3.15.3']],
    options: {
      Finish: {
        'Painted to match the wall behind it': [OK],
        'Plain green plastic': [NO, 'Tanks will always be painted to match the immediate building background.', '3.15.3'],
      },
    },
  },
];

const SETBACK = { street: 5, other: 3 }; // see ASSUMED above
const MAX_COVERAGE = 0.5; // clause 2.3

export default function initBuild(world) {
  const { THREE } = world;
  const S = { item: CATALOGUE[0], opts: {}, rot: 0, placing: false, placed: [], lines: true, last: null, submitted: null };
  let ghost = null, boundary = null, edges = [], erfArea = 0, lineGroup = null;
  const ray = new THREE.Raycaster();
  const DOWN = new THREE.Vector3(0, -1, 0);

  const defaults = (item) => Object.fromEntries(Object.entries(item.options).map(([k, v]) => [k, Object.keys(v === 'roofColour' ? ROOF_COLOURS : v)[0]]));
  S.opts = defaults(S.item);

  // ── Plot geometry ──────────────────────────────────────────────────
  function setupPlot() {
    const raw = world.variants.plan?.site.boundary_raw;
    if (!raw) return;
    const order = ['street_n', 'street_s', 'splay_e', 'south_bend', 'south_e', 'east_n', 'jog_s', 'north_e'];
    boundary = order.map((k) => raw[k]);
    edges = boundary.map((a, i) => ({ a, b: boundary[(i + 1) % boundary.length], kind: i <= 1 ? 'street' : 'other' }));
    erfArea = Math.abs(boundary.reduce((s, p, i) => { const q = boundary[(i + 1) % boundary.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  }
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
      const [xi, yi] = boundary[i], [xj, yj] = boundary[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const distSeg = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  function corners(item, x, y, rot) {
    const c = Math.cos(rot), s = Math.sin(rot), hw = item.w / 2, hd = item.d / 2;
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
  }
  function samplePoints(item, x, y, rot) { // corners, edge midpoints, centre
    const cs = corners(item, x, y, rot);
    return [...cs, ...cs.map((p, i) => [(p[0] + cs[(i + 1) % 4][0]) / 2, (p[1] + cs[(i + 1) % 4][1]) / 2]), [x, y]];
  }

  // ── Looking at the model ───────────────────────────────────────────
  const solids = () => {
    const g = world.variant().groups;
    return ['terrain', 'house', 'roof', 'carport', 'context_near'].map((k) => g[k]).filter(Boolean);
  };
  function groundAt(x, y) { // highest surface under (x, y): { z, group }
    ray.set(world.b2t(x, y, 60), DOWN);
    ray.far = 200;
    const hit = ray.intersectObjects(solids(), true)[0];
    return hit ? { z: hit.point.y, group: hit.object.userData.group } : { z: 0, group: null };
  }
  function terrainAt(x, y) {
    const g = world.variant().groups;
    ray.set(world.b2t(x, y, 60), DOWN);
    const hit = ray.intersectObjects([g.terrain].filter(Boolean), true)[0];
    return hit ? hit.point.y : 0;
  }

  // ── The rules ──────────────────────────────────────────────────────
  function judge(item, opts, x, y, rot, ignore) {
    const out = [];
    const add = (level, text, ref) => out.push({ level, text, ref });
    for (const a of item.always || []) add(...a);
    for (const [k, def] of Object.entries(item.options)) {
      const table = def === 'roofColour' ? null : def;
      if (table) { const r = table[opts[k]]; if (r && r[1]) add(...r); }
      else {
        const lvl = ROOF_COLOURS[opts[k]];
        if (lvl === NO) add(NO, opts[k] === 'Red' ? 'Red roofs are being phased out. Approved roof colours are black, dark grey and white.' : 'Approved roof colours are black, dark grey and white.', opts[k] === 'Red' ? '3.2.1.6' : '3.2.1.4');
      }
    }
    if (!boundary) return out;
    const pts = samplePoints(item, x, y, rot);
    const outside = pts.filter((p) => !inside(p[0], p[1])).length;
    if (outside) add(NO, `${outside === pts.length ? 'This is' : 'Part of this is'} outside the erf. You cannot build on the neighbour's land or the street.`, 'plot boundary (2020 site plan)');
    else if (!item.noSetback) {
      for (const kind of ['street', 'other']) {
        const d = Math.min(...edges.filter((e) => e.kind === kind).flatMap((e) => pts.map((p) => distSeg(p, e.a, e.b))));
        if (d < SETBACK[kind]) add(ASK, `${d.toFixed(1)} m from the ${kind === 'street' ? 'street' : 'side or back'} boundary, inside the ${SETBACK[kind]} m building line: a departure needs the neighbour, the VAC and the VVHOA.`, '2.6');
      }
    } else {
      const d = Math.min(...edges.filter((e) => e.kind === 'street').flatMap((e) => pts.map((p) => distSeg(p, e.a, e.b))));
      if (d < 1.5) add(ASK, 'Boundary walls between houses and estate roads should be avoided where possible.', '3.3.1.2');
    }
    // sits on something that is already there?
    const base = Math.min(...pts.map((p) => terrainAt(p[0], p[1])));
    const clash = pts.some((p) => { const g = groundAt(p[0], p[1]); return (g.group === 'roof' || g.group === 'carport' || g.z > terrainAt(p[0], p[1]) + 1.5); });
    const others = S.placed.filter((q) => q !== ignore).some((q) => Math.hypot(q.x - x, q.y - y) < (Math.hypot(q.item.w, q.item.d) + Math.hypot(item.w, item.d)) / 2 - 0.4);
    if (clash || others) add(NO, 'There is already something built here.', 'the model');
    // coverage
    if (item.roofed) {
      const cov = coverage(ignore) + item.w * item.d / erfArea;
      if (cov > MAX_COVERAGE) add(NO, `Coverage would be ${(cov * 100).toFixed(0)}% of the erf; the maximum is 50%.`, '2.3');
    }
    if (!out.some((o) => o.level !== OK)) add(OK, 'Nothing in the guideline stands in the way. Any building work still goes to the VAC and the trustees before the City.', 'README');
    out.base = base;
    return out;
  }
  const roofedExisting = () => world.site()?.roofed_footprint_m2 || 0;
  const coverage = (ignore) => (roofedExisting() + S.placed.filter((p) => p !== ignore && p.item.roofed).reduce((s, p) => s + p.item.w * p.item.d, 0)) / erfArea;
  const worst = (list) => (list.some((o) => o.level === NO) ? NO : list.some((o) => o.level === ASK) ? ASK : OK);
  const tint = { ok: 0x7fc28a, consent: 0xe8c25a, fail: 0xe2675a };

  // ── 3D ─────────────────────────────────────────────────────────────
  function makeBox(item, opacity) {
    const h = item.id === 'block' && S.opts.Storeys === 'Three storeys' ? 9.5 : item.id === 'wall' && S.opts.Height === '2.5 m' ? 2.5 : item.h;
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(item.w, h, item.d);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: item.colour, transparent: opacity < 1, opacity, roughness: 0.8 }));
    m.position.y = h / 2; m.castShadow = opacity >= 1; m.receiveShadow = true;
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x1c1612 }));
    e.position.y = h / 2;
    g.add(m, e);
    g.userData = { mesh: m, edge: e };
    return g;
  }
  function poseBox(g, x, y, z, rot, level) {
    g.position.copy(world.b2t(x, y, z));
    g.rotation.y = rot;
    if (level) g.userData.edge.material.color.setHex(tint[level]);
  }
  function drawLines() {
    if (lineGroup) world.scene.remove(lineGroup);
    lineGroup = null;
    if (!boundary || !S.lines || !world.variant()) return;
    lineGroup = new THREE.Group();
    const strip = (pts, color) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      lineGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 })));
    };
    for (const e of edges) {
      const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), n = Math.max(2, Math.ceil(len / 1.5));
      const nx = -(e.b[1] - e.a[1]) / len, ny = (e.b[0] - e.a[0]) / len; // inward normal (boundary runs anticlockwise seen from above)
      const outer = [], inner = [];
      for (let i = 0; i <= n; i++) {
        const x = e.a[0] + (e.b[0] - e.a[0]) * i / n, y = e.a[1] + (e.b[1] - e.a[1]) * i / n;
        outer.push(world.b2t(x, y, groundAt(x, y).z + 0.25));
        const sx = x + nx * SETBACK[e.kind], sy = y + ny * SETBACK[e.kind];
        if (inside(sx, sy)) inner.push(world.b2t(sx, sy, groundAt(sx, sy).z + 0.25));
      }
      strip(outer, 0xe2675a);
      if (inner.length > 1) strip(inner, 0xe8c25a);
    }
    lineGroup.renderOrder = 5;
    world.scene.add(lineGroup);
  }

  // ── Placing ────────────────────────────────────────────────────────
  function startPlacing() {
    stopPlacing();
    S.placing = true; S.submitted = null;
    ghost = makeBox(S.item, 0.55);
    world.scene.add(ghost);
    if (world.state.mode !== 'orbit') world.lookFrom([8, -34, 46], [20, -2, 4]);
  }
  function stopPlacing() {
    S.placing = false;
    if (ghost) world.scene.remove(ghost);
    ghost = null;
  }
  function moveGhost(x, y) {
    const v = judge(S.item, S.opts, x, y, S.rot);
    S.last = { x, y, verdict: v };
    poseBox(ghost, x, y, v.base ?? 0, S.rot, worst(v));
    ghost.userData.mesh.material.color.setHex(tint[worst(v)]);
  }
  function place(x, y, rot = S.rot) {
    const verdict = judge(S.item, S.opts, x, y, rot);
    const g = makeBox(S.item, 1);
    const p = { item: S.item, opts: { ...S.opts }, x, y, rot, verdict, g, id: Math.random().toString(36).slice(2, 7) };
    poseBox(g, x, y, verdict.base ?? 0, rot, worst(verdict));
    world.scene.add(g);
    S.placed.push(p);
    S.last = { x, y, verdict };
    S.submitted = null;
    world.toast(`${S.item.name} placed: ${{ ok: 'fits the guideline', consent: 'needs approval or consent', fail: 'not permitted' }[worst(verdict)]}.`, worst(verdict) === NO ? 'bad' : worst(verdict) === OK ? 'good' : '');
    return p;
  }
  function removePlaced(id) {
    const i = S.placed.findIndex((p) => p.id === id);
    if (i >= 0) { world.scene.remove(S.placed[i].g); S.placed.splice(i, 1); S.submitted = null; }
  }
  function submit() {
    for (const p of S.placed) p.verdict = judge(p.item, p.opts, p.x, p.y, p.rot, p); // re-check with everything in place
    const all = S.placed.flatMap((p) => p.verdict.filter((o) => o.level !== OK).map((o) => ({ ...o, name: p.item.name })));
    const level = !S.placed.length ? null : worst(all);
    S.submitted = { level, fails: all.filter((o) => o.level === NO), asks: all.filter((o) => o.level === ASK) };
  }

  // pointer: in the overview the ghost follows the mouse; a click (not a drag) places it
  const canvas = world.camera && document.querySelector('#view');
  let down = null;
  const pointerXY = (e) => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), world.camera);
    ray.far = 2000;
    const hit = ray.intersectObjects(solids(), true)[0];
    if (!hit) return null;
    const [x, y] = world.t2b(hit.point);
    return [x, y];
  };
  canvas.addEventListener('pointermove', (e) => {
    if (!S.placing || world.state.mode !== 'orbit') return;
    const p = pointerXY(e);
    if (p) moveGhost(p[0], p[1]);
  });
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!S.placing || world.state.mode !== 'orbit' || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || e.button !== 0) return;
    const p = pointerXY(e);
    if (p) { place(p[0], p[1]); world.renderPanel(); }
  });
  window.addEventListener('keydown', (e) => {
    if (!S.placing) return;
    if (e.code === 'KeyR') { S.rot += Math.PI / 12; if (S.last) moveGhost(S.last.x, S.last.y); }
    if (e.code === 'Escape') { stopPlacing(); world.renderPanel(); }
  });
  // on foot the ghost floats four metres ahead
  world.on('frame', () => {
    if (lineGroup) lineGroup.visible = S.lines && (S.placing || world.activeTabId() === 'build');
    if (!S.placing || world.state.mode !== 'walk') return;
    const [x, y] = world.playerPos();
    const yaw = window.game.player.yaw;
    moveGhost(x - Math.sin(yaw) * 4, y + Math.cos(yaw) * 4);
  });
  world.hotspots.push({ id: 'build:place', pos: [0, 0, 0], radius: Infinity, label: () => `Place the ${S.item.name.toLowerCase()} here`, when: () => S.placing && world.state.mode === 'walk' && !!S.last, action: () => place(S.last.x, S.last.y) });

  world.on('variant', () => { setupPlot(); drawLines(); });
  setupPlot(); drawLines();

  // ── Panel ──────────────────────────────────────────────────────────
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const icon = { ok: '<b class="good">✔</b>', consent: '<b class="warn">!</b>', fail: '<b class="bad">✖</b>' };
  const verdictHtml = (v) => v.map((o) => `<li>${icon[o.level]} ${esc(o.text)} <span class="hint">(${esc(o.ref)})</span></li>`).join('');

  world.registerModule({
    id: 'build', title: 'Build', live: true,
    render(el) {
      const cov = coverage();
      let h = `<h3>Build on the plot</h3>
        <p class="hint">Pick something, place it, and see what the Valco aesthetics guideline says. Red line: the erf boundary. Yellow line: the 5 m (street) and 3 m building lines.</p>
        <dl class="kv"><dt>Erf</dt><dd>${erfArea.toFixed(0)} m² (the model's boundary, from the 2020 site plan)</dd>
        <dt>Coverage</dt><dd><div class="meter" style="position:relative" title="max 50% (clause 2.3)"><i style="width:${Math.min(100, cov * 200)}%;background:${cov > MAX_COVERAGE ? 'var(--bad)' : 'var(--good)'}"></i></div>${(cov * 100).toFixed(0)}% of 50% allowed</dd></dl>
        <div class="row">${CATALOGUE.map((c) => `<button data-item="${c.id}" class="${c === S.item ? 'on' : ''}">${c.name}</button>`).join('')}</div>`;
      for (const [k, def] of Object.entries(S.item.options)) {
        const vals = Object.keys(def === 'roofColour' ? ROOF_COLOURS : def);
        h += `<p style="margin:4px 0"><span class="hint">${k}</span><br><select data-opt="${esc(k)}">${vals.map((v) => `<option ${v === S.opts[k] ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></p>`;
      }
      h += `<div class="row"><button data-act="place" class="${S.placing ? '' : 'primary'}">${S.placing ? 'Stop placing' : 'Place it'}</button><button data-act="rot" ${S.placing ? '' : 'disabled'}>Turn (R)</button><label class="chk"><input type="checkbox" data-act="lines" ${S.lines ? 'checked' : ''}> Boundary lines</label></div>`;
      if (S.placing) h += `<p class="hint">${world.state.mode === 'orbit' ? 'Move the mouse over the plot and click to place.' : 'Walk around: it floats ahead of you. Press E to place.'}</p>`;
      if (S.last) h += `<ul class="log" style="max-height:none">${verdictHtml(S.last.verdict)}</ul>`;
      if (S.placed.length) {
        h += `<h3 style="margin-top:10px">On the plot</h3><div class="row">${S.placed.map((p) => `<button data-rm="${p.id}" title="Remove">${icon[worst(p.verdict)]} ${p.item.name} ×</button>`).join('')}</div>
          <div class="row"><button data-act="submit" class="primary">Submit to the VAC</button></div>`;
      }
      if (S.submitted) {
        const s = S.submitted;
        h += s.level === NO ? `<p class="bad">Rejected: ${s.fails.length} point${s.fails.length > 1 ? 's' : ''} against the guideline.</p>`
          : s.level === ASK ? '<p class="warn">Not rejected, but it needs approvals before anyone builds.</p>'
            : '<p class="good">Fits the guideline as far as this game can tell.</p>';
        h += `<ul class="log" style="max-height:none">${[...s.fails, ...s.asks].map((o) => `<li>${icon[o.level]} <b>${esc(o.name)}:</b> ${esc(o.text)} <span class="hint">(${esc(o.ref)})</span></li>`).join('')}</ul>`;
      }
      if (document.activeElement?.tagName === 'SELECT' && el.contains(document.activeElement)) return; // do not rebuild under an open dropdown
      if (el.dataset.html !== h) { el.innerHTML = h; el.dataset.html = h; }
      el.onclick = (e) => {
        const d = e.target.dataset || {};
        if (d.item) { S.item = CATALOGUE.find((c) => c.id === d.item); S.opts = defaults(S.item); S.last = null; if (S.placing) startPlacing(); }
        else if (d.rm) removePlaced(d.rm);
        else if (d.act === 'place') { if (S.placing) stopPlacing(); else startPlacing(); }
        else if (d.act === 'rot') { S.rot += Math.PI / 12; if (S.last) moveGhost(S.last.x, S.last.y); }
        else if (d.act === 'lines') { S.lines = e.target.checked; drawLines(); }
        else if (d.act === 'submit') submit();
        else return;
        el.dataset.html = '';
        world.renderPanel();
      };
      el.onchange = (e) => {
        const k = e.target.dataset?.opt;
        if (!k) return;
        S.opts[k] = e.target.value;
        e.target.blur();
        if (S.placing) { startPlacing(); if (S.last) moveGhost(S.last.x, S.last.y); }
        el.dataset.html = '';
        world.renderPanel();
      };
    },
  });

  window.game.build = {
    S, CATALOGUE, judge, place, submit, startPlacing, stopPlacing, coverage, erfArea: () => erfArea,
    pick(id, opts = {}) { S.item = CATALOGUE.find((c) => c.id === id); S.opts = { ...defaults(S.item), ...opts }; },
    remove: removePlaced,
  };
}
