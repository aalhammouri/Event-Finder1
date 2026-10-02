const assert = require('assert');
const { normalizeStreet: n, addressMatchKey: k, normalizeEin: e } = require('./matchkey.js');

const same = [
  ['2902 Jensen Dr', '2902 Jensen Drive'],
  ['2520 W.W. Thorne Blvd.', '2520 WW Thorne Boulevard'],
  ['802 Dominion Drive, Suite 100-300', '802 Dominion Dr'],
  ['3555 Timmons Ln, Ste 800', '3555 Timmons Lane'],
  ['13121 Louetta Road #1360', '13121 Louetta Rd'],
  ['7055 Old Katy Rd #14', '7055 Old Katy Road # 14'],
  ['1416 Stonehollow Drive, Ste C', '1416 Stonehollow Dr.'],
  ['P.O. Box 2738', 'PO Box 2738'],
  ['Post Office Box 19808', 'P. O. Box 19808'],
  ['14811 St. Mary\'s Lane, Suite 265', '14811 Saint Marys Ln'],
  ['927 3rd Street', '927 Third St'],
  ['4307 FM 517 Rd E', '4307 FM-517 Road East'],
  ['4307 FM 517 Rd E', '4307 Farm to Market 517 Rd E'],
  ['9800 Richmond Ave, Suite 335', '9800 Richmond Avenue'],
  ['100 Main St Apt 4B', '100 Main Street'],
];
for (const [a, b] of same) assert.strictEqual(n(a), n(b), `${a}  vs  ${b}: ${n(a)} != ${n(b)}`);

const diff = [
  ['2902 Jensen Dr', '2904 Jensen Dr'],
  ['100 Main St', '100 Main Ave'],
  ['PO Box 2738', 'PO Box 2739'],
  ['4500 Memorial Dr', '4500 Memorial Dr N'],
];
for (const [a, b] of diff) assert.notStrictEqual(n(a), n(b), `${a} should differ from ${b}`);

assert.strictEqual(k('1905 Holcombe Blvd.', 'Houston', '77030'), '1905 HOLCOMBE BLVD|77030');
assert.strictEqual(k('P.O. Box 2738', 'Humble', '77347-2738'), 'PO BOX 2738|77347');
assert.strictEqual(k('100 Main St', 'Katy', ''), '100 MAIN ST|KATY');
assert.notStrictEqual(k('100 Main St', 'Katy', '77450'), k('100 Main St', 'Houston', '77002'));
assert.strictEqual(k('', 'Houston', '77002'), '');

assert.strictEqual(e('45-2346150'), '452346150');
assert.strictEqual(e('6-1807573'), '061807573');
assert.strictEqual(e(null), '');
assert.strictEqual(e('1234567890'), '');
console.log(`ok: ${same.length} same, ${diff.length} different, keys and EIN pass`);
