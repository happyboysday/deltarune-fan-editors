/**
 * tests/engine/t-expr-v2.mjs — V2-03：拍點單位 + 子彈運算式新變數（SPEC-EXPR-V2）
 *
 * 涵蓋：
 *   - 拍點字串解析、"b" → 秒（時間點加 beatOffset、長度類不加）
 *   - 沒 bpm 卻用拍點字串 → 驗證錯誤（清楚路徑與訊息）
 *   - 原始 JSON 不改寫（存檔保留 "2b"）
 *   - 新變數 spawnX / spawnY / spawnT / i / n / k / bpm / beat / mem
 *   - mem 生成時只求值一次（age 在生成後變大也不影響）
 *   - 鏡像子彈：用 spawnX 追蹤靈魂，不需要 box.x - soul.x 繞路
 *   - 決定性：同 seed 同結果
 */
import { group, test, eq, ok, notOk, approx, deepEq } from './harness.mjs';
import {
  normalizeAttack,
  validateAttack,
  parseBeatString,
  timeToSeconds,
  beatTimingOf,
  deriveDuration,
  FPS,
} from '../../engine/attack.js';
import { createSimulation } from '../../engine/sim.js';
import { makeContext, evalNumber, createHelpers } from '../../engine/expr.js';
import { createRng } from '../../engine/rng.js';

/* ------------------------------------------------------------ 工具 */

function attack(over) {
  const base = {
    format: 'dr-battle-attack/1',
    settings: { duration: 5, seed: 1, ...(over && over.settings) },
    box: { x: 320, y: 171, w: 150, h: 150, rotation: 0, border: 5, color: '#00c000', ...(over && over.box) },
    soul: { x: null, y: null, speed: 4, slowSpeed: 2, mode: 'red', color: '#ff0000', ...(over && over.soul) },
    party: (over && over.party) || [{ name: 'Kris', hp: 90, maxHp: 90, color: '#00ffff' }],
    enemies: [],
    bulletTypes:
      (over && over.bulletTypes) || {
        dot: { sprite: null, hitbox: { shape: 'circle', r: 5 }, damage: null },
      },
    timeline: (over && over.timeline) || [],
  };
  if (over && over.demo !== undefined) base.demo = over.demo;
  return base;
}

function sim(json, mode = 'preview') {
  const s = createSimulation({ mode });
  s.load(json);
  return s;
}

/** 取子彈快照（依 id 排序） */
function bullets(s) {
  return s.getState().bullets.slice().sort((a, b) => a.id - b.id);
}

function snap(s) {
  const st = s.getState();
  return {
    frame: st.frame,
    tp: st.tp,
    soul: { x: st.soul.x, y: st.soul.y },
    box: { x: st.box.x, y: st.box.y, w: st.box.w, h: st.box.h },
    bullets: st.bullets
      .map((b) => ({ id: b.id, type: b.type, x: b.x, y: b.y, angle: b.angle, speed: b.speed, rotation: b.rotation }))
      .sort((a, b) => a.id - b.id),
  };
}

/** 驗證錯誤清單中是否有某個 path（回傳符合的錯誤） */
function errorsAt(errors, path) {
  return errors.filter((e) => e.path === path);
}

function helpers() {
  return createHelpers(createRng(7), () => ({ x: 300, y: 180 }));
}

/* ================================================================== */

group('V2-03 拍點：字串解析');

test('parseBeatString 只認 "數字b" 這種寫法', () => {
  eq(parseBeatString('2b'), 2, '"2b"');
  eq(parseBeatString('1.5b'), 1.5, '"1.5b"');
  eq(parseBeatString('-0.5b'), -0.5, '"-0.5b"（負數語法上可解析）');
  eq(parseBeatString('.5b'), 0.5, '".5b"');
  eq(parseBeatString(' 2b '), 2, '前後空白可容忍');
  eq(parseBeatString('2B'), 2, '大小寫不敏感');
  eq(parseBeatString('2'), null, '純數字不是拍點字串');
  eq(parseBeatString('2 b'), null, '"2 b" 不是拍點字串');
  eq(parseBeatString('b'), null, '"b" 不是拍點字串');
  eq(parseBeatString('beat*4'), null, '表達式不是拍點字串');
  eq(parseBeatString(2), null, '數字不是字串');
  eq(parseBeatString(null), null, 'null 不是字串');
});

