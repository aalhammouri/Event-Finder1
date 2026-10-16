Weekly Charity Event Scan — v1.6 (amended 2026-10-02)

CHANGE LOG FOR THIS VERSION
- New Step 3A: retail and market formats are excluded unless the event's own page confirms an auction or raffle. Added after "Holiday Market at the CCMH" reached Ready to Send at 81/100 with two invented Yes values.
- Step 5A tightened: the prior-year rule may set Silent Auction only, and only on a matching event name — not merely a matching organisation. An Assumed Yes with no snippet is now invalid.
- Step 7A and Step 9 extended to enforce both of the above.

PHASE 0 — Hygiene and setup
Pure Airtable reads/writes plus one file download. No crawling.

0A. URL artifact assertion
Query Organizations for Website URL containing ://HTTP (case-insensitive). Expected: 0 rows. The double-wrapped-URL artifact no longer exists; the table was re-imported clean on 2026-09-18 [MEASURED]. If any appear, do not invent a repair mid-run — report the count and the affected record IDs and skip those orgs for this run. If the artifact ever does return, the repair is: strip the outer scheme, lowercase the host only (never the path — hostnames are case-insensitive, paths are not), and strip a trailing bare dot from the path.

0B. Unusable organization rows
Where Name has no dot AND Website URL does not parse to a host with a real TLD, set Active = false and record the reason. Both conditions must hold — a junk-looking name with a working URL stays active and is handled by "trust the URL" in Step 1B. There are 11 such rows [MEASURED]; on every one the URL is the junk and the Name was derived from it, so renaming produces none → none. These need retiring, not repairing. List every deactivation in the report. Do not delete rows.

0C. Load the IRS Texas extract (once per run)
Download https://www.irs.gov/pub/irs-soi/eo_tx.csv once to local disk before any worker starts. All workers share the one copy. Re-download only if the cache is older than 14 days.
Never read this file into context — about 25 MB, about 200,000 rows. Query it with line-level search and pull only the matching line.
Header, confirmed against the live file:
EIN,NAME,ICO,STREET,CITY,STATE,ZIP,GROUP,SUBSECTION,AFFILIATION,CLASSIFICATION,RULING,DEDUCTIBILITY,FOUNDATION,ACTIVITY,ORGANIZATION,STATUS,TAX_PERIOD,ASSET_CD,INCOME_CD,FILING_REQ_CD,PF_FILING_REQ_CD,ACCT_PD,ASSET_AMT,INCOME_AMT,REVENUE_AMT,NTEE_CD,SORT_NAME
EIN is 9 digits, zero-padded, no dash. Candid shows 20-4748799 — strip and pad before searching. ZIP is ZIP+4; store the first 5. The file covers all tax-exempt orgs, not only charities, so require SUBSECTION = 03 and STATUS = 01.

0D. Report the hygiene results
URL artifacts found (expect 0), organizations deactivated, and any org whose URL duplicates another row's URL — flag as possible duplicate organizations, do not delete.

PHASE A — Revisit queue
Three situations produce an incomplete row that no care on first crawl would have prevented: the event had not matured yet (a September page for a March gala has no contact, venue or auction detail; the sponsorship packet drops in November); Unclear only means something if something revisits it, otherwise it is a permanent shrug; and at 50 orgs per run the rotation takes about 42 weeks, so an event found in week 1 would never be looked at again before it happens.

Selection — upcoming events only (Days Until Event 0 to 180), where any of:
- GCP - Auction Evidence = Unverified. The Step 4 checks never completed because the crawl budget ran out. Always requeue; this is unfinished work, not an unknowable answer.
- Any auction/raffle field is Unclear AND the event is within 120 days. Do not re-check an exhausted Unclear on an event 9 months out — nothing has changed.
- A mission-critical field is blank AND the event is within 120 days.

Mission-critical set: GCP - Online Auction, GCP - Silent Auction, GCP - Raffle, GCP - Event Date Sort, GCP - Beneficiary of Fundraiser, GCP - Event, Mailing Address 1, Mailing Address 2, Mailing City, Mailing State, Mailing Zip, Contact, Event Contact, Event Contact E-mail.

Limits: skip any row whose Last Enriched is within 21 days; skip any row already revisited 3 times; cap at 20 rows, soonest events first.

