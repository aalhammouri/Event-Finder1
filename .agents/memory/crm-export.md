---
name: CRM export format
description: ACT CRM 30-column CSV export format and boolean tristate convention
---

Endpoint: GET /api/events/export/crm?runId=N

30 columns (exact order):
First Name, Last Name, Title, Company, Phone, Email Address, Address 1, City, State, Zip, Web Site, Primary Group 1, Event Name, Event Date, Event Venue, Event Address, Auction Type, Has Silent Auction, Has Live Auction, Has Online Auction, Has Raffle, Has Donation Request, Ticket Price, Table Price, Formality, Sponsorship Mentioned, RSVP Link, Event Page URL, Score, Tier

Boolean tristate: true → "Yes", false → "No", null/undefined → "Unkown" (intentional typo matching ACT CRM template)

Admin settings for export: primaryGroup1Label (default "2026 Events"), defaultMailingState (default "TX").
State column: uses orgState if present, else defaultMailingState.

**Why:** ACT CRM import requires this exact column order and the "Unkown" tristate spelling.
**How to apply:** Any changes to the export format must preserve the column order and the tristate spelling.
