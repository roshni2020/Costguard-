// Live proof panel: real, checkable values from the Vultr deployment (VM identity, Kubernetes pods right now,
// the last Vultr inference call, the data source). Separate from app.js on purpose; it only reads the API.
const qs = new URLSearchParams(location.search);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const get = async (p) => { const r = await fetch(p, { cache: 'no-store' }); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
const ago = (ts) => { const s = Math.max(0, Math.round((Date.now() - new Date(ts)) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
const short = (s, n = 8) => (s || '').slice(0, n);

const CSS = `
#proof{position:fixed;left:16px;bottom:16px;z-index:40;width:min(470px,calc(100vw - 32px));max-height:min(78vh,760px);overflow:auto;
 background:#0b1220f2;border:1px solid #2a3b5e;border-radius:14px;box-shadow:0 12px 40px #0009;color:#e8eef7;font:14px/1.45 system-ui,sans-serif;backdrop-filter:blur(6px)}
#proof header{display:flex;align-items:center;gap:.5rem;padding:.65rem .9rem;border-bottom:1px solid #22314f;cursor:pointer;position:sticky;top:0;background:#0b1220}
#proof header b{font:700 .8rem/1 ui-monospace,monospace;letter-spacing:.12em}
#proof .dot{width:.55rem;height:.55rem;border-radius:50%;background:#4ade80;box-shadow:0 0 8px #4ade80}
#proof .muted{color:#94a3b8;font-size:.8rem;margin-left:auto}
#proof section{padding:.6rem .9rem;border-bottom:1px solid #1b2842}
#proof h4{margin:0 0 .35rem;font:600 .72rem/1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:#5ea2ff}
#proof .row{display:flex;justify-content:space-between;gap:.6rem;padding:.12rem 0}
#proof .row span:first-child{color:#94a3b8}
#proof code{font:.8rem ui-monospace,monospace;color:#e8eef7;word-break:break-all}
#proof .pod{display:grid;grid-template-columns:1fr auto;gap:.4rem;font:.78rem ui-monospace,monospace;padding:.15rem 0}
#proof .ok{color:#4ade80}#proof .run{color:#fbbf24}#proof .bad{color:#ff6b6b}
#proof pre{white-space:pre-wrap;background:#060a12;border:1px solid #1b2842;border-radius:8px;padding:.5rem;font:.74rem/1.4 ui-monospace,monospace;max-height:180px;overflow:auto;margin:.35rem 0 0}
#proof button{background:#16233d;color:#e8eef7;border:1px solid #2a3b5e;border-radius:7px;padding:.2rem .55rem;font:inherit;font-size:.78rem;cursor:pointer}
#proof a{color:#5ea2ff}
#proof.min section{display:none}
@media (min-width:1600px){#proof{font-size:15px;width:520px}}`;

async function boot() {
  let sys;
  try { sys = await get('/api/system'); } catch { return; }            // no backend (static page): stay hidden
  document.head.append(h('style', { text: CSS }));
  const body = h('div');
  const status = h('span', { class: 'muted', text: 'connecting…' });
  const panel = h('aside', { id: 'proof', 'aria-label': 'Live proof from the Vultr deployment' },
    h('header', { onclick: () => panel.classList.toggle('min'), title: 'Collapse or expand' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }), h('b', { text: 'LIVE PROOF · VULTR' }), status),
    body);
  document.body.append(panel);
  let showPrompt = false, last = 0;
  const tick = async () => {
    try {
      if (Date.now() - last > 15000) { sys = await get('/api/system'); last = Date.now(); }
      const hashId = decodeURIComponent(location.hash.slice(1)).split('/')[0];
      const runs = await get('/api/runs');
      const run = runs.find((r) => r.id === hashId) || runs.find((r) => r.id === qs.get('run')) || runs[0];
      const [live, full, evs] = await Promise.all([
        get('/api/sandboxes/live').catch(() => ({ pods: [] })),
        run ? get(`/api/runs/${run.id}`) : null,
        run ? get(`/api/runs/${run.id}/events`) : [],
      ]);
      render(body, sys, live, full, evs, showPrompt, () => { showPrompt = !showPrompt; tick(); });
      status.textContent = `refreshed ${new Date().toLocaleTimeString()}`;
    } catch (e) { status.textContent = `offline: ${e.message}`; }
  };
  await tick();
  setInterval(tick, 2000);
}

function render(body, sys, live, run, evs, showPrompt, togglePrompt) {
  const vm = sys.control_plane?.vultr || {}, sb = sys.sandbox_host || {}, st = sys.control_plane?.storage || {};
  const secs = [];
  secs.push(h('section', {}, h('h4', { text: 'Vultr VM (control plane)' }),
    row('Host', `${vm.hostname || sys.control_plane?.hostname || '?'} · ${vm.region || '?'}`),
    row('Instance ID', h('code', { text: vm.instance_id || 'not on Vultr' })),
    row('Public IP', h('code', { text: vm.public_ip || '-' }))));

  const pods = live.pods || [];
  const nodes = sb.nodes || [];
  const destroyed = (run?.proofs || []).slice(-4).reverse();
  secs.push(h('section', {}, h('h4', { text: `Vultr Kubernetes · ${sb.mode || '?'}` }),
    row('gVisor RuntimeClass', h('span', { class: sb.runsc ? 'ok' : 'bad', text: sb.runsc ? 'present ✓' : 'missing' })),
    ...nodes.map((n) => row(n.pool || 'node', h('code', { text: `${n.name} ${n.ready ? '✓ ready' : '✗'}` }))),
    h('div', { class: 'muted', style: 'margin:.35rem 0 .15rem', text: `Sandbox pods right now: ${pods.length}` }),
    ...(pods.length ? pods.slice(0, 8).map((p) => h('div', { class: 'pod' },
      h('code', { text: `${p.name} · ${p.node || 'scheduling'} · ${p.runtime}` }),
      h('span', { class: p.phase === 'Running' ? 'run' : 'muted', text: p.phase })))
      : [h('div', { class: 'muted', text: 'none running now: start a run to watch pods appear and get deleted' })]),
    ...(destroyed.length ? [h('div', { class: 'muted', style: 'margin:.35rem 0 .15rem', text: 'Last sandboxes of this run' }),
      ...destroyed.map((p) => h('div', { class: 'pod' }, h('code', { text: `${p.sandbox_id} · ${p.runtime} · ${p.uname.split(' ')[2] || ''}` }),
        h('span', { class: 'ok', text: 'destroyed ✓' })))] : [])));

  const calls = evs.filter((e) => e.kind === 'llm_call');
  const lc = calls[calls.length - 1];
  const ai = h('section', {}, h('h4', { text: 'Last Vultr Serverless Inference call' }));
  if (lc) {
    ai.append(row('Agent · model', `${lc.agent} · ${lc.model}`),
      row('Tokens · time', `${(lc.tokens_in || 0).toLocaleString()} in / ${(lc.tokens_out || 0).toLocaleString()} out · ${((lc.latency_ms || 0) / 1000).toFixed(1)} s`),
      row('When', ago(lc.ts)), row('Calls this run', String(calls.length)),
      h('button', { onclick: togglePrompt, text: showPrompt ? 'Hide real reply' : 'Show real reply' }));
    if (showPrompt) ai.append(h('pre', { text: String(lc.data?.reply || '').slice(0, 1200) }));
  } else ai.append(h('div', { class: 'muted', text: 'no AI call in this run yet' }));
  secs.push(ai);

  const src = [...evs].reverse().find((e) => e.message.startsWith('Replay data source'));
  const ev = run?.github?.evidence_url;
  secs.push(h('section', {}, h('h4', { text: 'Data and storage' }),
    row('Replay data', src ? src.message.replace('Replay data source: ', '') : 'no replay in this run'),
    row('Block Storage', h('code', { text: `${st.device || '?'} · ${st.free_gb ?? '?'} GB free ${st.is_block_storage ? '✓' : ''}` })),
    row('Object Storage', h('code', { text: sys.object_storage?.bucket || 'not configured' })),
    ev ? row('Evidence', h('a', { href: ev, target: '_blank', rel: 'noopener', text: 'evidence.json ↗' })) : null));
  body.replaceChildren(...secs);
}

function row(k, v) { return h('div', { class: 'row' }, h('span', { text: k }), v instanceof Node ? v : h('span', { text: v })); }

// started last: boot() uses the const helpers above, which don't exist until their line has run
if (!qs.has('mock') && !qs.has('snapshot')) boot();
