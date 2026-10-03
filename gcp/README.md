# GCP charity events: Dynamics helpers

- `address-match/matchkey.js` builds the Merge-gate dedupe key for a charity:
  normalised street (uppercase, no punctuation, suite/unit dropped, USPS abbreviations,
  PO Box unified) plus ZIP5, or city when there is no ZIP. Also normalises EIN to 9 digits.
  Match order at merge: EIN first, then address key.
  Run the tests with `node gcp/address-match/matchkey.test.js`.
- `package-desk/gcp-package-desk.html` is a preview of the GCP event lead view, using the
  25 pilot leads read from the sandbox (orgcad402f2) on 2026-10-02. Buttons only change the
  preview; nothing is written to Dynamics.
- `package-desk/dynamics/` is the live Dynamics web resource version. `live.js` reads and writes
  GCP leads through the Dataverse Web API (each write confirmed on the page, then re-read).
  `build.py` assembles `index.html` from `desk.src.html` (styles, Goff design-system tokens),
  `live.js` and `address-match/matchkey.js`; `mocktest.js` runs it in Chromium against a mocked API.