test('timeToSeconds：時間點加 beatOffset、長度類不加', () => {
  const tm = { bpm: 120, beatOffset: 0.25 };
  const at = timeToSeconds('2b', { ...tm, addOffset: true });
  approx(at.value, 1.25, 1e-12, '"2b" @120bpm + offset 0.25 = 1.25 秒');
  eq(at.error, null, '合法');
  const len = timeToSeconds('2b', { ...tm, addOffset: false });
  approx(len.value, 1.0, 1e-12, '長度類不加 offset');
  const dur = timeToSeconds('0.5b', { ...tm, addOffset: false });
  approx(dur.value, 0.25, 1e-12, '"0.5b" = 0.25 秒');
  eq(timeToSeconds(3, tm).value, 3, '數字秒原樣');
  eq(timeToSeconds(null, tm).value, 0, 'null → 0');
});

test('timeToSeconds：沒有 bpm 時拍點字串回報清楚錯誤', () => {
  const r = timeToSeconds('2b', { bpm: null, beatOffset: 0 });
  ok(r.error, '應有錯誤');
  ok(/settings\.bpm/.test(r.error), `錯誤訊息應提到 settings.bpm（實際 ${r.error}）`);
  ok(/"2b"/.test(r.error), '錯誤訊息應引用原字串');
});

test('beatTimingOf：bpm 非正數視同未設定', () => {
  const a = beatTimingOf({ bpm: 120, beatOffset: 0.25 });
  eq(a.hasBpm, true, '有 bpm');
  approx(a.beatSec, 0.5, 1e-12, 'beat = 60/120');
  eq(beatTimingOf({ bpm: 0 }).hasBpm, false, 'bpm 0 → 未設定');
  eq(beatTimingOf({ bpm: -10 }).hasBpm, false, '負 bpm → 未設定');
  eq(beatTimingOf({}).beatOffset, 0, 'beatOffset 預設 0');
});

/* ================================================================== */

group('V2-03 拍點：normalizeAttack 轉成秒');

test('normalizeAttack：所有時間欄位換算成秒（at 加 offset、長度不加）', () => {
  const src = attack({
    settings: { duration: 10, bpm: 120, beatOffset: 0.25 },
    timeline: [
      { type: 'spawn', bullet: 'dot', at: '2b', life: '1.5b', count: 1 },
      { type: 'emitter', at: '1b', duration: '4b', interval: '0.25b', count: 1, spawn: { bullet: 'dot', at: 0 } },
      { type: 'box', at: '0b', duration: '1b', to: { w: 200 } },
      { type: 'clear', at: '0b', fade: '0.5b' },
      { type: 'shake', at: '0b', duration: '0.25b', amount: 2 },
    ],
  });
  const out = normalizeAttack(src);
  eq(out.settings.bpm, 120, 'settings.bpm 保留');
  eq(out.settings.beatOffset, 0.25, 'settings.beatOffset 保留');

  approx(out.timeline[0].at, 1.25, 1e-9, 'spawn at "2b" = 1 + 0.25');
  approx(out.timeline[0].life, 0.75, 1e-9, 'life "1.5b" = 0.75（不加 offset）');
  approx(out.timeline[1].at, 0.75, 1e-9, 'emitter at "1b" = 0.5 + 0.25');
  approx(out.timeline[1].duration, 2, 1e-9, 'emitter duration "4b" = 2');
  approx(out.timeline[1].interval, 0.125, 1e-9, 'emitter interval "0.25b" = 0.125');
  approx(out.timeline[2].duration, 0.5, 1e-9, 'box duration "1b" = 0.5');
  approx(out.timeline[3].fade, 0.25, 1e-9, 'clear fade "0.5b" = 0.25');
  approx(out.timeline[4].duration, 0.125, 1e-9, 'shake duration "0.25b" = 0.125');
});

test('normalizeAttack：settings.duration 可用拍點字串（長度類，不加 offset）', () => {
  const out = normalizeAttack(attack({ settings: { bpm: 60, beatOffset: 1, duration: '8b' } }));
  approx(out.settings.duration, 8, 1e-9, '8b @60bpm = 8 秒（不含 offset）');
});

test('normalizeAttack：負拍點 at 夾到 0、長度不夾（引擎另行驗證）', () => {
  const out = normalizeAttack(
    attack({ settings: { bpm: 120, beatOffset: 0 }, timeline: [{ type: 'spawn', bullet: 'dot', at: '-0.5b' }] }),
  );
  eq(out.timeline[0].at, 0, 'at 夾到 0');
  const neg = normalizeAttack(attack({ settings: { bpm: 120 }, timeline: [{ type: 'emitter', at: 0, duration: '-2b', interval: '1b' }] }));
  approx(neg.timeline[0].duration, 0, 1e-9, '負 duration 會被夾成 0（validateAttack 會報錯）');
});

