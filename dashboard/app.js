/* ============================================================================
 * Seguros Venezuela · Pipeline de Ventas — lógica del dashboard
 * ==========================================================================*/
const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.SV_CONFIG;
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const $ = (id) => document.getElementById(id);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const nfInt = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 0 });
const fmtN = (n) => nfInt.format(Number(n || 0));
const fmtMoney = (n) => (Number(n || 0) ? nfInt.format(Math.round(Number(n))) : '—');
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('es-VE', { day: '2-digit', month: 'short' }) : '—';
const fmtDateTime = (s) => s ? new Date(s).toLocaleString('es-VE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

let STAGES = {};   // status -> {order, group, color}
let STAGE_LIST = []; // ordenadas
let tablePage = 0;
const PAGE_SIZE = 25;
let reloadTimer = null;

/* ----------------------------- Auth ----------------------------- */
async function initAuth() {
  const { data } = await sb.auth.getSession();
  if (data.session) showApp();
  else showLogin();

  sb.auth.onAuthStateChange((_e, session) => {
    if (session) showApp(); else showLogin();
  });
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn'); btn.disabled = true; btn.textContent = 'Entrando…';
  $('loginError').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  btn.disabled = false; btn.textContent = 'Entrar';
  if (error) $('loginError').textContent = 'Credenciales inválidas. Verifica correo y contraseña.';
});

$('logoutBtn').addEventListener('click', async () => { await sb.auth.signOut(); });
$('refreshBtn').addEventListener('click', () => loadAll());

function showLogin() { $('login').style.display = 'grid'; $('app').style.display = 'none'; }
async function showApp() {
  $('login').style.display = 'none'; $('app').style.display = 'block';
  await loadStages();
  await fillChannels();
  await loadAll();
  subscribeRealtime();
}

/* ----------------------------- Data load ----------------------------- */
async function loadStages() {
  const { data } = await sb.from('pipeline_stages').select('*').order('stage_order');
  STAGE_LIST = data || [];
  STAGES = {};
  for (const s of STAGE_LIST) STAGES[s.status] = s;
}

async function loadAll() {
  $('lastSync').textContent = 'Actualizando…';
  await Promise.all([
    loadKpisAndFunnel(),
    loadKanbanAndPlans(),
    loadChannels(),
    loadTrend(),
    loadAgents(),
    loadTable(),
    loadSyncMeta(),
  ]);
}

async function loadSyncMeta() {
  const { data } = await sb.from('sync_state').select('*').eq('id', 1).maybeSingle();
  if (data) {
    const t = data.last_incremental_sync || data.last_full_sync;
    $('lastSync').textContent = `${fmtN(data.total_tickets)} tickets · última sync ${fmtDateTime(t)}`;
  } else {
    $('lastSync').textContent = 'Conectado';
  }
}

/* ----------------------------- KPIs + Funnel ----------------------------- */
async function loadKpisAndFunnel() {
  const [{ data: k }, { data: f }] = await Promise.all([
    sb.from('v_kpis').select('*').maybeSingle(),
    sb.from('v_funnel').select('*').order('stage_order'),
  ]);
  renderKPIs(k || {}, f || []);
  renderFunnel(f || []);
  renderDistribution(f || []);
  // llenar filtro de etapas
  const sel = $('fStatus');
  if (sel.options.length <= 1) {
    (f || []).forEach((r) => sel.appendChild(el(`<option value="${esc(r.status)}">${esc(r.status)}</option>`)));
  }
}

function renderKPIs(k, funnel) {
  const abierto = funnel.filter((r) => r.stage_group === 'abierto');
  const abiertoCnt = abierto.reduce((a, r) => a + Number(r.tickets), 0);
  const primaPipe = abierto.reduce((a, r) => a + Number(r.total_prima || 0), 0);
  const ganados = Number(k.ganados || 0), perdidos = Number(k.perdidos || 0);
  const conv = (ganados + perdidos) ? (ganados / (ganados + perdidos) * 100) : 0;

  const cards = [
    { label: 'Total tickets', value: fmtN(k.total_tickets), sub: `${fmtN(k.nuevos_30d)} en 30 días`, cls: 'accent-blue' },
    { label: 'Pipeline activo', value: fmtN(abiertoCnt), sub: `prima ${fmtMoney(primaPipe)}`, cls: 'accent-teal' },
    { label: 'Ganados (cerrados)', value: fmtN(ganados), sub: `${conv.toFixed(1)}% de conversión`, cls: 'accent-green' },
    { label: 'Perdidos (anulados)', value: fmtN(perdidos), sub: 'anulada / rechazada', cls: 'accent-red' },
    { label: 'Nuevos (7 días)', value: fmtN(k.nuevos_7d), sub: 'últimos 7 días', cls: 'accent-amber' },
  ];
  $('kpis').innerHTML = '';
  cards.forEach((c) => $('kpis').appendChild(el(
    `<div class="kpi ${c.cls}"><div class="label">${c.label}</div><div class="value">${c.value}</div><div class="sub">${c.sub}</div></div>`
  )));
}

