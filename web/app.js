// SwitchProof UI ("mission control": one page per step, hash-routed, with a three.js scene): vanilla ES module, no build step.
// Modes: live (default), ?mock=1, ?snapshot=<export.json url>. Optional ?theme=dark|light.
const qs = new URLSearchParams(location.search);
const MODE = qs.has('snapshot') ? 'snapshot' : qs.get('mock') === '1' ? 'mock' : 'live';
const $ = (s) => document.querySelector(s);
const TERMINAL = ['blocked', 'approved_for_release'];
const CODES = { '00': 'Approved', 14: 'Invalid card number', 25: 'Original not found', 51: 'Insufficient funds', 54: 'Expired card',
  55: 'Incorrect PIN', 62: 'Restricted card', 94: 'Duplicate transmission', 96: 'System malfunction' };
const SHORT = { '00': 'Approved', 14: 'Invalid card', 25: 'Not found', 51: 'Insufficient', 54: 'Expired', 55: 'Bad PIN', 62: 'Restricted', 94: 'Duplicate', 96: 'Malfunction' };
const MTI = { '0100': 'Authorization', '0200': 'Purchase', '0400': 'Reversal', '0110': 'Authorization response', '0210': 'Purchase response', '0410': 'Reversal response' };
const AGENTS = ['coordinator', 'planner', 'generator', 'executor', 'triage', 'reporter', 'rl'];
const ROLE = { coordinator: 'Runs the tool-calling loop and routes work', planner: 'Turns rules into states worth testing',
  generator: 'Writes ISO 8583 test cases', executor: 'Runs approved tests as gVisor Jobs on VKE', triage: 'Finds the failure boundary with follow-ups',
  reporter: 'Files the GitHub issue and release check (templated)', rl: 'Explores for bugs with a learned policy' };
const COLOR = { coordinator: '#818cf8', planner: '#2dd4bf', generator: '#c084fc', executor: '#94a3b8', triage: '#facc15',
  reporter: '#fdba74', rl: '#60a5fa', human: '#f472b6', system: '#7c8aa5' };
const RULES = { approve_purchase: 'Approve a purchase when funds are available', decline_insufficient: 'Decline a purchase for insufficient funds',
  reject_duplicate: 'Reject a duplicate purchase (same card, STAN and amount within 60 seconds)', reverse_approved: 'Reverse an approved payment and restore the balance',
  decline_bad_pin: 'Decline an incorrect PIN', decline_expired: 'Decline an expired card', decline_bad_card: 'Decline an unknown card',
  technical_glitch: 'Technical glitch', replay: 'Replayed TabFormer transactions', custom: 'Custom' };
const FIELD = { t: 'Message type', 2: 'Card number', 3: 'Processing code', 4: 'Amount', 7: 'Transmission time (MMDDhhmmss)', 11: 'STAN',
  14: 'Expiry (YYMM)', 18: 'Merchant category', 22: 'Entry mode', 37: 'Retrieval reference', 39: 'Response code', 41: 'Terminal ID', 48: 'Private data', 49: 'Currency' };
const STEPS = [['rules', 'Rules'], ['review', 'Approve'], ['run', 'Run'], ['evidence', 'Evidence'], ['decision', 'Decision']];
const TABS = [['metrics', 'Metrics'], ['agents', 'Agents'], ['infra', 'Infrastructure'], ['rl', 'RL explorer']];
const STATUS_VIEW = { draft: 'review', planning: 'review', awaiting_approval: 'review', running: 'run', triaging: 'run',
  awaiting_decision: 'evidence', blocked: 'decision', approved_for_release: 'decision' };
const STATUS_LABEL = { draft: 'Draft', planning: 'Agents planning', awaiting_approval: 'Awaiting your approval', running: 'Running in sandboxes',
  triaging: 'Triage investigating', awaiting_decision: 'Awaiting decision', blocked: 'Migration blocked', approved_for_release: 'Release approved' };
const ORDER = Object.keys(STATUS_VIEW);
const PAGES = ['overview', 'rules', 'review', 'run', 'evidence', 'decision', 'metrics', 'agents', 'infra', 'rl'];
// Page to open when a run reaches a status (null: stay put).
const STATUS_PAGE = { draft: null, planning: null, awaiting_approval: 'review', running: 'run', triaging: null, awaiting_decision: 'evidence', blocked: 'decision', approved_for_release: 'decision' };
// URL names: the Approve page is #…/approve (internally 'review'); old links (#…/hero, /safety) still work.
const toHash = (p) => (p === 'review' ? 'approve' : p);
const fromHash = (h) => ({ approve: 'review', hero: 'overview', safety: 'infra' }[h] || h);
// The one WebGL scene: full size on the overview, a compact banner on Run/Evidence/Decision, parked (paused) elsewhere.
const SCENE_PAGES = { overview: 'full', run: 'compact', evidence: 'compact', decision: 'compact' };
const CONV_KINDS = ['message', 'tool_call', 'tool_result', 'llm_call', 'decision'];

const S = { runs: [], run: null, events: [], agents: [], system: null, probe: null, results: null, triageResults: null,
  view: 'rules', verdict: 'regression', sel: null, editing: null, convAgent: '', showLLM: true, findingSeen: false, flashUntil: 0,
  busy: false, probing: false, loadingResults: false, dirty: false, lastKey: '', replayStep: 0, seen: new Set(), me: null, share: undefined, shareWas: false, page: 'overview', keys: {}, dirtySec: new Set(), replayOn: false, metrics: undefined, metricsAll: undefined, metricsFor: null };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
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
const k8s = () => S.system?.sandbox_host?.mode === 'kubernetes';
const poolOf = (p) => (String(p?.sandbox_id || '').startsWith('sp-data-') ? 'data' : 'agent'); // older ids without a prefix: agent lane
const WALL = '<div class="wall" role="separator" aria-label="separate namespaces, separate VMs"><span>separate namespaces · separate VMs</span></div>';
const netLabel = (n) => `${n}${k8s() ? ' · egress denied by NetworkPolicy' : ''}`;
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
const M = { run: null, t0: 0, rlT0: 0, decisionEvents: [], share: null };
const DUR = { planning: 5000, running: 10000, triaging: 4000 };
async function loadMock() {
  const names = ['run_awaiting_approval', 'run_awaiting_decision', 'results_regression', 'events', 'events_conversation', 'agents', 'system', 'probe', 'rl_report', 'me', 'metrics', 'metrics_all'];
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
  if (p === '/api/me') return clone(FX.me);
  if (p === '/api/metrics') return clone(FX.metrics_all);                        // recorded example from the Vultr deployment
  if (method === 'GET' && /^\/api\/runs\/[^/]+\/metrics$/.test(p)) return clone(FX.metrics);
  if (method !== 'GET' && FX.me.can_act === false) throw httpErr(403, "Read-only: approvals need the 'testers' group via NetBird SSO");
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
    case 'GET share': return clone(M.share || { active: false });
    case 'DELETE share': M.share = null; return { active: false };
    case 'POST share':
      if (r.status !== 'awaiting_decision') throw httpErr(409, 'A reviewer link can only be opened while the run awaits a decision');
      M.share = { active: true, url: 'https://sp-review-7f3a.proxy.netbird.io', pin: '482913', expires: 'when the decision is recorded' };
      return clone(M.share);
    case 'POST decision': {
      M.share = null;
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
  if (p === '/api/me') return { auth: 'none', user: null, groups: [], role: 'viewer', can_act: false };
  if (p === '/api/metrics') { if (SNAP.metrics_all) return SNAP.metrics_all; throw httpErr(404, 'Not recorded'); }
  if (/\/metrics$/.test(p)) { if (SNAP.metrics) return SNAP.metrics; throw httpErr(404, 'Not recorded'); }
  if (p === '/api/system' && SNAP.system) return SNAP.system;
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
  if (rest === 'share') return { active: false };
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
    clearInterval(replayTimer);
    Object.assign(S, { run, events: [], results: null, triageResults: null, sel: null, editing: null, probe: null, replayStep: 0, seen: new Set(), share: undefined, replayOn: false, metrics: undefined, metricsFor: null });
    addEvents(evs);
    S.findingSeen = S.events.some((e) => e.kind === 'finding'); S.flashUntil = 0;
    S.agents = await api('GET', `/api/runs/${id}/agents`).catch(() => deriveAgents(S.events, run.status));
    S.keys = {};
    showPage(view || 'overview', { replace: true });
    return;
  } catch (e) { toast(`Could not open run: ${e.message}`, 'err'); }
  render(true);
}

async function refreshRun() {
  const id = S.run.id, prev = S.run.status;
  const [run, evs] = await Promise.all([api('GET', `/api/runs/${id}`), api('GET', `/api/runs/${id}/events?after=${lastSeq()}`)]);
  if (S.run?.id !== id) return;
  S.run = run; addEvents(evs);
  S.agents = await api('GET', `/api/runs/${id}/agents`).catch(() => deriveAgents(S.events, run.status));
  if (run.status !== prev) { S.results = S.triageResults = null; S.metrics = undefined; if (STATUS_PAGE[run.status]) setTimeout(() => go(STATUS_PAGE[run.status]), 120); }
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
  startReplay();
}