Rules: run the free checks before spending any crawl (the prior-year lookup is an Airtable query, the Contact composition and e-mail fallbacks are field logic, the IRS lookup is a local file read), then re-crawl the event page, its ticket platform and its sponsorship page. UPDATE the existing row, never create a second. Never overwrite Confirmed with Assumed. Never modify Event ID on a pre-existing row. Stamp Last Enriched = today on every row touched whether or not anything changed — that is what makes the 21-day guard work. Still blank after all of that, leave blank; do not guess.

PHASE B — Scan new organizations

Step 1 — Build this run's batch
1A. Read active orgs from tblaiTaxPk5rPVria where Active = true, sorted by Last Scanned ascending (blank first). Take the first 50. Organizations holds 2,085 active rows [MEASURED].
Idempotency guard: exclude any row whose Last Scanned is already today. If a run fires twice in one day it must not burn another 50 orgs — it should find its batch empty or partial and say so rather than advancing the rotation again.
1B. Resolve a usable URL per org. Prefer Website URL. If blank, use Name only if it is a plausible domain (a dot and a real TLD); reject http, https, org, com, gmail.com, google.com, facebooks.com, projects.propublica.org, and bare words with no TLD. If neither works, do ONE Firecrawl search for the likely org name. If still nothing: skip extraction, still stamp Last Scanned, and write a Screened Out row with reason "No working site".
Trust the URL, not the Name. On some rows they are misaligned from an old import. Always scan the site the URL points to and derive identity from that site's content. If they clearly disagree, report "Name/URL mismatch — needs a human look" and carry on using the URL.
1C. Split the 50 across 5 workers of 10 orgs each. Each worker runs Steps 2 to 7 independently.
Budget: 6 to 8 Firecrawl calls per org. If the budget runs out mid-Step-4, write Unclear, set GCP - Auction Evidence = Unverified, and let Phase A pick the row up next week — do not silently skip the checks.
1D. After each org — events found, none, or dead site — set Last Scanned = today. Batch these writes (after the first 5 orgs, and again at the end) so a worker that dies partway still advances what it completed.

Step 2 — Crawl with Firecrawl
Use the Firecrawl connector, not generic browsing — it renders JavaScript and can be pointed at PDFs and flyer images. Per org: homepage, then /events, /calendar, /get-involved or /support-us if present, then follow specific event links. For PDF flyers use parsers: ["pdf"]. Check linked Facebook/social when the site is thin.

Step 3 — Keep only genuinely upcoming, live events
Determine each candidate's date before including it.
- Confirmed date before today → Missed Events, not an Events row.
- Cancelled, postponed, or "date TBD — check back" → Screened Out, reason "Cancelled or postponed".
- URL or name contains a specific past year within 5 years and no newer instance exists on the site → Missed Events.
- No date findable anywhere but otherwise current → may go to Events, but only after checking the event page, any linked ticket platform, PDF flyers and the org's Facebook. Record what you tried in GCP - Donation Needed By. If truly none → Screened Out, "Date TBD — no date published".
- If a date appears in any format, parse it into GCP - Event Date Sort as YYYY-MM-DD. A range takes the start date. Do not leave the date blank when the page shows one.
- Out of the Texas/Houston region → Screened Out, "Out of geography".
- PTA/PTO or political org → Screened Out, "Excluded category (PTA, political — per the Excluded formula)".
- Politically charged cause → Screened Out, "Sensitive — needs human review".

Step 3A — Retail and market formats [NEW 2026-10-02]
Some events are retail, not fundraising-by-auction. A vendor rents a stall and sells their own goods; nothing is bid on and there is no lot a donated gift certificate could sit in. The package has nowhere to go, so the event is not a lead however well it scores on contact and timing.

Treat an event as a retail or market format when the event NAME or the PAGE DESCRIPTION identifies it as one of: holiday market, Christmas market, winter market, craft fair, craft show, craft market, vendor fair, vendor market, vendor show, bazaar, pop-up shop, pop-up market, pop-up boutique, holiday boutique, holiday gift shop, artisan market, makers market, marketplace, trunk show, farmers market, flea market, rummage sale, garage sale, book sale, plant sale, bake sale, swap meet, shop-small or small-business shopping event.