function renderFunnel(f) {
  const rows = [...f].sort((a, b) => a.stage_order - b.stage_order);
  const max = Math.max(1, ...rows.map((r) => Number(r.tickets)));
  const totalAbierto = rows.filter((r) => r.stage_group === 'abierto').reduce((a, r) => a + Number(r.tickets), 0) || 1;
  const cont = $('funnel'); cont.innerHTML = '';
  rows.forEach((r) => {
    const cnt = Number(r.tickets);
    const w = Math.max(2, (cnt / max) * 100);
    // Para etapas abiertas, mostramos su peso dentro del pipeline activo.
    const share = r.stage_group === 'abierto' ? ` · ${(cnt / totalAbierto * 100).toFixed(0)}% del pipeline` : '';
    cont.appendChild(el(
      `<div class="funnel-row">
        <div class="funnel-head">
          <span class="name">${esc(r.status)}</span>
          <span><span class="cnt">${fmtN(cnt)}</span><span class="prima">${fmtMoney(r.total_prima)}</span></span>
        </div>
        <div class="funnel-bar"><span style="width:${w}%;background:${r.color}"></span></div>
        <div class="conv">${r.stage_group}${share}</div>
      </div>`
    ));
  });
}

function renderDistribution(f) {
  const g = { ganado: 0, abierto: 0, perdido: 0 };
  f.forEach((r) => { g[r.stage_group] = (g[r.stage_group] || 0) + Number(r.tickets); });
  const total = g.ganado + g.abierto + g.perdido || 1;
  const segs = [
    { k: 'Ganado', v: g.ganado, c: 'var(--green)' },
    { k: 'Pipeline activo', v: g.abierto, c: 'var(--teal)' },
    { k: 'Perdido', v: g.perdido, c: 'var(--red)' },
  ];
  const cont = $('distribution'); cont.innerHTML = '';
  const bar = el('<div style="display:flex;height:34px;border-radius:8px;overflow:hidden;margin-bottom:16px"></div>');
  segs.forEach((s) => bar.appendChild(el(`<div title="${s.k}" style="width:${(s.v / total * 100)}%;background:${s.c}"></div>`)));
  cont.appendChild(bar);
  segs.forEach((s) => cont.appendChild(el(
    `<div class="bar-row"><span class="bname"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${s.c};margin-right:7px"></span>${s.k}</span>
      <div class="bar-track"><span style="width:${(s.v / total * 100)}%;background:${s.c}"></span></div>
      <span class="bval">${(s.v / total * 100).toFixed(1)}%</span></div>`
  )));
}

/* ----------------------------- Kanban + Plans ----------------------------- */
async function loadKanbanAndPlans() {
  const abiertoStatuses = STAGE_LIST.filter((s) => s.stage_group === 'abierto').map((s) => s.status);
  if (!abiertoStatuses.length) return;
  const { data } = await sb.from('tickets')
    .select('id,ticket_number,subject,status,channel,assignee_name,contact_name,monto_prima,plan_hcm,created_time,web_url')
    .in('status', abiertoStatuses)
    .order('created_time', { ascending: false })
    .limit(1500);
  renderKanban(data || [], abiertoStatuses);
  renderPlans(data || []);
}

