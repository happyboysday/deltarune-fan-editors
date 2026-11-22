/**
 * tests/engine/smoke.mjs — 手動煙霧測試（不屬於正式測試）
 * node tests/engine/smoke.mjs
 */
import { createBattle, normalizeAttack, validateAttack } from '../../engine/index.js';
import { readFileSync } from 'node:fs';

const url = new URL('../../samples/spade-rain.json', import.meta.url);
const attack = JSON.parse(readFileSync(url, 'utf8'));

const errs = validateAttack(attack);
console.log('validate errors:', errs.length, errs.slice(0, 5));

const b = createBattle({ canvas: null, assets: null, mode: 'preview' });
b.load(attack);
b.step(30);
let st = b.getState();
console.log('frame', st.frame, 'bullets', st.bullets.length, 'soul', st.soul.x, st.soul.y, 'tp', st.tp);
b.seek(300);
st = b.getState();
console.log('seek300 -> frame', st.frame, 'bullets', st.bullets.length);
const snapA = JSON.stringify(st);

const b2 = createBattle({ canvas: null, assets: null, mode: 'preview' });
b2.load(attack);
b2.seek(300);
const snapB = JSON.stringify(b2.getState());
console.log('deterministic seek:', snapA === snapB);

// step vs seek
const b3 = createBattle({ canvas: null, assets: null, mode: 'preview' });
b3.load(attack);
b3.step(300);
const snapC = JSON.stringify(b3.getState());
console.log('step300 == seek300:', snapC === snapA);
if (snapC !== snapA) {
  const a = JSON.parse(snapA);
  const c = JSON.parse(snapC);
  for (const k of Object.keys(a)) {
    if (JSON.stringify(a[k]) !== JSON.stringify(c[k])) {
      console.log('  diff key:', k, JSON.stringify(a[k]).slice(0, 200), '!=', JSON.stringify(c[k]).slice(0, 200));
    }
  }
}
console.log('getState keys:', Object.keys(st).join(','));
