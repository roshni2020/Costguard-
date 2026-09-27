// SwitchProof UI: vanilla ES module, no build step. Modes: live (default), ?mock=1, ?snapshot=<export.json url>.
const qs = new URLSearchParams(location.search);
const MODE = qs.has('snapshot') ? 'snapshot' : qs.get('mock') === '1' ? 'mock' : 'live';
const $ = (s) => document.querySelector(s);
const TERMINAL = ['blocked', 'approved_for_release'];
const CODES = { '00': 'Approved', 14: 'Invalid card number', 25: 'Original not found', 51: 'Insufficient funds', 54: 'Expired card',
  55: 'Incorrect PIN', 62: 'Restricted card', 94: 'Duplicate transmission', 96: 'System malfunction' };
const MTI = { '0100': 'Authorization', '0200': 'Purchase', '0400': 'Reversal', '0110': 'Authorization response', '0210': 'Purchase response', '0410': 'Reversal response' };
const AGENTS = ['coordinator', 'planner', 'generator', 'executor', 'triage', 'reporter', 'rl'];
const ROLE = { coordinator: 'Runs the tool-calling loop and routes work', planner: 'Turns rules into states worth testing',
  generator: 'Writes ISO 8583 test cases', executor: 'Runs approved tests in gVisor sandboxes', triage: 'Finds the failure boundary with follow-ups',
  reporter: 'Writes the report and GitHub issue', rl: 'Explores for bugs with a learned policy' };
const COLOR = { coordinator: '#3b4cca', planner: '#0e7490', generator: '#7c3aed', executor: '#475569', triage: '#a15c00',
  reporter: '#0f766e', rl: '#1d6fa5', human: '#b0206a', system: '#64748b' };
const RULES = { approve_purchase: 'Approve a purchase when funds are available', decline_insufficient: 'Decline a purchase for insufficient funds',
  reject_duplicate: 'Reject a duplicate purchase (same card, STAN and amount within 60 seconds)', reverse_approved: 'Reverse an approved payment and restore the balance',
  decline_bad_pin: 'Decline an incorrect PIN', decline_expired: 'Decline an expired card', decline_bad_card: 'Decline an unknown card',
  technical_glitch: 'Technical glitch', replay: 'Replayed TabFormer transactions', custom: 'Custom' };
const FIELD = { t: 'Message type', 2: 'Card number', 3: 'Processing code', 4: 'Amount', 7: 'Transmission time (MMDDhhmmss)', 11: 'STAN',
  14: 'Expiry (YYMM)', 18: 'Merchant category', 22: 'Entry mode', 37: 'Retrieval reference', 39: 'Response code', 41: 'Terminal ID', 48: 'Private data', 49: 'Currency' };
const STEPS = [['rules', 'Rules'], ['review', 'Review tests'], ['run', 'Run in sandboxes'], ['evidence', 'Evidence'], ['decision', 'Decision']];
const TABS = [['agents', 'Agents'], ['safety', 'Safety'], ['rl', 'RL explorer']];
const STATUS_VIEW = { draft: 'review', planning: 'review', awaiting_approval: 'review', running: 'run', triaging: 'run',
  awaiting_decision: 'evidence', blocked: 'decision', approved_for_release: 'decision' };
const STATUS_LABEL = { draft: 'Draft', planning: 'Agents planning', awaiting_approval: 'Awaiting your approval', running: 'Running in sandboxes',
  triaging: 'Triage investigating', awaiting_decision: 'Awaiting decision', blocked: 'Migration blocked', approved_for_release: 'Release approved' };
const ORDER = Object.keys(STATUS_VIEW);
const CONV_KINDS = ['message', 'tool_call', 'tool_result', 'llm_call', 'decision'];

const S = { runs: [], run: null, events: [], agents: [], system: null, probe: null, results: null, triageResults: null,
  view: 'rules', verdict: 'regression', sel: null, editing: null, convAgent: '', showLLM: true, findingSeen: false, flashUntil: 0,
  busy: false, probing: false, loadingResults: false, dirty: false, lastKey: '' };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (n) => Number(n ?? 0).toLocaleString('en-US');