function renderKanban(tickets, statuses) {
  const byStatus = {};
  statuses.forEach((s) => (byStatus[s] = []));
  tickets.forEach((t) => { (byStatus[t.status] = byStatus[t.status] || []).push(t); });

  const cont = $('kanban'); cont.innerHTML = '';
  STAGE_LIST.filter((s) => s.stage_group === 'abierto').forEach((s) => {
    const items = byStatus[s.status] || [];
    const col = el(`<div class="kcol">
      <div class="khead"><span class="t"><span class="dot" style="background:${s.color}"></span>${esc(s.status)}</span><span class="n">${items.length}</span></div>
      <div class="kbody"></div></div>`);
    const body = col.querySelector('.kbody');
    items.slice(0, 40).forEach((t) => body.appendChild(el(
      `<div class="tk">
        <div class="subj">${esc(t.subject || '(sin asunto)')}</div>
        <div class="row"><span>#${esc(t.ticket_number || '')}</span><span class="monto">${fmtMoney(t.monto_prima)}</span></div>
        <div class="row"><span class="who">${esc(t.contact_name || t.assignee_name || '—')}</span><span class="ch">${esc(t.channel || '')}</span></div>
      </div>`
    )));
    if (items.length > 40) body.appendChild(el(`<div class="kmore">+${items.length - 40} más</div>`));
    cont.appendChild(col);
  });
}

function renderPlans(tickets) {
  const counts = {};
  tickets.forEach((t) => { const p = t.plan_hcm || 'Sin plan'; counts[p] = (counts[p] || 0) + 1; });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const cont = $('plans'); cont.innerHTML = '';
  if (!rows.length) { cont.innerHTML = '<div class="loading">Sin datos</div>'; return; }
  rows.forEach(([name, n]) => cont.appendChild(el(
    `<div class="bar-row"><span class="bname">${esc(name)}</span><div class="bar-track"><span style="width:${n / max * 100}%"></span></div><span class="bval">${fmtN(n)}</span></div>`
  )));
}

/* ----------------------------- Channels ----------------------------- */
async function loadChannels() {
  const { data } = await sb.from('v_channel').select('*');
  const rows = (data || []).filter((r) => r.channel);
  const max = Math.max(1, ...rows.map((r) => Number(r.tickets)));
  const cont = $('channels'); cont.innerHTML = '';
  if (!rows.length) { cont.innerHTML = '<div class="loading">Sin datos</div>'; return; }
  rows.forEach((r) => cont.appendChild(el(
    `<div class="bar-row"><span class="bname">${esc(r.channel)}</span><div class="bar-track"><span style="width:${Number(r.tickets) / max * 100}%"></span></div><span class="bval">${fmtN(r.tickets)}</span></div>`
  )));
}

/* ----------------------------- Agents ----------------------------- */
async function loadAgents() {
  const { data } = await sb.from('v_agent').select('*').limit(12);
  const rows = data || [];
  const max = Math.max(1, ...rows.map((r) => Number(r.tickets)));
  const cont = $('agents'); cont.innerHTML = '';
  if (!rows.length) { cont.innerHTML = '<div class="loading">Sin datos</div>'; return; }
  rows.forEach((r) => cont.appendChild(el(
    `<div class="bar-row"><span class="bname" title="${esc(r.agente)}">${esc(r.agente)}</span><div class="bar-track"><span style="width:${Number(r.tickets) / max * 100}%"></span></div><span class="bval">${fmtN(r.tickets)}</span></div>`
  )));
}