let ticks = 0;
async function tick() {
  if (ticks++ % 10 === 0) {
    try { S.system = await api('GET', '/api/system'); } catch (e) { S.system = { error: e.message }; }
    if (!S.noMe) try { S.me = await api('GET', '/api/me'); } catch (e) { S.me = null; S.noMe = e.status === 404; } // older backend: local dev, stop asking
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
  try { await fn(); } catch (e) { ok = false; toast(e.message, 'err'); } // 403/409/503 details come from the server
  S.busy = false;
  if (S.run) { try { await refreshRun(); } catch { /* next tick retries */ } }
  render(ok); // on failure keep any half-edited form as the user left it
}

// ---------- shared fragments ----------
const SRC = { llm: 'Vultr AI', dataset: 'TabFormer replay', triage: 'Triage follow-up', rl: 'RL explorer', human: 'Human' };
const badge = (src) => `<span class="chip src-${esc(src)}">${esc(SRC[src] || src)}</span>`;
const verdictChip = (v) => `<span class="chip v-${esc(v)}">${v === 'regression' ? '✗ ' : v === 'pass' ? '✓ ' : ''}${esc({ both_wrong: 'both wrong' }[v] || v)}</span>`;
const gateChip = (st) => (st ? `<span class="chip gate-${esc(st)}">GitHub gate: ${esc(st)}</span>` : '');
const agentStrip = () => `<div class="strip">${S.agents.map((a) => `<span title="${esc(a.state)}"><i class="dot ${esc(a.state)}"></i>${esc(nm(a.name))}<span class="sr"> ${esc(a.state)}</span></span>`).join('')}</div>`;
const empty = (msg) => `<section class="panel"><p class="muted">${msg}</p></section>`;
const LOCK = (open, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${open
  ? 'M17 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-4V7a3 3 0 1 1 6 0v1h2V7a5 5 0 0 0-5-5Z'
  : 'M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z'}"/></svg>`;
const K8S = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 3.3 6.5v9L12 22l8.7-6.5v-9L12 2Zm0 2.3 6.7 3.5v7.2L12 20l-6.7-5V7.8L12 4.3Zm0 3.2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z"/></svg>';
const SERVER = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 3h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm0 10h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Zm3-7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></svg>';
const ruleIcon = (t) => (/duplicate/i.test(t) ? '⧉' : /revers/i.test(t) ? '↺' : /insufficient|decline/i.test(t) ? '⊘' : /approve/i.test(t) ? '✓' : '§');
const casesOf = (r) => (r?.cases || []).filter((c) => c.source !== 'triage');
const gateOpen = (r) => !!r && (stage(r.status) >= stage('running') || (casesOf(r).length > 0 && !casesOf(r).some((c) => c.status === 'proposed')));
const extraDebit = (bd) => { const pan = Object.keys(bd?.old_a || {})[0]; return pan == null ? 0 : bd.old_a[pan] - (bd.new?.[pan] ?? 0); }; // > 0: customer overcharged
const canAct = () => MODE !== 'snapshot' && S.me?.can_act !== false;
const RO_MSG = "Read-only: approvals need the 'testers' group via NetBird SSO";
const roLine = () => (!canAct() && MODE !== 'snapshot' ? `<p class="roline">${LOCK(false, 14)} ${RO_MSG}</p>` : '');
const dis = (extra = false) => (extra || !canAct() ? `disabled title="${canAct() ? '' : RO_MSG}"` : '');
const SHIELD = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 3 6v6c0 5 3.8 9.4 9 10 5.2-.6 9-5 9-10V6l-9-4Z"/></svg>';
const calloutText = (extra, dup) => (extra > 0 ? `${dup ? 'Charged twice' : 'Overcharged'}: +${usd(extra)}` : '');

function termlog(evs, title = 'agent-log') {
  return `<div class="termlog"><div class="th"><i></i><i></i><i></i><span>${esc(title)}</span></div><ol data-bottom="1">${evs.map((e) =>
    `<li class="k-${esc(e.kind)}" style="--c:${col(e.agent)}"><time>${tm(e.ts)}</time><b>${esc(nm(e.agent))}${e.to_agent ? ' →' : ''}</b><span>${e.to_agent ? `<em class="ag-c" style="--c:${col(e.to_agent)}">${esc(nm(e.to_agent))}</em> ` : ''}${esc(e.message)}</span></li>`).join('')
    || '<li><time></time><b></b><span>waiting for agents…</span></li>'}</ol></div>`;
}

function findingText() {
  const f = S.events.find((e) => e.kind === 'finding'); if (!f) return '';
  const d = f.data || {}, c = S.run.cases.find((x) => x.id === d.case_id);
  if (c?.rule === 'reject_duplicate') return `New switch approved a duplicate ${usd(c.steps[0].amount_cents)} payment`;
  if (d.old_code === '94' && d.new_code === '00') { const x = extraDebit(d.balance_delta_cents); return `New switch approved a duplicate ${x > 0 ? usd(x) + ' ' : ''}payment`; }
  return f.message;
}
const findingBanner = () => { const t = S.findingSeen && findingText(); return t ? `<div class="banner danger ${Date.now() < S.flashUntil ? 'flash' : ''}" role="alert"><span class="tag">REGRESSION</span>✗ ${esc(t)}</div>` : ''; };

// ---------- hero: card terminal → OLD A / OLD B / NEW ----------
function heroSvg({ codes = null, expected = null, callout = '', label = '', packets = true }) {
  const boxes = [['old_a', 'OLD A', 'legacy v4', 26], ['old_b', 'OLD B', 'legacy v4', 104], ['new', 'NEW', 'NewSwitch v1', 182]];
  const move = packets && !reduced();
  const reg = codes && codes.new !== codes.old_a && codes.old_a === codes.old_b;
  const paths = boxes.map(([, , , y]) => `M150 118 C 320 118, 330 ${y + 26}, 496 ${y + 26}`);
  const pk = paths.map((p, i) => (move ? [0, 1].map((j) => `<circle r="4.5" class="pkt"><animateMotion dur="2.2s" begin="-${(i * 0.3 + j * 1.1).toFixed(1)}s" repeatCount="indefinite" path="${p}"/></circle>`).join('')
    : `<circle r="4.5" class="pkt" cx="330" cy="${(118 + boxes[i][3] + 26) / 2}"/>`)).join('');
  const box = ([k, name, sub, y]) => {
    const cd = codes?.[k];
    const st = !cd ? '' : k === 'new' && reg ? 'bad' : expected && cd === expected ? 'ok' : '';
    const mark = cd && expected ? (cd === expected ? '<tspan fill="var(--good)">✓ </tspan>' : '<tspan fill="var(--bad)">✗ </tspan>') : '';
    return `<rect class="box ${st}" x="496" y="${y}" width="244" height="52" rx="10"/>
      <text x="512" y="${y + 23}" font-size="13" font-weight="700" class="t-mono">${name}</text><text x="512" y="${y + 41}" font-size="11" class="t-muted">${sub}</text>
      <text x="726" y="${y + 27}" font-size="22" font-weight="800" text-anchor="end" class="t-mono" ${st === 'bad' ? 'fill="var(--bad)"' : ''}>${mark}${esc(cd || '···')}</text>
      <text x="726" y="${y + 44}" font-size="11" text-anchor="end" class="t-muted">${esc(cd ? SHORT[cd] || CODES[cd] || '' : 'waiting')}</text>`;
  };
  const aria = codes ? `Old A ${codes.old_a}, Old B ${codes.old_b}, New ${codes.new}${callout ? '. ' + callout : ''}` : 'Messages in flight to the three switches';
  return `<svg viewBox="0 0 760 272" role="img" aria-label="${esc(aria)}">
    ${paths.map((p) => `<path d="${p}" class="ln" fill="none" stroke-width="2" stroke-dasharray="3 5"/>`).join('')}${pk}
    <rect class="term" x="20" y="70" width="130" height="96" rx="12" stroke-width="1.5"/>
    <rect x="34" y="82" width="102" height="30" rx="5" fill="var(--bg2)"/><text x="85" y="102" text-anchor="middle" font-size="11" class="t-mono" fill="var(--cyan)">ISO 8583</text>
    ${[0, 1, 2].flatMap((cx) => [0, 1].map((cy) => `<rect x="${42 + cx * 30}" y="${122 + cy * 18}" width="24" height="12" rx="3" fill="var(--line2)"/>`)).join('')}
    <text x="85" y="186" text-anchor="middle" font-size="12" font-weight="600">Card terminal</text>
    <text x="323" y="16" text-anchor="middle" font-size="11" class="t-muted t-mono">${esc(label)}</text>
    ${boxes.map(box).join('')}
    ${callout ? `<g class="callout"><rect x="526" y="242" width="214" height="26" rx="7"/><text x="633" y="260" text-anchor="middle" font-size="13">${esc(callout)}</text></g>` : ''}</svg>`;
}

function heroInner(mode = 'run') {
  const r = S.run;
  if (mode === 'evidence') {
    const x = S.results?.find((y) => y.case.id === S.sel);
    if (!x) return heroSvg({ packets: false });
    const res = x.result, c = x.case, n = res.steps.length, i = Math.min(S.replayStep, n - 1), s = res.steps[i];
    if (!s) return heroSvg({ packets: false });
    const dup = res.steps.some((t) => t.old_a_code === '94' && t.new_code === '00');
    const cs = c.steps[i] || {};
    return (scene ? '' : heroSvg({ codes: { old_a: s.old_a_code, old_b: s.old_b_code, new: s.new_code }, expected: s.expected_code,
      callout: i === n - 1 ? calloutText(extraDebit(res.balance_delta_cents), dup) : '', label: `${cs.mti || ''} ${MTI[cs.mti] || ''} · STAN ${cs.stan || ''} · t+${secs(cs.at_offset_s)}s` }))
      + `<div class="cap">${scene ? `<span class="chip">replaying in the 3D view above · ${esc(`${s.old_a_code}/${s.old_b_code}/${s.new_code}`)}</span>` : ''}<span class="chip">step ${i + 1}/${n}</span><b>${esc(stepText(cs, c.steps[i - 1]))}</b><span>expected ${code(s.expected_code)}</span><span class="spacer"></span>
        ${res.steps.map((_, j) => `<button class="btn small" data-act="replay-step" data-i="${j}" aria-pressed="${j === i}" aria-label="Show step ${j + 1}">${j + 1}</button>`).join('')}
        <button class="btn small" data-act="replay">Replay ▶</button></div>`;
  }
  if (!r) return heroSvg({ packets: false });
  const f = S.events.find((e) => e.kind === 'finding' && e.data?.new_code);
  const active = ['running', 'triaging'].includes(r.status);
  if (f) {
    const d = f.data;
    return heroSvg({ codes: { old_a: d.old_code, old_b: d.old_code, new: d.new_code }, expected: d.old_code, packets: active,
      callout: calloutText(extraDebit(d.balance_delta_cents), d.old_code === '94' && d.new_code === '00'), label: 'first regression found' })
      + `<div class="cap"><b>${esc(f.message)}</b></div>`;
  }
  return heroSvg({ packets: active, label: active ? 'sending approved tests to all three switches' : '' })
    + `<div class="cap">${active ? '<span class="spin"></span> Each ISO 8583 message goes to both legacy copies and the new switch.' : 'No regression found.'}</div>`;
}
const heroBlock = () => `<section class="panel hero" id="ev-hero" aria-label="Case replay">${heroInner('evidence')}</section>`;
const drawHero = () => { const el = $('#ev-hero'); if (el) el.innerHTML = heroInner('evidence'); S.replayOn = true; syncScene(); };

let replayTimer = null;
function startReplay() {
  clearInterval(replayTimer);
  const x = S.results?.find((y) => y.case.id === S.sel); if (!x) return;
  const n = x.result.steps.length;
  if (reduced()) { const m = x.result.steps.findIndex((s) => s.new_code !== s.expected_code || s.old_a_code !== s.expected_code); S.replayStep = m < 0 ? n - 1 : m; drawHero(); return; }
  S.replayStep = 0; drawHero();
  replayTimer = setInterval(() => { if (S.replayStep >= n - 1) { clearInterval(replayTimer); return; } S.replayStep++; drawHero(); }, 1400);
}

// ---------- views ----------
const DEFAULT_RULES = 'Legacy v4 checks every 0100/0200 in this order: unknown card -> 14; blocked card -> 62; expired card -> 54; incorrect PIN -> 55; issuer glitch -> 96; duplicate (same card, STAN and amount within 60 seconds) -> 94; balance below amount -> 51; otherwise approve 00 and debit. 0400 reversals: original not found or not approved -> 25; already reversed -> 94; otherwise credit back 00.';
const DEFAULT_SPEC = 'ISO 8583 (ASCII). MTI 0100 auth, 0200 purchase, 0400 reversal. Fields: 2 card number, 3 processing code, 4 amount (12 digits, cents), 7 transmission time MMDDhhmmss, 11 STAN, 14 expiry YYMM, 18 MCC, 22 entry mode, 37 retrieval ref, 39 response code, 41 terminal id, 48 private data, 49 currency (840 = USD).';

function viewRules() {
  const r = S.run;
  if (r) {
    return `<section class="panel"><div class="eyebrow">Step 1 · Rules · submitted ${dt(r.created_at)}</div><h1>${esc(r.title)}</h1>
      <div class="req-grid">${r.requirements.map((x) => `<div class="req"><span class="ric">${ruleIcon(x)}</span><span>${esc(x)}</span></div>`).join('')}</div>
      <div class="pills"><span class="pill">Max ${usd(r.bounds.max_amount_cents)} per transaction&nbsp;</span>${r.bounds.allowed_mti.map((m) => `<span class="chk"><span>${esc(m)} ${esc(MTI[m] || '')}</span></span>`).join('')}
        <span class="pill">Auto follow-ups: <b>${r.bounds.auto_followups ? 'on' : 'off'}</b>&nbsp;</span><span class="pill">Replay: <b>${r.replay.enabled ? `${num(r.replay.sample_size)} TabFormer txns` : 'off'}</b>&nbsp;</span></div>
      <details data-k="rules-src"><summary>Legacy rules and message spec</summary><p>${esc(r.rules_text)}</p><p class="mono" style="font-size:.8rem">${esc(r.spec_text)}</p></details></section>`;
  }
  const reqs = [RULES.approve_purchase, RULES.decline_insufficient, RULES.reject_duplicate, RULES.reverse_approved];
  return `<form class="panel" data-form="new-run"><div class="eyebrow">Step 1 · Rules</div><h1>What must the new switch do?</h1>
    <p class="muted">Agents on Vultr Serverless Inference turn these rules into ISO 8583 tests. You approve every test before anything runs.</p>
    <label for="f-title" class="sr">Title</label><input id="f-title" name="title" type="text" required value="Core switch migration — Legacy v4 → NewSwitch v1" style="font-weight:600;margin-top:.6rem">
    <div class="req-grid">${reqs.map((t, i) => `<label class="req"><span class="ric" aria-hidden="true">${ruleIcon(t)}</span><span class="sr">Rule ${i + 1}</span><textarea name="req" rows="2" ${i === 0 ? 'required' : ''}>${esc(t)}</textarea></label>`).join('')}
      <label class="req add"><span class="ric" aria-hidden="true">+</span><span class="sr">Another rule</span><textarea name="req" rows="2" placeholder="Add another rule (optional)"></textarea></label></div>
    <div class="pills">
      <label class="pill">Max per transaction $<input name="max_amount" type="number" min="1" step="0.01" value="1000.00" required aria-label="Maximum amount per transaction in USD"></label>
      ${['0100', '0200', '0400'].map((m) => `<label class="chk"><input type="checkbox" name="mti" value="${m}" checked><span>${m} ${MTI[m]}</span></label>`).join('')}
      <label class="toggle"><input type="checkbox" name="auto" checked> Auto follow-ups</label>
      <label class="toggle"><input type="checkbox" name="replay" checked> Replay</label>
      <label class="pill"><input name="sample" type="number" min="1" max="20000" value="2000" aria-label="Replay sample size"> TabFormer txns</label></div>
    <p class="hint">Auto follow-ups: the triage agent may run extra tests without asking again, but only inside these bounds. Replay uses IBM's public synthetic TabFormer benchmark.</p>
    <details><summary>Legacy rules and message spec</summary>
      <label for="f-rules">Legacy rules (check order)</label><textarea id="f-rules" name="rules_text" rows="4">${esc(DEFAULT_RULES)}</textarea>
      <label for="f-spec">Message spec</label><textarea id="f-spec" name="spec_text" rows="3">${esc(DEFAULT_SPEC)}</textarea></details>
    ${roLine()}<button class="cta" type="submit" ${dis(S.busy)}>Generate tests with Vultr AI <small>→ planner · generator</small></button></form>`;
}

function stepsList(c) {
  return `<ol class="steps">${c.steps.map((s, i) => `<li>${esc(stepText(s, c.steps[i - 1]))} <span class="muted">→</span> ${code(c.expected_codes[i])}</li>`).join('')}</ol>`;
}

function caseCard(c, editable) {
  const id = esc(c.id), pressed = (v) => `aria-pressed="${c.status === v}"`;
  const body = S.editing === c.id
    ? `<form data-form="case-edit" data-id="${id}">${c.steps.map((s, i) => `<div class="edit-row"><span class="muted">Step ${i + 1}</span>
        <label>Amount (USD)<input type="number" name="amt${i}" step="0.01" min="0.01" max="${S.run.bounds.max_amount_cents / 100}" value="${(s.amount_cents / 100).toFixed(2)}"></label>
        <label>At t+ (s)<input type="number" name="gap${i}" step="0.1" min="0" value="${s.at_offset_s}"></label>
        <label>Expected<select name="code${i}">${Object.keys(CODES).map((k) => `<option value="${k}" ${k === c.expected_codes[i] ? 'selected' : ''}>${k} ${CODES[k]}</option>`).join('')}</select></label></div>`).join('')}
        <div class="row"><button class="btn small primary" type="submit">Save</button><button class="btn small" type="button" data-act="case-cancel">Cancel</button></div></form>`
    : stepsList(c);
  return `<article class="case ${esc(c.status)}"><header><h4>${esc(c.title)}</h4>${badge(c.source)}</header>${body}
    ${c.rationale ? `<p class="why">${esc(c.rationale)}</p>` : ''}
    ${editable && S.editing !== c.id ? `<div class="row"><div class="seg" role="group" aria-label="Decision for ${id}">
      <button class="ok" data-act="case-status" data-id="${id}" data-v="approved" ${pressed('approved')}>✓ Approve</button>
      <button class="no" data-act="case-status" data-id="${id}" data-v="rejected" ${pressed('rejected')}>✗ Reject</button></div>
      <button class="btn small" data-act="case-edit" data-id="${id}">Edit</button><span class="spacer"></span><span class="chip st-${esc(c.status)}">${esc(c.status)}</span></div>`
      : `<div class="row"><span class="chip st-${esc(c.status)}">${esc(c.status)}</span></div>`}</article>`;
}

function ring(done, total) {
  const R = 30, C = 2 * Math.PI * R, f = total ? done / total : 0;
  return `<svg class="ring" width="78" height="78" viewBox="0 0 78 78" role="img" aria-label="${done} of ${total} tests decided">
    <circle cx="39" cy="39" r="${R}" fill="none" stroke="var(--line2)" stroke-width="7"/>
    <circle cx="39" cy="39" r="${R}" fill="none" stroke="${f === 1 ? 'var(--good)' : 'var(--vultr)'}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(C * f).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 39 39)"/>
    <text x="39" y="44" text-anchor="middle">${done}/${total}</text></svg>`;
}

function viewReview() {
  const r = S.run;
  if (!r) return empty('Start a new migration test to generate test cases.');
  const cases = casesOf(r);
  if (!cases.length) {
    return `<section class="panel"><div class="eyebrow">Step 2 · Approve</div><h1><span class="spin"></span> Vultr AI is planning your tests…</h1>
      <p class="muted">The coordinator asks the planner to break each rule into states, then the generator writes ISO 8583 test cases. Nothing runs yet.</p>
      ${agentStrip()}${termlog(S.events.slice(-40), 'coordinator loop · Vultr Serverless Inference')}</section>`;
  }
  const open = r.status === 'awaiting_approval', edit = open && canAct(), n = (st) => cases.filter((c) => c.status === st).length, proposed = n('proposed');
  const unlocked = proposed === 0, groups = [...new Set(cases.map((c) => c.rule))];
  const label = (rule) => r.plan.find((p) => p.rule === rule)?.description || RULES[rule] || rule;
  return `<section class="panel gate ${unlocked ? 'unlocked' : ''}">${ring(cases.length - proposed, cases.length)}
      <span class="lockbig">${LOCK(unlocked, 34)}</span>
      <div style="flex:1;min-width:15rem"><div class="eyebrow">Step 2 · Human gate</div><h2>${unlocked ? 'Every test decided. The gate is open.' : 'Nothing runs until every test is decided'}</h2>
        <p class="muted">${n('approved')} approved · ${n('rejected')} rejected · ${proposed} waiting · Replay: ${r.replay.enabled ? `${num(r.replay.sample_size)} TabFormer transactions (switched on by you)` : 'off'}</p></div>
      ${open ? `<div class="row"><button class="btn" data-act="approve-all" ${dis(S.busy || !proposed)}>Approve all</button>
        <button class="btn primary ${unlocked && canAct() ? 'glow' : ''}" data-act="execute" ${dis(S.busy || proposed)}>${LOCK(unlocked, 14)} Run approved tests in sandboxes</button></div>`
        : `<span class="chip">${esc(STATUS_LABEL[r.status])}</span>`}</section>${open ? roLine() : ''}
    ${groups.map((g) => `<h3 class="group-h"><span class="ric" aria-hidden="true">${ruleIcon(label(g))}</span>${esc(label(g))}<span class="chip">${cases.filter((c) => c.rule === g).length} tests</span></h3>
      <div class="case-grid">${cases.filter((c) => c.rule === g).map((c) => caseCard(c, edit)).join('')}</div>`).join('')}`;
}

function viewRun() {
  const r = S.run;
  if (!r) return empty('No run selected.');
  if (stage(r.status) < stage('running')) return empty(`${LOCK(false, 14)} The sandbox run starts after every test in step 2 is decided.`);
  const c = r.counts, planned = casesOf(r).filter((x) => x.status === 'approved').length + (r.replay.enabled ? r.replay.sample_size : 0);
  const pct = r.status === 'running' ? Math.min(100, (100 * c.total) / Math.max(1, planned)) : 100;
  const tile = (p) => {
    const st = r.status === 'running' && p === r.proofs.at(-1) ? 'running' : 'destroyed';
    return `<div class="tile ${st} ${S.seen.has(p.sandbox_id) ? '' : 'spawn'}"><span class="sid">${esc(p.sandbox_id)}</span>
      <span class="badge ${p.runtime === 'runsc' ? 'vultr' : 'warn'}">${p.runtime === 'runsc' ? 'gVisor pod' : 'local-unsafe (dev)'}</span>
      <span class="muted">net ${esc(p.network)}${k8s() ? ' · egress denied' : ''}</span>
      <span>${st === 'running' ? '<i class="pulse"></i> running' : '<span class="good">✓ destroyed</span>'}</span></div>`;
  };
  const lane = (pool, title, sub) => { const ps = r.proofs.filter((p) => poolOf(p) === pool);
    return `<div class="lane lane-${pool}"><h4>${title} <span class="muted">· ${sub}</span></h4><div class="tiles">${ps.map(tile).join('') || `<p class="muted">${pool === 'data' && !r.replay.enabled ? 'Replay is off for this run.' : 'Scheduling…'}</p>`}</div></div>`; };
  const counter = (n, label, cls = '') => `<div class="counter ${cls}"><div class="big">${num(n)}</div><small>${label}</small></div>`;
  return `${findingBanner()}
    <div class="counters">${counter(c.total, 'tests executed')}${counter(c.passed, '✓ passed', 'good')}${counter(c.regression, '✗ regressions · new differs from old', c.regression ? 'bad' : '')}${counter(c.error, `errors · ${num(c.noise)} noise · ${num(c.both_wrong)} both wrong`)}</div>
    <div class="progress" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="Run progress"><div style="width:${pct}%"></div></div>
    <p class="progress-lbl">${r.status === 'running' ? `Running ${num(c.total)} of about ${num(planned)} ${k8s() ? 'as throwaway gVisor Jobs on Vultr Kubernetes Engine' : 'in throwaway sandboxes'}` : r.status === 'triaging' ? 'Triage agent is running follow-ups inside your bounds' : 'Run complete'} · ${num(r.sandboxes_used)} sandboxes used</p>
    <section class="panel"><div class="row"><h3 style="margin:0">${k8s() ? 'gVisor pods' : 'Sandboxes'}</h3><span class="muted">one ${k8s() ? 'Job' : 'sandbox'} per batch, deleted after</span></div>
      <div class="lanes">${lane('agent', 'Agent sandboxes', 'agent-written tests')}${WALL}${lane('data', 'Data sandboxes', 'replay data, no agent code')}</div></section>
    <section class="panel"><h3>Agents</h3>${agentStrip()}${termlog(S.events.slice(-60), `run ${r.id}`)}</section>`;
}

function boundaryChart(items) {
  const retry = (st) => st.length === 2 && st[0].pan === st[1].pan && st[0].amount_cents === st[1].amount_cents && st[0].stan === st[1].stan;
  const pts = items.filter((x) => retry(x.case.steps) && x.result.steps.length === 2).map((x) => {
    const st = x.case.steps, rs = x.result.steps.at(-1);
    return { gap: st[1].at_offset_s - st[0].at_offset_s, old: rs.old_a_code, neu: rs.new_code, reg: x.result.verdict === 'regression' };
  }).sort((a, b) => a.gap - b.gap);
  if (!pts.length) return '';
  const W = 700, L = 128, dx = (W - L - 30) / Math.max(1, pts.length - 1), X = (i) => L + i * dx;
  const fill = (cd, reg) => (reg ? 'var(--bad)' : cd === '94' ? 'var(--vultr)' : 'var(--faint)');
  const node = (i, y, cd, reg) => `<circle cx="${X(i)}" cy="${y}" r="17" fill="${fill(cd, reg)}"/><text x="${X(i)}" y="${y + 4}" text-anchor="middle" font-size="12" font-weight="700" style="fill:#fff" class="t-mono">${esc(cd)}</text>${reg ? `<text x="${X(i)}" y="${y - 23}" text-anchor="middle" font-size="13" style="fill:var(--bad)">✗</text>` : ''}`;
  const b = pts.findIndex((p, i) => p.reg && (i === 0 || !pts[i - 1].reg)), bx = b > 0 ? (X(b) + X(b - 1)) / 2 : null;
  return `<figure><svg viewBox="0 0 ${W} 212" width="100%" role="img" aria-label="Retry gap versus response code. ${esc(pts.map((p) => `${secs(p.gap)} seconds: old ${p.old}, new ${p.neu}`).join('; '))}">
    <text x="10" y="74" font-size="13" font-weight="600">New switch</text><text x="10" y="134" font-size="13" font-weight="600">Legacy (Old A)</text>
    <line class="ln" x1="${L - 20}" x2="${W - 10}" y1="100" y2="100"/>
    ${bx ? `<line x1="${bx}" x2="${bx}" y1="30" y2="165" stroke="var(--bad)" stroke-dasharray="5 4"/><text x="${bx + 6}" y="26" font-size="12" style="fill:var(--bad)">boundary: approved at ≥ ${secs(pts[b].gap)} s</text>` : ''}
    ${pts.map((p, i) => node(i, 70, p.neu, p.reg) + node(i, 130, p.old, false) + `<text class="t-muted t-mono" x="${X(i)}" y="186" text-anchor="middle" font-size="12">${secs(p.gap)} s</text>`).join('')}
    <text class="t-muted" x="${(L + W) / 2}" y="208" text-anchor="middle" font-size="12">Retry gap (seconds between two identical purchases)</text></svg>
    <figcaption>Blue <b>94</b> = duplicate rejected · grey <b>00</b> = approved as a new purchase · red <b>00 ✗</b> = new switch approved what the legacy switch rejected. Triage ran these follow-ups automatically inside your bounds.</figcaption></figure>`;
}

function resultDetail(x) {
  const { case: c, result: res } = x;
  const bad = res.steps.find((s) => s.new_code !== s.old_a_code || s.old_a_code !== s.expected_code);
  const summary = res.error ? `The test errored: ${res.error}`
    : bad ? `Step ${bad.index + 1}: the rules expect ${bad.expected_code} ${CODES[bad.expected_code] || ''}. Old A returned ${bad.old_a_code}, Old B returned ${bad.old_b_code}, and the new switch returned ${bad.new_code} ${CODES[bad.new_code] || ''}.`
      : 'All three switches returned the expected codes.';
  const cell = (v, exp) => (v === exp ? `<td class="match">✓ ${esc(v)}</td>` : `<td class="mis">✗ ${code(v)}</td>`);
  const bd = res.balance_delta_cents || {};
  const impact = Object.keys(bd.old_a || {}).map((pan) => {
    const o = bd.old_a[pan], nw = bd.new?.[pan] ?? 0, d = nw - o, max = Math.max(Math.abs(o), Math.abs(nw), 1);
    const row = (label, v, cls) => `<div class="bar-row ${cls}"><span>${label}</span><div class="bar"><i style="width:${((100 * Math.abs(v)) / max).toFixed(1)}%"></i></div><b>${usd(v, true)}</b></div>`;
    return `<p class="muted" style="margin:.2rem 0">Card ${mask(pan)}</p><div class="bars">${row('Old switch', o, '')}${row('New switch', nw, d !== 0 ? 'bad' : '')}</div>
      <p>${d < 0 ? `<span class="overcharge">✗ Customer overcharged ${usd(-d)}</span>` : d > 0 ? `<span class="overcharge">✗ Customer credited ${usd(d)} too much</span>` : '<span class="good">✓ Same balance impact</span>'}</p>`;
  }).join('');
  const fmt = (k, v) => (k === '2' ? mask(v) : k === '4' ? `${v} (${usd(+v)})` : k === 't' ? `${v} (${MTI[v] || ''})` : k === '49' && v === '840' ? '840 (USD)' : k === '39' ? `${v} ${CODES[v] || ''}` : v);
  const hex = (h) => esc((h || '').match(/.{1,2}/g)?.join(' ') || '');
  const want = c.source === 'dataset' ? 'data' : 'agent', p = S.run.proofs.find((x) => poolOf(x) === want) || S.run.proofs[0];
  return `<div class="row"><h2 style="margin:0">${esc(c.title)}</h2>${verdictChip(res.verdict)}${badge(c.source)}</div>
    <p>${esc(summary)}</p>${c.rationale ? `<p class="why">${esc(c.rationale)}</p>` : ''}
    <div class="tbl-wrap"><table><thead><tr><th>#</th><th>Step</th><th>Expected</th><th>Old A</th><th>Old B</th><th>New</th></tr></thead><tbody>
    ${res.steps.map((s) => `<tr><td class="mono">${s.index + 1}</td><td class="stepc">${esc(stepText(c.steps[s.index] || {}, c.steps[s.index - 1]))}</td><td>${code(s.expected_code)}</td>${cell(s.old_a_code, s.expected_code)}${cell(s.old_b_code, s.expected_code)}${cell(s.new_code, s.expected_code)}</tr>`).join('')}
    </tbody></table></div>
    <h3 style="margin-top:.8rem">Balance impact</h3>${impact || '<p class="muted">No balance data.</p>'}
    <details data-k="raw-${esc(c.id)}"><summary>Raw ISO 8583 messages</summary>${res.steps.map((s) => `<h4>Step ${s.index + 1}</h4>
      <div class="tbl-wrap"><table><tbody>${Object.entries(s.request_fields).map(([k, v]) => `<tr><th>${esc(k === 't' ? 'MTI' : 'Field ' + k)}</th><td>${esc(FIELD[k] || '')}</td><td class="mono">${esc(fmt(k, v))}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted">Request (hex; synthetic test card)</p><pre>${hex(s.request_hex)}</pre><p class="muted">New switch response (hex)</p><pre>${hex(s.new_response_hex)}</pre>`).join('')}</details>
    ${p ? `<p class="muted" style="font-size:.82rem">Sandbox proof (${poolOf(p)} pool, <span class="mono">${esc(p.sandbox_id)}</span>): ${esc(runtimeLabel(p.runtime))} · network ${esc(netLabel(p.network))} · read-only root ${p.readonly_rootfs ? '✓' : '✗'} · kernel seen from inside <span class="mono">${esc(p.uname)}</span> · ${num(res.duration_ms)} ms</p>` : ''}`;
}

function viewEvidence() {
  const r = S.run;
  if (!r) return empty('No run selected.');
  if (stage(r.status) < stage('running')) return empty('Evidence appears once approved tests have run.');
  if (!S.results) { loadResults(); return empty('<span class="spin"></span> Loading results…'); }
  const sel = S.results.find((x) => x.case.id === S.sel), gh = r.github || {};
  const filters = ['regression', 'error', 'noise', 'both_wrong', 'pass', 'all'];
  const links = [gh.issue_url && `<a href="${esc(safeUrl(gh.issue_url))}" target="_blank" rel="noopener">GitHub issue · ${esc(gh.issue_url.replace('https://github.com/', ''))}</a>`,
    gh.evidence_url && `<a class="vultr" href="${esc(safeUrl(gh.evidence_url))}" target="_blank" rel="noopener">Evidence bundle on Vultr Object Storage</a>`, gateChip(gh.status_state)].filter(Boolean).join('');
  return `${findingBanner()}<div class="split"><aside class="panel"><label for="f-verdict">Show</label>
      <select id="f-verdict" data-change="verdict">${filters.map((v) => `<option value="${v}" ${v === S.verdict ? 'selected' : ''}>${esc({ both_wrong: 'both wrong', all: 'all results' }[v] || v)}</option>`).join('')}</select>
      <ul class="rlist" data-keep="rlist">${S.results.map((x) => `<li><button data-act="sel" data-id="${esc(x.case.id)}" aria-current="${x.case.id === S.sel}">${esc(x.case.title)}<small>${verdictChip(x.result.verdict)}<span class="muted">${esc(SRC[x.case.source] || x.case.source)}</span></small></button></li>`).join('') || '<li class="muted">None.</li>'}</ul></aside>
    <div>${heroBlock()}<section class="panel">${sel ? resultDetail(sel) : '<p class="muted">Select a result.</p>'}${links ? `<div class="links" style="margin-top:.6rem">${links}</div>` : ''}</section></div></div>
    ${S.triageResults?.length ? `<section class="panel"><div class="eyebrow">Triage follow-ups</div><h2>Where does it break?</h2>${boundaryChart(S.triageResults)}</section>` : ''}
    ${r.triage ? `<section class="panel"><div class="row"><h2 style="margin:0">Triage report</h2><span class="chip v-regression">severity: ${esc(r.triage.severity)}</span><span class="chip">money at risk ${usd(r.triage.money_at_risk_cents)}</span></div>
      <div class="md">${md(r.triage.summary_md)}</div><p><b>Root-cause hypothesis:</b> ${esc(r.triage.root_cause_hypothesis)}</p></section>` : ''}`;
}

function viewDecision() {
  const r = S.run;
  if (!r) return empty('No run selected.');
  const gh = r.github || {};
  const sso = S.me?.auth === 'netbird';
  if (r.decision) {
    const block = r.decision.decision === 'block';
    return `<section class="panel stampwrap"><div class="stamp ${block ? 'bad' : 'good'}" role="status">${block ? 'MIGRATION BLOCKED' : 'RELEASE APPROVED'}</div>
      <div class="stampmeta"><span class="chip">${block ? 'Blocked' : 'Approved'} by ${esc(r.decision.reviewer)}${sso ? ' · authenticated by NetBird SSO' : ''}</span><span class="chip">${dt(r.decision.ts)}</span>${gateChip(gh.status_state || (block ? 'failure' : 'success'))}</div>
      ${r.decision.note ? `<p class="muted" style="max-width:40rem">“${esc(r.decision.note)}”</p>` : ''}
      <p>${num(r.counts.total)} tests · ${num(r.counts.regression)} regressions · ${num(r.sandboxes_used)} sandboxes, all destroyed</p>${S.shareWas ? '<p class="muted">Reviewer link closed: it died with the decision.</p>' : ''}
      <div class="links">${gh.issue_url ? `<a href="${esc(safeUrl(gh.issue_url))}" target="_blank" rel="noopener">GitHub issue</a>` : ''}${gh.evidence_url ? `<a class="vultr" href="${esc(safeUrl(gh.evidence_url))}" target="_blank" rel="noopener">Evidence bundle on Vultr Object Storage</a>` : ''}</div></section>`;
  }
  if (r.status !== 'awaiting_decision') return empty('The decision opens after the sandbox run and triage finish.');
  return `<form class="panel" data-form="decision"><div class="eyebrow">Step 5 · Decision</div><h1>Ship NewSwitch v1?</h1>
    <p>${num(r.counts.total)} tests · <b class="bad">${num(r.counts.regression)} regressions</b> · ${num(r.counts.error)} errors${r.triage ? ` · severity <b>${esc(r.triage.severity)}</b> · money at risk <b>${usd(r.triage.money_at_risk_cents)}</b>` : ''} ${gateChip(gh.status_state)}</p>
    <div class="decide-in"><label>Reviewer${sso && S.me.user ? ' · NetBird SSO' : ' name'}<input name="reviewer" type="text" required autocomplete="name" ${sso && S.me.user ? `value="${esc(S.me.user)}" readonly` : ''}></label><label>Note<input name="note" type="text" placeholder="Why this decision?"></label></div>
    ${roLine()}<div class="bigbtns"><button class="bigbtn block" type="submit" name="d" value="block" ${dis(S.busy)}><b>Block migration</b><small>GitHub gate → failure</small></button>
      <button class="bigbtn" type="submit" name="d" value="approve" ${dis(S.busy)}><b>Approve release</b><small>GitHub gate → success</small></button></div></form>${shareBlock()}`;
}

async function loadShare() {
  S.share = null;
  try { S.share = await api('GET', `/api/runs/${S.run.id}/share`); } catch { S.share = { active: false }; } // 404 on older backends
  if (S.share?.active) S.shareWas = true;
  render(true);
}
function shareBlock() {
  if (MODE === 'snapshot') return '';
  if (S.share === undefined) { loadShare(); return ''; }
  const sh = S.share || {}, note = '<p class="hint">Link dies automatically when you block or approve — powered by netbird expose</p>';
  return `<section class="panel share"><div class="row"><span class="vm-ic">${SHIELD}</span><div style="flex:1"><div class="eyebrow">NetBird · lifecycle-bound</div><h3 style="margin:0">Temporary reviewer link</h3></div>
    ${sh.active ? `<button class="btn small" data-act="share-close" ${dis(S.busy)}>Close link now</button>` : `<button class="btn" data-act="share-create" ${dis(S.busy)}>Create temporary reviewer link</button>`}</div>
    ${sh.active ? `<dl class="kv" style="margin-top:.6rem"><div><dt>URL</dt><dd><a href="${esc(safeUrl(sh.url))}" target="_blank" rel="noopener">${esc(sh.url)}</a></dd></div>
      <div><dt>PIN</dt><dd class="pin">${sh.pin ? esc(sh.pin) : 'shown to testers only'}</dd></div><div><dt>Expires</dt><dd>${esc(sh.expires || 'when the decision is recorded')}</dd></div></dl>` : '<p class="muted">Let a colleague review this run over NetBird with a PIN, without opening any port.</p>'}${note}</section>`;
}

function diagram() {
  const others = ['planner', 'generator', 'executor', 'triage', 'reporter', 'rl', 'human'], cx = 200, cy = 130;
  const lastConv = [...S.events].reverse().find((e) => e.to_agent && CONV_KINDS.includes(e.kind));
  const hot = lastConv && (lastConv.agent === 'coordinator' ? lastConv.to_agent : lastConv.agent);
  const pos = others.map((a, i) => { const t = (i / others.length) * 2 * Math.PI - Math.PI / 2; return [a, cx + 158 * Math.cos(t), cy + 98 * Math.sin(t)]; });
  const hp = pos.find(([a]) => a === hot);
  const pkt = hp && !reduced() ? (() => { const out = lastConv.agent === 'coordinator'; const d = out ? `M${cx} ${cy} L${hp[1]} ${hp[2]}` : `M${hp[1]} ${hp[2]} L${cx} ${cy}`;
    return `<circle r="5" class="pkt"><animateMotion dur="1.2s" repeatCount="indefinite" path="${d}"/></circle>`; })() : '';
  return `<svg viewBox="0 0 400 262" width="100%" style="max-width:480px" role="img" aria-label="Coordinator in the centre connected to each agent and the human${hot ? `; active link: coordinator and ${esc(hot)}` : ''}">
    ${pos.map(([a, x, y]) => `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="spoke ${a === hot ? 'hot' : ''}"/>`).join('')}${pkt}
    ${[['coordinator', cx, cy], ...pos].map(([a, x, y]) => `<circle cx="${x}" cy="${y}" r="${a === 'coordinator' ? 27 : 19}" fill="${col(a)}" ${a === hot ? 'stroke="var(--cyan)" stroke-width="3"' : ''}/><text x="${x}" y="${y + 4}" text-anchor="middle" font-size="11" font-weight="800" style="fill:#0a1020" class="t-mono">${esc(a.slice(0, 2).toUpperCase())}</text><text x="${x}" y="${y + (a === 'coordinator' ? 42 : 33)}" text-anchor="middle" font-size="11">${esc(nm(a))}</text>`).join('')}</svg>`;
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
  return `<div class="grid2"><section class="panel"><div class="eyebrow">Agents</div><h2>Who talks to whom</h2>${diagram()}</section>
    <section class="panel"><h2>Roster</h2><div class="roster">${S.agents.map((a) => `<div class="agent" style="--c:${col(a.name)}"><h4><i class="dot ${esc(a.state)}"></i>${esc(nm(a.name))}</h4>
      <div class="muted">${esc(a.role)}</div><div style="margin:.25rem 0"><span class="badge ${a.model ? 'vultr' : ''}">${a.model ? `Vultr · ${esc(a.model)}` : 'CPU · no LLM'}</span></div>
      <div class="mono" style="font-size:.74rem">${esc(a.state.replace('_', ' '))} · ${num(a.llm_calls)} calls · ${num(a.tokens)} tok</div><div class="last">${esc(a.last_message)}</div></div>`).join('')}</div></section></div>
    <section class="panel"><div class="row"><h2 style="margin:0">Conversation</h2><span class="spacer"></span>
      <label class="toggle">Agent <select data-change="conv-agent" style="width:auto">${['', ...AGENTS, 'human'].map((a) => `<option value="${a}" ${a === S.convAgent ? 'selected' : ''}>${a ? nm(a) : 'All'}</option>`).join('')}</select></label>
      <label class="toggle"><input type="checkbox" data-change="show-llm" ${S.showLLM ? 'checked' : ''}> Show raw LLM calls</label></div>
      <ol class="conv">${rows || '<li class="muted">No messages yet.</li>'}</ol></section>`;
}

function vmCard(title, host = {}, extra = '') {
  const v = host.vultr || {}, on = v.available === true;
  const kv = (k, val) => `<div><dt>${k}</dt><dd>${esc(val ?? '—')}</dd></div>`;
  return `<section class="panel vm"><header><span class="vm-ic">${SERVER}</span><div style="flex:1"><h3>${title}</h3><div class="muted" style="font-size:.8rem">${on ? 'Vultr instance' : 'Local dev (not on Vultr)'}</div></div><span class="badge ${on ? 'vultr' : ''}">${on ? 'VULTR' : 'LOCAL'}</span></header>
    <dl class="kv">${kv('Instance id', v.instance_id)}${kv('Region', v.region)}${kv('Plan', v.plan)}${kv('Hostname', v.hostname || host.hostname)}${kv('Public IP', v.public_ip)}${kv('Private IP', v.private_ip)}${extra}</dl></section>`;
}

function viewInfra() {
  const sys = S.system || {}, cp = sys.control_plane || {}, sb = sys.sandbox_host || {}, st = cp.storage || {}, os = sys.object_storage || {}, r = S.run, probe = S.probe;
  const yn = (v) => (v === true ? '✓ yes' : v === false ? '✗ no' : '—');
  const kv = (k, val, raw = false) => `<div><dt>${k}</dt><dd>${raw ? val : esc(val ?? '—')}</dd></div>`;
  const used = st.total_gb ? Math.max(0, Math.min(100, (100 * (st.total_gb - (st.free_gb ?? 0))) / st.total_gb)) : 0;
  const sbExtra = sb.error ? kv('Status', `unreachable: ${sb.error}`) : kv('KVM', yn(sb.kvm)) + kv('gVisor runsc', yn(sb.runsc)) + kv('Mode', sb.mode) + kv('Active sandboxes', sb.active_sandboxes);
  const storage = `<section class="panel vm"><header><span class="vm-ic">${SERVER}</span><div style="flex:1"><h3>Storage</h3><div class="muted" style="font-size:.8rem">run data and evidence</div></div></header>
    <dl class="kv">${kv('Block Storage', st.is_block_storage === true ? '✓ Vultr Block Storage' : st.is_block_storage === false ? 'local disk' : '—')}${kv('Device', st.device)}${kv('Mount point', st.mount_point)}
      ${kv('Free / total', st.total_gb != null ? `${st.free_gb ?? '?'} / ${st.total_gb} GB<div class="usage"><i style="width:${used.toFixed(0)}%"></i></div>` : '—', true)}
      ${kv('Object Storage', os.configured === true ? '✓ configured' : os.configured === false ? 'not configured' : '—')}${kv('Endpoint', os.endpoint)}${kv('Bucket', os.bucket)}</dl></section>`;
  const nb = sys.netbird || {}, peers = nb.peers || [], sbPeer = peers.find((p) => /sandbox/i.test(p.fqdn || '')) || peers[0];
  const path = (t) => (t ? `<span class="chip ${t === 'P2P' ? 'blocked' : 'v-error'}">${esc(t)}</span>` : '—');
  const netbird = `<section class="panel"><div class="row"><span class="vm-ic">${SHIELD}</span><div style="flex:1"><div class="eyebrow">NetBird · zero-port access</div><h2 style="margin:0">No inbound app ports</h2></div>
      <span class="badge ${nb.available ? 'vultr' : ''}">${nb.available ? 'NETBIRD CONNECTED' : 'NETBIRD NOT DETECTED'}</span></div>
    ${nb.available ? `<p class="copyline">Public URL served by the NetBird reverse proxy; no inbound app ports on either Vultr VM.</p>
      <div class="grid2"><dl class="kv">${kv('Public URL', nb.public_url ? `<a href="${esc(safeUrl(nb.public_url))}" target="_blank" rel="noopener">${esc(nb.public_url)}</a>` : '—', true)}${kv('This peer', `${nb.ip || '—'}${nb.fqdn ? ' · ' + nb.fqdn : ''}`)}
        ${kv('Control → sandbox', nb.sandbox_via_netbird ? `over NetBird WireGuard${sbPeer?.connection_type ? ` (${sbPeer.connection_type})` : ''}` : 'over Vultr VPC')}</dl>
      <div class="tbl-wrap"><table><thead><tr><th>Peer</th><th>NetBird IP</th><th>Status</th><th>Path</th><th>Latency</th></tr></thead><tbody>
        ${peers.map((p) => `<tr><td class="mono">${esc(p.fqdn)}</td><td class="mono">${esc(p.ip)}</td><td>${p.status === 'Connected' ? '<span class="good">● Connected</span>' : esc(p.status)}</td><td>${path(p.connection_type)}</td><td class="mono">${p.latency_ms != null ? `${Number(p.latency_ms).toFixed(1)} ms` : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No peers reported.</td></tr>'}</tbody></table></div></div>`
      : '<p class="muted">NetBird is not running on this host (local dev). On Vultr, both VMs join NetBird and the UI is reached through the NetBird reverse proxy.</p>'}</section>`;
  const onK8s = sb.mode === 'kubernetes';
  const host = (() => { try { return new URL(sb.cluster_api).host; } catch { return sb.cluster_api; } })();
  const pools = sb.pools || {}, nodes = sb.nodes || [];
  const poolCard = (key, title, sub) => { const pl = pools[key] || {}, ns = nodes.filter((n) => pl.node_pool && n.pool === pl.node_pool);
    return `<div class="panel2 pool pool-${key}"><div class="eyebrow">${title}</div><div class="muted" style="font-size:.8rem">${sub}</div>
      <dl class="kv" style="margin-top:.4rem">${kv('Namespace', pl.namespace)}${kv('Node pool', pl.node_pool || 'not set: pods may share nodes')}</dl>
      <ul class="nodes">${ns.map((n) => `<li><span class="mono">${esc(n.name)}</span>${n.ready ? '<span class="chip blocked">✓ Ready</span>' : '<span class="chip allowed">✗ NotReady</span>'}</li>`).join('') || '<li class="muted">No nodes with this pool label.</li>'}</ul></div>`; };
  const hasPools = !!(pools.agent || pools.data);
  const poolsBlock = hasPools ? `<div class="lanes" style="margin-top:.7rem">${poolCard('agent', 'Agent pool', 'agent-written tests, human and triage follow-ups')}<div class="wall slim" role="separator" aria-label="separate namespaces, separate VMs"></div>${poolCard('data', 'Data pool', 'IBM TabFormer replay only · refuses agent code')}</div>
    <p class="copyline">Agent code and customer-like data never share a sandbox or a machine.</p>` : '';
  const vke = `<section class="panel vm span2"><header><span class="vm-ic">${K8S}</span><div style="flex:1"><h3>Vultr Kubernetes Engine</h3><div class="muted" style="font-size:.8rem">sandbox cluster · one Job per test batch</div></div><span class="badge vultr">VKE</span></header>
    ${sb.error ? `<p class="bad">Kubernetes API unreachable: ${esc(sb.error)}</p>` : `<div class="${hasPools ? '' : 'grid2'}"><dl class="kv ${hasPools ? 'kv2' : ''}">${kv('Cluster API', host)}${kv('Namespace', sb.namespace)}
      ${kv('RuntimeClass', sb.runtime_class ? `${sb.runtime_class} ${sb.runsc ? '✓' : '✗ missing'}` : '—')}${kv('Active sandbox Jobs', sb.active_sandboxes)}${kv('Runner image', sb.image)}${kv('Registry', 'Vultr Container Registry')}</dl>
      ${hasPools ? '' : `<div class="tbl-wrap"><table><thead><tr><th>Node</th><th>Pool</th><th>Ready</th><th>Kubelet</th></tr></thead><tbody>
      ${(sb.nodes || []).map((n) => `<tr><td class="mono">${esc(n.name)}</td><td class="mono">${esc(n.pool || '—')}</td><td>${n.ready ? '<span class="good">✓ Ready</span>' : '<span class="bad">✗ NotReady</span>'}</td><td class="mono">${esc(n.kubelet || '—')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No nodes reported.</td></tr>'}
      </tbody></table></div>`}</div>${poolsBlock}`}</section>`;
  const HARDEN = ['separate agent and data pools', 'restricted Pod Security', 'deny-all NetworkPolicy', 'no ServiceAccount token', 'read-only root', 'drop ALL capabilities', 'ResourceQuota 20 pods', 'Job deleted after each batch'];
  const hardening = `<section class="panel vm ${onK8s ? 'span2' : 'span3'}"><div class="eyebrow">Sandbox hardening${onK8s ? ' · both pools' : ''}</div><h3>Every sandbox pod gets</h3>
    <ul class="harden">${HARDEN.map((h) => `<li><span class="${onK8s ? 'good' : 'muted'}" aria-hidden="true">${onK8s ? '✓' : '○'}</span> ${h}</li>`).join('')}</ul>
    ${onK8s ? '' : '<p class="muted" style="font-size:.82rem">Local dev: tests run as plain processes (local-unsafe). These controls apply on Vultr Kubernetes Engine.</p>'}</section>`;
  const proof = probe?.proof || r?.proofs?.[0], blocked = probe?.checks.filter((c) => c.outcome === 'BLOCKED').length;
  return `<div class="eyebrow">Infrastructure · show me the instance</div>
    <div class="vm-grid">${vmCard('Control plane', cp)}${onK8s ? vke : vmCard('Sandbox host', sb, sbExtra)}${storage}${hardening}</div>${netbird}
    <section class="panel"><div class="row"><div><div class="eyebrow">Blast radius zero</div><h2 style="margin:0">Isolation probe</h2></div><span class="spacer"></span>
      <button class="btn primary" data-act="probe" ${dis(S.probing)}>${S.probing ? '<span class="spin"></span> Probing…' : 'Run isolation probe'}</button></div>
      ${roLine()}<p class="copyline">The VM can read its Vultr metadata; the sandbox cannot.</p>
      <p class="muted">Agent-written tests never run on the control plane. ${onK8s ? 'Each batch runs as a fresh Kubernetes Job under the gVisor RuntimeClass on Vultr Kubernetes Engine: egress denied by NetworkPolicy, read-only root, no credentials, deleted afterwards.' : 'In local dev they run as plain processes (local-unsafe); on Vultr each batch is a gVisor Job on Kubernetes Engine.'}</p>
      ${probe ? `<p><b>${blocked} of ${probe.checks.length}</b> attacks blocked.</p><div class="tbl-wrap"><table><thead><tr><th>Attack</th><th>Tried inside the sandbox</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>
        ${probe.checks.map((c) => `<tr><td>${esc(c.name)}</td><td class="mono">${esc(c.attempted)}</td><td><span class="chip ${c.outcome === 'BLOCKED' ? 'blocked' : 'allowed'}">${c.outcome === 'BLOCKED' ? '✓ BLOCKED' : '✗ ALLOWED'}</span></td><td>${esc(c.detail)}</td></tr>`).join('')}</tbody></table></div>`
        : `<p class="muted">${MODE === 'snapshot' ? 'The probe is not part of the recording.' : 'Click "Run isolation probe" to try rm -rf /, internet egress, the cloud metadata service and more from inside a fresh sandbox.'}</p>`}
      ${proof ? `<h3 style="margin-top:.8rem">Proof from inside the sandbox</h3><p>hostname <b class="mono">${esc(proof.hostname)}</b> · runtime <b>${esc(runtimeLabel(proof.runtime))}</b> · network <b>${esc(proof.network)}</b>${onK8s ? ' <span class="chip blocked">egress denied by NetworkPolicy</span>' : ''} · read-only root ${yn(proof.readonly_rootfs)}</p><pre>${esc(proof.uname)}</pre>
        ${sb.uname ? `<p class="muted" style="font-size:.82rem">Host kernel for comparison: <span class="mono">${esc(sb.uname)}</span>. A different kernel inside means gVisor's user-space kernel answered, not the host.</p>` : ''}` : ''}
      <p>Teardown: active sandbox ${onK8s ? 'Jobs' : 'processes'} right now <b class="mono">${esc(sb.active_sandboxes ?? '—')}</b>${probe ? ` · probe sandbox ${probe.destroyed ? '<span class="good">✓ destroyed</span>' : '<span class="bad">✗ still running</span>'}` : ''}${r?.sandboxes_used ? ` · this run used ${num(r.sandboxes_used)} sandboxes` : ''}</p></section>`;
}

function lineChart(series) {
  series = series.filter((s) => s[0]?.length);
  if (!series.length) return '';
  const n = Math.max(...series.map((s) => s[0].length)), maxV = Math.max(0, ...series.flatMap((s) => s[0]));
  const frac = maxV <= 1, max = frac ? 1 : Math.max(1, maxV);
  const W = 560, H = 250, pl = 46, pr = 84, pt = 14, pb = 40;
  const X = (i) => pl + (i * (W - pl - pr)) / Math.max(1, n - 1), Y = (v) => pt + (H - pt - pb) * (1 - v / max);
  const step = Math.max(1, Math.ceil(max / 4)), ticks = frac ? [0, 0.25, 0.5, 0.75, 1] : Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  const f = (v) => (frac ? `${Math.round(v * 100)}%` : v);
  const lab = series.map(([a], i) => ({ i, y: Y(a.at(-1)) })).sort((a, b) => a.y - b.y); // keep end labels >= 14px apart
  for (let k = 1; k < lab.length; k++) if (lab[k].y - lab[k - 1].y < 14) lab[k].y = lab[k - 1].y + 14;
  const ly = Object.fromEntries(lab.map((l) => [l.i, l.y]));
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${frac ? 'Share of runs that found the bug' : 'Regressions found'} versus executions: ${esc(series.map((s) => s[1]).join(' versus '))}">
    ${ticks.map((t) => `<line class="ln" x1="${pl}" x2="${W - pr}" y1="${Y(t)}" y2="${Y(t)}"/><text class="t-muted t-mono" x="${pl - 6}" y="${Y(t) + 4}" text-anchor="end" font-size="10">${f(t)}</text>`).join('')}
    ${[0, Math.floor((n - 1) / 2), n - 1].map((i) => `<text class="t-muted t-mono" x="${X(i)}" y="${H - pb + 16}" text-anchor="middle" font-size="10">${i + 1}</text>`).join('')}
    <text class="t-muted" x="${(pl + W - pr) / 2}" y="${H - 6}" text-anchor="middle" font-size="11">Executions (test transactions sent)</text>
    ${series.map(([a, label, c, dash], i) => { const y = ly[i]; return `<path d="${a.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('')}" fill="none" stroke="${c}" stroke-width="3" stroke-dasharray="${dash}"/>
      <text x="${X(a.length - 1) + 8}" y="${y + 4}" font-size="12" font-weight="700" style="fill:${c}">${label}</text>`; }).join('')}</svg>`;
}

function viewRL() {
  const r = S.run, rl = r?.rl || { status: 'idle' }, ff = rl.first_find || {}, cv = rl.curves || {};
  const fmt = (v) => (v == null ? '—' : Number(v).toFixed(1));
  const panel = (title, sub, lk, rk) => {
    if (ff[lk] == null && !cv[lk]?.length) return '';
    const L = ff[lk], R = ff[rk], win = L != null && R != null && L !== R ? (L < R ? 'l' : 'r') : '';
    const box = (who, v, w) => `<div class="${win === w ? 'win' : ''}"><small>${who}</small><b>${fmt(v)}</b><small>executions to first find${win === w ? ' · faster' : ''}</small></div>`;
    return `<div class="panel2"><h3>${title}</h3><p class="muted" style="font-size:.82rem">${sub}</p><div class="ff">${box('Learned policy', L, 'l')}${box('Random order', R, 'r')}</div>
      ${lineChart([[cv[lk], 'Learned', 'var(--vultr-ink)', ''], [cv[rk], 'Random', 'var(--warn)', '6 5']])}</div>`;
  };
  const panels = panel('Trained bug families', `The ${rl.trained_on_bugs?.length || 7} mutant switches it trained on, evaluated on fresh seeds.`, 'learned_training_mix', 'random_training_mix')
    + panel(`Held-out bug · <code>${esc(rl.holdout_bug || 'dup_window_units')}</code>`, 'Never seen in training: the duplicate-window bug from the demo.', 'learned', 'random');
  return `<section class="panel"><div class="row"><div><div class="eyebrow">RL explorer · CPU, no LLM</div><h2 style="margin:0">Can a learned policy find bugs sooner?</h2></div><span class="spacer"></span>
      <button class="btn primary" data-act="rl" ${dis(!r || rl.status === 'running' || S.busy)}>${rl.status === 'running' ? '<span class="spin"></span> Training…' : 'Train RL explorer on CPU'}</button></div>
    <p class="muted">Trained inside a sandbox on 7 mutant switches, then evaluated on a held-out bug. Lower is better. ${rl.episodes ? `${num(rl.episodes)} episodes · ${num(rl.seeds)} evaluation seeds.` : ''}</p>
    ${roLine()}<p class="caption">Learns bug families it has seen; does not generalise to the held-out duplicate bug (reported honestly).</p>
    ${!r ? '<p class="muted">Select a run first.</p>' : rl.status === 'error' ? '<p class="bad">Training failed. Check the sandbox logs.</p>' : ''}
    ${panels ? `<div class="rl-grid">${panels}</div>` : ''}${rl.trained_on_bugs?.length ? `<p class="muted" style="font-size:.8rem">Trained on: <span class="mono">${esc(rl.trained_on_bugs.join(', '))}</span></p>` : ''}</section>`;
}

function viewOverview() {
  const r = S.run;
  if (!r) return `<section class="panel"><h3>No run yet</h3><p class="muted">Describe what the new switch must do; Vultr AI writes ISO 8583 tests and you approve every one before anything runs.</p>${roLine()}
    <button class="btn primary" data-act="nav" data-v="rules">Write the rules →</button></section>`;
  const c = r.counts, ps = r.proofs || [], n = (p) => ps.filter((x) => poolOf(x) === p).length, gh = r.github || {};
  const cases = casesOf(r), prop = cases.filter((x) => x.status === 'proposed').length, st = stage(r.status);
  const gate = st >= stage('running') ? ['Open', 'good', 'every test decided'] : gateOpen(r) ? ['Ready', 'good', 'every test decided'] : ['Locked', 'warn', `${num(prop)} of ${num(cases.length)} tests waiting`];
  const tri = r.triage ? `<b class="bad">${esc(r.triage.severity)}</b> · ${esc(r.triage.root_cause_hypothesis)} · money at risk ${usd(r.triage.money_at_risk_cents)}`
    : st >= stage('triaging') ? 'Triage agent is running follow-ups…' : 'Starts after the sandbox run.';
  const cell = (label, big, sub, cls = '', to = '') => `<${to ? `button data-act="nav" data-v="${to}"` : 'div'} class="sumcell ${cls}"><small>${label}</small><b>${big}</b><span>${sub}</span></${to ? 'button' : 'div'}>`;
  return `<section class="panel summary"><div class="eyebrow">Run ${esc(r.id)} · ${esc(STATUS_LABEL[r.status] || r.status)} · ${dt(r.created_at)}</div><h2 style="margin:.1rem 0 .7rem">${esc(r.title)}</h2>
    <div class="sumgrid">
      ${cell('Tests executed', num(c.total), `${num(c.passed)} passed · ${num(c.regression)} regressions · ${num(c.error)} errors`, c.regression ? 'bad' : '', 'run')}
      ${cell('Sandboxes', num(r.sandboxes_used), `${n('agent')} agent pool · ${n('data')} data pool${ps.length && r.status !== 'running' ? ' · all destroyed ✓' : ''}`, '', 'infra')}
      ${cell('Human gate', `${LOCK(gate[0] !== 'Locked', 16)} ${gate[0]}`, gate[2], gate[1], 'review')}
      ${cell('Release gate', esc(gh.status_state || '—'), r.decision ? `${r.decision.decision === 'block' ? 'blocked' : 'approved'} by ${esc(r.decision.reviewer)}` : 'GitHub commit status', gh.status_state === 'failure' ? 'bad' : gh.status_state === 'success' ? 'good' : '', 'decision')}
    </div>
    <p class="tri"><span class="eyebrow" style="display:inline">Triage</span> ${tri}</p></section>`;
}

// ---------- metrics (evaluation) ----------
async function loadMetrics() {
  if (S.metricsLoading) return;
  S.metricsLoading = true;
  const id = S.metricsFor || S.run?.id, fail = (e) => ({ error: e.message, status: e.status });
  const [m, all] = await Promise.all([id ? api('GET', `/api/runs/${id}/metrics`).catch(fail) : null, S.metricsAll ? S.metricsAll : api('GET', '/api/metrics').catch(fail)]);
  S.metrics = m; S.metricsAll = all; S.metricsLoading = false;
  render(true);
}
const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(v >= 99.95 || v === 0 ? 0 : 1)}%`);
const dur = (sec) => { if (sec == null) return '—'; const s = Math.round(sec); return s < 60 ? `${sec < 10 ? Number(sec).toFixed(1) : s} s` : `${Math.floor(s / 60)} m ${s % 60} s`; };
const secs1 = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const cost = (v) => (v == null ? '—' : `$${Number(v) < 1 ? Number(v).toFixed(3) : Number(v).toFixed(2)}`);
const RULE_NAME = (r) => (r === 'replay' ? 'IBM TabFormer replay' : RULES[r] || r);

function viewMetrics() {
  if (S.metrics === undefined || S.metricsAll === undefined) { loadMetrics(); return empty('<span class="spin"></span> Loading metrics…'); }
  const m = S.metrics, all = S.metricsAll, recorded = MODE !== 'live';
  const head = `<section class="panel"><div class="row"><div><div class="eyebrow">Evaluation${m?.run_id ? ` · run ${esc(m.run_id)} · ${esc(STATUS_LABEL[m.status] || m.status || '')}` : ''}</div>
      <h1 style="margin:0">Metrics</h1><p class="muted" style="margin:.2rem 0 0">${m?.title ? esc(m.title) : 'How well did the agents, the sandboxes and the test suite do?'}</p></div><span class="spacer"></span>
      ${recorded ? '<span class="chip v-error">recorded example · real 10k run on our Vultr deployment</span>' : ''}
      ${S.metricsFor ? `<button class="btn small" data-act="metrics-run" data-id="${esc(S.run?.id || '')}">Back to current run</button>` : ''}<button class="btn small" data-act="metrics-refresh">Refresh</button></div></section>`;
  let body = '';
  if (!m || m.error) {
    body = `<section class="panel"><p class="muted">${!m ? 'Select or start a run to see its metrics.' : m.status === 404 ? 'No metrics for this run yet (or this backend has no metrics endpoint).' : esc(m.error)}</p></section>`;
  } else {
    const c = m.counts || {}, d = m.detection || {}, cov = m.coverage || {}, q = m.ai_quality || {}, ag = m.agents || {}, sb = m.sandboxes || {};
    const tile = (label, big, sub, cls = '') => `<div class="mtile ${cls}"><small>${label}</small><b>${big}</b><span>${sub}</span></div>`;
    const score = `<div class="mgrid">
      ${tile('Defect caught', d.defect_caught ? '✓ Yes' : '— Not yet', d.defect_caught ? `found in ${dur(d.seconds_to_first_finding)} · ${esc(d.severity || '')}${d.money_at_risk_cents ? ` · ${usd(d.money_at_risk_cents)} at risk` : ''}` : 'no regression found so far', d.defect_caught ? 'good' : '')}
      ${tile('Pass rate', pct(m.pass_rate_pct), `${num(c.passed)} of ${num(c.total)} · ${num(c.regression)} regressions`, c.regression ? 'warn' : 'good')}
      ${tile('Throughput', `${m.tests_per_second ?? '—'}<em>tests/s</em>`, `${num(c.total)} tests in ${dur(m.wall_seconds)}`)}
      ${tile('AI expectation accuracy', pct(q.expectation_correct_pct), `${num(q.executed)} AI-written tests executed · ${num(q.both_wrong)} both-wrong`, q.expectation_correct_pct >= 95 ? 'good' : '')}
      ${tile('Sandboxes', num(sb.count), `${sb.gvisor === sb.count && sb.count ? 'all gVisor ✓' : `${num(sb.gvisor)} gVisor · ${num(sb.not_gvisor)} not`} · ${sb.destroyed_all ? 'all destroyed ✓' : 'not all destroyed ✗'}`, sb.gvisor === sb.count && sb.destroyed_all ? 'good' : 'bad')}
      ${tile('Total AI cost', cost(ag.cost_usd), `${num(ag.tokens)} tokens · ${num(ag.llm_calls)} Vultr inference calls`)}
    </div>
    ${d.boundary || d.root_cause ? `<div class="mdetect">${d.boundary ? `<p><b>Boundary</b> ${esc(d.boundary)}</p>` : ''}${d.root_cause ? `<p><b>Root cause</b> ${esc(d.root_cause)}</p>` : ''}${d.decision ? `<p><b>Decision</b> ${esc(d.decision)}</p>` : ''}</div>` : ''}`;

    const per = Object.entries(cov.per_rule || {}).sort(([a], [b]) => (a === 'replay') - (b === 'replay'));
    const SEG = [['pass', 'pass', 'var(--good)'], ['regression', 'regression', 'var(--bad)'], ['both_wrong', 'both wrong', 'var(--warn)'], ['error', 'error', 'var(--faint)'], ['noise', 'noise', 'var(--line2)']];
    const bar = (v) => { const n = v.cases || SEG.reduce((t, [k]) => t + (v[k] || 0), 0) || 1;
      return `<div class="sbar" role="img" aria-label="${esc(SEG.filter(([k]) => v[k]).map(([k, l]) => `${v[k]} ${l}`).join(', '))}">${SEG.filter(([k]) => v[k]).map(([k, l, col]) => `<i style="width:${(100 * v[k] / n).toFixed(2)}%;background:${col}" title="${v[k]} ${l}"></i>`).join('')}</div>`; };
    const coverage = `<section class="panel"><div class="row"><h2 style="margin:0">Coverage by rule</h2><span class="spacer"></span>
        <span class="chip">${num(cov.rules_with_cases)} of ${num(cov.rules_planned)} planned rules have tests</span>
        ${Object.entries(cov.cases_by_source || {}).map(([k, v]) => `<span class="chip">${esc(SRC[k] || k)}: ${num(v)}</span>`).join('')}</div>
      <div class="legend">${SEG.slice(0, 4).map(([, l, col]) => `<span><i style="background:${col}"></i>${l}</span>`).join('')}</div>
      <div class="tbl-wrap"><table class="mtable"><thead><tr><th>Rule</th><th class="num">Cases</th><th style="width:40%">Outcome</th><th class="num">Pass</th><th class="num">Regression</th><th class="num">Both wrong</th><th class="num">Error</th></tr></thead><tbody>
      ${per.map(([r, v]) => `<tr><td>${r === 'replay' ? `<b>${esc(RULE_NAME(r))}</b>` : esc(RULE_NAME(r))}</td><td class="num">${num(v.cases)}</td><td>${bar(v)}</td><td class="num">${num(v.pass)}</td><td class="num ${v.regression ? 'bad' : ''}">${num(v.regression)}</td><td class="num">${num(v.both_wrong)}</td><td class="num">${num(v.error)}</td></tr>`).join('')}
      </tbody></table></div></section>`;

    const agents = Object.entries(ag.per_agent || {});
    const aiAgents = `<section class="panel"><h2>AI agents</h2>
      <p class="muted" style="margin-top:0">GLM-5.3 does the reasoning (coordinator, planner, triage); DeepSeek-v4.1-flash does fast structured test writing. All calls go to Vultr Serverless Inference.</p>
      <div class="tbl-wrap"><table class="mtable"><thead><tr><th>Agent</th><th>Model</th><th class="num">Calls</th><th class="num">Tokens in</th><th class="num">Tokens out</th><th class="num">Avg latency</th><th class="num">p95 latency</th><th class="num">Cost</th></tr></thead><tbody>
      ${agents.map(([n, a]) => `<tr><td><span class="ag-c" style="--c:${col(n)};font-weight:700;text-transform:capitalize">${esc(nm(n))}</span></td><td><span class="badge vultr">Vultr · ${esc(a.model || '?')}</span></td><td class="num">${num(a.calls)}</td><td class="num">${num(a.tokens_in)}</td><td class="num">${num(a.tokens_out)}</td><td class="num">${secs1(a.avg_latency_ms)}</td><td class="num">${secs1(a.p95_latency_ms)}</td><td class="num">${cost(a.cost_usd)}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td>${num(ag.loop_iterations)} coordinator loops · ${num(ag.agent_messages)} agent messages</td><td class="num">${num(ag.llm_calls)}</td><td class="num">${num(agents.reduce((t, [, a]) => t + (a.tokens_in || 0), 0))}</td><td class="num">${num(agents.reduce((t, [, a]) => t + (a.tokens_out || 0), 0))}</td><td></td><td></td><td class="num">${cost(ag.cost_usd)}</td></tr>
      </tbody></table></div></section>`;

    const top = Math.max(1, q.proposed || 0);
    const stepRow = (label, v, note, cls = '') => `<div class="fstep ${cls}"><span class="fl">${label}</span><div class="fbar"><i style="width:${Math.max(v ? 3 : 0, (100 * (v || 0)) / top).toFixed(1)}%"></i></div><b>${num(v)}</b><span class="muted">${note}</span></div>`;
    const correct = q.executed && q.expectation_correct_pct != null ? Math.round((q.executed * q.expectation_correct_pct) / 100) : 0;
    const quality = `<section class="panel"><h2>AI test quality</h2><div class="funnel">
      ${stepRow('Proposed by the generator', q.proposed, 'ISO 8583 test cases written by the LLM')}
      ${stepRow('Rejected by the validator', q.rejected_by_validator, `schema / bounds check · ${num(q.repaired_by_validator)} repaired`, 'minus')}
      ${stepRow('Rejected by the human', q.rejected_by_human, 'at the approval gate', 'minus')}
      ${stepRow('Executed in sandboxes', q.executed, 'approved, then run in gVisor')}
      ${stepRow('Correct expectations', correct, `${pct(q.expectation_correct_pct)} matched the legacy switch · ${num(q.both_wrong)} both-wrong`, 'good')}
      ${stepRow('Follow-ups designed by triage', q.followups_designed_by_triage, 'boundary search inside the human bounds', 'extra')}
      </div></section>`;

    const bp = sb.by_pool || {};
    const sandboxes = `<section class="panel"><h2>Sandboxes</h2><div class="mgrid small">
      ${tile('Agent pool', num(bp.agent), 'agent-written tests · switchproof-agent')}
      ${tile('Data pool', num(bp.data), 'replay data, no agent code · switchproof-data')}
      ${tile('gVisor', `${num(sb.gvisor)}/${num(sb.count)}`, sb.not_gvisor ? `${num(sb.not_gvisor)} ran without gVisor ✗` : 'every sandbox under runsc ✓', sb.not_gvisor ? 'bad' : 'good')}
      ${tile('Destroyed', sb.destroyed_all ? '✓ all' : '✗', 'Job deleted after each batch', sb.destroyed_all ? 'good' : 'bad')}
      ${tile('Avg time per case', sb.case_ms_avg != null ? `${sb.case_ms_avg}<em>ms</em>` : '—', 'inside the sandbox')}
      </div></section>`;
    body = score + coverage + `<div class="grid2">${quality}${sandboxes}</div>` + aiAgents;
  }
  const rows = Array.isArray(all) ? [...all].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) : null;
  const cur = S.metricsFor || S.run?.id;
  const runs = `<section class="panel"><h2>All runs</h2>${!rows ? `<p class="muted">${all?.status === 404 ? 'This backend has no run comparison endpoint.' : esc(all?.error || 'Unavailable.')}</p>`
    : `<div class="tbl-wrap"><table class="mtable runs"><thead><tr><th>Run</th><th>Status</th><th class="num">Tests</th><th class="num">Regressions</th><th>Caught?</th><th class="num">Time to find</th><th class="num">AI tests</th><th class="num">Accuracy</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Sandboxes</th><th class="num">Duration</th><th>Models</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.run_id === cur ? 'cur' : ''}"><td><button class="linkbtn" data-act="metrics-run" data-id="${esc(r.run_id)}" ${r.run_id === cur ? 'aria-current="true"' : ''}>${esc(r.title || r.run_id)}</button><small class="mono">${esc(r.run_id)} · ${dt(r.created_at)}</small></td>
      <td><span class="chip">${esc(STATUS_LABEL[r.status] || r.status)}</span></td><td class="num">${num(r.tests)}</td><td class="num ${r.regressions ? 'bad' : ''}">${num(r.regressions)}</td>
      <td>${r.defect_caught ? '<span class="good">✓ caught</span>' : '<span class="muted">—</span>'}</td><td class="num">${dur(r.seconds_to_first_finding)}</td><td class="num">${num(r.ai_tests)}</td>
      <td class="num">${pct(r.expectation_correct_pct)}</td><td class="num">${num(r.tokens)}</td><td class="num">${cost(r.cost_usd)}</td><td class="num">${num(r.sandboxes)}</td><td class="num">${dur(r.wall_seconds)}</td>
      <td>${(r.models || []).map((x) => `<span class="badge vultr">${esc(x)}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table></div><p class="muted" style="font-size:.8rem">Click a run to open its metrics.</p>`}</section>`;
  return head + body + runs;
}

// ---------- render ----------
const VIEW_FN = { metrics: viewMetrics, overview: viewOverview, rules: viewRules, review: viewReview, run: viewRun, evidence: viewEvidence, decision: viewDecision, agents: viewAgents, infra: viewInfra, rl: viewRL };

function renderTop() {
  const r = S.run, sys = S.system;
  const cp = sys?.control_plane || {}, sb = sys?.sandbox_host || {}, llm = sys?.llm || {}, v = cp.vultr || {};
  const b = $('#badge');
  if (MODE === 'snapshot') { b.className = 'badge-live vultr'; b.innerHTML = '<b>RECORDED</b> Vultr deployment'; }
  else if (!sys) b.innerHTML = '<span class="spin"></span> connecting';
  else if (sys.error) { b.className = 'badge-live'; b.innerHTML = '<span class="dot bad"></span><b>OFFLINE</b> control plane unreachable'; }
  else if (v.available) {
    const vms = 1 + (sb.vultr?.available ? 1 : 0);
    b.className = 'badge-live vultr';
    b.innerHTML = `${MODE === 'mock' ? '<b>MOCK</b>' : '<span class="dot ok"></span><b>LIVE</b>'} on Vultr · ${esc(v.region || '?')} · ${vms} VM${vms > 1 ? 's' : ''}${sb.mode === 'kubernetes' ? ' + VKE' : ''}`;
  } else { b.className = 'badge-live'; b.innerHTML = '<span class="dot"></span><b>LOCAL DEV</b> not on Vultr'; }
  if (sys?.netbird?.available) b.innerHTML += ` <span class="nb" title="Reached through NetBird">${SHIELD} NetBird</span>`;
  const me = S.me, short = (u) => (u && u.length > 16 && u.includes('@') ? u.split('@')[0] + '@…' : u || '');
  $('#me').innerHTML = !me || me.auth === 'none' ? '' : me.can_act
    ? `<span class="chip-model" title="${esc(me.user || '')}">${SHIELD} ${esc(short(me.user))} · ${esc((me.role || 'tester').replace(/^./, (c) => c.toUpperCase()))} · NetBird SSO</span>`
    : `<span class="chip-model">${SHIELD} Viewer · read-only (NetBird PIN)</span>`;
  const lstate = llm.offline ? ['', 'offline'] : llm.reachable === true ? ['ok', 'reachable'] : llm.reachable === false ? ['bad', 'unreachable'] : null;
  $('#model').innerHTML = sys && !sys.error ? `<span class="chip-model">Vultr · <b>${esc(llm.model || '—')}</b>${lstate ? ` <i class="dot ${lstate[0]}" title="${lstate[1]}"></i><span class="sr">${lstate[1]}</span>` : ''}</span>` : '';
  const llmEv = S.events.filter((e) => e.kind === 'llm_call');
  const telemetry = `<span class="telemetry" aria-label="Run telemetry"><b>${S.agents.length || AGENTS.length}</b> agents · <b>${num(llmEv.length)}</b> inference calls · <b>${num(llmEv.reduce((s, e) => s + (e.tokens_in || 0) + (e.tokens_out || 0), 0))}</b> tokens</span>`;
  $('#sw-sum').textContent = r ? `${r.title} · ${STATUS_LABEL[r.status] || r.status}` : `Runs (${S.runs.length})`;
  $('#runs').innerHTML = S.runs.map((x) => `<button class="run-item" data-act="open" data-id="${esc(x.id)}" aria-current="${x.id === r?.id}"><span class="t">${esc(x.title)}</span><small>${esc(STATUS_LABEL[x.id === r?.id ? r.status : x.status] || x.status)} · ${dt(x.created_at)} · ${esc(x.id)}</small></button>`).join('') || '<p class="muted" style="padding:.4rem">No runs yet.</p>';
  const st = r ? stage(r.status) : -1, open = gateOpen(r);
  const done = { rules: !!r, review: st > stage('awaiting_approval'), run: st >= stage('awaiting_decision'), evidence: !!r?.decision, decision: !!r?.decision };
  const cur = (v) => (S.page === v ? 'aria-current="page"' : '');
  const btn = ([v, label], i) => { const wait = !reached(v) && !done[v];
    return `<button data-act="nav" data-v="${v}" class="${done[v] ? 'done' : ''} ${wait ? 'waiting' : ''}" ${cur(v)}><span class="n">${done[v] ? '✓' : wait ? LOCK(false, 11) : i + 1}</span>${label}<span class="sr">${done[v] ? ' (done)' : wait ? ' (waiting)' : ''}</span></button>`; };
  const html = `<button data-act="nav" data-v="overview" class="ov" ${cur('overview')}><span class="n">◎</span>Overview</button>` + STEPS.slice(0, 2).map(btn).join('')
    + `<span class="lockline ${open ? 'open' : ''}" role="img" aria-label="Human gate ${open ? 'open' : 'locked'}" title="Human gate ${open ? 'open' : 'locked'}">${LOCK(open)}</span>`
    + STEPS.slice(2).map((x, i) => btn(x, i + 2)).join('') + '<span class="sep" aria-hidden="true"></span>'
    + TABS.map(([v, label]) => `<button class="tab ${reached(v) ? '' : 'waiting'}" data-act="nav" data-v="${v}" ${cur(v)}>${label}</button>`).join('') + telemetry;
  const rail = $('#rail'); if (rail._h !== html) { rail.innerHTML = html; rail._h = html; }
}

const reached = (id) => { const r = S.run, st = r ? stage(r.status) : -1;
  return { metrics: true, overview: true, rules: true, review: !!r, run: st >= stage('running'), evidence: st >= stage('running'), decision: st >= stage('awaiting_decision'), agents: !!r, infra: true, rl: !!r }[id]; };

function secKey(id) {
  const r = S.run, busy = [S.busy, S.me?.can_act], fl = S.flashUntil > Date.now();
  switch (id) {
    case 'overview': return [r?.id, r?.status, r?.title, r?.counts, r?.proofs?.length, r?.sandboxes_used, r?.triage, r?.github, r?.cases?.map((c) => c.status), r?.decision];
    case 'rules': return [r?.id, r?.created_at, ...busy];
    case 'metrics': return [r?.id, S.metricsFor, S.metrics, S.metricsAll];
    case 'review': return [r?.id, r?.status, r?.cases, r?.plan, r?.replay, S.editing, ...busy, r && !casesOf(r).length ? S.events.length : 0];
    case 'run': return [r?.id, r?.status, r?.counts, r?.proofs, r?.replay, S.events.length, S.agents, S.findingSeen, fl, S.system?.sandbox_host?.mode];
    case 'evidence': return [r?.id, r?.status, r?.triage, r?.github, r?.proofs?.length, S.results ? S.results.length : -1, S.triageResults?.length, S.verdict, S.sel, S.findingSeen, fl, S.system?.sandbox_host?.mode];
    case 'decision': return [r?.id, r?.status, r?.decision, r?.github, r?.counts, r?.triage, r?.sandboxes_used, S.share, S.shareWas, ...busy];
    case 'agents': return [r?.id, S.events.length, S.agents, S.convAgent, S.showLLM];
    case 'infra': return [S.system, S.probe, S.probing, r?.proofs?.length, r?.sandboxes_used, ...busy];
    case 'rl': return [r?.id, r?.rl, ...busy];
  }
  return [];
}

function renderSection(id, force) {
  const sec = document.getElementById(`sec-${id}`), el = sec?.querySelector('.sec-body'); if (!el) return;
  const key = JSON.stringify(secKey(id));
  const editing = el.contains(document.activeElement) && document.activeElement.matches('input,textarea,select');
  // Polling never clobbers a form the user is editing; explicit actions (force) do.
  if (!force && (key === S.keys[id] || S.dirtySec.has(id) || editing)) return;
  S.keys[id] = key; S.dirtySec.delete(id);
  sec.classList.toggle('waiting', !reached(id));
  const open = [...el.querySelectorAll('details[open][data-k]')].map((d) => d.dataset.k);
  const keep = Object.fromEntries([...el.querySelectorAll('[data-keep]')].map((x) => [x.dataset.keep, x.scrollTop]));
  el.innerHTML = VIEW_FN[id]();
  open.forEach((k) => el.querySelector(`details[data-k="${CSS.escape(k)}"]`)?.setAttribute('open', ''));
  el.querySelectorAll('[data-keep]').forEach((x) => { if (keep[x.dataset.keep] != null) x.scrollTop = keep[x.dataset.keep]; });
  el.querySelectorAll('[data-bottom]').forEach((x) => { x.scrollTop = x.scrollHeight; });
  if (id === 'run') S.run?.proofs?.forEach((p) => S.seen.add(p.sandbox_id));
}

// ---------- hero: status line (the accessible equivalent of the 3D scene) + scene sync ----------
function heroStatus() {
  const r = S.run;
  if (!r) return ['Waiting for rules', 'Describe what the new switch must do. Vultr AI writes the tests; you approve every one.', ''];
  const c = r.counts, cases = casesOf(r), prop = cases.filter((x) => x.status === 'proposed').length;
  const planned = cases.filter((x) => x.status === 'approved').length + (r.replay.enabled ? r.replay.sample_size : 0);
  const dup = S.events.some((e) => e.kind === 'finding' && e.data?.old_code === '94' && e.data?.new_code === '00');
  const reg = S.findingSeen || c.regression > 0, regText = dup ? 'New switch charged a customer twice' : 'New switch disagrees with the legacy switch';
  switch (r.status) {
    case 'draft': case 'planning': return ['Vultr AI is writing tests…', 'coordinator → planner → generator on Vultr Serverless Inference', ''];
    case 'awaiting_approval': return prop ? [`${num(prop)} test${prop > 1 ? 's' : ''} await your approval`, 'Human gate locked: nothing runs until every test is decided', 'warn']
      : ['Every test decided. The gate is open', 'Run the approved tests in gVisor sandboxes', 'good'];
    case 'running': return reg ? [regText, `Running ${num(c.total)} / ${num(planned)} · ${num(c.regression)} regressions`, 'bad'] : [`Running ${num(c.total)} / ${num(planned)}`, 'Every message goes to OLD A, OLD B and NEW', ''];
    case 'triaging': return [reg ? regText : 'Triage agent investigating', 'Triage agent is finding the boundary inside your bounds', reg ? 'bad' : ''];
    case 'awaiting_decision': return reg ? [regText, `${num(c.regression)} regressions · your decision`, 'bad'] : ['No regressions found', 'Awaiting your decision', 'good'];
    case 'blocked': return [`Migration blocked by ${r.decision?.reviewer || 'the reviewer'}`, `GitHub gate: ${r.github?.status_state || 'failure'}`, 'bad'];
    case 'approved_for_release': return [`Release approved by ${r.decision?.reviewer || 'the reviewer'}`, `GitHub gate: ${r.github?.status_state || 'success'}`, 'good'];
  }
  return [STATUS_LABEL[r.status] || r.status, '', ''];
}

let scene = null, sceneRun, sceneIds = new Set(), lastPulse = '';
const towersFor = (a, b, n, exp) => { const reg = n !== a && a === b, t = (cd, st) => ({ text: `${cd}\n${SHORT[cd] || CODES[cd] || ''}`, state: st });
  return { old_a: t(a, a === exp ? 'ok' : 'idle'), old_b: t(b, b === exp ? 'ok' : 'idle'), new: t(n, reg ? 'bad' : n === exp ? 'ok' : 'idle') }; };
function syncScene() {
  if (!scene) return;
  const r = S.run, ps = r?.proofs || [];
  if ((r?.id || null) !== sceneRun) {       // new run: start clean, no burst of old pods
    sceneRun = r?.id || null; scene.reset(); sceneIds = new Set(ps.map((p) => p.sandbox_id)); lastPulse = '';
    if (r?.status === 'running' && ps.length) scene.addPod(ps.at(-1).sandbox_id, poolOf(ps.at(-1)));
  }
  for (const p of ps) if (!sceneIds.has(p.sandbox_id)) { sceneIds.add(p.sandbox_id); scene.addPod(p.sandbox_id, poolOf(p)); }
  scene.setRunning(r?.status === 'running' ? ps.at(-1)?.sandbox_id ?? null : null);
  const count = (pool) => { const n = ps.filter((p) => poolOf(p) === pool).length; return n ? ` · ${n} Job${n > 1 ? 's' : ''}${r.status === 'running' ? '' : ', destroyed ✓'}` : ''; };
  scene.setPools({ agent: `agent-written tests${count('agent')}`, data: `replay data, no agent code${count('data')}` });
  let towers = null, callout = '', screen = 'ISO 8583';
  const x = S.replayOn && S.page === 'evidence' && S.results?.find((y) => y.case.id === S.sel); // replay drives the towers only on Evidence
  if (x && x.result.steps.length) {
    const res = x.result, n = res.steps.length, i = Math.min(S.replayStep, n - 1), st = res.steps[i], cs = x.case.steps[i] || {};
    towers = towersFor(st.old_a_code, st.old_b_code, st.new_code, st.expected_code);
    if (i === n - 1) callout = calloutText(extraDebit(res.balance_delta_cents), res.steps.some((t) => t.old_a_code === '94' && t.new_code === '00'));
    screen = `${cs.mti || ''} · STAN ${cs.stan || ''}`;
    const pk = `${x.case.id}:${i}`; if (pk !== lastPulse) { lastPulse = pk; scene.pulse(); }
  } else {
    const f = S.events.find((e) => e.kind === 'finding' && e.data?.new_code);
    if (f) { const d = f.data; towers = towersFor(d.old_code, d.old_code, d.new_code, d.old_code); callout = calloutText(extraDebit(d.balance_delta_cents), d.old_code === '94' && d.new_code === '00'); }
  }
  const stg = r ? stage(r.status) : -1;
  scene.setState({ gate: stg >= stage('running') ? 'open' : gateOpen(r) ? 'ready' : 'closed', blocked: r?.decision?.decision === 'block',
    flowing: ['running', 'triaging'].includes(r?.status), towers, callout, screen }); // replays use pulse() bursts
}

function nextAction() {
  const r = S.run; if (!r) return [['rules', 'Write the rules →']];
  const prop = casesOf(r).filter((c) => c.status === 'proposed').length;
  switch (r.status) {
    case 'draft': case 'planning': return [['review', 'Watch Vultr AI write the tests →']];
    case 'awaiting_approval': return [['review', prop ? `Review ${num(prop)} test${prop > 1 ? 's' : ''} →` : 'Run the approved tests →']];
    case 'running': case 'triaging': return [['run', 'Watch the sandboxes →']];
    case 'awaiting_decision': return [['evidence', 'Open evidence →'], ['decision', 'Make the decision →']];
  }
  return [['decision', 'See the decision →'], ['evidence', 'Open evidence →']];
}

function renderHero() {
  const [main, sub, tone] = heroStatus(), st = $('#hero-status');
  if (st.textContent !== main) st.textContent = main;
  const cta = nextAction().map(([v, t], i) => `<button class="btn ${i ? '' : 'primary'}" data-act="nav" data-v="${v}">${esc(t)}</button>`).join('');
  const ce = $('#hero-cta'); if (ce._h !== cta) { ce.innerHTML = cta; ce._h = cta; }
  $('#hero-sub').textContent = sub; $('#hero').dataset.tone = tone;
  if (scene) return syncScene();
  const fb = $('#hero-fallback'), html = heroInner('run');
  if (fb._h !== html) { fb.innerHTML = html; fb._h = html; }
}

function render(force = false) {
  renderTop(); renderHero();
  renderSection(S.page, force);   // hidden pages render when they are opened
}

const pageHash = (page) => `#${S.run ? encodeURIComponent(S.run.id) + '/' : ''}${toHash(page)}`;
function parseHash() {
  const [a, b] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (b) return { id: a, view: fromHash(b) };
  return PAGES.includes(fromHash(a)) ? { id: null, view: fromHash(a) } : { id: a || null, view: null };
}
// Navigate: push a history entry; the hashchange listener shows the page (so back/forward behave the same way).
function go(page) {
  if (!PAGES.includes(page)) return;
  if (location.hash === pageHash(page)) return showPage(page);
  location.hash = pageHash(page);
}
function placeHero(page) {
  const hero = $('#hero'), mode = SCENE_PAGES[page], slot = mode ? $(`#sec-${page} .hero-slot`) : $('#hero-park');
  if (hero.parentElement !== slot) slot.appendChild(hero);  // moving the canvas keeps its single WebGL context
  hero.classList.toggle('compact', mode === 'compact');
}
function showPage(page, { replace = false } = {}) {
  page = PAGES.includes(page) ? page : 'overview';
  const changed = page !== S.page || replace;
  S.page = page;
  if (replace) history.replaceState(null, '', `${location.search}${pageHash(page)}`);
  for (const p of PAGES) { const el = $(`#sec-${p}`); el.hidden = p !== page; }
  placeHero(page);
  const el = $(`#sec-${page}`);
  el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
  render(true);
  if (page === 'evidence' && S.results) startReplay();
  if (changed) { window.scrollTo(0, 0); el.querySelector('.sec-h')?.focus({ preventScroll: true }); }
}
window.addEventListener('hashchange', () => {
  const { id, view } = parseHash();
  if (id && id !== S.run?.id) return selectRun(id, view || 'overview');
  showPage(view || 'overview');
});

// ---------- events ----------
const ACTIONS = {
  nav: (b) => go(b.dataset.v),
  new: () => { clearInterval(replayTimer); Object.assign(S, { run: null, events: [], agents: [], results: null, triageResults: null, replayOn: false, keys: {} }); go('rules'); },
  open: (b) => { $('#switcher').open = false; selectRun(b.dataset.id); },
  sel: (b) => { S.sel = b.dataset.id; render(true); startReplay(); },
  replay: () => startReplay(),
  'replay-step': (b) => { clearInterval(replayTimer); S.replayStep = +b.dataset.i; drawHero(); },
  'case-edit': (b) => { S.editing = b.dataset.id; render(true); },
  'case-cancel': () => { S.editing = null; render(true); },
  'case-status': (b) => act(() => api('PATCH', `/api/runs/${S.run.id}/cases/${b.dataset.id}`, { status: b.dataset.v })),
  'approve-all': () => act(async () => { const j = await api('POST', `/api/runs/${S.run.id}/approve_all`); toast(`Approved ${j.approved} tests`); }),
  execute: () => act(() => api('POST', `/api/runs/${S.run.id}/execute`)),
  'metrics-run': (b) => { const id = b.dataset.id; if (id !== S.run?.id && S.runs.some((x) => x.id === id)) return selectRun(id, 'metrics');
    S.metricsFor = id === S.run?.id ? null : id; S.metrics = undefined; render(true); window.scrollTo(0, 0); },
  'metrics-refresh': () => { S.metrics = S.metricsAll = undefined; render(true); },
  rl: () => act(async () => { await api('POST', `/api/runs/${S.run.id}/rl`); S.run.rl = { status: 'running' }; }),
  'share-create': () => act(async () => { S.share = await api('POST', `/api/runs/${S.run.id}/share`); S.shareWas = true; }),
  'share-close': () => act(async () => { S.share = await api('DELETE', `/api/runs/${S.run.id}/share`); }),
  probe: async () => {
    S.probing = true; render(true);
    try { S.probe = await api('POST', '/api/system/probe'); S.system = await api('GET', '/api/system'); } catch (e) { toast(`Probe failed: ${e.message}`, 'err'); }
    S.probing = false; render(true);
  },
};
const FORMS = {
  'new-run': (f, fd) => act(async () => {
    const run = await api('POST', '/api/runs', {
      title: fd.get('title'), requirements: fd.getAll('req').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean),
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
    setTimeout(() => go('decision'), 150); // stamp + the BLOCKED barrier in the banner
    S.runs = await api('GET', '/api/runs');
  }),
};
document.addEventListener('click', (e) => {
  // the skip link must not touch the hash (the hash is the router): move focus to the page heading instead
  if (e.target.closest('.skip')) { e.preventDefault(); $(`#sec-${S.page} .sec-h`)?.focus(); return; }
  const sw = $('#switcher'); if (sw.open && !sw.contains(e.target)) sw.open = false;
  const b = e.target.closest('[data-act]'); if (b && !b.disabled) ACTIONS[b.dataset.act]?.(b);
});
document.addEventListener('submit', (e) => { const f = e.target; if (FORMS[f.dataset.form]) { e.preventDefault(); if (!S.busy) FORMS[f.dataset.form](f, new FormData(f), e.submitter); } });
document.addEventListener('input', (e) => { const sec = e.target.closest('.sec'); if (sec && e.target.closest('form')) S.dirtySec.add(sec.dataset.sec); });
document.addEventListener('change', (e) => {
  const k = e.target.dataset.change; if (!k) return;
  if (k === 'verdict') { S.verdict = e.target.value; S.results = null; }
  if (k === 'conv-agent') S.convAgent = e.target.value;
  if (k === 'show-llm') S.showLLM = e.target.checked;
  e.target.blur(); render(true);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#switcher').open = false; });

// ---------- boot ----------
(async function boot() {
  if (['dark', 'light'].includes(qs.get('theme'))) document.documentElement.dataset.theme = qs.get('theme');
  const banner = { mock: 'Mock mode: fixture data, no backend. Numbers and ids are placeholders; the data set is IBM TabFormer (public synthetic) and the defect is seeded.',
    snapshot: 'Recorded run from our Vultr deployment (Atlanta): real Vultr Kubernetes sandboxes and Vultr Serverless Inference. Read-only replay; synthetic data, seeded defect.' }[MODE];
  if (banner) { $('#mode').textContent = banner; $('#mode').hidden = false; }
  try { if (MODE === 'mock') { await loadMock(); if (qs.get('viewer') === '1') FX.me = { auth: 'netbird', user: null, groups: [], role: 'viewer', can_act: false }; } } catch (e) { toast(`Could not load mock fixtures: ${e.message}`, 'err'); }
  // run from #<id>/<view> or ?run=<id> (links in GitHub issues use ?run=); read before the first render rewrites the hash
  const parsed = parseHash(), hashId = parsed.id;
  const id = hashId || qs.get('run') || '';
  const view = parsed.view;
  const topH = () => document.documentElement.style.setProperty('--top-h', `${$('.top').offsetHeight}px`);
  topH(); new ResizeObserver(topH).observe($('.top'));
  await startScene();
  await tick();
  // no run asked for: open the most recent one so visitors never land on an empty page
  const want = S.runs.find((x) => x.id === id) || ((MODE === 'snapshot' || !hashId) && S.runs[0]);
  // first load lands on the overview (the whole story at a glance) unless the link names a page
  if (want) await selectRun(want.id, view || 'overview'); else showPage(view || 'overview', { replace: true });
  setInterval(tick, 1000);
})();

// 3D hero, with the SVG diagram as the fallback (no WebGL, reduced motion, ?scene=off, or any scene error).
async function startScene() {
  // The reason is kept on the element (not logged) so a silent fallback is still diagnosable.
  const fallback = (why) => { try { scene?.dispose?.(); } catch { /* already gone */ } scene = null; $('#hero').dataset.fallback = String(why?.message || why || 'error').slice(0, 200);
    $('#scene').hidden = true; $('#hero-fallback').hidden = false; $('#hero').classList.add('flat'); render(true); };
  if (qs.get('scene') === 'off' || reduced()) return fallback(qs.get('scene') === 'off' ? 'scene=off' : 'reduced motion');
  try {
    const mod = await import('./scene3d.js');
    if (!mod.webglAvailable()) return fallback('no WebGL');
    scene = mod.createScene($('#scene'), { onTowerClick: () => go('evidence'), onError: fallback });
    $('#hero-fallback').hidden = true;
  } catch (e) { fallback(e); }
}