test('normalizeAttack 不改寫原始 JSON（存檔保留 "2b"）', () => {
  const src = attack({
    settings: { bpm: 120, beatOffset: 0.5 },
    timeline: [{ type: 'spawn', bullet: 'dot', at: '2b', life: '1b' }],
    demo: { path: [{ t: '1b', x: 320, y: 171 }], fallback: 'bot' },
  });
  const before = JSON.stringify(src);
  normalizeAttack(src);
  eq(JSON.stringify(src), before, '輸入物件完全沒被改動');
  eq(src.timeline[0].at, '2b', 'timeline at 仍是字串');
  eq(src.timeline[0].life, '1b', 'life 仍是字串');
  eq(src.demo.path[0].t, '1b', 'demo t 仍是字串');
});

test('normalizeAttack：demo.path[].t 也接受拍點字串（時間點加 offset）', () => {
  const out = normalizeAttack(
    attack({
      settings: { bpm: 120, beatOffset: 0.1 },
      demo: { path: [{ t: '1b', x: 1, y: 2 }, { t: 0.5, x: 3, y: 4 }] },
    }),
  );
  approx(out.demo.path[0].t, 0.6, 1e-9, '"1b" = 0.5 + 0.1');
  eq(out.demo.path[1].t, 0.5, '數字 t 不變');
});

test('normalizeAttack：沒有 bpm 時拍點字串不會偷偷變成 0', () => {
  const out = normalizeAttack(attack({ settings: {}, timeline: [{ type: 'spawn', bullet: 'dot', at: '2b' }] }));
  eq(typeof out.timeline[0].at, 'number', 'at 仍是數字（避免引擎拿到字串）');
  // 轉不了就維持 0；validateAttack 會明確報錯，不會靜默播出錯的節奏
  eq(out.timeline[0].at, 0, '無 bpm → fallback 0');
});

test('deriveDuration 支援拍點字串', () => {
  const tm = beatTimingOf({ bpm: 120, beatOffset: 0.25 });
  approx(
    deriveDuration([{ type: 'emitter', at: '1b', duration: '2b' }], tm),
    0.75 + 1 + 0.5,
    1e-9,
    'emitter 結束時間 + 0.5 緩衝',
  );
  approx(deriveDuration([{ type: 'spawn', at: '2b' }], tm), 1.25 + 0.5, 1e-9, 'spawn 結束時間 + 0.5');
  eq(deriveDuration([]), 8, '空時間軸 → 預設 8 秒');
});

/* ================================================================== */

group('V2-03 拍點：validateAttack 錯誤');

test('沒 bpm 卻用拍點字串 → 錯誤帶清楚路徑與訊息', () => {
  const errs = validateAttack(
    attack({ settings: {}, timeline: [{ type: 'spawn', bullet: 'dot', at: '2b', y: 0 }] }),
  );
  const at = errorsAt(errs, 'timeline[0].at');
  eq(at.length, 1, `應有 timeline[0].at 錯誤（實際 ${JSON.stringify(errs.map((e) => e.path))}）`);
  ok(/settings\.bpm/.test(at[0].message), `訊息應提到 settings.bpm（實際 ${at[0].message}）`);
  ok(/"2b"/.test(at[0].message), '訊息應引用原字串');
});

test('沒 bpm 卻用拍點 life / emitter duration / demo t → 各自報錯', () => {
  const errs = validateAttack(
    attack({
      settings: {},
      timeline: [
        { type: 'spawn', bullet: 'dot', at: 0, life: '1b' },
        { type: 'emitter', at: 0, duration: '2b', interval: 0.25, count: 1, spawn: { bullet: 'dot' } },
      ],
      demo: { path: [{ t: '1b', x: 1, y: 2 }] },
    }),
  );
  ok(errorsAt(errs, 'timeline[0].life').length >= 1, 'life 錯誤');
  ok(errorsAt(errs, 'timeline[1].duration').length >= 1, 'emitter duration 錯誤');
  ok(errorsAt(errs, 'demo.path[0].t').length >= 1, 'demo t 錯誤');
  for (const e of errs) {
    if (/拍點/.test(e.message)) ok(/settings\.bpm/.test(e.message), `拍點錯誤都要提到 bpm（${e.path}）`);
  }
});

test('bpm 非正數 / beatOffset 非數字 → settings 錯誤', () => {
  const bad = validateAttack(attack({ settings: { bpm: 0 } }));
  ok(errorsAt(bad, 'settings.bpm').length === 1, 'bpm 0 應報錯');
  const neg = validateAttack(attack({ settings: { bpm: -60 } }));
  ok(errorsAt(neg, 'settings.bpm').length === 1, 'bpm 負數應報錯');
  const off = validateAttack(attack({ settings: { beatOffset: 'abc' } }));
  ok(errorsAt(off, 'settings.beatOffset').length === 1, 'beatOffset 非數字應報錯');
});