/* ----------------------------- Trend (SVG) ----------------------------- */
async function loadTrend() {
  const { data } = await sb.from('v_daily_trend').select('*').order('dia');
  renderTrend(data || []);
}
function renderTrend(rows) {
  const cont = $('trend');
  if (!rows.length) { cont.innerHTML = '<div class="loading">Sin datos</div>'; return; }
  const W = 600, H = 200, pad = 24;
  const xs = rows.map((r) => new Date(r.dia).getTime());
  const ys = rows.map((r) => Number(r.tickets));
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const maxY = Math.max(1, ...ys);
  const px = (x) => pad + (x - minX) / (maxX - minX || 1) * (W - pad * 2);
  const py = (y) => H - pad - (y / maxY) * (H - pad * 2);
  const line = rows.map((r, i) => `${i ? 'L' : 'M'}${px(xs[i]).toFixed(1)},${py(ys[i]).toFixed(1)}`).join(' ');
  const area = `${line} L${px(maxX).toFixed(1)},${(H - pad).toFixed(1)} L${px(minX).toFixed(1)},${(H - pad).toFixed(1)} Z`;
  const last = rows[rows.length - 1];
  cont.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#12b0a8" stop-opacity="0.35"/><stop offset="100%" stop-color="#12b0a8" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#g)"/>
    <path d="${line}" fill="none" stroke="#12b0a8" stroke-width="2.5"/>
    <text x="${pad}" y="14" fill="var(--muted)" font-size="11">máx ${maxY}/día</text>
    <text x="${W - pad}" y="14" fill="var(--muted)" font-size="11" text-anchor="end">${fmtDate(last.dia)}: ${last.tickets}</text>
  </svg>`;
}

/* ----------------------------- Tickets table ----------------------------- */
['fSearch', 'fStatus', 'fChannel'].forEach((id) => {
  $(id).addEventListener('input', () => { tablePage = 0; debounceTable(); });
});
let tableTimer = null;
function debounceTable() { clearTimeout(tableTimer); tableTimer = setTimeout(loadTable, 300); }
$('prevPage').addEventListener('click', () => { if (tablePage > 0) { tablePage--; loadTable(); } });
$('nextPage').addEventListener('click', () => { tablePage++; loadTable(); });

async function loadTable() {
  const search = $('fSearch').value.trim();
  const status = $('fStatus').value;
  const channel = $('fChannel').value;

  let q = sb.from('tickets').select(
    'id,ticket_number,subject,status,channel,assignee_name,contact_name,email,monto_prima,created_time,web_url',
    { count: 'exact' });
  if (status) q = q.eq('status', status);
  if (channel) q = q.eq('channel', channel);
  if (search) {
    const s = search.replace(/[,()]/g, ' ');
    q = q.or(`subject.ilike.%${s}%,contact_name.ilike.%${s}%,email.ilike.%${s}%,ticket_number.ilike.%${s}%`);
  }
  const fromI = tablePage * PAGE_SIZE;
  q = q.order('created_time', { ascending: false }).range(fromI, fromI + PAGE_SIZE - 1);

  const { data, count, error } = await q;
  const body = $('ticketsBody');
  if (error) { body.innerHTML = `<tr><td colspan="8" class="loading">Error: ${esc(error.message)}</td></tr>`; return; }
  if (!data.length) { body.innerHTML = '<tr><td colspan="8" class="loading">Sin resultados</td></tr>'; }
  else {
    body.innerHTML = '';
    // llenar filtro de canales una vez
    const cSel = $('fChannel');
    data.forEach((t) => {
      const st = STAGES[t.status];
      const color = st ? st.color : '#94a3b8';
      body.appendChild(el(
        `<tr>
          <td class="tnum">#${esc(t.ticket_number || '')}</td>
          <td>${esc((t.subject || '').slice(0, 70))}</td>
          <td>${esc(t.contact_name || '—')}<div style="color:var(--muted);font-size:11px">${esc(t.email || '')}</div></td>
          <td><span class="pill" style="background:${color}22;color:${color}">${esc(t.status || '')}</span></td>
          <td>${esc(t.channel || '—')}</td>
          <td>${esc(t.assignee_name || '—')}</td>
          <td style="font-weight:700">${fmtMoney(t.monto_prima)}</td>
          <td>${fmtDate(t.created_time)}</td>
        </tr>`
      ));
    });
  }
  const total = count || 0;
  const shown = Math.min(fromI + PAGE_SIZE, total);
  $('pageInfo').textContent = total ? `${fromI + 1}–${shown} de ${fmtN(total)}` : '0 resultados';
  $('prevPage').disabled = tablePage === 0;
  $('nextPage').disabled = shown >= total;
}

/* ----------------------------- Realtime ----------------------------- */
let channel = null;
function subscribeRealtime() {
  if (channel) return;
  channel = sb.channel('tickets-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, (payload) => {
      if (payload.eventType === 'INSERT') {
        const t = payload.new;
        toast(`Nuevo ticket <b>#${esc(t.ticket_number || '')}</b> · ${esc(t.status || '')}`);
      }
      scheduleReload();
    })
    .subscribe();
}
function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 1500); }

function toast(html) {
  const t = el(`<div class="toast">${html}</div>`);
  $('toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 400); }, 6000);
}

/* ----------------------------- Filtro de canales ----------------------------- */
async function fillChannels() {
  const { data } = await sb.from('v_channel').select('channel');
  const sel = $('fChannel');
  if (sel && sel.options.length <= 1 && data) {
    data.filter((r) => r.channel).forEach((r) => sel.appendChild(el(`<option value="${esc(r.channel)}">${esc(r.channel)}</option>`)));
  }
}

/* ----------------------------- Go ----------------------------- */
initAuth();
