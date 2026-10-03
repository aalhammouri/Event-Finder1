// GCP Package Desk: Dynamics web resource. Reads and writes leads through the Dataverse Web API
// of the org it is served from. Every write is user-initiated and confirmed on the page.
const API = (() => {
  try { if (window.parent && parent.Xrm && parent.Xrm.Utility) return parent.Xrm.Utility.getGlobalContext().getClientUrl() + '/api/data/v9.2/'; } catch (e) {}
  return location.origin + '/api/data/v9.2/';
})();
const ORG = API.replace('/api/data/v9.2/', '');
const HDRS = { 'Accept': 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Prefer': 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' };
async function api(path, opt = {}) {
  const r = await fetch(API + path, Object.assign({ credentials: 'same-origin', headers: HDRS }, opt));
  if (!r.ok) { let m = r.status + ' ' + r.statusText; try { const j = await r.json(); m = j.error?.message || m; } catch (e) {} throw new Error(m); }
  if (r.status === 204) return { id: (r.headers.get('OData-EntityId') || '').match(/\(([0-9a-f-]{36})\)/i)?.[1] };
  return r.json();
}
const FV = (o, k) => o[k + '@OData.Community.Display.V1.FormattedValue'];

__MATCHKEY__

const STAGES = [
  {v:714000010, a:'New Event', b:'Pending Review'},
  {v:714000011, a:'Pending', b:'Ready to Merge'},
  {v:714000012, a:'Pending', b:'Merged'},
  {v:714000013, a:'Printed', b:''},
  {v:714000014, a:'Assembled', b:'and Sealed'},
  {v:714000015, a:'Open', b:'Mailed'},
];
const OUTCOMES = {714000020:'Pending – Ready to Merge',714000021:'Do Not Donate',714000022:'Not Appropriate for Event',714000023:'Missed Event',714000024:'Duplicate'};
const OUTCOME_HELP = {714000021:'The firm will not donate to this charity',714000022:'The event is not a fit for a certificate',714000023:'Too late to mail before the event',714000024:'Another lead already covers this event'};
const AU_NAMES = ['Online auction','Live auction','Silent auction','Raffle'];
const AU_WORD = {Y:'Yes',N:'No',U:'Unclear'};
const AU_CODE = {714000000:'Y',714000001:'N',714000002:'U'};
const ADDR_SRC_TO_ACCOUNT = {714000000:714000142, 714000001:714000143, 714000002:714000141, 714000003:714000140};
const VENUE_ICON = {Gala:'i-gala','Golf Tournament':'i-golf',Luncheon:'i-lunch',Dinner:'i-dinner',Festival:'i-fest'};
const GENERIC_MAIL = /^(info|office|support|contact|admin|hello|events?|development|foundation|giving|donate|leaf|cy-hope)$/i;
const LEAD_SELECT = ['leadid','subject','companyname','firstname','lastname','jobtitle','emailaddress1','emailaddress2','telephone1','telephone2','websiteurl',
  'lead_event_web_page','lead_event_date','lead_mail_by_date','lead_donation_needed_by','lead_venue','lead_online_auction','lead_live_auction','lead_silent_auction',
  'lead_raffle','lead_auction_evidence','lead_event_score','lead_ein','lead_mailing_address_verified','address1_line1','address1_city','address1_stateorprovince',
  'address1_postalcode','lead_address_source','lead_gcp_stage','lead_review_outcome','lead_assembled_on','lead_package_mailed_on','_parentaccountid_value',
  '_ownerid_value','_modifiedby_value','createdon','modifiedon','statecode'].join(',');