const usd = (c, signed = false) => (c < 0 ? '−' : signed && c > 0 ? '+' : '') + '$' + (Math.abs(c ?? 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mask = (pan) => '•••• ' + String(pan ?? '').slice(-4);
const secs = (n) => String(+Number(n ?? 0).toFixed(2));
const dt = (t) => (t ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const tm = (t) => (t ? new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');
const yes = (v) => (v === true ? '<span class="good" aria-label="yes">✓</span>' : v === false ? '<span class="bad" aria-label="no">✗</span>' : '<span class="muted" aria-label="unknown">?</span>');
const code = (c) => `<span class="code"><b>${esc(c)}</b>${esc(CODES[c] || 'Unknown code')}</span>`;
const col = (a) => COLOR[a] || COLOR.system;
const nm = (a) => (a === 'rl' ? 'RL' : a);
const safeUrl = (u) => (/^https:\/\//i.test(u || '') ? u : '#');
const runtimeLabel = (r) => (r === 'runsc' ? 'gVisor (runsc)' : 'local-unsafe (dev)');
const lastSeq = () => S.events.at(-1)?.seq ?? 0;
const stage = (st) => ORDER.indexOf(st);
const httpErr = (status, detail) => Object.assign(new Error(detail), { status });

function toast(msg, kind = '') {
  if ([...document.querySelectorAll('.toast')].some((t) => t.textContent === msg)) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

function stepText(s, prev) {
  const at = `at t+${secs(s.at_offset_s)}s`;
  const noun = s.mti === '0400' ? 'reversal' : s.mti === '0100' ? 'authorization' : 'purchase';
  if (prev && prev.mti === s.mti && prev.pan === s.pan && prev.amount_cents === s.amount_cents && prev.stan === s.stan) return `Same ${noun} again ${at}`;
  const extra = [s.entry_mode === 'swipe' && 'swiped', s.entry_mode === 'online' && 'online', s.pin_ok === false && 'incorrect PIN', s.force_glitch && 'issuer glitch'].filter(Boolean);
  const base = s.mti === '0400' ? `Reverse STAN ${s.original_stan} (${usd(s.amount_cents)}) on card ${mask(s.pan)}` : `${s.mti === '0100' ? 'Authorize' : 'Purchase'} ${usd(s.amount_cents)} on card ${mask(s.pan)}`;
  return `${base}, STAN ${s.stan}${extra.length ? ', ' + extra.join(', ') : ''}, ${at}`;
}

// Minimal safe markdown: escape first, then headings, bold, code, tables, lists.
function md(src) {
  const inline = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>').replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
  const out = []; let list = null, table = null, fence = null;
  const flush = () => { if (list) out.push(`<${list.t}>${list.items.join('')}</${list.t}>`); if (table) out.push(`<div class="tbl-wrap"><table>${table.join('')}</table></div>`); list = table = null; };
  for (const raw of esc(src).split('\n')) {
    if (raw.startsWith('```')) { if (fence) { out.push(`<pre>${fence.join('\n')}</pre>`); fence = null; } else { flush(); fence = []; } continue; }
    if (fence) { fence.push(raw); continue; }
    const line = raw.trim(); let m;
    if (/^\|.*\|$/.test(line)) {
      if (list) flush();
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      const cells = line.slice(1, -1).split('|').map((c) => inline(c.trim()));
      const tag = table ? 'td' : 'th';
      (table ||= []).push(`<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`);
    } else if ((m = line.match(/^([-*]|\d+\.)\s+(.*)/))) {
      const t = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (table || (list && list.t !== t)) flush();
      (list ||= { t, items: [] }).items.push(`<li>${inline(m[2])}</li>`);
    } else {
      flush();
      if ((m = line.match(/^(#{1,4})\s+(.*)/))) out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`);
      else if (line) out.push(`<p>${inline(line)}</p>`);
    }
  }
  flush();
  if (fence) out.push(`<pre>${fence.join('\n')}</pre>`);
  return out.join('');
}

// ---------- API: live / mock / snapshot ----------
async function api(method, path, body) {
  if (MODE === 'mock') return mockApi(method, path, body);
  if (MODE === 'snapshot') return snapApi(method, path);
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(r.status, typeof j.detail === 'string' ? j.detail : `${method} ${path} failed (${r.status})`);
  return j;
}

function filterResults(items, params) {
  const v = params.get('verdict');
  return items.filter((x) => !v || x.result.verdict === v).slice(0, +(params.get('limit') || 200));
}

function deriveAgents(events, status, base = AGENTS.map((name) => ({ name, role: ROLE[name], model: null }))) {
  const lastEv = events.at(-1);
  return base.map((a) => {
    const mine = events.filter((e) => e.agent === a.name), llm = mine.filter((e) => e.kind === 'llm_call');
    const state = TERMINAL.includes(status) ? 'done' : status?.startsWith('awaiting') ? (a.name === 'coordinator' ? 'waiting_human' : mine.length ? 'done' : 'idle')
      : lastEv?.agent === a.name ? 'acting' : mine.length ? 'done' : 'idle';
    return { ...a, model: a.model || llm[0]?.model || null, state, last_message: mine.at(-1)?.message || '',
      llm_calls: llm.length, tokens: llm.reduce((s, e) => s + (e.tokens_in || 0) + (e.tokens_out || 0), 0) };
  });
}

// Mock mode: replays the whole story from web/mock/*.json with local state changes.
const FX = {};
const M = { run: null, t0: 0, rlT0: 0, decisionEvents: [] };
const DUR = { planning: 5000, running: 10000, triaging: 4000 };
async function loadMock() {
  const names = ['run_awaiting_approval', 'run_awaiting_decision', 'results_regression', 'events', 'events_conversation', 'agents', 'system', 'probe', 'rl_report'];
  await Promise.all(names.map(async (n) => { FX[n] = await (await fetch(`mock/${n}.json`)).json(); }));
}
function mockAdvance() {
  const r = M.run; if (!r) return;
  const el = Date.now() - M.t0, aw = FX.run_awaiting_decision;
  if (r.status === 'planning' && el > DUR.planning) Object.assign(r, { status: 'awaiting_approval', plan: clone(aw.plan), cases: clone(FX.run_awaiting_approval.cases) });
  if (r.status === 'running') {
    const p = Math.min(1, el / DUR.running);
    r.counts = Object.fromEntries(Object.entries(aw.counts).map(([k, v]) => [k, Math.round(v * p)]));
    r.proofs = clone(aw.proofs.slice(0, Math.ceil(p * aw.proofs.length)));
    r.sandboxes_used = r.proofs.length;
    if (p >= 1) { r.status = 'triaging'; M.t0 = Date.now(); }
  } else if (r.status === 'triaging' && el > DUR.triaging) {
    Object.assign(r, { status: 'awaiting_decision', triage: clone(aw.triage), github: clone(aw.github), cases: [...r.cases, ...clone(aw.cases.filter((c) => c.source === 'triage'))] });
  }
  if (r.rl.status === 'running' && Date.now() - M.rlT0 > 4000) r.rl = clone(FX.rl_report);
}
function mockEvents() {
  const r = M.run; if (!r) return [];
  const el = Date.now() - M.t0;
  const [cur, f] = { draft: [0, 0], planning: [0, el / DUR.planning], awaiting_approval: [0, 1], running: [1, el / DUR.running], triaging: [2, el / DUR.triaging] }[r.status] || [2, 1];
  const all = [...FX.events, ...FX.events_conversation].sort((a, b) => a.seq - b.seq);
  const out = [];
  ['plan', 'run', 'triage'].forEach((ph, i) => {
    const evs = all.filter((e) => e.data.phase === ph);
    if (i < cur) out.push(...evs); else if (i === cur) out.push(...evs.slice(0, Math.ceil(Math.min(1, f) * evs.length)));
  });
  return [...out, ...M.decisionEvents];
}
async function mockApi(method, path, body = {}) {
  await sleep(120);
  mockAdvance();
  const [p, q] = path.split('?'), params = new URLSearchParams(q), r = M.run;
  if (p === '/api/system') return clone(FX.system);
  if (p === '/api/system/probe') { await sleep(1500); return clone(FX.probe); }
  if (p === '/api/runs' && method === 'GET') return r ? [{ ...clone(r), cases: [] }] : [];
  if (p === '/api/runs') {
    M.run = { ...clone(FX.run_awaiting_approval), ...body, id: 'run_mock01', status: 'draft', created_at: new Date().toISOString(), plan: [], cases: [],
      replay: { enabled: false, sample_size: 2000, dataset: 'tabformer' } };
    M.decisionEvents = [];
    return clone(M.run);
  }
  if (!r) throw httpErr(404, 'Run not found');
  const rest = p.split('/').slice(4).join('/');
  const key = `${method} ${rest.replace(/^cases\/.+$/, 'cases/:id')}`;
  const bump = (ph) => { M.t0 = Date.now(); r.status = ph; return { ok: true }; };
  switch (key) {
    case 'GET ': return clone(r);
    case 'POST generate': return bump('planning');
    case 'PATCH cases/:id': { const c = r.cases.find((x) => x.id === rest.split('/')[1]); if (!c) throw httpErr(404, 'Case not found'); Object.assign(c, body); return clone(c); }
    case 'POST approve_all': { const ps = r.cases.filter((c) => c.status === 'proposed'); ps.forEach((c) => { c.status = 'approved'; }); return { approved: ps.length }; }
    case 'PATCH replay': r.replay = { ...r.replay, ...body }; return clone(r);
    case 'POST execute': {
      const n = r.cases.filter((c) => c.status === 'proposed').length;
      if (n) throw httpErr(409, `${n} test${n > 1 ? 's are' : ' is'} still proposed. Approve or reject every test first.`);
      return bump('running');
    }
    case 'GET events': return mockEvents().filter((e) => e.seq > +(params.get('after') || 0));
    case 'GET results': return filterResults(FX.results_regression, params);
    case 'GET agents': return deriveAgents(mockEvents(), r.status, FX.agents);
    case 'GET export': return { run: clone(r), results: FX.results_regression, events: mockEvents() };
    case 'GET rl': return clone(r.rl);
    case 'POST rl': M.rlT0 = Date.now(); r.rl = { status: 'running' }; return { ok: true };
    case 'POST decision': {
      const block = body.decision === 'block', ts = new Date().toISOString(), seq = (mockEvents().at(-1)?.seq || 0) + 1;
      Object.assign(r, { status: block ? 'blocked' : 'approved_for_release', decision: { ...body, ts }, github: { ...r.github, status_state: block ? 'failure' : 'success' } });
      M.decisionEvents = [
        { seq, ts, agent: 'human', kind: 'decision', to_agent: 'coordinator', message: `${block ? 'Blocked migration' : 'Approved release'}${body.note ? ': ' + body.note : ''}`, data: {} },
        { seq: seq + 1, ts, agent: 'reporter', kind: 'decision', message: `GitHub check set to ${block ? 'failure' : 'success'}`, data: {} }];
      return clone(r);
    }
  }
  throw httpErr(404, `Mock has no route for ${method} ${path}`);
}

// Snapshot mode: read-only replay of an exported run.
let SNAP = null;
async function snapApi(method, path) {
  if (method !== 'GET') throw httpErr(405, 'This is a recorded run, so it is read-only.');
  if (!SNAP) { const r = await fetch(qs.get('snapshot')); if (!r.ok) throw httpErr(r.status, 'Could not load the recorded run'); SNAP = await r.json(); }
  const { run, results, events } = SNAP, [p, q] = path.split('?'), params = new URLSearchParams(q);
  if (p === '/api/system') {
    const runsc = run.proofs.some((x) => x.runtime === 'runsc');
    return { control_plane: { hostname: 'recorded' }, sandbox_host: { kvm: null, runsc, mode: runsc ? 'gvisor' : 'local', active_sandboxes: 0, hostname: 'recorded' },
      llm: { model: events.find((e) => e.model)?.model || '', reachable: null } };
  }
  if (p === '/api/runs') return [{ ...run, cases: [] }];
  const rest = p.split('/').slice(4).join('/');
  if (rest === '') return run;
  if (rest === 'events') return events.filter((e) => e.seq > +(params.get('after') || 0));
  if (rest === 'results') return filterResults(results, params);
  if (rest === 'agents') return deriveAgents(events, run.status);
  if (rest === 'rl') return run.rl;
  throw httpErr(404, 'Not recorded');
}

// ---------- data loading ----------
function addEvents(evs) {
  const seen = new Set(S.events.map((e) => e.seq));
  const fresh = evs.filter((e) => !seen.has(e.seq));
  S.events = [...S.events, ...fresh].sort((a, b) => a.seq - b.seq);
  if (!S.findingSeen && fresh.some((e) => e.kind === 'finding')) { S.findingSeen = true; S.flashUntil = Date.now() + 3000; }
}

async function selectRun(id, view) {
  try {
    const [run, evs] = await Promise.all([api('GET', `/api/runs/${id}`), api('GET', `/api/runs/${id}/events?after=0`)]);
    Object.assign(S, { run, events: [], results: null, triageResults: null, sel: null, editing: null, probe: null });
    addEvents(evs);
    S.findingSeen = S.events.some((e) => e.kind === 'finding'); S.flashUntil = 0;
    S.view = view || STATUS_VIEW[run.status];
    S.agents = await api('GET', `/api/runs/${id}/agents`).catch(() => deriveAgents(S.events, run.status));
  } catch (e) { toast(`Could not open run: ${e.message}`, 'err'); }
  render(true);
}

async function refreshRun() {
  const id = S.run.id, prev = S.run.status;
  const [run, evs] = await Promise.all([api('GET', `/api/runs/${id}`), api('GET', `/api/runs/${id}/events?after=${lastSeq()}`)]);
  if (S.run?.id !== id) return;
  S.run = run; addEvents(evs);
  S.agents = await api('GET', `/api/runs/${id}/agents`).catch(() => deriveAgents(S.events, run.status));
  if (run.status !== prev) { S.results = S.triageResults = null; if (STEPS.some(([v]) => v === S.view)) S.view = STATUS_VIEW[run.status]; }
}

async function loadResults() {
  if (S.loadingResults || !S.run) return;
  S.loadingResults = true;
  try {
    const id = S.run.id, v = S.verdict === 'all' ? '' : `verdict=${S.verdict}&`;
    const needTri = !S.triageResults && S.run.cases.some((c) => c.source === 'triage');
    // ponytail: boundary chart pulls all results once per status change; add a server-side source filter if runs grow past ~10k.
    const [list, all] = await Promise.all([api('GET', `/api/runs/${id}/results?${v}limit=200`), needTri ? api('GET', `/api/runs/${id}/results?limit=5000`) : null]);
    S.results = list;
    if (needTri) S.triageResults = all.filter((x) => x.case.source === 'triage'); else S.triageResults ||= [];
    if (!list.some((x) => x.case.id === S.sel)) S.sel = list[0]?.case.id ?? null;
  } catch (e) { toast(`Could not load results: ${e.message}`, 'err'); S.results = []; S.triageResults ||= []; }
  S.loadingResults = false;
  render();
}

let ticks = 0;
async function tick() {
  if (ticks++ % 10 === 0) {
    try { S.system = await api('GET', '/api/system'); } catch (e) { S.system = { error: e.message }; }
    try { S.runs = await api('GET', '/api/runs'); } catch (e) { toast(`Could not list runs: ${e.message}`, 'err'); }
  }
  try {
    if (S.run && !TERMINAL.includes(S.run.status)) await refreshRun();
    if (S.run?.rl?.status === 'running') S.run.rl = await api('GET', `/api/runs/${S.run.id}/rl`);
  } catch (e) { toast(e.message, 'err'); }
  render();
}

async function act(fn) {
  S.busy = true; render();
  let ok = true;
  try { await fn(); } catch (e) { ok = false; toast(e.status === 409 ? `Blocked by the approval gate: ${e.message}` : e.message, 'err'); }
  S.busy = false;
  if (S.run) { try { await refreshRun(); } catch { /* next tick retries */ } }
  render(ok); // on failure keep any half-edited form as the user left it
}

// ---------- shared fragments ----------
const SRC = { llm: 'Vultr AI', dataset: 'TabFormer replay', triage: 'Triage follow-up', rl: 'RL explorer', human: 'Human' };
const badge = (src) => `<span class="chip src-${esc(src)}">${esc(SRC[src] || src)}</span>`;
const verdictChip = (v) => `<span class="chip v-${esc(v)}">${v === 'regression' ? '✗ ' : v === 'pass' ? '✓ ' : ''}${esc({ both_wrong: 'both wrong' }[v] || v)}</span>`;
const gateChip = (st) => (st ? `<span class="chip gate-${esc(st)}">GitHub release check: ${esc(st)}</span>` : '');
const agentStrip = () => `<div class="strip">${S.agents.map((a) => `<span title="${esc(a.state)}"><i class="dot ${esc(a.state)}"></i>${esc(nm(a.name))} <span class="sr">${esc(a.state)}</span></span>`).join('')}</div>`;
const feed = (evs) => `<ol class="feed">${evs.map((e) => `<li class="k-${esc(e.kind)}"><span class="ag" style="--c:${col(e.agent)}">${esc(nm(e.agent))}</span><time>${tm(e.ts)}</time><span>${esc(e.message)}</span></li>`).join('') || '<li><span></span><span></span><span class="muted">No activity yet.</span></li>'}</ol>`;
const empty = (msg) => `<section class="card"><p class="muted">${msg}</p></section>`;
const lock = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z"/></svg>';

function findingText() {
  const f = S.events.find((e) => e.kind === 'finding'); if (!f) return '';
  const d = f.data || {}, c = S.run.cases.find((x) => x.id === d.case_id);
  if (c?.rule === 'reject_duplicate') return `New switch approved a duplicate ${usd(c.steps[0].amount_cents)} payment`;
  if (d.old_code === '94' && d.new_code === '00') { // legacy said duplicate, new approved: extra debit = the duplicate amount
    const bd = d.balance_delta_cents || {}, pan = Object.keys(bd.old_a || {})[0];
    const extra = pan != null ? (bd.old_a[pan] - (bd.new?.[pan] ?? 0)) : 0;
    return `New switch approved a duplicate ${extra > 0 ? usd(extra) + ' ' : ''}payment`;
  }
  return f.message;
}

const findingBanner = () => { const t = S.findingSeen && findingText(); return t ? `<div class="banner danger ${Date.now() < S.flashUntil ? 'flash' : ''}" role="alert">✗ ${esc(t)}</div>` : ''; };

// ---------- views ----------
const DEFAULT_RULES = 'Legacy v4 checks every 0100/0200 in this order: unknown card -> 14; blocked card -> 62; expired card -> 54; incorrect PIN -> 55; issuer glitch -> 96; duplicate (same card, STAN and amount within 60 seconds) -> 94; balance below amount -> 51; otherwise approve 00 and debit. 0400 reversals: original not found or not approved -> 25; already reversed -> 94; otherwise credit back 00.';
const DEFAULT_SPEC = 'ISO 8583 (ASCII). MTI 0100 auth, 0200 purchase, 0400 reversal. Fields: 2 card number, 3 processing code, 4 amount (12 digits, cents), 7 transmission time MMDDhhmmss, 11 STAN, 14 expiry YYMM, 18 MCC, 22 entry mode, 37 retrieval ref, 39 response code, 41 terminal id, 48 private data, 49 currency (840 = USD).';

function viewRules() {
  const r = S.run;
  if (r) {
    return `<section class="card"><h2>${esc(r.title)}</h2><p class="muted">Submitted ${dt(r.created_at)} · ${esc(STATUS_LABEL[r.status])}</p>
      <h3>Requirements</h3><ol>${r.requirements.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
      <p><b>Bounds:</b> up to ${usd(r.bounds.max_amount_cents)} per transaction · ${r.bounds.allowed_mti.map((m) => esc(MTI[m] || m)).join(', ')} · automatic follow-ups ${r.bounds.auto_followups ? 'on' : 'off'}</p>
      <p><b>Replay:</b> ${r.replay.enabled ? `${num(r.replay.sample_size)} transactions from IBM's public synthetic TabFormer benchmark` : 'off'}</p>
      <details data-k="rules-src"><summary>Legacy rules and message spec</summary><p>${esc(r.rules_text)}</p><p>${esc(r.spec_text)}</p></details></section>`;
  }
  const reqs = [RULES.approve_purchase, RULES.decline_insufficient, RULES.reject_duplicate, RULES.reverse_approved].join('\n');
  return `<form class="card" data-form="new-run"><h2>1 · Rules</h2><p class="muted">Describe what the new switch must do. Agents on Vultr Serverless Inference will propose tests; you approve every test before anything runs.</p>
    <label for="f-title">Title</label><input id="f-title" name="title" type="text" required value="Core switch migration — Legacy v4 → NewSwitch v1">
    <label for="f-req">Requirements</label><textarea id="f-req" name="requirements" rows="5" required>${esc(reqs)}</textarea><p class="hint">One rule per line.</p>
    <label for="f-rules">Legacy rules (check order)</label><textarea id="f-rules" name="rules_text" rows="4">${esc(DEFAULT_RULES)}</textarea>
    <label for="f-spec">Message spec</label><textarea id="f-spec" name="spec_text" rows="3">${esc(DEFAULT_SPEC)}</textarea>
    <fieldset><legend>Bounds for agents</legend>
      <label for="f-max">Maximum amount per transaction (USD)</label><input id="f-max" name="max_amount" type="number" min="1" step="0.01" value="1000.00" required>
      <div role="group" aria-label="Allowed message types">${['0100', '0200', '0400'].map((m) => `<label class="inline"><input type="checkbox" name="mti" value="${m}" checked> ${m} ${MTI[m]}</label>`).join('')}</div>
      <label class="inline"><input type="checkbox" name="auto" checked> Allow automatic follow-ups</label>
      <p class="hint">The triage agent may run extra tests without asking again, but only inside these bounds.</p></fieldset>
    <fieldset><legend>Transaction replay</legend>
      <label class="inline"><input type="checkbox" name="replay" checked> Replay 2,000 transactions from IBM's public synthetic TabFormer benchmark</label>
      <label for="f-sample">Sample size</label><input id="f-sample" name="sample" type="number" min="1" max="20000" value="2000"></fieldset>
    <div class="row end"><button class="btn primary" type="submit" ${S.busy ? 'disabled' : ''}>Generate tests with Vultr AI</button></div></form>`;
}

function stepsList(c) {
  return `<ol class="steps">${c.steps.map((s, i) => `<li>${esc(stepText(s, c.steps[i - 1]))} <span class="muted">→ expect</span> ${code(c.expected_codes[i])}</li>`).join('')}</ol>`;
}

function caseCard(c, editable) {
  const id = esc(c.id), pressed = (v) => `aria-pressed="${c.status === v}"`;
  const body = S.editing === c.id
    ? `<form data-form="case-edit" data-id="${id}">${c.steps.map((s, i) => `<div class="edit-row"><span class="muted">Step ${i + 1}</span>
        <label>Amount (USD)<input type="number" name="amt${i}" step="0.01" min="0.01" max="${S.run.bounds.max_amount_cents / 100}" value="${(s.amount_cents / 100).toFixed(2)}"></label>
        <label>At t+ (seconds)<input type="number" name="gap${i}" step="0.1" min="0" value="${s.at_offset_s}"></label>
        <label>Expected code<select name="code${i}">${Object.keys(CODES).map((k) => `<option value="${k}" ${k === c.expected_codes[i] ? 'selected' : ''}>${k} ${CODES[k]}</option>`).join('')}</select></label></div>`).join('')}
        <div class="row"><button class="btn small primary" type="submit">Save</button><button class="btn small" type="button" data-act="case-cancel">Cancel</button></div></form>`
    : stepsList(c);
  return `<article class="case ${esc(c.status)}"><header><h4>${esc(c.title)}</h4>${badge(c.source)}<span class="chip st-${esc(c.status)}">${esc(c.status)}</span></header>
    ${body}${c.rationale ? `<p class="why">${esc(c.rationale)}</p>` : ''}
    ${editable && S.editing !== c.id ? `<div class="row"><button class="btn small ok" data-act="case-status" data-id="${id}" data-v="approved" ${pressed('approved')}>Approve</button>
      <button class="btn small no" data-act="case-status" data-id="${id}" data-v="rejected" ${pressed('rejected')}>Reject</button>
      <button class="btn small" data-act="case-edit" data-id="${id}">Edit</button></div>` : ''}</article>`;
}

function viewReview() {
  const r = S.run;
  if (!r) return empty('Start a new migration test to generate test cases.');
  const cases = r.cases.filter((c) => c.source !== 'triage');
  if (!cases.length) {
    return `<section class="card"><h2><span class="spin"></span> Agents are planning your tests on Vultr Serverless Inference…</h2>
      <p class="muted">The coordinator asks the planner to break each rule into states, then the generator writes ISO 8583 test cases. Nothing runs yet.</p>
      ${agentStrip()}${feed(S.events.slice(-14).reverse())}</section>`;
  }
  const open = r.status === 'awaiting_approval', proposed = cases.filter((c) => c.status === 'proposed').length;
  const n = (st) => cases.filter((c) => c.status === st).length;
  const groups = [...new Set(cases.map((c) => c.rule))];
  const label = (rule) => r.plan.find((p) => p.rule === rule)?.description || RULES[rule] || rule;
  return `<div class="banner gate">${lock}<div><b>Nothing runs until every test is approved or rejected.</b>
      <div class="muted">${n('approved')} approved · ${n('rejected')} rejected · ${proposed} waiting · Replay: ${r.replay.enabled ? `${num(r.replay.sample_size)} TabFormer transactions (switched on by you)` : 'off'}</div></div>
      <span class="spacer"></span>${open ? `<button class="btn" data-act="approve-all" ${S.busy || !proposed ? 'disabled' : ''}>Approve all</button>
      <button class="btn primary" data-act="execute" ${S.busy || proposed ? 'disabled' : ''} title="${proposed ? 'Approve or reject every test first' : ''}">Run approved tests in sandboxes</button>` : `<span class="chip">${esc(STATUS_LABEL[r.status])}</span>`}</div>
    ${groups.map((g) => `<h3 class="rule-h">${esc(label(g))}</h3>${cases.filter((c) => c.rule === g).map((c) => caseCard(c, open)).join('')}`).join('')}`;
}

function viewRun() {
  const r = S.run;
  if (!r) return empty('No run selected.');
  if (stage(r.status) < stage('running')) return empty('The sandbox run starts after you approve the tests in step 2.');
  const c = r.counts, planned = r.cases.filter((x) => x.status === 'approved' && x.source !== 'triage').length + (r.replay.enabled ? r.replay.sample_size : 0);
  const pct = r.status === 'running' ? Math.min(100, (100 * c.total) / Math.max(1, planned)) : 100;
  const tile = (p) => `<div class="tile"><b>${esc(p.sandbox_id)}</b>${esc(runtimeLabel(p.runtime))}<br>host ${esc(p.hostname)} · network ${esc(p.network)}<br>${r.status === 'running' && p === r.proofs.at(-1) ? '<span class="spin"></span> running' : '<span class="good">destroyed ✓</span>'}</div>`;
  return `${findingBanner()}
    <div class="counters">
      <div class="counter"><div class="num">${num(c.total)}</div><small>tests executed</small></div>
      <div class="counter good"><div class="num">${num(c.passed)}</div><small>✓ passed</small></div>
      <div class="counter bad"><div class="num">${num(c.regression)}</div><small>✗ regressions (new differs from old)</small></div>
      <div class="counter"><div class="num">${num(c.error)}</div><small>errors · ${num(c.noise)} noise · ${num(c.both_wrong)} both wrong</small></div></div>
    <div class="progress" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="Run progress"><div style="width:${pct}%"></div></div>
    <p class="muted">${r.status === 'running' ? `<span class="spin"></span> Running ${num(c.total)} of about ${num(planned)} in throwaway gVisor sandboxes on the sandbox VM` : r.status === 'triaging' ? '<span class="spin"></span> Triage agent is running follow-ups inside your bounds' : 'Run complete.'} · ${num(r.sandboxes_used)} sandboxes used</p>
    <div class="grid2"><section class="card"><h3>Sandboxes</h3><div class="tiles">${r.proofs.map(tile).join('') || '<p class="muted">Starting…</p>'}</div></section>
      <section class="card"><h3>Agents</h3>${agentStrip()}${feed(S.events.slice(-40).reverse())}</section></div>`;
}

function boundaryChart(items) {
  // Only pure retries (same card, amount and STAN, differing only in time) belong on the gap axis.
  const retry = (st) => st.length === 2 && st[0].pan === st[1].pan && st[0].amount_cents === st[1].amount_cents && st[0].stan === st[1].stan;
  const pts = items.filter((x) => retry(x.case.steps) && x.result.steps.length === 2).map((x) => {
    const st = x.case.steps, rs = x.result.steps.at(-1);
    return { gap: st.at(-1).at_offset_s - st[0].at_offset_s, old: rs.old_a_code, neu: rs.new_code, reg: x.result.verdict === 'regression' };
  }).sort((a, b) => a.gap - b.gap);
  if (!pts.length) return '';
  const W = 660, L = 120, dx = (W - L - 30) / Math.max(1, pts.length - 1), X = (i) => L + i * dx;
  const fill = (cd, reg) => (reg ? 'var(--bad)' : cd === '94' ? 'var(--blue)' : 'var(--gray)');
  const node = (i, y, cd, reg) => `<circle cx="${X(i)}" cy="${y}" r="17" fill="${fill(cd, reg)}"/><text x="${X(i)}" y="${y + 4}" text-anchor="middle" font-size="12" font-weight="700" style="fill:#fff">${esc(cd)}</text>${reg ? `<text x="${X(i)}" y="${y - 23}" text-anchor="middle" font-size="13" style="fill:var(--bad)">✗</text>` : ''}`;
  const b = pts.findIndex((p, i) => p.reg && (i === 0 || !pts[i - 1].reg));
  const bx = b > 0 ? (X(b) + X(b - 1)) / 2 : null;
  return `<figure><svg viewBox="0 0 ${W} 210" width="100%" role="img" aria-label="Retry gap versus response code. ${esc(pts.map((p) => `${secs(p.gap)} seconds: old ${p.old}, new ${p.neu}`).join('; '))}">
    <text x="10" y="74" font-size="13" font-weight="600">New switch</text><text x="10" y="134" font-size="13" font-weight="600">Legacy (Old A)</text>
    <line class="axis" x1="${L - 20}" x2="${W - 10}" y1="100" y2="100"/>
    ${bx ? `<line x1="${bx}" x2="${bx}" y1="30" y2="165" stroke="var(--bad)" stroke-dasharray="5 4"/><text x="${bx + 6}" y="26" font-size="12" style="fill:var(--bad)">boundary: approved at ≥ ${secs(pts[b].gap)} s</text>` : ''}
    ${pts.map((p, i) => node(i, 70, p.neu, p.reg) + node(i, 130, p.old, false) + `<text class="muted-t" x="${X(i)}" y="186" text-anchor="middle" font-size="12">${secs(p.gap)} s</text>`).join('')}
    <text class="muted-t" x="${(L + W) / 2}" y="206" text-anchor="middle" font-size="12">Retry gap (seconds between the two identical purchases)</text></svg>
    <figcaption>Blue <b>94</b> = duplicate rejected · grey <b>00</b> = approved as a new purchase · red <b>00 ✗</b> = new switch approved what the legacy switch rejected. Triage follow-ups ran automatically inside your bounds.</figcaption></figure>`;
}

function resultDetail(x) {
  const { case: c, result: res } = x;
  const bad = res.steps.find((s) => s.new_code !== s.old_a_code || s.old_a_code !== s.expected_code);
  const summary = res.error ? `The test errored: ${res.error}`
    : bad ? `Step ${bad.index + 1}: the rules expect ${bad.expected_code} ${CODES[bad.expected_code] || ''}. Old A returned ${bad.old_a_code}, Old B returned ${bad.old_b_code}, and the new switch returned ${bad.new_code} ${CODES[bad.new_code] || ''}.`
      : 'All three switches returned the expected codes.';
  const cell = (v, exp) => (v === exp ? `<td class="match">✓ <b class="mono">${esc(v)}</b></td>` : `<td class="mis">✗ ${code(v)}</td>`);
  const bd = res.balance_delta_cents || {};
  const impact = Object.keys(bd.old_a || {}).map((pan) => {
    const o = bd.old_a[pan], nw = bd.new?.[pan] ?? 0, d = nw - o;
    const v = d < 0 ? `<strong class="bad">✗ Customer overcharged ${usd(-d)}</strong>` : d > 0 ? `<strong class="bad">✗ Customer credited ${usd(d)} too much</strong>` : '<span class="good">✓ Same balance impact</span>';
    return `<p>Card ${mask(pan)} · Old switch: ${usd(o, true)} · New switch: ${usd(nw, true)} · ${v}</p>`;
  }).join('');
  const fmt = (k, v) => (k === '2' ? mask(v) : k === '4' ? `${v} (${usd(+v)})` : k === 't' ? `${v} (${MTI[v] || ''})` : k === '49' && v === '840' ? '840 (USD)' : k === '39' ? `${v} ${CODES[v] || ''}` : v);
  const hex = (h) => esc((h || '').match(/.{1,2}/g)?.join(' ') || '');
  const p = S.run.proofs[0];
  return `<h3>${esc(c.title)}</h3><div class="row">${verdictChip(res.verdict)}${badge(c.source)}<span class="chip">${esc(RULES[c.rule] || c.rule)}</span></div>
    <p>${esc(summary)}</p>${c.rationale ? `<p class="why">${esc(c.rationale)}</p>` : ''}
    <div class="tbl-wrap"><table><thead><tr><th>#</th><th>Step</th><th>Expected</th><th>Old A</th><th>Old B</th><th>New</th></tr></thead><tbody>
    ${res.steps.map((s) => `<tr><td>${s.index + 1}</td><td class="stepc">${esc(stepText(c.steps[s.index] || {}, c.steps[s.index - 1]))}</td><td>${code(s.expected_code)}</td>${cell(s.old_a_code, s.expected_code)}${cell(s.old_b_code, s.expected_code)}${cell(s.new_code, s.expected_code)}</tr>`).join('')}
    </tbody></table></div>
    <div class="impact"><b>Balance impact</b>${impact || '<p class="muted">No balance data.</p>'}</div>
    <details data-k="raw-${esc(c.id)}"><summary>Raw ISO 8583 messages</summary>${res.steps.map((s) => `<h4>Step ${s.index + 1}</h4>
      <div class="tbl-wrap"><table><tbody>${Object.entries(s.request_fields).map(([k, v]) => `<tr><th>${esc(k === 't' ? 'MTI' : 'Field ' + k)}</th><td>${esc(FIELD[k] || '')}</td><td class="mono">${esc(fmt(k, v))}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted">Request (hex, card digits included; synthetic test card)</p><pre>${hex(s.request_hex)}</pre>
      <p class="muted">New switch response (hex)</p><pre>${hex(s.new_response_hex)}</pre>`).join('')}</details>
    ${p ? `<p class="muted">Sandbox proof: executed in ${esc(runtimeLabel(p.runtime))}, network ${esc(p.network)}, read-only root ${p.readonly_rootfs ? '✓' : '✗'}; kernel seen from inside: <span class="mono">${esc(p.uname)}</span></p>` : ''}
    <p class="muted">Took ${num(res.duration_ms)} ms.</p>`;
}

function viewEvidence() {
  const r = S.run;
  if (!r) return empty('No run selected.');
  if (stage(r.status) < stage('running')) return empty('Evidence appears once approved tests have run.');
  if (!S.results) { loadResults(); return empty('<span class="spin"></span> Loading results…'); }
  const sel = S.results.find((x) => x.case.id === S.sel);
  const gh = r.github || {};
  const filters = ['regression', 'error', 'noise', 'both_wrong', 'pass', 'all'];
  return `${findingBanner()}<div class="grid-ev"><section class="card"><label for="f-verdict">Show</label>
      <select id="f-verdict" data-change="verdict">${filters.map((v) => `<option value="${v}" ${v === S.verdict ? 'selected' : ''}>${esc({ both_wrong: 'both wrong', all: 'all results' }[v] || v)}</option>`).join('')}</select>
      <ul class="rlist">${S.results.map((x) => `<li><button data-act="sel" data-id="${esc(x.case.id)}" aria-current="${x.case.id === S.sel}">${esc(x.case.title)}<small>${verdictChip(x.result.verdict)} ${esc(SRC[x.case.source] || x.case.source)}</small></button></li>`).join('') || '<li class="muted">None.</li>'}</ul></section>
    <section class="card">${sel ? resultDetail(sel) : '<p class="muted">Select a result.</p>'}</section></div>
    ${S.triageResults?.length ? `<section class="card"><h3>Triage follow-ups: where does it break?</h3>${boundaryChart(S.triageResults)}</section>` : ''}
    ${r.triage ? `<section class="card"><div class="row"><h3>Triage report</h3><span class="chip v-regression">severity: ${esc(r.triage.severity)}</span><span class="chip">money at risk ${usd(r.triage.money_at_risk_cents)}</span></div>
      <div class="md">${md(r.triage.summary_md)}</div><p><b>Root-cause hypothesis:</b> ${esc(r.triage.root_cause_hypothesis)}</p></section>` : ''}
    ${gh.issue_url || gh.status_state ? `<section class="card row"><b>GitHub</b>${gh.issue_url ? `<a href="${esc(safeUrl(gh.issue_url))}" target="_blank" rel="noopener">${esc(gh.issue_url.replace('https://github.com/', ''))}</a>` : ''}${gateChip(gh.status_state)}</section>` : ''}`;
}

function viewDecision() {
  const r = S.run;
  if (!r) return empty('No run selected.');
  const gh = r.github || {};
  if (r.decision) {
    const block = r.decision.decision === 'block';
    return `<div class="banner big ${block ? 'danger' : 'success'}" role="status">${block ? '✗ Migration blocked' : '✓ Release approved'} · by ${esc(r.decision.reviewer)} · ${dt(r.decision.ts)} · GitHub check: ${esc(gh.status_state || (block ? 'failure' : 'success'))}</div>
      ${r.decision.note ? `<section class="card"><b>Reviewer note</b><p>${esc(r.decision.note)}</p></section>` : ''}
      <section class="card"><p>${num(r.counts.total)} tests · ${num(r.counts.regression)} regressions · ${num(r.sandboxes_used)} gVisor sandboxes, all destroyed.</p>
      ${gh.issue_url ? `<p><a href="${esc(safeUrl(gh.issue_url))}" target="_blank" rel="noopener">Open the GitHub issue</a> ${gateChip(gh.status_state)}</p>` : ''}</section>`;
  }
  if (r.status !== 'awaiting_decision') return empty('The decision opens after the sandbox run and triage finish.');
  return `<form class="card" data-form="decision"><h2>5 · Decision</h2>
    <p>${num(r.counts.total)} tests · <b class="bad">${num(r.counts.regression)} regressions</b> · ${num(r.counts.error)} errors${r.triage ? ` · triage severity <b>${esc(r.triage.severity)}</b> · money at risk ${usd(r.triage.money_at_risk_cents)}` : ''}</p>
    <p>${gateChip(gh.status_state)}</p>
    <label for="f-rev">Reviewer name</label><input id="f-rev" name="reviewer" type="text" required autocomplete="name">
    <label for="f-note">Note</label><textarea id="f-note" name="note" rows="3" placeholder="Why this decision?"></textarea>
    <div class="row"><button class="btn danger" type="submit" name="d" value="block" ${S.busy ? 'disabled' : ''}>Block migration</button>
      <button class="btn" type="submit" name="d" value="approve" ${S.busy ? 'disabled' : ''}>Approve release</button></div></form>`;
}

function diagram() {
  const others = ['planner', 'generator', 'executor', 'triage', 'reporter', 'rl', 'human'], cx = 190, cy = 125;
  const lastConv = [...S.events].reverse().find((e) => e.to_agent && CONV_KINDS.includes(e.kind));
  const hot = lastConv && (lastConv.agent === 'coordinator' ? lastConv.to_agent : lastConv.agent);
  const pos = others.map((a, i) => { const t = (i / others.length) * 2 * Math.PI - Math.PI / 2; return [a, cx + 150 * Math.cos(t), cy + 95 * Math.sin(t)]; });
  return `<svg viewBox="0 0 380 250" width="100%" style="max-width:460px" role="img" aria-label="Coordinator in the centre connected to each agent and the human${hot ? `; active link: coordinator and ${esc(hot)}` : ''}">
    ${pos.map(([a, x, y]) => `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${a === hot ? col(a) : 'var(--line)'}" stroke-width="${a === hot ? 4 : 2}" ${a === hot ? '' : 'stroke-dasharray="4 4"'}/>`).join('')}
    ${[['coordinator', cx, cy], ...pos].map(([a, x, y]) => `<circle cx="${x}" cy="${y}" r="${a === 'coordinator' ? 26 : 18}" fill="${col(a)}"/><text x="${x}" y="${y + 4}" text-anchor="middle" font-size="11" font-weight="700" style="fill:#fff">${esc(a.slice(0, 2).toUpperCase())}</text><text x="${x}" y="${y + (a === 'coordinator' ? 42 : 32)}" text-anchor="middle" font-size="11">${esc(nm(a))}</text>`).join('')}</svg>`;
}

function convRow(e) {
  const human = e.agent === 'human' || e.to_agent === 'human';
  const body = e.kind === 'llm_call'
    ? `<details data-k="llm-${e.seq}"><summary>${esc(e.message)} · Vultr · ${esc(e.model || '?')} · ${num(e.tokens_in)} in / ${num(e.tokens_out)} out · ${num(e.latency_ms)} ms</summary>
       <p class="muted">Prompt</p><pre>${esc(e.data?.prompt)}</pre><p class="muted">Reply</p><pre>${esc(e.data?.reply)}</pre></details>`
    : `<p>${e.tool && !e.message.startsWith(e.tool) ? `<code>${esc(e.tool)}</code> ` : ''}${esc(e.message)}</p>`;
  return `<li class="msg ${human ? 'human' : ''}" style="--c:${col(e.agent)}"><span class="av" aria-hidden="true">${esc(e.agent.slice(0, 2).toUpperCase())}</span><div>
    <div class="meta"><b>${esc(nm(e.agent))}</b><span>→ ${esc(e.to_agent || (e.kind === 'llm_call' ? 'Vultr inference' : 'log'))}</span><time>${tm(e.ts)}</time>${e.loop_iter != null ? `<span class="chip">loop #${e.loop_iter}</span>` : ''}<span class="chip">${esc(e.kind.replace('_', ' '))}</span></div>${body}</div></li>`;
}

function viewAgents() {
  if (!S.run) return empty('Select or start a run to see the agents at work.');
  const evs = S.events.filter((e) => CONV_KINDS.includes(e.kind) && (!S.convAgent || e.agent === S.convAgent || e.to_agent === S.convAgent) && (S.showLLM || e.kind !== 'llm_call'));
  let loop = null;
  const rows = evs.map((e) => { let d = ''; if (e.loop_iter != null && e.loop_iter !== loop) { loop = e.loop_iter; d = `<li class="divider">Loop iteration ${loop}</li>`; } return d + convRow(e); }).join('');
  return `<div class="grid2"><section class="card"><h3>Who talks to whom</h3>${diagram()}</section>
    <section class="card"><h3>Roster</h3><div class="roster">${S.agents.map((a) => `<div class="agent" style="--c:${col(a.name)}"><h4><i class="dot ${esc(a.state)}"></i>${esc(nm(a.name))}</h4>
      <div class="muted">${esc(a.role)}</div><div><span class="chip">${a.model ? `Vultr · ${esc(a.model)}` : 'CPU · no LLM'}</span></div>
      <div>${esc(a.state.replace('_', ' '))} · ${num(a.llm_calls)} LLM calls · ${num(a.tokens)} tokens</div><div class="last">${esc(a.last_message)}</div></div>`).join('')}</div></section></div>
    <section class="card"><div class="row"><h3>Conversation</h3><span class="spacer"></span>
      <label class="inline">Agent <select data-change="conv-agent" style="width:auto"><option value="">All</option>${[...AGENTS, 'human'].map((a) => `<option ${a === S.convAgent ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
      <label class="inline"><input type="checkbox" data-change="show-llm" ${S.showLLM ? 'checked' : ''}> Show raw LLM calls</label></div>
      <ol class="conv">${rows || '<li class="muted">No messages yet.</li>'}</ol></section>`;
}

function viewSafety() {
  const sys = S.system || {}, sb = sys.sandbox_host || {}, r = S.run, probe = S.probe;
  const proof = probe?.proof || r?.proofs?.[0];
  const ic = (ok) => `<span class="ic ${ok === true ? 'ok' : ok === false ? 'bad' : ''}" aria-label="${ok === true ? 'passed' : ok === false ? 'failed' : 'pending'}">${ok === true ? '✓' : ok === false ? '✗' : '○'}</span>`;
  const blocked = probe?.checks.filter((c) => c.outcome === 'BLOCKED').length;
  const item = (ok, title, body) => `<li>${ic(ok)}<div><h4>${title}</h4>${body}</div></li>`;
  return `<section class="card"><div class="row"><h2>Safety: blast radius zero</h2><span class="spacer"></span>
      <button class="btn primary" data-act="probe" ${S.probing || MODE === 'snapshot' ? 'disabled' : ''}>${S.probing ? '<span class="spin"></span> Probing…' : 'Run isolation probe'}</button></div>
    <p class="muted">Agent-written tests never run on the control plane. They run in throwaway gVisor sandboxes on a separate Vultr VM with no network.</p>
    <ol class="checklist">
      ${item(sb.error || sb.kvm === false || sb.runsc === false ? false : sb.kvm && sb.runsc ? true : null, '① Host check', sb.error ? `<p class="bad">Sandbox host unreachable: ${esc(sb.error)}</p>` : `<p>Sandbox host <b>${esc(sb.hostname || '—')}</b> · KVM ${yes(sb.kvm)} · gVisor runsc ${yes(sb.runsc)} · mode <b>${esc(sb.mode || '—')}</b></p>`)}
      ${item(r?.sandboxes_used ? r.proofs.every((p) => p.runtime === 'runsc') : null, '② Agent ran tests in a sandbox', r?.sandboxes_used ? `<p>${num(r.sandboxes_used)} sandboxes · runtime ${esc([...new Set(r.proofs.map((p) => runtimeLabel(p.runtime)))].join(', '))}</p>` : '<p class="muted">No sandbox run yet for this run.</p>')}
      ${item(proof ? proof.runtime === 'runsc' : null, '③ Proof from inside the sandbox', proof ? `<p>hostname <b class="mono">${esc(proof.hostname)}</b> · network <b>${esc(proof.network)}</b> · read-only root ${yes(proof.readonly_rootfs)}</p><pre>${esc(proof.uname)}</pre>${sb.uname ? `<p class="muted">Host kernel for comparison: <span class="mono">${esc(sb.uname)}</span>. A different kernel inside means gVisor's user-space kernel answered, not the host.</p>` : ''}` : '<p class="muted">Run tests or the probe to capture proof.</p>')}
      ${item(probe ? blocked === probe.checks.length : null, '④ Isolation probe', probe ? `<p>${blocked} of ${probe.checks.length} attacks blocked.</p><div class="tbl-wrap"><table><thead><tr><th>Attack</th><th>Tried</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>
        ${probe.checks.map((c) => `<tr><td>${esc(c.name)}</td><td class="mono">${esc(c.attempted)}</td><td><span class="chip ${c.outcome === 'BLOCKED' ? 'blocked' : 'allowed'}">${c.outcome === 'BLOCKED' ? '✓ BLOCKED' : '✗ ALLOWED'}</span></td><td>${esc(c.detail)}</td></tr>`).join('')}</tbody></table></div>`
        : `<p class="muted">${MODE === 'snapshot' ? 'The probe is not part of the recording.' : 'Click "Run isolation probe" to try rm -rf /, internet egress and more from inside a fresh sandbox.'}</p>`)}
      ${item(sb.active_sandboxes === 0 && (!probe || probe.destroyed) ? true : null, '⑤ Teardown', `<p>Active sandboxes right now: <b>${sb.active_sandboxes ?? '—'}</b>${probe ? ` · probe sandbox ${probe.destroyed ? '<span class="good">destroyed ✓</span>' : '<span class="bad">still running ✗</span>'}` : ''}</p>`)}
    </ol></section>`;
}

function lineChart(curves) {
  const series = [['learned', 'Learned policy', 'var(--blue)', ''], ['random', 'Random', 'var(--orange)', '6 5']].filter(([k]) => curves[k]?.length);
  const n = Math.max(...series.map(([k]) => curves[k].length)), max = Math.max(1, ...series.flatMap(([k]) => curves[k]));
  const W = 660, H = 300, pl = 44, pr = 120, pt = 14, pb = 44;
  const X = (i) => pl + (i * (W - pl - pr)) / Math.max(1, n - 1), Y = (v) => pt + (H - pt - pb) * (1 - v / max);
  const stepY = Math.max(1, Math.ceil(max / 4)), ticks = Array.from({ length: Math.floor(max / stepY) + 1 }, (_, i) => i * stepY);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Regressions found versus executions: learned policy versus random">
    ${ticks.map((t) => `<line class="axis" x1="${pl}" x2="${W - pr}" y1="${Y(t)}" y2="${Y(t)}"/><text class="muted-t" x="${pl - 8}" y="${Y(t) + 4}" text-anchor="end" font-size="11">${t}</text>`).join('')}
    ${[0, Math.floor((n - 1) / 2), n - 1].map((i) => `<text class="muted-t" x="${X(i)}" y="${H - pb + 18}" text-anchor="middle" font-size="11">${i + 1}</text>`).join('')}
    <text class="muted-t" x="${(pl + W - pr) / 2}" y="${H - 6}" text-anchor="middle" font-size="12">Executions (test transactions sent)</text>
    <text class="muted-t" x="12" y="${pt + (H - pt - pb) / 2}" font-size="12" transform="rotate(-90 12 ${pt + (H - pt - pb) / 2})" text-anchor="middle">Regressions found (mean)</text>
    ${series.map(([k, label, c, dash]) => { const a = curves[k]; return `<path d="${a.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('')}" fill="none" stroke="${c}" stroke-width="3" stroke-dasharray="${dash}"/>
      <text x="${X(a.length - 1) + 8}" y="${Y(a.at(-1)) + 4}" font-size="12" font-weight="700" style="fill:${c}">${label}</text>`; }).join('')}</svg>`;
}

function viewRL() {
  const r = S.run, rl = r?.rl || { status: 'idle' }, ff = rl.first_find || {};
  return `<section class="card"><div class="row"><h2>RL explorer</h2><span class="spacer"></span>
      <button class="btn primary" data-act="rl" ${!r || rl.status === 'running' || S.busy || MODE === 'snapshot' ? 'disabled' : ''}>${rl.status === 'running' ? '<span class="spin"></span> Training…' : 'Train RL explorer on CPU'}</button></div>
    <p class="muted">Trained inside a sandbox on 7 mutant switches; evaluated on a held-out bug${rl.holdout_bug ? ` (<code>${esc(rl.holdout_bug)}</code>)` : ''}. No LLM, CPU only.</p>
    ${!r ? '<p class="muted">Select a run first.</p>' : rl.status === 'error' ? '<p class="bad">Training failed. Check the sandbox host logs.</p>' : ''}
    ${rl.curves && Object.keys(rl.curves).length ? `<div class="bigstats"><div><small>Learned policy: first find after</small><b>${esc(ff.learned ?? '—')}</b><small>executions</small></div>
      <div><small>Random: first find after</small><b>${esc(ff.random ?? '—')}</b><small>executions</small></div>
      <div><small>Training</small><b>${num(rl.episodes)}</b><small>episodes · ${num(rl.seeds)} seeds</small></div></div>
      ${lineChart(rl.curves)}<p class="muted">Trained on: ${esc((rl.trained_on_bugs || []).join(', '))}</p>` : ''}</section>`;
}

// ---------- render ----------
const VIEW_FN = { rules: viewRules, review: viewReview, run: viewRun, evidence: viewEvidence, decision: viewDecision, agents: viewAgents, safety: viewSafety, rl: viewRL };

function render(force = false) {
  const r = S.run;
  const sys = S.system;
  if (sys) {
    const cp = sys.control_plane || {}, sb = sys.sandbox_host || {}, llm = sys.llm || {};
    $('#sys').innerHTML = sys.error ? `<span class="pill bad">Control plane unreachable</span>`
      : `<span class="pill">Control plane <b>${esc(cp.hostname || '—')}</b></span>
      <span class="pill">Sandbox host ${sb.error ? '<b class="bad">unreachable</b>' : `<b>${esc(sb.hostname || '—')}</b> KVM ${yes(sb.kvm)} runsc ${yes(sb.runsc)} <b>${esc(sb.mode || '')}</b>`}</span>
      <span class="pill">Model <b>Vultr · ${esc(llm.model || '—')}</b>${llm.reachable == null ? '' : llm.reachable ? ' <i class="dot ok"></i>reachable' : ' <i class="dot bad"></i>unreachable'}</span>`;
  }
  const llmEv = S.events.filter((e) => e.kind === 'llm_call');
  $('#stats').innerHTML = `<b>${S.agents.length || AGENTS.length}</b> agents · <b>${num(llmEv.length)}</b> Vultr inference calls · <b>${num(llmEv.reduce((s, e) => s + (e.tokens_in || 0) + (e.tokens_out || 0), 0))}</b> tokens`;
  $('#runs').innerHTML = S.runs.map((x) => `<button class="run-item" data-act="open" data-id="${esc(x.id)}" aria-current="${x.id === r?.id}"><span class="t">${esc(x.title)}</span><small>${esc(STATUS_LABEL[x.id === r?.id ? r.status : x.status] || x.status)} · ${dt(x.created_at)}</small></button>`).join('') || '<p class="muted" style="padding:0 .3rem">No runs yet.</p>';
  const st = r ? stage(r.status) : -1;
  const done = { rules: !!r, review: st > stage('awaiting_approval'), run: st >= stage('awaiting_decision'), evidence: !!r?.decision, decision: !!r?.decision };
  $('#rail').innerHTML = STEPS.map(([v, label], i) => `<button data-act="nav" data-v="${v}" class="${done[v] ? 'done' : ''}" ${S.view === v ? 'aria-current="page"' : ''}><span class="n">${done[v] ? '✓' : i + 1}</span>${label}${done[v] ? '<span class="sr"> (done)</span>' : ''}</button>`).join('')
    + '<span class="sep"></span>' + TABS.map(([v, label]) => `<button class="tab" data-act="nav" data-v="${v}" ${S.view === v ? 'aria-current="page"' : ''}>${label}</button>`).join('');
  const main = $('#main');
  const key = JSON.stringify([S.view, r, S.events.length, S.agents, S.system, S.probe, S.probing, S.results?.length, S.triageResults?.length, S.verdict, S.sel, S.editing, S.convAgent, S.showLLM, S.busy, S.flashUntil > Date.now()]);
  // Polling never clobbers a form the user is editing; explicit actions (force) do.
  if (!force && (key === S.lastKey || S.dirty || (main.contains(document.activeElement) && document.activeElement.matches('input,textarea,select')))) return;
  S.lastKey = key; S.dirty = false;
  const open = [...main.querySelectorAll('details[open][data-k]')].map((d) => d.dataset.k);
  main.innerHTML = VIEW_FN[S.view]();
  open.forEach((k) => main.querySelector(`details[data-k="${CSS.escape(k)}"]`)?.setAttribute('open', ''));
  history.replaceState(null, '', `${location.search}#${r ? encodeURIComponent(r.id) + '/' : ''}${S.view}`);
}

// ---------- events ----------
const ACTIONS = {
  nav: (b) => { S.view = b.dataset.v; S.editing = null; render(true); $('#main').focus(); },
  new: () => { Object.assign(S, { run: null, events: [], agents: [], view: 'rules', results: null, triageResults: null }); render(true); },
  open: (b) => selectRun(b.dataset.id),
  sel: (b) => { S.sel = b.dataset.id; render(true); },
  'case-edit': (b) => { S.editing = b.dataset.id; render(true); },
  'case-cancel': () => { S.editing = null; render(true); },
  'case-status': (b) => act(() => api('PATCH', `/api/runs/${S.run.id}/cases/${b.dataset.id}`, { status: b.dataset.v })),
  'approve-all': () => act(async () => { const j = await api('POST', `/api/runs/${S.run.id}/approve_all`); toast(`Approved ${j.approved} tests`); }),
  execute: () => act(() => api('POST', `/api/runs/${S.run.id}/execute`)),
  rl: () => act(async () => { await api('POST', `/api/runs/${S.run.id}/rl`); S.run.rl = { status: 'running' }; }),
  probe: async () => {
    S.probing = true; render(true);
    try { S.probe = await api('POST', '/api/system/probe'); S.system = await api('GET', '/api/system'); } catch (e) { toast(`Probe failed: ${e.message}`, 'err'); }
    S.probing = false; render(true);
  },
};
const FORMS = {
  'new-run': (f, fd) => act(async () => {
    const run = await api('POST', '/api/runs', {
      title: fd.get('title'), requirements: fd.get('requirements').split('\n').map((s) => s.trim()).filter(Boolean),
      rules_text: fd.get('rules_text'), spec_text: fd.get('spec_text'),
      bounds: { max_amount_cents: Math.round(parseFloat(fd.get('max_amount')) * 100), allowed_mti: fd.getAll('mti'), auto_followups: fd.has('auto') } });
    if (fd.has('replay')) await api('PATCH', `/api/runs/${run.id}/replay`, { enabled: true, sample_size: +fd.get('sample'), dataset: 'tabformer' });
    await api('POST', `/api/runs/${run.id}/generate`);
    S.runs = await api('GET', '/api/runs');
    await selectRun(run.id, 'review');
  }),
  'case-edit': (f, fd) => act(async () => {
    const c = S.run.cases.find((x) => x.id === f.dataset.id);
    const steps = c.steps.map((s, i) => ({ ...s, amount_cents: Math.round(parseFloat(fd.get(`amt${i}`)) * 100), at_offset_s: parseFloat(fd.get(`gap${i}`)) }));
    await api('PATCH', `/api/runs/${S.run.id}/cases/${c.id}`, { steps, expected_codes: c.steps.map((_, i) => fd.get(`code${i}`)) });
    S.editing = null;
  }),
  decision: (f, fd, sub) => act(async () => {
    S.run = await api('POST', `/api/runs/${S.run.id}/decision`, { decision: sub?.value || 'block', reviewer: fd.get('reviewer'), note: fd.get('note') || '' });
    S.runs = await api('GET', '/api/runs');
  }),
};
document.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) ACTIONS[b.dataset.act]?.(b); });
document.addEventListener('submit', (e) => { const f = e.target; if (FORMS[f.dataset.form]) { e.preventDefault(); if (!S.busy) FORMS[f.dataset.form](f, new FormData(f), e.submitter); } });
document.addEventListener('input', (e) => { if (e.target.closest('#main form')) S.dirty = true; });
document.addEventListener('change', (e) => {
  const k = e.target.dataset.change; if (!k) return;
  if (k === 'verdict') { S.verdict = e.target.value; S.results = null; }
  if (k === 'conv-agent') S.convAgent = e.target.value;
  if (k === 'show-llm') S.showLLM = e.target.checked;
  e.target.blur(); render(true);
});

// ---------- boot ----------
(async function boot() {
  const banner = { mock: 'Mock mode: fixture data, no backend. Numbers are placeholders; the data set is IBM TabFormer (public synthetic) and the defect is seeded.',
    snapshot: 'Recorded run from our Vultr deployment — live app is behind NetBird. Read-only replay; synthetic data, seeded defect.' }[MODE];
  if (banner) { $('#mode').textContent = banner; $('#mode').hidden = false; }
  try { if (MODE === 'mock') await loadMock(); } catch (e) { toast(`Could not load mock fixtures: ${e.message}`, 'err'); }
  const [id, view] = decodeURIComponent(location.hash.slice(1)).split('/'); // read before the first render rewrites the hash
  await tick();
  const want = S.runs.find((x) => x.id === id) || (MODE === 'snapshot' && S.runs[0]);
  if (want) await selectRun(want.id, VIEW_FN[view] ? view : undefined);
  else if (VIEW_FN[id]) { S.view = id; render(true); } else render(true);
  setInterval(tick, 1000);
})();
