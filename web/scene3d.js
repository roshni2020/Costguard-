// SwitchProof 3D hero: card terminal → OLD A / OLD B / NEW towers, human gate, and two sandbox pools.
// Dumb view: app.js owns all state and drives it through the small API returned by createScene().
import * as THREE from './vendor/three.module.min.js';

const COL = { bg: 0x060a13, vultr: 0x007bfc, vultrInk: 0x5aa9ff, cyan: 0x22d3ee, good: 0x2fd27a, bad: 0xff4d5e, warn: 0xfbbf24, body: 0x0e1628, line: 0x28375a };
const STATE_COL = { idle: COL.vultrInk, ok: COL.good, bad: COL.bad };
const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const easeBack = (t) => { t = Math.min(1, Math.max(0, t)); const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// Canvas-texture sprite; label.userData.draw(text, opts) redraws in place.
function label(text, opts = {}) {
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false }));
  sprite.renderOrder = 10; // HUD-style: labels stay readable in front of geometry
  sprite.userData.draw = (t, o = opts) => {
    const lines = String(t).split('\n'), fs = o.size || 40, sub = o.subSize || Math.round(fs * 0.62), pad = o.pad ?? 16;
    const f0 = `${o.weight || 800} ${fs}px ${o.mono ? 'ui-monospace, Consolas, monospace' : 'system-ui, "Segoe UI", sans-serif'}`, f1 = `600 ${sub}px system-ui, "Segoe UI", sans-serif`;
    ctx.font = f0; let w = ctx.measureText(lines[0]).width; ctx.font = f1;
    for (const l of lines.slice(1)) w = Math.max(w, ctx.measureText(l).width);
    const W = Math.ceil(w + pad * 2), H = Math.ceil(fs * 1.2 + (lines.length - 1) * sub * 1.35 + pad * 1.2);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; tex.dispose(); }
    ctx.clearRect(0, 0, W, H);
    if (o.bg) { ctx.fillStyle = o.bg; roundRect(ctx, 2, 2, W - 4, H - 4, o.r ?? 12); ctx.fill(); }
    if (o.border) { ctx.strokeStyle = o.border; ctx.lineWidth = 3; roundRect(ctx, 2, 2, W - 4, H - 4, o.r ?? 12); ctx.stroke(); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = f0; ctx.fillStyle = o.fg || '#e6edf7'; ctx.fillText(lines[0], W / 2, pad * 0.6 + fs * 0.6);
    ctx.font = f1; ctx.fillStyle = o.subFg || '#8596b0';
    lines.slice(1).forEach((l, i) => ctx.fillText(l, W / 2, pad * 0.6 + fs * 1.2 + sub * (0.7 + i * 1.35)));
    tex.needsUpdate = true;
    const k = o.scale || 0.011; sprite.scale.set(W * k, H * k, 1);
  };
  sprite.userData.draw(text);
  return sprite;
}

let glowTex = null;
function glow(color, size, opacity = 0.5) {
  if (!glowTex) {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64); grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128); glowTex = new THREE.CanvasTexture(c);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.set(size, size, 1); return s;
}