test('合法拍點檔（有 bpm）沒有時間相關錯誤', () => {
  const errs = validateAttack(
    attack({
      settings: { bpm: 120, beatOffset: 0.25, duration: '16b' },
      timeline: [
        { type: 'spawn', bullet: 'dot', at: '2b', life: '1.5b', count: 1 },
        { type: 'emitter', at: '1b', duration: '4b', interval: '0.5b', count: 2, spawn: { bullet: 'dot', at: 0 } },
        { type: 'box', at: '0b', duration: '1b', to: { w: 200 } },
        { type: 'shake', at: '0b', duration: '0.25b', amount: 1 },
      ],
    }),
  );
  const timeErrs = errs.filter((e) => /at|duration|interval|life|fade|bpm|beatOffset/.test(e.path));
  eq(timeErrs.length, 0, `不該有時間欄位錯誤（實際 ${JSON.stringify(timeErrs)}）`);
});

test('負拍點 at → "不可為負數" 錯誤', () => {
  const errs = validateAttack(
    attack({ settings: { bpm: 120 }, timeline: [{ type: 'spawn', bullet: 'dot', at: '-1b', y: 0 }] }),
  );
  const at = errorsAt(errs, 'timeline[0].at');
  eq(at.length, 1, '應有 at 錯誤');
  ok(/負數/.test(at[0].message), `訊息應提到負數（實際 ${at[0].message}）`);
});

test('不合法的時間字串（"abc"）→ 明確錯誤，不是靜默變成 0', () => {
  const errs = validateAttack(
    attack({ settings: { bpm: 120 }, timeline: [{ type: 'spawn', bullet: 'dot', at: 'abc', y: 0 }] }),
  );
  const at = errorsAt(errs, 'timeline[0].at');
  eq(at.length, 1, '應有 at 錯誤');
  ok(/秒數或拍點字串/.test(at[0].message), `訊息應說明可用秒數或拍點字串（實際 ${at[0].message}）`);
});

test('純數字字串仍是秒（向後相容舊檔），且不需要 bpm', () => {
  const json = attack({
    settings: {},
    timeline: [
      { type: 'spawn', bullet: 'dot', at: '1.5', y: 0 },
      { type: 'emitter', at: 0, duration: '2', interval: '0.5', count: 1, spawn: { bullet: 'dot' } },
    ],
  });
  const errs = validateAttack(json).filter((e) => /at|duration|interval/.test(e.path));
  eq(errs.length, 0, `數字字串不該報錯（實際 ${JSON.stringify(errs)}）`);
  const out = normalizeAttack(json);
  approx(out.timeline[0].at, 1.5, 1e-9, '"1.5" → 1.5 秒');
  approx(out.timeline[1].duration, 2, 1e-9, '"2" → 2 秒');
  approx(out.timeline[1].interval, 0.5, 1e-9, '"0.5" → 0.5 秒');
});

test('life 仍接受表達式字串（SPEC §5 向後相容）', () => {
  const json = attack({
    settings: { bpm: 120 },
    timeline: [
      { type: 'spawn', bullet: 'dot', at: 0, count: 3, x: 100, y: 100, speed: 0, life: 'beat*4' },
    ],
  });
  const errs = validateAttack(json);
  eq(errorsAt(errs, 'timeline[0].life').length, 0, `life 運算式不該報錯（實際 ${JSON.stringify(errs)}）`);
  const s = sim(json);
  s.advance(1, null);
  eq(bullets(s).length, 3, '3 發');
  // bpm 120 → beat 0.5s → life = 2 秒
  s.advance(30 * 1.9, null);
  eq(bullets(s).length, 3, '1.9 秒時還活著');
  s.advance(30 * 0.2, null);
  eq(bullets(s).length, 0, '超過 2 秒後消失');
});

test('beatOffset 只影響拍點字串的時間點（數字 at、長度類都不動）', () => {
  const out = normalizeAttack(
    attack({
      settings: { bpm: 60, beatOffset: 5 },
      timeline: [
        { type: 'spawn', bullet: 'dot', at: 0, life: '2b', x: 100, y: 100 },
        { type: 'spawn', bullet: 'dot', at: '1b', life: 2, x: 100, y: 100 },
        { type: 'emitter', at: '0b', duration: '2b', interval: '1b', count: 1, spawn: { bullet: 'dot' } },
      ],
    }),
  );
  approx(out.timeline[0].life, 2, 1e-9, 'life "2b" @60bpm = 2 秒（沒有 +5 的 offset）');
  approx(out.timeline[0].at, 0, 1e-9, '數字 at 是絕對秒數，不加 offset');
  approx(out.timeline[1].at, 6, 1e-9, '拍點 at "1b" = 1 + 5 秒');
  approx(out.timeline[2].at, 5, 1e-9, '拍點 at "0b" = 0 + 5 秒');
  approx(out.timeline[2].duration, 2, 1e-9, 'emitter duration "2b" 不加 offset');
  approx(out.timeline[2].interval, 1, 1e-9, 'emitter interval "1b" 不加 offset');
});