For an event matching that list:
1. NO INFERENCE MAY SET ANY AUCTION OR RAFFLE FIELD. The Step 5A venue rules are barred and the prior-year rule is barred. There is no exception.
2. A Yes is allowed only from Confirmed evidence quoted from that event's OWN page — wording such as "silent auction table", "raffle tickets", "bid on", "auction items wanted". The organisation's general auction language elsewhere on the site, or a different event of theirs, does not count.
3. If no field reaches a Confirmed Yes, do not write an Events row. Write Screened Out with reason "Retail or market format - no auction evidence", set all four auction fields to No, and in Reason Detail either quote the page text or state plainly that the page carries no auction language.
4. A retail-format event that DOES carry a Confirmed auction or raffle goes to Events normally. Kingwood Women's Club "28th Annual Holiday Marketplace" is the worked example of one that qualifies: a marketplace with a confirmed silent auction and raffle.
5. Judge on the format, not the word. "Empty Bowls presented by the Bulldog Marketplace" is a charity luncheon whose host venue happens to be called a marketplace — it is not a retail format. Read the description before applying this rule.

The failure this rule exists to prevent: "Holiday Market at the CCMH" (Czech Center Museum Houston, 2026-11-21) reached Ready to Send at 81/100 carrying Silent Auction = Yes and Online Auction = Yes, both on Assumed evidence, both with a blank Auction Evidence Snippet, on an event page with no auction language anywhere. 33 of its 40 auction points rested on two values no rule authorised.

Step 4 — Exhaust "Unclear" before settling for it
Unclear is a last resort, not a default. Check all of these that exist, in this order:
1. Prior-year instance in the Events table. An Airtable query, not a crawl — it costs nothing, so always first.
2. Sponsorship, sponsor-packet and donation-request pages. This is where auction and in-kind language actually lives ("donate an auction item", "raffle prizes needed", "in-kind donations"), not in the event blurb.
3. Third-party ticketing and registration pages — Givebutter, Qgiv, OneCause, Membership Toolkit, BetterUnite, Network for Good, Zeffy, Paybee, GiveSmart, DonorPerfect, Classy, Eventbrite. Follow the link with Firecrawl and read it.
4. The prior-year page on the web, if the table had nothing.
Only after all four come back empty may a field be Unclear.

Step 5 — Extract the event
Fill: GCP - Donation Needed By, the four auction/raffle fields, GCP - Event Web Page, GCP - Event Date Sort, GCP - Beneficiary of Fundraiser (org name), GCP - Event (event name), Mailing Address 1 (org name), Mailing Address 2/City/State/Zip, Phone - Business, E-mail, Web Site, Company.
Derive the real organization name from crawled site content — the Organizations Name field is often a leftover email domain and must not be used as the org name.
Auction/raffle values: Yes only with real evidence (quoted page text, or a Step 5A rule that is permitted for this event). No only when you actually read the relevant pages and are confident. Unclear only after Step 4 is exhausted.

Address fallback — stop at the first source returning a full street address
1. The organization's own website — event page first, then Contact/About. Address Source = "Organization website" or "Event page".
2. Candid. No connector exists; do ONE Firecrawl search for site:app.candid.org "<legal org name>" and scrape the top matching profile. Address Source = "Candid"; fill Candid Match = Yes, Candid URL, Candid Mailing Address, Candid City/State/Zip, Candid EIN. No clear match → Candid Match = No with the reason in Candid Note. This step is MANDATORY before an address may be declared unavailable — Candid Match is blank on 621 of 664 rows [MEASURED], which means it is being skipped, not failing.
3. IRS Texas EO extract (the Phase 0C file), only if 1 and 2 are both empty. EIN known: strip the dash, zero-pad to 9, match the line starting with that EIN — use this path whenever the EIN is known even if Candid had no usable address. EIN unknown: grep a distinctive name token for a short candidate list, then normalize both sides (uppercase, strip punctuation, collapse whitespace, drop trailing INC / INCORPORATED / FOUNDATION / ASSOCIATION / ASSN / CO / CORP / LLC) and compare; ProPublica's search index (projects.propublica.org/nonprofits/api/v2/search.json?q=<NAME>&state%5Bid%5D=TX) resolves name to EIN better than grep. Accept only SUBSECTION = 03 and STATUS = 01. Exactly one match → take STREET, CITY, STATE and the first 5 of ZIP. Zero matches, or two or more plausible → leave blank and stop. Do not guess. Address Source = "IRS Texas EO extract", noted in Candid Note (Events) or Notes (Missed Events).
Registry addresses are the address of record — often a PO box or a registered agent. Never overwrite a website address with a registry one.

Step 5A — Classify venue, then infer silent auction
Set GCP - Venue from the event name AND the page description, not the name alone. "Veritas Rewind", "Boots & Bling", "Guts + Glory" are galas with no format word in the title, so read the description: black-tie or attire language, "seated dinner", "cocktail hour", "table sponsor" → Gala; "shotgun start", "tee time", "foursome", "scramble" → Golf Tournament; "seated lunch", midday start → Luncheon.
Allowed: Gala, Luncheon, Golf Tournament, Festival, Breakfast, Art Event, Dinner, Other. Use Other only when the format genuinely is not one of these (walk/run, poker night, pickleball, clay shoot, casino night) — not as a shrug.