export function createScene(el, { onTowerClick, onError } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true'); canvas.style.touchAction = 'pan-y';
  el.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COL.bg);
  scene.fog = new THREE.Fog(COL.bg, 20, 46);
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 120);
  const camBase = new THREE.Vector3(0.9, 9.6, 18.2), camTarget = new THREE.Vector3(0.7, 0.5, 0);

  scene.add(new THREE.HemisphereLight(0x9fc2ff, 0x060a13, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1); sun.position.set(6, 12, 9); scene.add(sun);
  const blue = new THREE.PointLight(COL.vultr, 30, 22); blue.position.set(-6, 5, 2); scene.add(blue);

  const grid = new THREE.GridHelper(80, 80, 0x1c2842, 0x0f1729); grid.material.transparent = true; grid.material.opacity = 0.7; scene.add(grid);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x070c17, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.01; scene.add(floor);

  // ---- card terminal ----
  const TERM = new THREE.Vector3(-8.0, 0, -1.6);
  const term = new THREE.Group(); term.position.copy(TERM); term.rotation.y = 0.35; scene.add(term);
  const termBody = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.5, 1.3), new THREE.MeshStandardMaterial({ color: COL.body, emissive: COL.vultr, emissiveIntensity: 0.15, metalness: 0.4, roughness: 0.4 }));
  termBody.position.y = 0.95; term.add(termBody);
  const termEdges = new THREE.LineSegments(new THREE.EdgesGeometry(termBody.geometry), new THREE.LineBasicMaterial({ color: COL.vultrInk }));
  termEdges.position.copy(termBody.position); term.add(termEdges);
  const screen = label('ISO 8583', { mono: true, size: 34, fg: '#22d3ee', bg: 'rgba(4,8,16,.95)', border: 'rgba(34,211,238,.6)', scale: 0.0105 });
  screen.position.set(0, 1.35, 0.9); term.add(screen);
  const keyMat = new THREE.MeshStandardMaterial({ color: 0x1c2842, emissive: COL.vultr, emissiveIntensity: 0.25 });
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { const k = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.3), keyMat); k.position.set(-0.55 + i * 0.55, 0.45 + j * 0.24, 0.66); term.add(k); }
  const termLbl = label('Card terminal', { size: 30, weight: 700, scale: 0.012 }); termLbl.position.set(TERM.x, 2.6, TERM.z); scene.add(termLbl);

  // ---- switch towers ----
  const TOWERS = [['old_a', 'OLD A', 'legacy v4', 2.0], ['old_b', 'OLD B', 'legacy v4', 5.5], ['new', 'NEW', 'NewSwitch v1', 9.0]];
  const towers = {};
  const TZ = -2.4, TH = 3.8;
  for (const [key, name, sub, x] of TOWERS) {
    const g = new THREE.Group(); g.position.set(x, 0, TZ); scene.add(g);
    const mat = new THREE.MeshStandardMaterial({ color: COL.body, emissive: COL.vultrInk, emissiveIntensity: 0.12, metalness: 0.35, roughness: 0.45 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, TH, 1.9), mat); body.position.y = TH / 2; body.userData.tower = key; g.add(body);
    const edgeMat = new THREE.LineBasicMaterial({ color: COL.vultrInk, transparent: true, opacity: 0.9 });
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), edgeMat); edges.position.y = TH / 2; g.add(edges);
    const stripMat = new THREE.MeshBasicMaterial({ color: COL.vultrInk });
    for (let i = 0; i < 4; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(1.94, 0.05, 1.94), stripMat); s.position.y = 0.6 + i * 0.85; g.add(s); }
    const halo = glow(COL.vultrInk, 5.5, 0.18); halo.position.y = TH / 2; g.add(halo);
    const nameLbl = label(`${name}\n${sub}`, { size: 36, subSize: 22, scale: 0.012 }); nameLbl.position.set(0, TH + 0.55, 0); g.add(nameLbl);
    const codeLbl = label('···\nwaiting', { mono: true, size: 40, subSize: 22, bg: 'rgba(10,16,30,.92)', border: 'rgba(90,169,255,.55)', scale: 0.0115 });
    codeLbl.position.set(0, TH + 1.75, 0); g.add(codeLbl);
    towers[key] = { g, body, mat, edgeMat, stripMat, halo, codeLbl, state: 'idle', text: '' };
  }

  // ---- message paths + packets ----
  const START = new THREE.Vector3(TERM.x + 0.9, 1.5, TERM.z + 0.3);
  const curves = TOWERS.map(([key, , , x], i) => new THREE.QuadraticBezierCurve3(START, new THREE.Vector3((START.x + x) / 2, 5.2 + i * 0.9, TZ + 0.6), new THREE.Vector3(x - 0.95, 2.2, TZ)));
  const pathMat = new THREE.MeshBasicMaterial({ color: COL.cyan, transparent: true, opacity: 0.18 });
  const tubes = curves.map((c) => { const m = new THREE.Mesh(new THREE.TubeGeometry(c, 64, 0.025, 6, false), pathMat); scene.add(m); return m; });
  const pktGeo = new THREE.SphereGeometry(0.12, 12, 12), pktMat = new THREE.MeshBasicMaterial({ color: COL.cyan });
  const makePacket = (ci, t0, speed, size = 1) => { const m = new THREE.Mesh(pktGeo, pktMat); const h = glow(COL.cyan, 0.9, 0.7); m.add(h); m.scale.setScalar(size); scene.add(m); return { m, ci, t: t0, speed }; };
  const packets = []; curves.forEach((_, ci) => { for (let j = 0; j < 3; j++) packets.push(makePacket(ci, j / 3 + ci * 0.11, 0.33)); });
  let bursts = [];

  // ---- human gate (padlock barrier) ----
  const GATE_X = -4.7;
  const gate = new THREE.Group(); gate.position.set(GATE_X, 0, TZ + 0.6); gate.rotation.y = -0.65; scene.add(gate); // angled toward the camera
  const postMat = new THREE.MeshStandardMaterial({ color: 0x1c2842, emissive: COL.warn, emissiveIntensity: 0.25 });
  for (const z of [-1.5, 1.5]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.6, 0.16), postMat); p.position.set(0, 1.8, z); gate.add(p); }
  const hinge = new THREE.Group(); hinge.position.set(0, 0, -1.5); gate.add(hinge);
  const panelMat = new THREE.MeshStandardMaterial({ color: COL.warn, emissive: COL.warn, emissiveIntensity: 0.35, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 3.3, 3.0), panelMat); panel.position.set(0, 1.75, 1.5); hinge.add(panel);
  const lock = new THREE.Group(); lock.position.set(0.1, 1.9, 1.5); hinge.add(lock);
  const lockMat = new THREE.MeshStandardMaterial({ color: COL.warn, emissive: COL.warn, emissiveIntensity: 0.8, metalness: 0.5, roughness: 0.3 });
  const lockBody = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.62, 0.78), lockMat); lock.add(lockBody);
  const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.07, 10, 24, Math.PI), lockMat); shackle.rotation.y = Math.PI / 2; shackle.position.y = 0.3; lock.add(shackle);
  const gateLbl = label('HUMAN GATE\nnothing runs until every test is decided', { size: 28, subSize: 20, fg: '#fbbf24', scale: 0.011 }); gateLbl.position.set(GATE_X, 4.4, TZ + 0.6); scene.add(gateLbl);

  // ---- BLOCKED barrier in front of NEW ----
  const barrier = new THREE.Group(); barrier.position.set(9.0, 12, TZ + 1.8); barrier.visible = false; scene.add(barrier);
  const barMat = new THREE.MeshStandardMaterial({ color: 0x8f1020, emissive: COL.bad, emissiveIntensity: 0.9, metalness: 0.3, roughness: 0.4 });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.0, 0.18), barMat); barrier.add(bar);
  const barLbl = label('BLOCKED', { mono: true, size: 60, fg: '#ffffff', scale: 0.011 }); barLbl.position.set(0, 0, 0.2); barrier.add(barLbl);
  const barGlow = glow(COL.bad, 6, 0.45); barrier.add(barGlow);

  // ---- floating callout above NEW ----
  const callout = label('', { size: 34, fg: '#ffffff', bg: 'rgba(196,32,47,.95)', border: 'rgba(255,140,150,.9)', scale: 0.012 });
  callout.position.set(11.6, TH * 0.72, TZ); callout.visible = false; scene.add(callout);

  // ---- two sandbox pools divided by a glass wall ----
  const PZ = 3.8, POOLS = { agent: { x: -4.2, color: COL.vultrInk, title: 'AGENT POOL' }, data: { x: 4.2, color: COL.cyan, title: 'DATA POOL' } };
  for (const [key, p] of Object.entries(POOLS)) {
    const plat = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.22, 2.6), new THREE.MeshStandardMaterial({ color: 0x0b1324, emissive: p.color, emissiveIntensity: 0.06, roughness: 0.6 }));
    plat.position.set(p.x, 0.12, PZ); scene.add(plat);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(plat.geometry), new THREE.LineBasicMaterial({ color: p.color, transparent: true, opacity: 0.7 })); e.position.copy(plat.position); scene.add(e);
    p.lbl = label(`${p.title}\n${key === 'agent' ? 'agent-written tests' : 'replay data, no agent code'}`, { size: 30, subSize: 21, fg: key === 'agent' ? '#5aa9ff' : '#22d3ee', scale: 0.011 });
    p.lbl.position.set(p.x, 1.05, PZ - 1.35); scene.add(p.lbl);
    p.slots = new Array(10).fill(null);
  }
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.2, 3.0), new THREE.MeshStandardMaterial({ color: 0xbfe3ff, emissive: 0x5aa9ff, emissiveIntensity: 0.25, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
  wall.position.set(0, 1.1, PZ); scene.add(wall);
  const wallE = new THREE.LineSegments(new THREE.EdgesGeometry(wall.geometry), new THREE.LineBasicMaterial({ color: COL.warn, transparent: true, opacity: 0.8 })); wallE.position.copy(wall.position); scene.add(wallE);
  const wallLbl = label('separate namespaces · separate VMs', { size: 24, weight: 700, fg: '#fbbf24', scale: 0.011 }); wallLbl.position.set(0, 2.55, PZ); scene.add(wallLbl);

  // ---- pods ----
  const podGeo = new THREE.BoxGeometry(0.52, 0.52, 0.52);
  const pods = new Map();
  const disposeObj = (o) => o.traverse((n) => { if (n.geometry && n.geometry !== podGeo && n.geometry !== pktGeo) n.geometry.dispose(); const ms = Array.isArray(n.material) ? n.material : n.material ? [n.material] : []; ms.forEach((m) => { if (m.map && m.map !== glowTex) m.map.dispose(); m.dispose(); }); });
  function addPod(id, pool = 'agent') {
    if (pods.has(id)) return;
    const P = POOLS[pool] || POOLS.agent;
    let slot = P.slots.indexOf(null); if (slot < 0) { slot = 0; const old = P.slots[0]; if (old) removePod(old); }
    P.slots[slot] = id;
    const mat = new THREE.MeshStandardMaterial({ color: 0x0d1a30, emissive: P.color, emissiveIntensity: 0.9, transparent: true, opacity: 1, metalness: 0.2, roughness: 0.35 });
    const m = new THREE.Mesh(podGeo, mat); const h = glow(P.color, 1.8, 0.35); m.add(h);
    m.position.set(P.x - 2.2 + (slot % 5) * 1.1, 0.55, PZ - 0.5 + Math.floor(slot / 5) * 1.0); m.scale.setScalar(0.001); scene.add(m);
    pods.set(id, { m, mat, halo: h, pool: P, slot, born: clockNow(), state: 'spawn', dieAt: 0 });
  }
  function destroyPod(id) { const p = pods.get(id); if (p && p.state !== 'dying' && !p.dieAt) p.dieAt = Math.max(clockNow(), p.born + 1.2); }
  function removePod(id) { const p = pods.get(id); if (!p) return; scene.remove(p.m); disposeObj(p.m); p.fx?.forEach((o) => { scene.remove(o); disposeObj(o); }); p.pool.slots[p.slot] = null; pods.delete(id); }
  function setRunning(id) { for (const [pid, p] of pods) { p.running = pid === id; if (pid !== id) destroyPod(pid); } }
  function startDissolve(p) {
    p.state = 'dying'; p.d0 = now;
    const n = 24, pos = new Float32Array(n * 3), vel = [];
    for (let i = 0; i < n; i++) { pos.set([p.m.position.x, p.m.position.y, p.m.position.z], i * 3); vel.push(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 2.2, (Math.random() - 0.5) * 2)); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: p.pool.color, size: 0.13, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }));
    pts.userData.vel = vel; scene.add(pts);
    const tag = label('destroyed ✓', { size: 26, weight: 700, fg: '#2fd27a', scale: 0.01 }); tag.position.copy(p.m.position).add(new THREE.Vector3(0, 0.8, 0)); scene.add(tag);
    p.fx = [pts, tag];
  }

  // ---- state ----
  // Real-time clock: while the hero is off-screen rendering pauses, but lifetimes keep counting.
  const clockNow = () => performance.now() / 1000;
  let now = clockNow(), flowing = false, gateMode = 'closed', gateOpenK = 0, blocked = false, barrierY = 12, pulseNew = false;
  let last = {};
  function setTower(key, s) {
    const T = towers[key]; if (!T) return;
    const text = s?.text || '···\nwaiting', state = s?.state || 'idle';
    if (text !== T.text) {
      T.text = text;
      T.codeLbl.userData.draw(text, { mono: true, size: 40, subSize: 22, bg: 'rgba(10,16,30,.92)', border: state === 'bad' ? 'rgba(255,77,94,.95)' : state === 'ok' ? 'rgba(47,210,122,.85)' : 'rgba(90,169,255,.55)',
        fg: state === 'bad' ? '#ff6b7a' : state === 'ok' ? '#6ee7a4' : '#e6edf7', scale: 0.0115 });
      T.base = T.codeLbl.scale.clone(); T.popAt = performance.now() / 1000;
    }
    if (state !== T.state || !T.colored) {
      T.state = state; T.colored = true; const c = STATE_COL[state];
      T.mat.emissive.setHex(c); T.edgeMat.color.setHex(c); T.stripMat.color.setHex(c); T.halo.material.color.setHex(c);
      T.mat.emissiveIntensity = state === 'idle' ? 0.12 : 0.35; T.halo.material.opacity = state === 'idle' ? 0.18 : 0.4;
    }
  }
  function setState(s = {}) {
    flowing = !!s.flowing; gateMode = s.gate || 'closed'; blocked = !!s.blocked;
    for (const k of ['old_a', 'old_b', 'new']) setTower(k, s.towers?.[k]);
    pulseNew = s.towers?.new?.state === 'bad';
    if ((s.callout || '') !== last.callout) { last.callout = s.callout || ''; callout.visible = !!s.callout; if (s.callout) callout.userData.draw(s.callout); }
    if ((s.screen || 'ISO 8583') !== last.screen) { last.screen = s.screen || 'ISO 8583'; screen.userData.draw(last.screen, { mono: true, size: 34, fg: '#22d3ee', bg: 'rgba(4,8,16,.95)', border: 'rgba(34,211,238,.6)', scale: 0.0105 }); }
    const lc = gateMode === 'ready' ? COL.good : COL.warn;
    lockMat.color.setHex(lc); lockMat.emissive.setHex(lc); panelMat.color.setHex(lc); panelMat.emissive.setHex(lc); postMat.emissive.setHex(gateMode === 'open' ? COL.good : lc);
    if (blocked && !barrier.visible) { barrier.visible = true; barrierY = 12; }
    if (!blocked) barrier.visible = false;
  }
  function setPools(p = {}) {
    for (const k of ['agent', 'data']) {
      const txt = `${POOLS[k].title}\n${p[k] || (k === 'agent' ? 'agent-written tests' : 'replay data, no agent code')}`;
      if (txt !== POOLS[k].txt) { POOLS[k].txt = txt; POOLS[k].lbl.userData.draw(txt, { size: 30, subSize: 21, fg: k === 'agent' ? '#5aa9ff' : '#22d3ee', scale: 0.011 }); }
    }
  }
  function pulse() { curves.forEach((_, ci) => bursts.push(makePacket(ci, 0, 0.9, 1.35))); }
  function reset() { for (const id of [...pods.keys()]) removePod(id); bursts.forEach((b) => { scene.remove(b.m); disposeObj(b.m); }); bursts = []; setState({}); }

  // ---- camera drift + pointer parallax + tower click ----
  const pointer = new THREE.Vector2(), par = new THREE.Vector2(), ray = new THREE.Raycaster();
  const bodies = Object.values(towers).map((t) => t.body);
  const onMove = (e) => { const r = canvas.getBoundingClientRect(); pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(pointer, camera); canvas.style.cursor = ray.intersectObjects(bodies).length ? 'pointer' : ''; };
  const onClick = (e) => { onMove(e); ray.setFromCamera(pointer, camera); const hit = ray.intersectObjects(bodies)[0]; if (hit) onTowerClick?.(hit.object.userData.tower); };
  canvas.addEventListener('pointermove', onMove); canvas.addEventListener('click', onClick);

  // ---- loop (paused when hidden or off-screen) ----
  let raf = 0, visible = true, prev = performance.now();
  const clock = { t: 0 };
  function frame(ts) {
    raf = 0;
    try {
      const dt = Math.min(0.05, (ts - prev) / 1000); prev = ts; now = clockNow(); clock.t += dt;
      par.lerp(pointer, 0.05);
      camera.position.set(camBase.x + Math.sin(clock.t * 0.13) * 1.1 + par.x * 1.4, camBase.y + Math.sin(clock.t * 0.19) * 0.3 + par.y * 0.6, camBase.z);
      camera.lookAt(camTarget);
      // packets
      const speed = flowing ? 1 : 0;
      for (const p of packets) { p.m.visible = flowing; if (flowing) { p.t = (p.t + dt * p.speed * speed) % 1; curves[p.ci].getPoint(p.t, p.m.position); } }
      bursts = bursts.filter((b) => { b.t += dt * b.speed; if (b.t >= 1) { scene.remove(b.m); disposeObj(b.m); return false; } curves[b.ci].getPoint(b.t, b.m.position); return true; });
      pathMat.opacity = flowing ? 0.28 : 0.12;
      // towers
      for (const T of Object.values(towers)) {
        if (T.popAt != null) { const k = ease((now - T.popAt) / 0.35); T.codeLbl.scale.copy(T.base).multiplyScalar(1.3 - 0.3 * k); if (k >= 1) T.popAt = null; }
      }
      const tn = towers.new;
      if (pulseNew) { const s = 0.5 + 0.5 * Math.sin(now * 5); tn.mat.emissiveIntensity = 0.3 + 0.5 * s; tn.halo.material.opacity = 0.3 + 0.35 * s; }
      callout.position.y = TH * 0.72 + Math.sin(now * 2) * 0.12;
      // gate
      const target = gateMode === 'open' ? 1 : 0; gateOpenK += (target - gateOpenK) * Math.min(1, dt * 3);
      hinge.rotation.y = -1.75 * gateOpenK; panelMat.opacity = 0.2 * (1 - gateOpenK) + 0.04;
      lock.scale.setScalar(1 - gateOpenK * 0.999); gateLbl.material.opacity = 1 - gateOpenK;
      shackle.position.y = gateMode === 'ready' ? 0.3 + 0.12 * (0.5 + 0.5 * Math.sin(now * 4)) : 0.3;
      // barrier slam
      if (barrier.visible) { barrierY += (1.0 - barrierY) * Math.min(1, dt * 9); barrier.position.y = barrierY + (Math.abs(barrierY - 1) < 0.05 ? Math.sin(now * 30) * 0.01 : 0); barMat.emissiveIntensity = 0.7 + 0.3 * Math.sin(now * 3); }
      // pods
      for (const [id, p] of pods) {
        if (p.state === 'spawn') { p.m.scale.setScalar(Math.max(0.001, easeBack((now - p.born) / 0.45))); if (now - p.born > 0.45) p.state = 'alive'; }
        if (p.state === 'alive') { p.mat.emissiveIntensity = p.running ? 0.7 + 0.5 * Math.sin(now * 6) : 0.6; p.m.rotation.y += dt * (p.running ? 1.2 : 0.3); if (p.dieAt && now >= p.dieAt) { if (now - p.dieAt > 1.5) { removePod(id); continue; } startDissolve(p); } }
        if (p.state === 'dying') {
          const k = (now - p.d0) / 1.1; const s = Math.max(0.001, 1 - ease(k));
          p.m.scale.setScalar(s); p.mat.opacity = 1 - k; p.halo.material.opacity = 0.35 * (1 - k);
          const [pts, tag] = p.fx; const a = pts.geometry.attributes.position;
          pts.userData.vel.forEach((v, i) => { a.setXYZ(i, a.getX(i) + v.x * dt, a.getY(i) + v.y * dt, a.getZ(i) + v.z * dt); });
          a.needsUpdate = true; pts.material.opacity = 1 - k; tag.position.y += dt * 0.7; tag.material.opacity = Math.min(1, 2.2 * (1 - k));
          if (k >= 1) removePod(id);
        }
      }
      renderer.render(scene, camera);
    } catch (e) { stop(); onError?.(e); return; }
    if (visible && !document.hidden) raf = requestAnimationFrame(frame);
  }
  const start = () => { if (!raf && visible && !document.hidden) { prev = performance.now(); raf = requestAnimationFrame(frame); } };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); }); io.observe(el);
  const onVis = () => (document.hidden ? stop() : start()); document.addEventListener('visibilitychange', onVis);
  const resize = () => { const w = el.clientWidth || 1, h = el.clientHeight || 1, a = w / h; renderer.setSize(w, h, false); camera.aspect = a;
    // Narrow screens: back the camera off so the whole switch row still fits horizontally.
    // Wide banners (Run/Evidence/Decision): move in so the towers stay legible.
    const z = a >= 2.2 ? Math.max(14, 18.2 * Math.pow(2.2 / a, 0.45)) : a >= 1.5 ? 18.2 : Math.min(52, (18.2 * 1.5) / a);
    camBase.set(0.9, 9.6 * (z / 18.2), z); camTarget.set(1.4, a >= 2.2 ? 1.6 : 0.5, 0.4);
    scene.fog.near = 20 + (z - 18.2); scene.fog.far = 46 + (z - 18.2);
    camera.updateProjectionMatrix(); canvas.style.width = '100%'; canvas.style.height = '100%'; };
  const ro = new ResizeObserver(resize); ro.observe(el); resize();
  renderer.render(scene, camera); // first frame, also surfaces shader errors early
  start();

  function dispose() {
    stop(); io.disconnect(); ro.disconnect(); document.removeEventListener('visibilitychange', onVis);
    canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('click', onClick);
    disposeObj(scene); podGeo.dispose(); pktGeo.dispose(); glowTex?.dispose(); glowTex = null; renderer.dispose(); canvas.remove();
  }
  return { setState, setPools, pulse, addPod, destroyPod, setRunning, reset, dispose };
}

export function webglAvailable() {
  try { const c = document.createElement('canvas'); return !!(window.WebGL2RenderingContext && c.getContext('webgl2')) || !!c.getContext('webgl'); } catch { return false; }
}