/* ================================================================== */

group('V2-03 拍點：引擎實際播放');

test('拍點驅動的 emitter 在正確的幀觸發（bpm 60 → 每 1 秒一發）', () => {
  const s = sim(
    attack({
      settings: { duration: 5, bpm: 60 },
      timeline: [
        {
          type: 'emitter',
          at: '1b',
          duration: '3b',
          interval: '1b',
          count: 1,
          spawn: { bullet: 'dot', at: 0, x: 100, y: 100, speed: 0 },
        },
      ],
    }),
  );
  // at=1s（第 30 幀）、interval 1s → 第 30、60、90 幀各一發（duration 3s 不含尾端）
  s.advance(29, null);
  eq(bullets(s).length, 0, '第 29 幀還沒有子彈');
  s.advance(1, null);
  eq(bullets(s).length, 1, '第 30 幀（1b）第一發');
  s.advance(30, null);
  eq(bullets(s).length, 2, '第 60 幀（2b）第二發');
  s.advance(30, null);
  eq(bullets(s).length, 3, '第 90 幀（3b）第三發');
});

test('拍點檔與等價秒數檔的模擬結果完全相同', () => {
  const beat = attack({
    settings: { duration: 3, seed: 5, bpm: 120, beatOffset: 0.2 },
    timeline: [
      { type: 'spawn', bullet: 'dot', at: '1b', life: '2b', count: 3, x: '100 + i*20', y: 120, angle: '90', speed: 1 },
    ],
  });
  const secs = attack({
    settings: { duration: 3, seed: 5 },
    timeline: [
      { type: 'spawn', bullet: 'dot', at: 0.7, life: 1, count: 3, x: '100 + i*20', y: 120, angle: '90', speed: 1 },
    ],
  });
  const a = sim(beat);
  const b = sim(secs);
  a.advance(60, null);
  b.advance(60, null);
  deepEq(snap(a), snap(b), '拍點與秒數描述同一個攻擊');
});

test('沒有 bpm 的既有攻擊行為不變（決定性與位置）', () => {
  const json = attack({
    timeline: [{ type: 'spawn', bullet: 'dot', at: 0.5, count: 2, x: 200, y: 100, angle: '45', speed: 2 }],
  });
  const a = sim(json);
  const b = sim(json);
  a.advance(40, null);
  b.advance(40, null);
  deepEq(snap(a), snap(b), '同輸入同結果');
  const bs = bullets(a);
  eq(bs.length, 2, '兩發都還在');
  for (const bullet of bs) {
    const moved = bullet.x - 200;
    approx(bullet.y - 100, moved, 1e-6, 'angle 45 → x、y 位移相等');
  }
  approx(bullets(a)[0].speed, 2, 1e-9, '速度不變');
});

/* ================================================================== */

group('V2-03 子彈運算式：新變數');

test('x / y 可用 spawnX / spawnY（生成時求值順序）', () => {
  const s = sim(
    attack({
      settings: { duration: 3 },
      timeline: [
        {
          type: 'spawn',
          bullet: 'dot',
          at: 0,
          count: 3,
          x: '100 + i*10',
          y: '200 + i*10',
          angle: 'spawnX',
          speed: 'spawnY/100',
        },
      ],
    }),
  );
  s.advance(1, null);
  const bs = bullets(s);
  eq(bs.length, 3, '三發');
  eq(bs[0].angle, 100, 'angle = spawnX（100）');
  eq(bs[1].angle, 110, 'angle = spawnX（110）');
  approx(bs[0].speed, 2, 1e-9, 'speed = spawnY/100 = 2');
  approx(bs[2].speed, 2.2, 1e-9, 'speed = spawnY/100 = 2.2');
});