Silent-auction inference. Apply only where GCP - Silent Auction would otherwise be blank or Unclear, and never where Step 3A bars inference. Never overwrite a Yes/No confirmed from page text.
- Gala → Yes. Venue type alone is sufficient.
- Dinner → Yes. Treat as Gala.
- Golf Tournament → Yes only if there is some indication of a raffle or live auction.
- Luncheon → Yes only if there is some indication of a live auction, raffle, or request for in-kind donations.
- Festival, Breakfast, Art Event, Other → do not infer from venue. Prior-year rule only.
Golf and luncheon are conditional because the original specification made only Gala unconditional. Dropping those conditions stamps a Yes into the highest-weighted scoring field based on reasoning about a different field.

Prior-year history [TIGHTENED 2026-10-02]
Check whether the org ran THIS SAME EVENT in prior years, up to 3 years back. Check the Events table first; it is free.
- The match is on organisation AND normalised event name, BOTH. Same organisation, different event, is NOT a match. A gala's confirmed auction does not travel to that organisation's market, fun run or breakfast. This is the error that put Online Auction = Yes on a holiday market.
- A matching prior instance confirming a silent auction may set GCP - Silent Auction = Yes. It may NEVER set Online Auction, Live Auction or Raffle. 15 rows currently carry Online Auction = Yes on Assumed evidence, which no rule in this spec authorises [MEASURED 2026-10-02].
Set Prior Year Auction to Yes / No / Not checked on every row. Never blank.

GCP - Auction Evidence — never blank
- Confirmed: from quoted page text. Store the quote in Auction Evidence Snippet (Events) or Notes (Missed Events).
- Assumed: from an inference rule above. The snippet MUST name which rule fired. An Assumed Yes with a blank snippet is invalid — set that field to Unclear and the evidence to Unverified and let Phase A pick it up. [NEW 2026-10-02]
- Unverified: a value exists with no stored quote or rule behind it, including budget exhaustion.
Never stamp Confirmed on something you did not read.

Step 6 — Check what is new, or repair what exists
Search Events for each event found. URL match first: normalize GCP - Event Web Page (ignore protocol, www., trailing slash); exactly one row matches AND that URL appears nowhere else → duplicate. Do not trust a shared URL — many small orgs point every event at the same generic /events page; if the URL appears on more than one row, or there is no URL match, fall back to GCP - Beneficiary of Fundraiser + GCP - Event (case-insensitive, trimmed, ignoring a leading year). Run the name match even when the URL matched, to catch the same event logged under a different URL. Neither → new.
A duplicate is not automatically a skip. Existing row has all mission-critical fields and no Unclear → skip. Existing row missing any, or holding any Unclear → Phase A repair: fill ONLY the blank fields from what you just crawled, update that row, create nothing, never modify its Event ID, never overwrite Confirmed with Assumed, stamp Last Enriched = today.
For missed events from Step 3, run the same process against Missed Events. Before writing any Screened Out row, check Screened Out for the same org + event so a rejection is not re-logged every week.
Concurrent-write guard: five workers run this step against a table the other four are writing to, so two can both conclude "new" for a co-hosted event. Keep a shared in-run log of (normalized org, normalized event name, normalized URL) for every row written this run and check it alongside the Airtable lookup.

Step 6B — Research contacts
Applies to new upcoming events AND Phase A repairs. Skip for missed events, whose contacts are stale. Use the event page and the org's website only; verify on pages you actually read and never fabricate.
- Event Contact: the named contact for this event; else the org's CEO, Executive Director, or Head of Fundraising/Development, in that order.
- Event Contact Title: job title.
- Event Contact Phone Number: direct line if available, ELSE the org's main business phone. Mandatory fallback.
- Event Contact E-mail: their email if available, ELSE the org's general contact email. Mandatory fallback.
- Employee or Volunteer: paid staff or leadership → Employee; board member, chair or volunteer committee → Volunteer. Default Employee for paid-staff titles.
Before leaving Event Contact E-mail or Phone blank, confirm the org-level E-mail / Phone - Business is also blank. There are 67 rows where the event email is blank while the org email on the same row is populated [MEASURED].
Second contact: the org's CEO / Executive Director / Head of Fundraising or Development, in that order, and only if a different person from the primary. If the primary already is the CEO or Director, leave all Person 2 fields blank. Person 2 E-mail = theirs else org general; Person 2 Phone = theirs else org main; Person 2 Employee/Volunteer by the same rule.

