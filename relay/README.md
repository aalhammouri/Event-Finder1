# GCP Package Desk postage relay

A 100-line Node service that holds the EasyPost API key so the Desk (a browser page inside Dynamics) never sees it.

## Routes (all JSON; header `X-Relay-Token`)
| Route | Purpose |
|---|---|
| `GET /health` | Liveness, says whether the key is configured |
| `POST /rates` | `{to, from, parcel:{length,width,height,weight}, ref}` → shipment id and rates |
| `POST /buy` | `{shipmentId, rateId}` → tracking code, label URL, cost |
| `GET /track/:code?carrier=` | Tracking status, delivered flag |
| `POST /verify` | `{street1, city, state, zip}` → deliverable + standardised address |

## Run
```
EASYPOST_API_KEY=EZAK... RELAY_TOKEN=some-long-secret ALLOW_ORIGIN=https://orgcad402f2.crm.dynamics.com node relay/server.js
```
Needs Node 18+ (built-in fetch). No dependencies.

Host it anywhere that keeps secrets out of the browser: Azure App Service / Container App, a small VM, or Render. Then open the Desk, press the gear (top right), enter the relay URL and token, and "Save for everyone" so the whole team gets it.

Use the EasyPost **test** key first: rates and labels are free and the labels say SAMPLE.