test('spawnX / spawnY 在每幀 path 運算式也讀得到（生成時固定）', () => {
  const s = sim(
    attack({
      settings: { duration: 3 },
      timeline: [
        { type: 'spawn', bullet: 'dot', at: 0, count: 2, x: '100 + i*10', y: 150, pathX: 'spawnX', pathY: 'spawnY' },
      ],
    }),
  );
  s.advance(5, null);
  const bs = bullets(s);
  // applyPath：b.x = spawnX + pathX = 2 * spawnX
  approx(bs[0].x, 200, 1e-6, 'b.x = spawnX + pathX(100)');
  approx(bs[1].x, 220, 1e-6, 'b.x = spawnX + pathX(110)');
  approx(bs[0].y, 300, 1e-6, 'b.y = spawnY + pathY(150)');
});

test('spawnT 是生成當下的回合時間（秒）', () => {
  const s = sim(
    attack({
      settings: { duration: 4, bpm: 60 },
      timeline: [
        { type: 'spawn', bullet: 'dot', at: '2b', count: 1, x: 100, y: 100, angle: 'spawnT*90', speed: 'spawnT' },
      ],
    }),
  );
  s.advance(60, null);
  const b = bullets(s)[0];
  approx(b.angle, 180, 1e-9, '2 秒生成 → angle = spawnT*90 = 180');
  approx(b.speed, 2, 1e-9, 'speed = spawnT = 2');
});

test('i / n：本輪序號與本輪數量', () => {
  const s = sim(
    attack({
      settings: { duration: 3 },
      timeline: [{ type: 'spawn', bullet: 'dot', at: 0, count: 4, x: '100 + i*10', y: 200, angle: 'i*10', speed: 'n' }],
    }),
  );
  // at=0 的事件在載入時就處理，第 0 幀即可看到生成位置
  const bs = bullets(s);
  eq(bs.length, 4, '四發');
  for (let idx = 0; idx < 4; idx += 1) {
    approx(bs[idx].x, 100 + idx * 10, 1e-9, `第 ${idx} 發 x 用 i`);
    approx(bs[idx].angle, idx * 10, 1e-9, `第 ${idx} 發 angle 用 i`);
    approx(bs[idx].speed, 4, 1e-9, '每發 speed = n = 4');
  }
});

test('k：emitter 第幾輪（從 0 起）', () => {
  const s = sim(
    attack({
      settings: { duration: 3 },
      timeline: [
        {
          type: 'emitter',
          at: 0,
          duration: 1,
          interval: 0.5,
          count: 1,
          spawn: { bullet: 'dot', at: 0, x: 100, y: 100, angle: 'k*10', speed: 0 },
        },
      ],
    }),
  );
  s.advance(30, null);
  const bs = bullets(s);
  eq(bs.length, 2, '兩輪（0.0、0.5）');
  approx(bs[0].angle, 0, 1e-9, '第 0 輪 k=0');
  approx(bs[1].angle, 10, 1e-9, '第 1 輪 k=1');
});

test('bpm / beat 常數可用（沒設 bpm 時都是 0）', () => {
  const s = sim(
    attack({
      settings: { duration: 3, bpm: 120 },
      timeline: [{ type: 'spawn', bullet: 'dot', at: 0, count: 1, x: 100, y: 100, angle: 'beat*90', speed: 'bpm/60' }],
    }),
  );
  s.advance(1, null);
  approx(bullets(s)[0].angle, 45, 1e-9, 'beat = 60/120 = 0.5，angle = 45');
  approx(bullets(s)[0].speed, 2, 1e-9, 'bpm/60 = 2');

  const noBpm = sim(
    attack({
      settings: { duration: 3 },
      timeline: [{ type: 'spawn', bullet: 'dot', at: 0, count: 1, x: 100, y: 100, angle: 'beat + bpm', speed: 0 }],
    }),
  );
  noBpm.advance(1, null);
  approx(bullets(noBpm)[0].angle, 0, 1e-9, '沒 bpm 時 beat 與 bpm 皆為 0');
});

test('mem：memory 在生成時求值，命名變數可被 angle / speed / path 讀取', () => {
  const s = sim(
    attack({
      settings: { duration: 3 },
      timeline: [
        {
          type: 'spawn',
          bullet: 'dot',
          at: 0,
          count: 2,
          x: '100 + i*10',
          y: 200,
          memory: { base: '10 + i*5' },
          angle: 'mem.base',
          speed: 'mem.base/10',
        },
      ],
    }),
  );
  s.advance(1, null);
  const bs = bullets(s);
  approx(bs[0].angle, 10, 1e-9, '第 0 發 mem.base = 10');
  approx(bs[1].angle, 15, 1e-9, '第 1 發 mem.base = 15');
  approx(bs[0].speed, 1, 1e-9, 'speed 也可讀 mem');
});