Step 6C — Contact
Exactly this format, omitting blank components, never more than one person:
<Event Contact>, <Event Contact Title>, <Event Contact E-mail>, <Event Contact Phone Number>
If Event Contact is blank, leave Contact blank.

Step 7 — Write rows
Events row = all Step 5 fields + the Step 5A venue/evidence fields + the nine Step 6B contact fields + Step 6C. Missed Events row = whatever Step 5/5A fields you found, no contact fields.
Event ID: required on every new row in any table. A randomly generated 24-character string of mixed-case letters and digits, produced with a real random utility — never typed by hand, because hand-made "random" strings collide. Fresh, distinct ID per row. Never modify an Event ID on a pre-existing row, including during a Phase A repair. Confirm the generator exists in the execution environment before relying on it.

Step 7A — Qualification filter → Screened Out
PRE-WRITE CHECK, immediately before each create_records_for_table call on Events. Inspect the payload record by record and remove any that fails either test below, writing it to Screened Out instead. Do not rely on having remembered these rules earlier in the run.
1. All four auction/raffle fields are a confident No → Screened Out, reason "All auction fields confirmed No". There is nowhere to place a gift certificate, so it is not a lead.
2. The event is a retail or market format under Step 3A and no field carries a Confirmed Yes → Screened Out, reason "Retail or market format - no auction evidence". [NEW 2026-10-02]
Events with at least one permitted Yes, or a remaining Unclear after Step 4 was exhausted, do get written to Events — an Unclear is a follow-up, a confident all-No is a dead end.
Every Screened Out row needs a Screen Out Reason and, where the decision came from page text, a quote in Reason Detail. A rejection without evidence is not training data.
Applies to Events only. Missed Events is a historical record — log those regardless.

Table boundaries: Events holds upcoming qualified leads. Missed Events holds real events found after they happened. Screened Out holds events found in time and deliberately rejected, plus retired orgs.

Step 7B — Screened Out table (tbleTzeVzQTU60S5e)
Screen Out Reason choices: All auction fields confirmed No · Retail or market format - no auction evidence · Cancelled or postponed · Date TBD — no date published · Excluded category (PTA, political — per the Excluded formula) · Sensitive — needs human review · Duplicate of existing row · No working site · Out of geography

Step 8 — Report
Email mattgofftx1@gmail.com. Subject "Weekly Charity Event Scan — New events found" if at least one new upcoming event was created, otherwise "Weekly Charity Event Scan — No new events found". Both carry every section below.
- New events. Per event: org, event name, date, venue, which auction/raffle fields are Yes, and whether evidence is Confirmed or Assumed, so triage does not require opening the base. Strongest first: Confirmed, then Assumed from a venue rule, then remaining Unclear.
- Phase 0: URL artifacts found (expected 0) and any record IDs; organizations deactivated; possible duplicate organizations flagged.
- Phase A: queue size before the cap (a growing queue means Phase B is producing incomplete rows and the cause needs fixing at source); rows revisited and how many became complete; rows requeued as Unverified (a persistent count means the crawl budget is too tight); rows hitting the 3-revisit limit; current completion X of Y upcoming rows and the change since last run.
- Phase B: new Missed Events rows; new Screened Out rows broken out by reason, with the retail/market count called out separately; orgs scanned and roughly how many active orgs remain; dead sites that should be deactivated; Name/URL mismatches needing a human look.
- Address sourcing: addresses resolved by website / Candid / IRS Texas extract / none. If the IRS extract resolved zero, say so — it means the fallback is not firing.
- Base link: https://airtable.com/appNUzEiGzNx3nFec

Step 9 — Final verification before finishing
Re-read the rows created or updated during this run and confirm:
- No Events row has all four auction/raffle fields set to No.
- No Events row is a Step 3A retail or market format without a Confirmed auction or raffle. [NEW]
- No Events row has an Assumed Yes with a blank Auction Evidence Snippet. [NEW]
- No Events row has Online Auction, Live Auction or Raffle set to Yes on Assumed evidence — only Silent Auction may be Assumed. [NEW]
- No row has a blank GCP - Auction Evidence.
- No row has a blank Prior Year Auction.
- No duplicate Event ID was issued this run, and no pre-existing Event ID was modified.
Fix or remove anything that fails, and say so in the email.
