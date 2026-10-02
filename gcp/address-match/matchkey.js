// GCP address match key. Same input on both sides (lead and account) -> same key.
const WORDS = {
  STREET: 'ST', STR: 'ST', ROAD: 'RD', DRIVE: 'DR', DRV: 'DR', AVENUE: 'AVE', AV: 'AVE', AVN: 'AVE',
  BOULEVARD: 'BLVD', BOUL: 'BLVD', PARKWAY: 'PKWY', PKY: 'PKWY', PARKWY: 'PKWY', LANE: 'LN',
  COURT: 'CT', CIRCLE: 'CIR', PLACE: 'PL', HIGHWAY: 'HWY', HIWAY: 'HWY', FREEWAY: 'FWY',
  EXPRESSWAY: 'EXPY', TRAIL: 'TRL', SQUARE: 'SQ', TERRACE: 'TER', PLAZA: 'PLZ', CROSSING: 'XING',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
  SAINT: 'ST', MOUNT: 'MT', FORT: 'FT',
  FIRST: '1ST', SECOND: '2ND', THIRD: '3RD', FOURTH: '4TH', FIFTH: '5TH',
  SIXTH: '6TH', SEVENTH: '7TH', EIGHTH: '8TH', NINTH: '9TH', TENTH: '10TH',
};
const UNIT = '(?:SUITE|STE|UNIT|APT|APARTMENT|BLDG|BUILDING|FLOOR|FL|ROOM|RM|SPACE|SPC)';

function normalizeStreet(line) {
  if (!line) return '';
  let s = String(line).toUpperCase();
  s = s.replace(/[’']/g, '');                                   // St. Mary's -> ST MARYS
  s = s.replace(/\bP\s*\.?\s*O\s*\.?\s*BOX\b|\bPOST\s+OFFICE\s+BOX\b/g, 'PO BOX');
  s = s.replace(/\bFARM\s+TO\s+MARKET\b/g, 'FM');
  s = s.replace(/\./g, '');                                           // W.W. -> WW, Blvd. -> BLVD
  // Drop the unit and its identifier: "Suite 100-300", "Ste C", "#1360", "# 14"
  s = s.replace(new RegExp(`,?\\s*(?:#|\\b${UNIT}\\b)\\s*[A-Z0-9-]*`, 'g'), ' ');
  s = s.replace(/[^A-Z0-9 ]+/g, ' ');                                // commas, hyphens, etc.
  const tokens = s.split(/\s+/).filter(Boolean).map(t => WORDS[t] || t);
  return tokens.join(' ');
}

function zip5(zip) {
  const m = String(zip || '').match(/\d{5}/);
  return m ? m[0] : '';
}

// Key = normalised street + ZIP5. Falls back to city when there is no ZIP.
function addressMatchKey(line, city, zip) {
  const street = normalizeStreet(line);
  if (!street) return '';
  const z = zip5(zip);
  const place = z || String(city || '').toUpperCase().replace(/[^A-Z ]/g, '').trim();
  return place ? `${street}|${place}` : '';
}

// EIN: digits only, zero-padded to 9 (same form as the IRS EO extract). Empty if not plausible.
function normalizeEin(ein) {
  const d = String(ein || '').replace(/\D/g, '');
  if (!d || d.length > 9) return '';
  return d.padStart(9, '0');
}

if (typeof module !== 'undefined') module.exports = { normalizeStreet, addressMatchKey, normalizeEin, zip5 };