test('mem 只求值一次：生成後 age 變大不會改寫記憶', () => {
  const s = sim(
    attack({
      settings: { duration: 3 },
      timeline: [
        {
          type: 'spawn',
          bullet: 'dot',
          at: 0,
          count: 1,
          x: 100,
          y: 100,
          speed: 0,
          memory: { a: 'age' },
          pathX: 'mem.a',
        },
      ],
    }),
  );
  s.advance(20, null);
  const b = bullets(s)[0];
  approx(b.x, 100, 1e-9, 'mem.a 固定為生成時 age=0 的 0，b.x = spawnX + 0');
  // 若每幀重算 memory，mem.a 會等於 age，b.x 會一路增加
  s.advance(10, null);
  approx(bullets(s)[0].x, 100, 1e-9, '30 幀後仍是 100');
});

test('mem 可引用同一 memory 中先算出的名字', () => {
  const s = sim(
    attack({
      settings: { duration: 3 },
      timeline: [
        {
          type: 'spawn',
          bullet: 'dot',
          at: 0,
          count: 1,
          x: 100,
          y: 100,
          memory: { a: '3', b: 'mem.a*4' },
          speed: 'mem.b',
        },
      ],
    }),
  );
  s.advance(1, null);
  approx(bullets(s)[0].speed, 12, 1e-9, 'mem.b = mem.a*4');
});

test('emitter spawn 的 memory 每發獨立求值（i 不同 → 值不同）', () => {
  const s = sim(
    attack({
      settings: { duration: 2 },
      timeline: [
        {
          type: 'emitter',
          at: 0,
          duration: 0.5,
          interval: 0.5,
          count: 2,
          spawn: { bullet: 'dot', at: 0, x: 100, y: 100, memory: { seed: 'k*10 + i' }, angle: 'mem.seed' },
        },
      ],
    }),
  );
  s.advance(2, null);
  const bs = bullets(s);
  eq(bs.length, 2, '兩發');
  approx(bs[0].angle, 0, 1e-9, 'k=0, i=0 → 0');
  approx(bs[1].angle, 1, 1e-9, 'k=0, i=1 → 1');
});

test('expr.makeContext / evalNumber 直接支援新變數', () => {
  const c = makeContext({
    t: 1,
    spawnX: 111,
    spawnY: 222,
    spawnT: 1.5,
    bpm: 120,
    beat: 0.5,
  });
  eq(evalNumber('spawnX', c, helpers()).value, 111, 'spawnX');
  eq(evalNumber('spawnY', c, helpers()).value, 222, 'spawnY');
  eq(evalNumber('spawnT', c, helpers()).value, 1.5, 'spawnT');
  eq(evalNumber('bpm', c, helpers()).value, 120, 'bpm');
  eq(evalNumber('beat', c, helpers()).value, 0.5, 'beat');
  eq(evalNumber('mem.anything', c, helpers()).value, 0, '沒有 memory 時 mem.* 一律 0');
  eq(evalNumber('beat*4', c, helpers()).value, 2, 'beat*4 可用');
});

/* ================================================================== */

group('V2-03 memory 驗證');

test('memory 非法名稱 → 錯誤（原型鏈名稱不可用）', () => {
  const bad = validateAttack(
    attack({
      timeline: [{ type: 'spawn', bullet: 'dot', at: 0, memory: { constructor: '1' } }],
    }),
  );
  const errs = errorsAt(bad, 'timeline[0].memory');
  eq(errs.length, 1, `應有 memory 錯誤（實際 ${JSON.stringify(bad.map((e) => e.path))}）`);
  ok(/constructor/.test(errs[0].message), '訊息應指出名稱');
});

test('memory 必須是物件、值必須是數字或合法表達式', () => {
  const notObj = validateAttack(attack({ timeline: [{ type: 'spawn', bullet: 'dot', at: 0, memory: 'x' }] }));
  eq(errorsAt(notObj, 'timeline[0].memory').length, 1, 'memory 非物件要報錯');

  const badExpr = validateAttack(
    attack({ timeline: [{ type: 'spawn', bullet: 'dot', at: 0, memory: { a: 'window.alert(1)' } }] }),
  );
  ok(errorsAt(badExpr, 'timeline[0].memory.a').length >= 1, '非法表達式要報錯');
});

test('normalizeAttack 清掉非法 memory 名稱（不讓原型鏈名稱進引擎）', () => {
  const out = normalizeAttack(
    attack({ timeline: [{ type: 'spawn', bullet: 'dot', at: 0, memory: { good: '1', __proto__: '2' } }] }),
  );
  const mem = out.timeline[0].memory;
  eq(Object.keys(mem).join(','), 'good', '只留下合法名稱');
  ok(!Object.prototype.hasOwnProperty.call(mem, '__proto__'), '__proto__ 不在了');
});

