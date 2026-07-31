# Threat Model

## Project Overview

Event Finder is a private-deployed internal web application for Goff Financial that crawls external nonprofit websites, extracts fundraising event data with AI-assisted parsing, stores the results in PostgreSQL, and exposes dashboards, exports, automation settings, and run-management tools through an Express API and React frontend. Production traffic is TLS-terminated by the platform, and the current deployment visibility is private, so the main realistic attackers are authenticated low-privilege users and anyone who can influence target websites or network responses to crawler requests.

## Assets

- **User accounts and sessions** — JWT bearer tokens, password hashes, activation tokens, and reset tokens. Compromise enables impersonation and access to all internal data surfaces.
- **Crawl control plane** — URL lists, crawl-run lifecycle controls, scheduler settings, domain blacklist, and error-analysis actions. Abuse can trigger outbound requests, consume AI/API budget, alter operational data, or interfere with scheduled jobs.
- **Collected event and contact data** — event details, organization data, contact names, emails, phone numbers, scoring, and exported CRM CSVs. This is business-sensitive prospecting data and includes personal contact information.
- **Application secrets and third-party privileges** — database credentials, JWT signing secret, Firecrawl API key, OpenAI integration credentials, and Resend credentials. Exposure would enable data compromise or third-party service abuse.
- **Operational logs and crawl artifacts** — stored run logs, coverage reports, missed URLs, crawl errors, and AI-derived diagnostics. These can expose what the crawler fetched and what internal users attempted.

## Trust Boundaries

- **Browser to API** — all frontend input is untrusted, including authenticated viewer traffic. Server-side authorization must be enforced independently of UI affordances.
- **API to PostgreSQL** — the API has broad read/write access to application data. Route-layer authorization failures expose all persisted data and operational state.
- **API to external services** — the server sends data to Firecrawl, OpenAI, Resend, and arbitrary target websites selected through crawl features. This boundary is high risk because user-supplied URLs can trigger outbound network activity and third-party processing.
- **Public auth routes to authenticated app** — login, activation, password reset, and account rehydration sit outside the main auth middleware and must defend against spoofing, brute force, and token misuse.
- **Viewer to admin boundary** — the product distinguishes `viewer` and `admin` roles. Admin-only settings and any state-changing crawler controls must be enforced server-side.
- **Production to dev-only boundary** — `artifacts/mockup-sandbox/` is development-only and should be ignored unless production reachability is demonstrated.

## Scan Anchors

- Production backend entry points: `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/`
- Highest-risk code areas: `artifacts/api-server/src/routes/{auth,urlLists,crawlRuns,admin}.ts`, `artifacts/api-server/src/services/{crawler,coverage,extractor,scheduler}.ts`, `artifacts/api-server/src/middleware/auth.ts`
- Public/authenticated/admin split: `/api/auth/*` is public, most `/api/*` routes are authenticated, and `/api/admin/*` adds `requireAdmin`; verify whether role separation is consistently applied outside `/admin`
- Dev-only area: `artifacts/mockup-sandbox/`

## Threat Categories

### Spoofing

The application relies on self-issued JWT bearer tokens for authenticated API access. All protected routes MUST require a valid signed token, password-reset and activation tokens MUST remain unguessable and single-use, and public auth flows MUST resist credential stuffing and account takeover attempts.

### Tampering

Authenticated users can create and modify URL lists, start and stop crawl runs, and change operational state. The server MUST enforce the intended viewer/admin permissions on every mutating route, and crawler inputs such as URLs and retry targets MUST be validated so users cannot turn the backend into an arbitrary network client.

### Information Disclosure

The system stores prospecting data, contact details, exports, crawl logs, and coverage records. API responses, exports, logs, and AI-analysis endpoints MUST only expose data appropriate to the caller’s role, and secrets or sensitive crawl artifacts MUST never leak through error messages, logs, or client-visible diagnostics.

### Denial of Service

Crawls trigger outbound requests, AI extraction, image downloads, log growth, and scheduled jobs. Public auth endpoints and authenticated crawl-control endpoints MUST resist brute-force and resource-exhaustion abuse through bounded inputs, concurrency limits, and rate limiting where abuse would materially raise cost or degrade service.

### Elevation of Privilege

The biggest privilege boundary is between viewer and admin users, plus the boundary between ordinary data access and server-side crawl execution. Low-privilege users MUST NOT be able to invoke admin-equivalent controls, trigger arbitrary outbound fetches into private networks, or use route-level gaps to read, mutate, or delete resources beyond their intended capabilities.
