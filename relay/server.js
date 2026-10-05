// GCP Package Desk postage relay.
// Holds the carrier API key (EasyPost) so the browser never sees it. The Desk calls this with a shared token.
// Run: EASYPOST_API_KEY=... RELAY_TOKEN=... ALLOW_ORIGIN=https://orgcad402f2.crm.dynamics.com node server.js
const http = require('http');
const KEY = process.env.EASYPOST_API_KEY || '', TOKEN = process.env.RELAY_TOKEN || '', ORIGIN = process.env.ALLOW_ORIGIN || '*', PORT = Number(process.env.PORT || 8787);
const EP = 'https://api.easypost.com/v2';
const auth = { Authorization: 'Basic ' + Buffer.from(KEY + ':').toString('base64'), 'Content-Type': 'application/json' };
async function ep(path, body, method) {
  const r = await fetch(EP + path, { method: method || (body ? 'POST' : 'GET'), headers: auth, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `${r.status} from EasyPost`);
  return j;
}
const addr = a => ({ name: a.name || a.company || '', company: a.company || '', street1: a.street1, street2: a.street2 || '', city: a.city, state: a.state, zip: a.zip, country: 'US', phone: a.phone || '', email: a.email || '' });
const handlers = {
  'GET /health': async () => ({ ok: true, carrier: 'easypost', keyConfigured: !!KEY }),
  'POST /rates': async b => {
    const s = await ep('/shipments', { shipment: { to_address: addr(b.to), from_address: addr(b.from), parcel: { length: b.parcel.length, width: b.parcel.width, height: b.parcel.height, weight: b.parcel.weight }, reference: b.ref || '' } });
    return { shipmentId: s.id, rates: (s.rates || []).map(r => ({ id: r.id, carrier: r.carrier, service: r.service, rate: Number(r.rate), days: r.delivery_days || null })) };
  },
  'POST /buy': async b => {
    const s = await ep(`/shipments/${b.shipmentId}/buy`, { rate: { id: b.rateId } });
    return { trackingCode: s.tracking_code, labelUrl: s.postage_label && (s.postage_label.label_url), cost: s.selected_rate ? Number(s.selected_rate.rate) : null, carrier: s.selected_rate && s.selected_rate.carrier, service: s.selected_rate && s.selected_rate.service };
  },
  'POST /verify': async b => {
    const a = await ep('/addresses', { address: Object.assign(addr(b), { verify: ['delivery'] }) });
    const v = a.verifications && a.verifications.delivery;
    return { deliverable: !!(v && v.success), normalized: { street1: a.street1, street2: a.street2, city: a.city, state: a.state, zip: a.zip }, message: v && v.errors && v.errors.map(e => e.message).join('; ') };
  },
};
async function track(code, carrier) {
  const t = await ep('/trackers', { tracker: { tracking_code: code, carrier: carrier || undefined } });
  const last = (t.tracking_details || []).slice(-1)[0];
  return { status: t.status, delivered: t.status === 'delivered', deliveredAt: t.status === 'delivered' && last ? last.datetime : null, estDelivery: t.est_delivery_date, lastEvent: last ? `${last.message} ${last.tracking_location ? '· ' + (last.tracking_location.city || '') : ''}`.trim() : '' };
}
http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  const send = (code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, cors)); res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') return send(204, {});
  const url = new URL(req.url, 'http://x');
  if (TOKEN && req.headers['x-relay-token'] !== TOKEN && url.pathname !== '/health') return send(401, { error: 'Bad relay token' });
  let body = ''; for await (const c of req) body += c;
  try {
    const b = body ? JSON.parse(body) : {};
    if (req.method === 'GET' && url.pathname.startsWith('/track/')) return send(200, await track(decodeURIComponent(url.pathname.slice(7)), url.searchParams.get('carrier')));
    const h = handlers[`${req.method} ${url.pathname}`]; if (!h) return send(404, { error: 'Unknown route' });
    send(200, await h(b));
  } catch (e) { send(500, { error: e.message }); }
}).listen(PORT, () => console.log(`GCP postage relay on :${PORT} (origin ${ORIGIN}, key ${KEY ? 'set' : 'MISSING'})`));