/* ================================================================== */

group('V2-03 鏡像子彈（用 spawnX 取代 box.x - soul.x 繞路）');

test('鏡像彈：以生成點與靈魂位置鏡射，不需要 box.x - soul.x', () => {
  const BOX_X = 320;
  const SOUL_X = 380;
  const s = sim(
    attack({
      settings: { duration: 3 },
      box: { x: BOX_X },
      soul: { x: SOUL_X },
      timeline: [
        {
          type: 'spawn',
          bullet: 'dot',
          at: 0,
          count: 1,
          x: 260,
          // 刻意遠離靈魂的 y，避免子彈撞到靈魂被 destroyOnHit 吃掉
          y: 50,
          speed: 0,
          // 舊寫法要繞：pathX: "(box.x - soul.x)*... + (x - box.x)" 之類
          // 新寫法：spawnX 就是這發的生成點，直接對靈魂鏡射
          pathX: '(soul.x - spawnX) * age',
        },
      ],
    }),
  );
  approx(bullets(s)[0].x, 260, 1e-9, '生成當下在原點');
  s.advance(30, null);
  approx(bullets(s)[0].x, 380, 1e-6, '1 秒後抵達靈魂的鏡射位置');
});

test('鏡像彈：兩發對稱子彈用 spawnX 各自鏡射', () => {
  const s = sim(
    attack({
      settings: { duration: 3 },
      box: { x: 320 },
      soul: { x: 320 },
      timeline: [
        {
          type: 'spawn',
          bullet: 'dot',
          at: 0,
          count: 2,
          x: '260 + i*120',
          y: 50,
          speed: 0,
          pathX: '(soul.x - spawnX) * age',
        },
      ],
    }),
  );
  s.advance(30, null);
  const bs = bullets(s);
  approx(bs[0].x, 320, 1e-6, '左邊那發鏡射到中心');
  approx(bs[1].x, 320, 1e-6, '右邊那發也鏡射到中心');
});

/* ================================================================== */

group('V2-03 決定性');

test('同 seed + 拍點運算式 → 同結果（含隨機函式）', () => {
  const json = attack({
    settings: { duration: 4, seed: 42, bpm: 150 },
    timeline: [
      {
        type: 'emitter',
        at: '0b',
        duration: '4b',
        interval: '0.5b',
        count: 3,
        spawn: {
          bullet: 'dot',
          at: 0,
          // 用運算式（而非 box.left/box.w）避免依賴讀寫順序
          x: '100 + rand()*100',
          y: '100 + rand()*20',
          angle: 'rand()*360',
          speed: '1 + rand()',
          memory: { spin: 'rand()*10 - 5' },
          angularVel: 'mem.spin',
          life: '1b',
        },
      },
    ],
  });
  const a = sim(json);
  const b = sim(json);
  // 逐段比對（子彈有 life，跑完整回合會全部消失，中途就要比）
  let sawBullet = false;
  for (let i = 0; i < 9; i += 1) {
    a.advance(10, null);
    b.advance(10, null);
    deepEq(snap(a), snap(b), `第 ${(i + 1) * 10} 幀狀態一致`);
    if (bullets(a).length > 0) sawBullet = true;
  }
  ok(sawBullet, '確實有子彈');
});

test('seek 與 step 在拍點檔上結果一致', () => {
  const json = attack({
    settings: { duration: 4, seed: 3, bpm: 90 },
    timeline: [
      { type: 'spawn', bullet: 'dot', at: '1b', count: 3, x: '100 + i*10', y: 100, angle: '90', speed: 1, life: '2b' },
    ],
  });
  const stepped = sim(json);
  stepped.advance(45, null);
  const sought = sim(json);
  sought.seekTo(45);
  deepEq(snap(stepped), snap(sought), 'seek(45) == step 45 次');
});

/* ================================================================== */

group('V2-03 表達式沙箱（新變數不破防線）');

test('mem 不可用來存取原型鏈', async () => {
  const { validateExprSyntax } = await import('../../engine/expr.js');
  ok(validateExprSyntax('mem.constructor') !== null, 'mem.constructor 應被拒');
  ok(validateExprSyntax('mem.__proto__') !== null, 'mem.__proto__ 應被拒');
  eq(validateExprSyntax('mem.angle0'), null, 'mem.正常名稱 合法');
  eq(validateExprSyntax('spawnX + spawnY'), null, 'spawnX/spawnY 合法');
  eq(validateExprSyntax('spawnT*10 + bpm + beat'), null, 'spawnT/bpm/beat 合法');
});