// ---------- dates ----------
const DAY = 86400000;
const today = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); })();
const localYmd = iso => { if (!iso) return null; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const parseD = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const days = s => s ? Math.round((parseD(s) - today) / DAY) : null;
const fmt = (s, opt) => s ? parseD(s).toLocaleDateString('en-US', opt || {month:'short', day:'numeric', year:'numeric'}) : '—';
const fmtShort = s => fmt(s, {month:'short', day:'numeric'});
const fmtStamp = iso => new Date(iso).toLocaleString('en-US', {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'});

// ---------- state ----------
let LEADS = [], ACCOUNTS = [], NOTES = {}, CERTS = {}, ME = '';
const UI_KEY = 'gcp-desk-ui-v1';
let S = { sel: null, filter: 'all', q: '', tab: 'summary', done: {} };
try { Object.assign(S, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch (e) {}
const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(S)); } catch (e) {} };
let pending = null, busy = false;

function toLead(r) {
  const L = {
    id: r.leadid, ev: (r.subject || '').replace(/^\[GCP\]\s*/, ''), org: r.companyname || '(no organization)', fn: r.firstname, ln: r.lastname,
    title: r.jobtitle, em1: r.emailaddress1, em2: r.emailaddress2, ph1: r.telephone1, ph2: r.telephone2, web: r.websiteurl, evweb: r.lead_event_web_page,
    evd: localYmd(r.lead_event_date), mby: localYmd(r.lead_mail_by_date), donation: localYmd(r.lead_donation_needed_by),
    venue: FV(r, 'lead_venue') || 'Event',
    au: [r.lead_online_auction, r.lead_live_auction, r.lead_silent_auction, r.lead_raffle].map(v => AU_CODE[v] || 'U'),
    evid: FV(r, 'lead_auction_evidence') || 'Unverified', score: r.lead_event_score, ein: r.lead_ein, verified: r.lead_mailing_address_verified === true,
    line: r.address1_line1, city: r.address1_city, state: r.address1_stateorprovince || 'TX', zip: r.address1_postalcode,
    srcCode: r.lead_address_source, src: FV(r, 'lead_address_source'), stage: r.lead_gcp_stage || 714000010, outcome: r.lead_review_outcome,
    assembledOn: r.lead_assembled_on, mailedOn: r.lead_package_mailed_on, accountId: r._parentaccountid_value, accountName: FV(r, '_parentaccountid_value'),
    owner: FV(r, '_ownerid_value'), modifiedBy: FV(r, '_modifiedby_value'), createdon: r.createdon, modifiedon: r.modifiedon, stateCode: r.statecode,
  };
  L.key = addressMatchKey(L.line, L.city, L.zip);
  L.einN = normalizeEin(L.ein);
  L.nameN = nameKey(L.org);
  L.person = [L.fn, L.ln].filter(Boolean).join(' ');
  return L;
}
function nameKey(n) { return String(n || '').toUpperCase().replace(/\(.*?\)/g,'').replace(/[^A-Z0-9 ]/g,'').replace(/\b(INC|INCORPORATED|THE)\b/g,'').replace(/\s+/g,' ').trim(); }

async function loadAll() {
  const [leads, accts, who] = await Promise.all([
    api(`leads?$select=${LEAD_SELECT}&$filter=lead_event_id ne null and statecode eq 0&$orderby=lead_mail_by_date asc`),
    api(`accounts?$select=accountid,name,account_ein,account_address_match_key,address1_line1,address1_city,address1_postalcode&$filter=account_relationship_type eq 714000070`),
    api('WhoAmI').then(w => api(`systemusers(${w.UserId})?$select=fullname`)).catch(() => null),
  ]);
  LEADS = leads.value.map(toLead);
  ACCOUNTS = accts.value.map(a => ({ id: a.accountid, name: a.name, ein: normalizeEin(a.account_ein),
    key: a.account_address_match_key || addressMatchKey(a.address1_line1, a.address1_city, a.address1_postalcode), line: a.address1_line1, city: a.address1_city }));
  if (who) ME = who.fullname;
  const params = new URLSearchParams(location.search);
  const fromForm = (params.get('id') || '').replace(/[{}]/g, '').toLowerCase();
  if (fromForm && LEADS.some(l => l.id === fromForm)) S.sel = fromForm;
  if (!LEADS.some(l => l.id === S.sel)) S.sel = LEADS[0]?.id || null;
}
async function loadDetail(id) {
  const [notes, certs] = await Promise.all([
    api(`annotations?$select=subject,notetext,createdon,_createdby_value&$filter=_objectid_value eq ${id}&$orderby=createdon desc`).catch(() => ({ value: [] })),
    api(`cr93c_giftcertificates?$select=cr93c_name,cr93c_certificate_slot,cr93c_certificate_status&$filter=_cr93c_event_lead_value eq ${id}`).catch(() => ({ value: [] })),
  ]);
  NOTES[id] = notes.value; CERTS[id] = certs.value;
}
async function reloadLead(id) {
  const r = await api(`leads(${id})?$select=${LEAD_SELECT}`);
  const L = toLead(r); const i = LEADS.findIndex(x => x.id === id);
  if (i >= 0) LEADS[i] = L;
  await loadDetail(id);
  return L;
}

// ---------- matching ----------
function matchesFor(L) {
  const out = [];
  for (const A of ACCOUNTS) {
    if (L.einN && A.ein && L.einN === A.ein) out.push({kind:'account', strength:'strong', reason:'Same EIN', A});
    else if (L.key && A.key === L.key) out.push({kind:'account', strength:'strong', reason:'Same address key', A});
    else if (L.nameN && nameKey(A.name) === L.nameN) out.push({kind:'account', strength:'soft', reason:'Same name, different address', A});
  }
  for (const O of LEADS) {
    if (O.id === L.id) continue;
    let reason = null, strength = null;
    if (L.einN && O.einN && L.einN === O.einN) { reason = 'Same EIN'; strength = 'strong'; }
    else if (L.key && O.key === L.key) { reason = 'Same address key'; strength = 'strong'; }
    else if (L.nameN && O.nameN === L.nameN) { reason = 'Same name, different address'; strength = 'soft'; }
    if (reason) out.push({kind:'lead', strength, reason, O});
  }
  return out;
}

// ---------- action items ----------
const isClosed = L => L.outcome && L.outcome !== 714000020;
function flags(L) {
  const out = [];
  if (isClosed(L)) return out;
  const dm = days(L.mby), de = days(L.evd);
  if (L.stage < 714000015 && de !== null) {
    if (de < 0) out.push({id:'past', sev:'crit', t:'Event date has passed', d:`The event was ${fmt(L.evd)}. Record the outcome as Missed Event.`, act:'missed'});
    else if (dm !== null && dm < 0) out.push({id:'late', sev:'crit', t:`Mail-by date passed ${-dm} day${dm===-1?'':'s'} ago`, d:`Event is in ${de} days (${fmt(L.evd)}). Mail now if the charity can still use it, or record Missed Event.`, act:'missed'});
    else if (dm !== null && dm <= 7) out.push({id:'soon', sev:'warn', t:`Mail by ${fmt(L.mby)} (${dm === 0 ? 'today' : dm + ' days'})`, d:'This package needs to move this week.'});
  }
  if (L.stage === 714000010) out.push({id:'review', sev:'info', t:'Review the event and choose an outcome', d:'Approve to send it to Matt for merge, or record why not.', act:'review'});
  if (L.stage === 714000011) out.push({id:'merge', sev:'warn', t:'Merge with a charity account', d:'Link to an existing charity or create one. Matches are on the Merge gate tab.', act:'merge'});
  const dup = matchesFor(L).filter(m => m.kind === 'lead' && m.strength === 'strong');
  if (dup.length) out.push({id:'dup', sev:'warn', t:`Same charity as ${dup.length} other lead${dup.length>1?'s':''}`, d: dup.map(m => m.O.ev).join('; ') + '. Merge both to one account and decide whether one package covers both events.', act:'merge'});
  if (L.evid === 'Assumed' && [0,1,3].some(i => L.au[i] === 'Y')) out.push({id:'evid', sev:'crit', t:'Auction values break scan rule 5A', d:`${[0,1,3].filter(i => L.au[i]==='Y').map(i => AU_NAMES[i]).join(' and ')} set to Yes on Assumed evidence. Only Silent auction may be assumed. Check the event page before mailing.`, link:L.evweb});
  if (L.au.includes('U')) out.push({id:'unclear', sev:'info', t:`${L.au.map((v,i)=>v==='U'?AU_NAMES[i]:null).filter(Boolean).join(', ')} is Unclear`, d:'The weekly scan revisits this within 120 days of the event.'});
  if (/\bP\.?\s*O\.?\s*BOX\b/i.test(L.line || '')) out.push({id:'pobox', sev:'warn', t:'Mailing address is a PO Box', d:'UPS and FedEx cannot deliver to PO Boxes. Ship by USPS or find a street address.'});
  if (!L.line) out.push({id:'noaddr', sev:'crit', t:'No mailing address', d:'The package cannot be mailed until an address is found.'});
  if (!L.einN) out.push({id:'ein', sev:'info', t:'No EIN on file', d:'Find it in the IRS Texas extract or Candid. EIN is the strongest merge key.'});
  if (!L.verified) out.push({id:'verify', sev:'info', t:'Mailing address not verified', d:`Source: ${L.src || 'not recorded'}. Confirm, then tick Mailing Address Verified on the lead.`});
  if (!L.donation) out.push({id:'deadline', sev:'info', t:'Charity donation deadline not recorded', d:'Mail-by is the 21-day assumption. Use the charity’s own "donation needed by" date when it publishes one.'});
  else if (L.mby && L.donation < L.mby) out.push({id:'deadline2', sev:'warn', t:`Charity wants donations by ${fmt(L.donation)}`, d:`That is earlier than the mail-by date of ${fmt(L.mby)}.`});
  if (!L.fn) out.push({id:'contact', sev:'warn', t:'Contact is a team, not a person', d:`${L.ln || 'No contact'}. Find a named person at ${L.org} for the package and follow-up.`});
  else {
    const local = (L.em1 || '').split('@')[0].toLowerCase().replace(/[^a-z]/g,'');
    if (local && !GENERIC_MAIL.test(local) && !local.includes(L.fn.toLowerCase().slice(0,3)) && !(L.ln && local.includes(L.ln.toLowerCase().slice(0,4))))
      out.push({id:'email', sev:'warn', t:'Contact e-mail may belong to someone else', d:`${L.person} is listed with ${L.em1}.`});
  }
  if (!L.title) out.push({id:'title', sev:'info', t:'Contact title missing', d:'Needed for the cover letter salutation.'});
  if (!L.ph1 && !L.ph2) out.push({id:'phone', sev:'info', t:'No phone number on file', d:'Delivery confirmation calls need one.'});
  return out;
}
const isDone = (L, f) => !!(S.done[L.id] && S.done[L.id][f.id]);
const openFlags = L => flags(L).filter(f => !isDone(L, f));
const urgency = L => { const f = openFlags(L); return f.some(x => x.sev==='crit') ? 'crit' : f.some(x => x.sev==='warn' && ['soon','dup','merge'].includes(x.id)) ? 'warn' : ''; };

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ico = (id, cls='') => `<svg class="ico ${cls}"><use href="#${id}"/></svg>`;
const host = u => { try { return new URL(u).host.replace(/^www\./,''); } catch (e) { return u || ''; } };
const stageIdx = v => Math.max(0, STAGES.findIndex(x => x.v === v));
const recUrl = (etn, id) => `${ORG}/main.aspx?pagetype=entityrecord&etn=${etn}&id=${id}`;
function openRecord(etn, id) {
  try { if (parent.Xrm && parent.Xrm.Navigation) return parent.Xrm.Navigation.openForm({ entityName: etn, entityId: id }); } catch (e) {}
  window.open(recUrl(etn, id), '_blank');
}
function mailChip(L) {
  if (isClosed(L)) return `<span class="chip">${esc(OUTCOMES[L.outcome])}</span>`;
  if (L.stage === 714000015) return `<span class="chip ok">${ico('i-check')}Mailed</span>`;
  const d = days(L.mby);
  if (d === null) return `<span class="chip">No mail-by date</span>`;
  if (d < 0) return `<span class="chip crit">Overdue ${-d}d</span>`;
  if (d <= 7) return `<span class="chip warn">Mail in ${d}d</span>`;
  if (d <= 14) return `<span class="chip info">Mail in ${d}d</span>`;
  return `<span class="chip">Mail ${fmtShort(L.mby)}</span>`;
}
const labelText = L => [L.org, L.person && L.fn ? `Attn: ${L.person}` : null, L.line, `${L.city || ''}, ${L.state} ${L.zip || ''}`].filter(Boolean).join('\n');
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
  catch (e) { toast(`Copy blocked here. ${what}: ${text.replace(/\n/g, ', ')}`); }
}
let toastTimer;
function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(msg)}</span>`; t.classList.toggle('err', !!isErr); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, isErr ? 9000 : 4000);
}

// ---------- writes (each one confirmed first, then re-read from Dynamics) ----------
const WRITES = {
  approve: L => ({ label: `Approve and move to Pending – Ready to Merge?`, run: () => api(`leads(${L.id})`, { method:'PATCH', body: JSON.stringify({ lead_gcp_stage: 714000011, lead_review_outcome: 714000020 }) }), done: 'Approved and sent to merge' }),
  reject: (L, o) => ({ label: `Close this lead as "${OUTCOMES[o]}"?`, run: () => api(`leads(${L.id})`, { method:'PATCH', body: JSON.stringify({ lead_review_outcome: Number(o) }) }), done: `Recorded: ${OUTCOMES[o]}` }),
  reopen: L => ({ label: 'Clear the review outcome and reopen this lead for review?', run: () => api(`leads(${L.id})`, { method:'PATCH', body: JSON.stringify({ lead_review_outcome: null }) }), done: 'Reopened' }),
  printed: L => ({ label: 'Mark the certificates as printed?', run: () => api(`leads(${L.id})`, { method:'PATCH', body: JSON.stringify({ lead_gcp_stage: 714000013 }) }), done: 'Marked printed' }),
  assembled: L => ({ label: 'Mark the package as assembled and sealed? Today is recorded as Assembled On.', run: () => api(`leads(${L.id})`, { method:'PATCH', body: JSON.stringify({ lead_gcp_stage: 714000014, lead_assembled_on: new Date().toISOString() }) }), done: 'Assembled and sealed' }),
  mailed: L => ({ label: 'Mark the package as mailed? Today is recorded as Package Mailed On.', run: () => api(`leads(${L.id})`, { method:'PATCH', body: JSON.stringify({ lead_gcp_stage: 714000015, lead_package_mailed_on: new Date().toISOString() }) }), done: 'Marked mailed' }),
  verified: L => ({ label: 'Confirm the mailing address is correct?', run: () => api(`leads(${L.id})`, { method:'PATCH', body: JSON.stringify({ lead_mailing_address_verified: true }) }), done: 'Address marked verified' }),
  mergeInto: (L, accId) => { const A = ACCOUNTS.find(a => a.id === accId); return { label: `Link this lead to the existing account "${A.name}" and move it to Pending – Merged?`,
    run: () => api(`leads(${L.id})`, { method:'PATCH', body: JSON.stringify({ 'parentaccountid@odata.bind': `/accounts(${A.id})`, lead_gcp_stage: 714000012 }) }), done: `Linked to ${A.name}` }; },
  mergeNew: L => ({ label: `Create a new charity account "${L.org}" from this lead and move it to Pending – Merged?`,
    run: async () => {
      const body = { name: L.org, account_relationship_type: 714000070, account_ein: L.ein || null, account_address_match_key: L.key || null,
        address1_line1: L.line, address1_city: L.city, address1_stateorprovince: L.state, address1_postalcode: L.zip,
        telephone1: L.ph2 || L.ph1 || null, emailaddress1: L.em2 || null, websiteurl: L.web || null,
        account_mailing_address_verified: L.verified };
      if (ADDR_SRC_TO_ACCOUNT[L.srcCode]) body.account_address_source = ADDR_SRC_TO_ACCOUNT[L.srcCode];
      const res = await api('accounts', { method:'POST', body: JSON.stringify(body) });
      if (!res.id) throw new Error('Account was not created');
      const check = await api(`accounts(${res.id})?$select=accountid,name`);
      await api(`leads(${L.id})`, { method:'PATCH', body: JSON.stringify({ 'parentaccountid@odata.bind': `/accounts(${check.accountid})`, lead_gcp_stage: 714000012 }) });
      ACCOUNTS.push({ id: check.accountid, name: check.name, ein: L.einN, key: L.key, line: L.line, city: L.city });
    }, done: `Charity account created for ${L.org}` }),
  note: (L, text) => ({ label: null, run: () => api('annotations', { method:'POST', body: JSON.stringify({ subject: 'GCP review note', notetext: text, 'objectid_lead@odata.bind': `/leads(${L.id})` }) }), done: 'Note added to the lead' }),
};
function ask(name, ...args) {
  const L = LEADS.find(x => x.id === S.sel); const w = WRITES[name](L, ...args);
  if (!w.label) return exec(L, w);
  pending = { L, w }; renderRecord();
  document.getElementById('confirm-yes')?.focus();
}
async function exec(L, w) {
  pending = null; busy = true; renderRecord();
  try { await w.run(); const fresh = await reloadLead(L.id); toast(w.done); if (w.done.startsWith('Approved') && fresh.stage !== 714000011) toast('Saved, but Dynamics shows a different stage. Refresh to check.', true); }
  catch (e) { toast(`Not saved: ${e.message}`, true); }
  busy = false; render();
}

// ---------- render ----------
function renderQueue() {
  const q = S.q.trim().toLowerCase(), f = S.filter;
  let list = LEADS.filter(L => !q || (L.ev + ' ' + L.org + ' ' + (L.city || '')).toLowerCase().includes(q));
  list = list.filter(L => {
    const closed = isClosed(L), mailed = L.stage === 714000015, d = days(L.mby);
    if (f === 'closed') return closed;
    if (closed) return false;
    if (f === 'overdue') return !mailed && d !== null && d < 0;
    if (f === 'soon') return !mailed && d !== null && d >= 0 && d <= 14;
    if (f === 'attention') return urgency(L) === 'crit';
    return true;
  });
  document.getElementById('q-count').textContent = `${list.length} of ${LEADS.length}`;
  document.querySelectorAll('#q-filter button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === f)));
  const ul = document.getElementById('q-list');
  if (!LEADS.length) { ul.innerHTML = `<li class="q-empty">No GCP event leads are open in Dynamics.</li>`; return; }
  if (!list.length) { ul.innerHTML = `<li class="q-empty">No events match this filter.</li>`; return; }
  ul.innerHTML = list.map(L => { const x = STAGES[stageIdx(L.stage)];
    return `<li class="q-item ${isClosed(L) ? 'closed' : urgency(L)}" data-id="${L.id}" tabindex="0" aria-current="${L.id === S.sel}">
      <span class="stripe"></span>
      <div style="min-width:0"><div class="q-title">${esc(L.ev)}</div><div class="q-org">${esc(L.org)} · ${esc(L.city || '')}</div>
        <div class="q-meta">${mailChip(L)}<span class="chip">${esc(x.a)}${x.b ? ' · ' + esc(x.b) : ''}</span></div></div>
      <div class="q-right num">${L.evd ? fmtShort(L.evd) : '—'}<br><span style="color:var(--faint)">event</span></div></li>`; }).join('');
}
function primaryAction(L) {
  if (isClosed(L)) return `<button class="btn primary" data-act="reopen">${ico('i-undo')}Reopen for review</button>`;
  switch (L.stage) {
    case 714000010: return `<button class="btn primary" data-act="approve">${ico('i-check')}Approve for merge</button>`;
    case 714000011: return `<button class="btn primary" data-tab="merge">${ico('i-merge')}Merge charity</button>`;
    case 714000012: return `<button class="btn primary" data-act="printed">${ico('i-print')}Mark printed</button>`;
    case 714000013: return `<button class="btn primary" data-act="assembled">${ico('i-box')}Assembled and sealed</button>`;
    case 714000014: return `<button class="btn accent" data-act="mailed">${ico('i-send')}Mark mailed</button>`;
    default: return `<button class="btn" disabled>${ico('i-check')}Package mailed</button>`;
  }
}
function renderRecord() {
  const rec = document.getElementById('record');
  const L = LEADS.find(x => x.id === S.sel);
  if (!L) { rec.innerHTML = `<section class="card card-b"><p class="hint">Select an event from the package queue.</p></section>`; return; }
  const si = stageIdx(L.stage), dm = days(L.mby), fl = openFlags(L), crit = fl.filter(f => f.sev === 'crit').length;
  const mailedYet = L.stage === 714000015;
  const dmCls = mailedYet || isClosed(L) || dm === null ? '' : dm < 0 ? 'crit' : dm <= 7 ? 'warn' : '';
  const dmVal = mailedYet ? 'Mailed' : dm === null ? '—' : dm < 0 ? `${-dm} late` : dm;
  const dmLbl = mailedYet ? 'Package' : dm !== null && dm < 0 ? `days · mail-by ${fmtShort(L.mby)}` : 'days to mail-by';
  rec.innerHTML = `
  <section class="card rec-head" aria-label="Event lead">
    <div class="rec-top">
      <div class="venue-badge">${ico(VENUE_ICON[L.venue] || 'i-org')}</div>
      <div class="rec-title"><h1>${esc(L.ev)}</h1>
        <div class="rec-sub"><span>Lead · GCP event</span><span>·</span><span>${esc(L.org)}</span>${isClosed(L) ? `<span class="chip">${esc(OUTCOMES[L.outcome])}</span>` : ''}</div></div>
      <div class="kpis">
        <div class="kpi ${dmCls}"><b class="num">${dmVal}</b><span>${dmLbl}</span></div>
        <div class="kpi"><b class="num">${L.score ?? '—'}</b><span>event score / 100</span></div>
        <div class="kpi"><b>${esc(L.evid)}</b><span>auction evidence</span></div>
      </div>
    </div>
    <div class="meta-row">
      <div><label>Organization</label><span>${ico('i-org')}${L.accountId ? `<a href="#" data-open="account:${L.accountId}">${esc(L.accountName || L.org)}</a>` : esc(L.org)}</span></div>
      <div><label>Event date</label><span class="num">${ico('i-cal')}${fmt(L.evd)}</span></div>
      <div><label>City</label><span>${ico('i-pin')}${esc(L.city || '—')}, ${esc(L.state)}</span></div>
      <div><label>Lead source</label><span>${ico('i-sync')}Weekly AI scan</span></div>
      <div><label>Owner</label><span>${ico('i-user')}${esc(L.owner || '—')}</span></div>
    </div>
    <div class="path" role="list" aria-label="GCP stage">
      ${STAGES.map((x, i) => `<div role="listitem" class="step ${i < si ? 'done' : i === si ? 'current' : ''}" ${i === si ? 'aria-current="step"' : ''}><b>${x.a}</b><small>${x.b}</small></div>`).join('')}
    </div>
  </section>

  <section class="card cmdbar" aria-label="Quick actions">
    ${primaryAction(L)}
    <div class="menu-wrap">
      <button class="btn danger" id="reject-btn" aria-haspopup="true" aria-expanded="false" ${isClosed(L) || L.stage >= 714000012 ? 'disabled' : ''}>${ico('i-x')}Close lead…</button>
      <div class="menu" id="reject-menu" hidden>${[714000021,714000022,714000023,714000024].map(o => `<button data-reject="${o}">${OUTCOMES[o]}<small>${OUTCOME_HELP[o]}</small></button>`).join('')}</div>
    </div>
    <span class="sep"></span>
    <button class="btn" data-copy="label">${ico('i-copy')}Copy mailing label</button>
    ${L.evweb ? `<a class="btn" href="${esc(L.evweb)}" target="_blank" rel="noopener">${ico('i-ext')}Event page</a>` : ''}
    <button class="btn" data-open="lead:${L.id}">${ico('i-ext')}Open lead form</button>
    <button class="btn" id="refresh-btn">${ico('i-sync')}Refresh</button>
  </section>
  ${pending ? `<section class="card confirm" role="alertdialog" aria-label="Confirm change"><span>${ico('i-alert')}${esc(pending.w.label)}</span><span class="decision"><button class="btn primary" id="confirm-yes">Confirm</button><button class="btn" id="confirm-no">Cancel</button></span></section>` : ''}
  ${busy ? `<section class="card confirm"><span>${ico('i-sync')}Saving to Dynamics…</span></section>` : ''}

  <nav class="tabs" role="tablist">
    <button role="tab" data-tab="summary" aria-selected="${S.tab==='summary'}">Summary ${crit ? `<span class="count">${crit}</span>` : ''}</button>
    <button role="tab" data-tab="merge" aria-selected="${S.tab==='merge'}">Merge gate</button>
    <button role="tab" data-tab="package" aria-selected="${S.tab==='package'}">Package and follow-up</button>
  </nav>
  <div id="tabpanel">${S.tab === 'merge' ? mergeTab(L) : S.tab === 'package' ? packageTab(L) : summaryTab(L, fl)}</div>`;
}

function summaryTab(L, fl) {
  const all = flags(L), certs = CERTS[L.id] || [], notes = NOTES[L.id] || [];
  const meter = Array.from({length: 10}, (_, i) => `<i class="${i < Math.round((L.score || 0) / 10) ? 'on' : ''}"></i>`).join('');
  return `<div class="grid">
  <div class="col">
    <section class="band">
      <div class="eyebrow">${esc(L.venue)} · ${esc(L.city || '')}</div>
      <h2>${esc(L.ev)}</h2>
      <div class="band-meta"><span>${ico('i-cal')}${L.evd ? fmt(L.evd, {weekday:'short', month:'short', day:'numeric', year:'numeric'}) : 'No date'}</span>${L.evd ? `<span class="num">${ico('i-clock')}${days(L.evd) >= 0 ? `${days(L.evd)} days away` : 'Held'}</span>` : ''}<span>${ico('i-org')}${esc(L.org)}</span></div>
      <div class="auction-row">${L.au.map((v,i) => `<div class="au ${({Y:'yes',N:'no',U:'unclear'})[v]}"><label>${AU_NAMES[i]}</label><b>${AU_WORD[v]}</b></div>`).join('')}</div>
      <div class="band-foot"><span class="evid ${esc(L.evid)}">Evidence: ${esc(L.evid)}</span>${L.evweb ? `<a class="btn sm" href="${esc(L.evweb)}" target="_blank" rel="noopener">${ico('i-ext')}${esc(host(L.evweb))}</a>` : ''}</div>
    </section>
    <section class="card tiles" aria-label="At a glance">
      <div class="tile">${ico('i-cal')}<div><b class="num">${L.mby ? fmtShort(L.mby) : '—'}</b><span>Mail-by date</span><small>${L.donation ? `Charity deadline ${fmtShort(L.donation)}` : 'Event date minus 21 days'}</small></div></div>
      <div class="tile">${ico('i-gift')}<div><b class="num">${certs.length}</b><span>Certificates</span><small>Created at assembly</small></div></div>
      <div class="tile">${ico('i-score')}<div><b class="num">${L.score ?? '—'}</b><span>Event score</span><div class="meter">${meter}</div></div></div>
      <div class="tile">${ico('i-merge')}<div><b>${L.accountId ? 'Linked' : 'Not yet'}</b><span>Charity account</span><small>${L.accountId ? esc(L.accountName || '') : 'Set at the merge gate'}</small></div></div>
    </section>
    <section class="card">
      <div class="card-h">${ico('i-org')}<h3>Organization and contact</h3></div>
      <div class="card-b org-grid">
        <div class="stack">
          <div class="kv">
            <div><label>Charity</label><span><b>${esc(L.org)}</b></span></div>
            <div><label>Website</label><span>${L.web ? `<a href="${esc(L.web)}" target="_blank" rel="noopener">${esc(host(L.web))}</a>` : '—'}</span></div>
            <div><label>EIN</label><span class="mono">${L.ein ? esc(L.ein) : '<span class="hint">Not on file</span>'}</span></div>
            <div><label>Address source</label><span>${esc(L.src || 'Not recorded')}</span></div>
          </div>
          <div><span class="field-label">Mailing label ${L.verified ? '<span class="chip ok">Verified</span>' : ''}</span><div class="label-card">${esc(labelText(L))}</div>
            ${L.verified ? '' : `<div class="decision"><button class="btn sm" data-act="verified">${ico('i-check')}Mark address verified</button></div>`}</div>
        </div>
        <div class="stack">
          <div class="person"><div class="avatar">${esc((L.fn ? L.fn[0] : '') + (L.ln ? L.ln[0] : ''))}</div><div style="min-width:0"><b>${esc(L.person || 'No contact')}</b><div class="hint">${esc(L.title || 'Title not recorded')}</div><div class="hint">Primary charity contact</div></div></div>
          <div>${[[L.em1,'i-mail','E-mail'],[L.em2 !== L.em1 ? L.em2 : null,'i-mail','Org e-mail'],[L.ph1,'i-phone','Phone'],[L.ph2 !== L.ph1 ? L.ph2 : null,'i-phone','Org phone']].filter(x => x[0]).map(([v, i, w]) =>
            `<div class="line-act"><span>${ico(i)}<span><span class="hint">${w}</span><br>${esc(v)}</span></span><button class="icon-btn" data-copytext="${esc(v)}" data-what="${w}" aria-label="Copy ${w}">${ico('i-copy')}</button></div>`).join('') || '<p class="hint">No e-mail or phone on file.</p>'}</div>
        </div>
      </div>
    </section>
  </div>
  <div class="col">
    <section class="card">
      <div class="card-h">${ico('i-alert')}<h3>Action items</h3><span class="chip num">${fl.length} open</span></div>
      <div class="card-b">${all.length ? `<ul class="todo">${all.map(f => {
        const done = isDone(L, f);
        const btn = f.act === 'missed' ? `<button class="btn sm" data-reject="714000023">Missed</button>`
          : f.act === 'review' ? `<button class="btn sm" data-focus="review">Review</button>`
          : f.act === 'merge' ? `<button class="btn sm" data-tab="merge">Open</button>`
          : f.link ? `<a class="btn sm" href="${esc(f.link)}" target="_blank" rel="noopener">Check</a>` : '';
        return `<li class="${f.sev} ${done ? 'done' : ''}"><span class="dot"></span><div style="min-width:0"><div class="t">${esc(f.t)}</div><div class="d">${esc(f.d)}</div></div>
          <div class="acts">${done ? '' : btn}<button class="icon-btn" data-done="${f.id}" aria-label="${done ? 'Mark not done' : 'Mark done'}" title="${done ? 'Mark not done' : 'Mark done (on this computer)'}">${ico(done ? 'i-undo' : 'i-check')}</button></div></li>`; }).join('')}</ul>`
        : `<div class="allclear">${ico('i-check')}Nothing needs attention on this lead.</div>`}</div>
    </section>
    <section class="card" id="review-card">
      <div class="card-h">${ico('i-check')}<h3>Review outcome</h3></div>
      <div class="card-b">
        <label class="field-label" for="outcome">Outcome</label>
        <select class="field" id="outcome" ${L.stage >= 714000012 ? 'disabled' : ''}>
          <option value="">Not decided</option>
          ${Object.entries(OUTCOMES).map(([v, n]) => `<option value="${v}" ${L.outcome == v ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
        <label class="field-label" for="notes">Add a review note</label>
        <textarea class="field" id="notes" placeholder="Why this event, anything the merge or print step should know"></textarea>
        <div class="decision"><button class="btn sm" id="add-note">${ico('i-check')}Save note to the lead</button></div>
      </div>
    </section>
    <section class="card">
      <div class="card-h">${ico('i-clock')}<h3>Timeline</h3></div>
      <div class="card-b"><ul class="tl">
        ${notes.map(n => `<li><span class="tl-ico">${ico('i-mail')}</span><div><b>${esc(n.notetext || n.subject || 'Note')}</b><span>${fmtStamp(n.createdon)} · ${esc(FV(n, '_createdby_value') || '')}</span></div></li>`).join('')}
        ${L.mailedOn ? `<li><span class="tl-ico">${ico('i-send')}</span><div><b>Package mailed</b><span>${fmtStamp(L.mailedOn)}</span></div></li>` : ''}
        ${L.assembledOn ? `<li><span class="tl-ico">${ico('i-box')}</span><div><b>Assembled and sealed</b><span>${fmtStamp(L.assembledOn)}</span></div></li>` : ''}
        <li><span class="tl-ico">${ico('i-sync')}</span><div><b>Lead last updated</b><span>${fmtStamp(L.modifiedon)} · ${esc(L.modifiedBy || '')}</span></div></li>
        <li><span class="tl-ico">${ico('i-sync')}</span><div><b>Lead created from the weekly scan</b><span>${fmtStamp(L.createdon)}</span></div></li>
      </ul></div>
    </section>
  </div></div>`;
}

function mergeTab(L) {
  const ms = matchesFor(L), accs = ms.filter(m => m.kind === 'account'), leads = ms.filter(m => m.kind === 'lead');
  const canMerge = L.stage === 714000011 && !isClosed(L) && !busy;
  const status = L.accountId ? `<span class="chip ok">${ico('i-check')}Linked to ${esc(L.accountName || 'account')}</span>`
    : L.stage === 714000011 ? `<span class="chip warn">Waiting for Matt</span>` : `<span class="chip">Opens at Pending – Ready to Merge</span>`;
  return `<div class="grid">
  <div class="col">
    <section class="card">
      <div class="card-h">${ico('i-merge')}<h3>Merge gate</h3>${status}</div>
      <div class="card-b stack">
        <p class="hint" style="margin:0">Before a charity account is created, this lead is checked against existing charity accounts. EIN is checked first. The address key is the fallback, so "Jensen Dr" and "Jensen Drive" count as the same place.</p>
        <div class="norm"><div class="box"><label>Address on the lead</label>${esc(L.line || '—')}<br>${esc(L.city || '')}, ${esc(L.state)} ${esc(L.zip || '')}</div><div class="arrow" aria-hidden="true">→</div><div class="box mono"><label>Match key</label>${esc(L.key || '—')}</div></div>
        <div class="norm"><div class="box"><label>EIN on the lead</label>${esc(L.ein || 'Not on file')}</div><div class="arrow" aria-hidden="true">→</div><div class="box mono"><label>Normalised EIN</label>${esc(L.einN || '—')}</div></div>
      </div>
    </section>
    <section class="card">
      <div class="card-h">${ico('i-org')}<h3>Charity accounts that match</h3><span class="chip num">${ACCOUNTS.length} charity accounts</span></div>
      <div class="card-b stack">
        ${accs.length ? accs.map(m => `<div class="match ${m.strength}"><div class="match-h"><b>${esc(m.A.name)}</b><span class="chip ${m.strength === 'strong' ? 'ok' : 'warn'}">${esc(m.reason)}</span></div>
          <span class="hint">${esc(m.A.line || '')} ${esc(m.A.city || '')}</span>
          <div class="decision">${canMerge ? `<button class="btn primary" data-mergeinto="${m.A.id}">${ico('i-merge')}Link to this account</button>` : ''}<button class="btn sm" data-open="account:${m.A.id}">Open account</button></div></div>`).join('')
        : `<p class="hint" style="margin:0">No charity account matches this EIN, address or name.</p>`}
        ${canMerge ? `<div class="decision"><button class="btn ${accs.length ? '' : 'primary'}" data-act="mergeNew">${ico('i-merge')}${accs.length ? 'Create a separate account anyway' : `Create charity account: ${esc(L.org)}`}</button></div>` : ''}
      </div>
    </section>
  </div>
  <div class="col">
    <section class="card">
      <div class="card-h">${ico('i-alert')}<h3>Other leads for the same charity</h3><span class="chip num">${leads.length}</span></div>
      <div class="card-b stack">${leads.length ? leads.map(m => `<div class="match ${m.strength}"><div class="match-h"><b>${esc(m.O.ev)}</b><span class="chip ${m.strength === 'strong' ? 'ok' : 'warn'}">${esc(m.reason)}</span></div>
          <span class="hint">${esc(m.O.org)} · event ${fmt(m.O.evd)} · mail by ${fmt(m.O.mby)}</span><span class="mono">${esc(m.O.key)}</span>
          <div class="decision"><button class="btn sm" data-goto="${m.O.id}">Show in desk</button></div></div>`).join('')
        : `<p class="hint" style="margin:0">No other open lead shares this EIN, address or name.</p>`}</div>
    </section>
    <section class="card">
      <div class="card-h">${ico('i-check')}<h3>How the key is built</h3></div>
      <div class="card-b"><ul class="hint" style="margin:0;padding-left:18px;display:grid;gap:4px">
        <li>Uppercase. Remove punctuation, so W.W. becomes WW.</li>
        <li>Drop suite and unit details: Suite 100-300, Ste C, #1360.</li>
        <li>Use standard abbreviations: Drive DR, Road RD, Street ST, Boulevard BLVD, Parkway PKWY, Lane LN, East E, Third 3RD.</li>
        <li>P.O. Box and Post Office Box become PO BOX.</li>
        <li>Add the 5-digit ZIP, or the city when the ZIP is missing.</li>
      </ul></div>
    </section>
  </div></div>`;
}

function packageTab(L) {
  const si = stageIdx(L.stage), certs = CERTS[L.id] || [];
  const ladder = [['Mailed', si >= 5, L.mailedOn ? `Mailed ${fmtStamp(L.mailedOn)}` : `Target ${fmt(L.mby)}`], ['Delivered', false, 'Confirm with the charity'], ['Event held', false, fmt(L.evd)], ['Results requested', false, 'Up to 3 purchaser request e-mails'], ['Purchasers recorded', false, 'Each purchaser becomes a prospect contact']];
  return `<div class="grid">
  <div class="col">
    <section class="card">
      <div class="card-h">${ico('i-gift')}<h3>Gift certificates</h3><span class="chip num">${certs.length}</span></div>
      <div class="card-b tbl-wrap">${certs.length ? `<table><thead><tr><th>Certificate</th><th>Slot</th><th>Status</th></tr></thead><tbody>${certs.map(c => `<tr><td>${esc(c.cr93c_name || '—')}</td><td>${esc(FV(c, 'cr93c_certificate_slot') || '—')}</td><td>${esc(FV(c, 'cr93c_certificate_status') || '—')}</td></tr>`).join('')}</tbody></table>`
        : `<p class="hint" style="margin:0">No certificates yet. They are created when the package is assembled and sealed${L.assembledOn ? `. Assembled ${fmtStamp(L.assembledOn)}.` : '.'}</p>`}</div>
    </section>
    <section class="card">
      <div class="card-h">${ico('i-box')}<h3>Mailing label</h3><button class="btn sm" data-copy="label">${ico('i-copy')}Copy</button></div>
      <div class="card-b stack"><div class="label-card" style="font-size:14px">${esc(labelText(L))}</div>
        ${/\bP\.?\s*O\.?\s*BOX\b/i.test(L.line || '') ? `<span class="chip warn" style="justify-self:start">PO Box: ship by USPS</span>` : ''}</div>
    </section>
  </div>
  <div class="col">
    <section class="card">
      <div class="card-h">${ico('i-send')}<h3>GCP event follow-up</h3><span class="chip">${si >= 5 ? 'Open' : 'Starts when mailed'}</span></div>
      <div class="card-b"><ul class="ladder">${ladder.map(([n, on, d]) => `<li class="${on ? 'on' : ''}"><span class="ring"></span><div><b style="font-weight:500">${n}</b><div class="hint">${esc(d)}</div></div><span class="chip ${on ? 'ok' : ''}">${on ? 'Done' : 'Not started'}</span></li>`).join('')}</ul>
      <p class="hint" style="margin:10px 0 0">Closed Won needs at least one purchaser recorded as a prospect. Closed Lost is split: certificates unsold, or sold with no purchaser identified.</p></div>
    </section>
  </div></div>`;
}

function render() {
  renderQueue(); renderRecord();
  const me = document.getElementById('me');
  if (ME) { me.textContent = ME.split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase(); me.title = ME; }
}
async function select(id) {
  S.sel = id; pending = null; saveUi(); render();
  if (!NOTES[id]) { try { await loadDetail(id); } catch (e) {} if (S.sel === id) renderRecord(); }
}

// ---------- events ----------
document.getElementById('q-list').addEventListener('click', e => { const li = e.target.closest('.q-item'); if (li) { select(li.dataset.id); if (innerWidth < 900) document.getElementById('record').scrollIntoView({block:'start'}); } });
document.getElementById('q-list').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const li = e.target.closest('.q-item'); if (li) { e.preventDefault(); select(li.dataset.id); } } });
document.getElementById('q-filter').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.filter = b.dataset.f; saveUi(); renderQueue(); } });
document.getElementById('q-search').addEventListener('input', e => { S.q = e.target.value; saveUi(); renderQueue(); });
document.getElementById('record').addEventListener('click', e => {
  const L = LEADS.find(x => x.id === S.sel), t = e.target.closest('button, a');
  if (!t || !L) return;
  const d = t.dataset;
  if (t.id === 'confirm-yes' && pending) return exec(pending.L, pending.w);
  if (t.id === 'confirm-no') { pending = null; return renderRecord(); }
  if (busy && (d.act || d.reject || d.mergeinto)) return;
  if (d.act) return ask(d.act);
  if (d.reject) { document.getElementById('reject-menu')?.setAttribute('hidden', ''); return ask('reject', d.reject); }
  if (d.mergeinto) return ask('mergeInto', d.mergeinto);
  if (d.tab) { S.tab = d.tab; saveUi(); return renderRecord(); }
  if (d.goto) return select(d.goto);
  if (d.open) { e.preventDefault(); const [etn, id] = d.open.split(':'); return openRecord(etn, id); }
  if (d.copy === 'label') return copy(labelText(L), 'Mailing label');
  if (d.copytext) return copy(d.copytext, d.what);
  if (d.done) { (S.done[L.id] ||= {}); S.done[L.id][d.done] = !S.done[L.id][d.done]; saveUi(); return render(); }
  if (d.focus === 'review') { document.getElementById('review-card').scrollIntoView({behavior:'smooth', block:'center'}); return document.getElementById('outcome').focus(); }
  if (t.id === 'add-note') { const v = document.getElementById('notes').value.trim(); if (!v) return toast('Write a note first', true); return ask('note', v); }
  if (t.id === 'refresh-btn') return boot(true);
  if (t.id === 'reject-btn') { const m = document.getElementById('reject-menu'); const open = m.hasAttribute('hidden'); m.toggleAttribute('hidden', !open); t.setAttribute('aria-expanded', String(open)); }
});
document.getElementById('record').addEventListener('change', e => {
  if (e.target.id !== 'outcome') return;
  const v = e.target.value;
  if (v === '714000020') return ask('approve');
  if (v) return ask('reject', v);
  return ask('reopen');
});
document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) document.getElementById('reject-menu')?.setAttribute('hidden', ''); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { document.getElementById('reject-menu')?.setAttribute('hidden', ''); if (pending) { pending = null; renderRecord(); } } });

async function boot(isRefresh) {
  const rec = document.getElementById('record');
  if (!isRefresh) rec.innerHTML = `<section class="card card-b"><p class="hint">Loading GCP event leads from Dynamics…</p></section>`;
  try { NOTES = {}; CERTS = {}; await loadAll(); if (S.sel) await loadDetail(S.sel); render(); if (isRefresh) toast('Refreshed from Dynamics'); }
  catch (e) { rec.innerHTML = `<section class="card card-b"><p><b>Could not load leads from Dynamics.</b></p><p class="hint">${esc(e.message)}. Open this page from inside Dynamics 365 Sales while signed in.</p></section>`; }
}
document.getElementById('q-search').value = S.q;
boot();
