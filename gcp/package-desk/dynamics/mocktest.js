const { chromium } = require('playwright');
const fs = require('fs');
const ORG = 'https://orgcad402f2.crm.dynamics.com';
const leads = [
 {leadid:'589648cb-e3bc-f111-aaae-70a8a5b0e87a',subject:'[GCP] 28th Annual Spirit Award Dinner',companyname:'Houston Hospice',firstname:'Daphne',lastname:'Singleterry',emailaddress1:'dsingleterry@houstonhospice.org',emailaddress2:'info@houstonhospice.org',telephone1:'713-677-7124',telephone2:'713-467-7423',websiteurl:'https://www.houstonhospice.org',lead_event_web_page:'https://www.houstonhospice.org/event/spiritaward2026/',lead_event_date:'2026-11-03T06:00:00Z',lead_mail_by_date:'2026-10-13T05:00:00Z',lead_venue:714000006,'lead_venue@OData.Community.Display.V1.FormattedValue':'Dinner',lead_online_auction:714000001,lead_live_auction:714000000,lead_silent_auction:714000000,lead_raffle:714000000,lead_auction_evidence:714000000,'lead_auction_evidence@OData.Community.Display.V1.FormattedValue':'Confirmed',lead_event_score:86,address1_line1:'1905 Holcombe Blvd.',address1_city:'Houston',address1_stateorprovince:'TX',address1_postalcode:'77030',lead_address_source:714000000,'lead_address_source@OData.Community.Display.V1.FormattedValue':'Organization website',lead_gcp_stage:714000011,lead_review_outcome:714000020,'_ownerid_value@OData.Community.Display.V1.FormattedValue':'AB Alhammouri',createdon:'2026-09-30T15:30:05Z',modifiedon:'2026-10-02T20:51:06Z',statecode:0},
 {leadid:'bf9087a5-e3bc-f111-aaae-70a8a5b0e87a',subject:'[GCP] Larry Dierker Celebrity Golf Shootout',companyname:'Cy-Hope',firstname:'Jennifer',lastname:'Herrera',lead_ein:'45-2346150',address1_line1:'12715 Telge Rd',address1_city:'Cypress',address1_postalcode:'77429',lead_event_date:'2026-10-29T05:00:00Z',lead_mail_by_date:'2026-10-08T05:00:00Z',lead_gcp_stage:714000010,createdon:'2026-09-30T15:29:05Z',modifiedon:'2026-10-02T20:51:06Z',statecode:0},
];
const writes = [];
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(()=>chromium.launch());
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**/*', async route => {
    const u = new URL(route.request().url()), m = route.request().method();
    if (u.origin !== ORG) return route.abort();
    const path = u.pathname;
    if (path.endsWith('/WebResources/gcp_/packagedesk/index.html')) return route.fulfill({ body: fs.readFileSync('index.min.html'), contentType: 'text/html' });
    if (path.endsWith('/logo.png')) return route.fulfill({ body: fs.readFileSync('goff-logo.png'), contentType: 'image/png' });
    if (m !== 'GET') { writes.push(m + ' ' + path + ' ' + route.request().postData()); 
      if (path.endsWith('/annotations') || path.endsWith('/accounts')) return route.fulfill({ status: 204, headers: { 'OData-EntityId': ORG + '/api/data/v9.2/x(11111111-2222-3333-4444-555555555555)' } });
      const id = path.match(/leads\(([^)]+)\)/)[1]; Object.assign(leads.find(l => l.leadid === id), JSON.parse(route.request().postData())); return route.fulfill({ status: 204 }); }
    const json = o => route.fulfill({ body: JSON.stringify(o), contentType: 'application/json' });
    if (path.endsWith('/WhoAmI')) return json({ UserId: '51805841-6a07-f011-bae3-000d3a3088ef' });
    if (path.includes('/systemusers(')) return json({ fullname: 'Matt Goff' });
    if (/\/leads$/.test(path)) return json({ value: leads });
    if (/\/leads\(/.test(path)) return json(leads.find(l => path.includes(l.leadid)));
    if (/\/accounts$/.test(path)) return json({ value: [] });
    if (/\/accounts\(/.test(path)) return json({ accountid: '11111111-2222-3333-4444-555555555555', name: 'Houston Hospice' });
    return json({ value: [] });
  });
  await p.goto(ORG + '/WebResources/gcp_/packagedesk/index.html'); await p.waitForTimeout(700);
  await p.screenshot({ path: 'live1.png' });
  await p.click('.q-item[data-id^="bf9087a5"]'); await p.waitForTimeout(300);
  await p.click('[data-act=approve]'); await p.waitForTimeout(100);
  await p.click('#confirm-yes'); await p.waitForTimeout(500);
  await p.click('.q-item[data-id^="589648cb"]'); await p.waitForTimeout(300);
  await p.click('[data-tab=merge]'); await p.waitForTimeout(200);
  await p.click('[data-act=mergeNew]'); await p.click('#confirm-yes'); await p.waitForTimeout(500);
  await p.screenshot({ path: 'live2.png' });
  console.log(JSON.stringify({ errs, writes }, null, 1));
  await b.close();
})();
