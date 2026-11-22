/**
 * tests/engine/t-attack.mjs — normalizeAttack / validateAttack 測試（SPEC §3–§5）
 */
import { group, test, eq, ok, notOk, isArray, isObj, hasKey, deepNotEq } from './harness.mjs';
import {
  normalizeAttack,
  validateAttack,
  attackHints,
  deriveDuration,
  SPAWN_FIELDS,
  EVENT_TYPES,
} from '../../engine/attack.js';

/** 最小可用攻擊 */
function minimal(over) {
  return {
    format: 'dr-battle-attack/1',
    settings: { duration: 2, seed: 1 },
    box: { x: 320, y: 171, w: 100, h: 100 },
    soul: { x: null, y: null },
    party: [{ name: 'Kris', hp: 90, maxHp: 90, color: '#00ffff' }],
    bulletTypes: { dot: { hitbox: { shape: 'circle', r: 4 } } },
    timeline: [],
    ...(over || {}),
  };
}

group('normalizeAttack：預設值與型別修正');

test('空物件也能補成完整攻擊（不丟例外）', () => {
  const a = normalizeAttack({});
  eq(a.format, 'dr-battle-attack/1', 'format 會被補上');
  ok(Number.isFinite(a.settings.duration) && a.settings.duration > 0, 'duration 補成正數');
  ok(Number.isFinite(a.settings.seed), 'seed 補成數字');
  // SPEC-LAYOUT §5：中心 (320,190)、內部 144×158、綠描邊 3px
  eq(a.box.x, 320, 'box.x 預設 320');
  eq(a.box.y, 190, 'box.y 預設 190（SPEC-LAYOUT §5）');
  eq(a.box.w, 144, 'box.w 預設 144');
  eq(a.box.h, 158, 'box.h 預設 158');
  eq(a.box.border, 3, 'box.border 預設 3（SPEC-LAYOUT §5）');
  eq(a.box.color, '#00c000', 'box.color 預設綠色');
  eq(a.soul.mode, 'red', 'soul.mode 預設 red');
  eq(a.soul.speed, 4, 'soul.speed 預設 4');
  eq(a.soul.slowSpeed, 2, 'soul.slowSpeed 預設 2');
  eq(a.party.length, 1, '沒有 party 時補一位隊員');
  equalsState(a.party[0].hp, a.party[0].maxHp, '預設隊員 HP 滿血');
  isArray(a.enemies, 'enemies 補成空陣列');
  isObj(a.bulletTypes, 'bulletTypes 補成物件');
  isArray(a.timeline, 'timeline 補成空陣列');
});

test('非物件輸入（null / 字串 / 數字）不會丟例外', () => {
  for (const bad of [null, undefined, 'x', 42, true, []]) {
    const a = normalizeAttack(bad);
    ok(a && typeof a === 'object', `輸入 ${String(bad)} 也回傳物件`);
    ok(a.settings.duration > 0, `輸入 ${String(bad)} 的 duration 有效`);
  }
});

test('不合法型別會被換成安全預設值', () => {
  const a = normalizeAttack(
    minimal({
      settings: { duration: 'abc', seed: {}, damage: 'x', invincibleFrames: -5, grazeTP: null, background: 7 },
      box: { x: 'x', y: NaN, w: 0, h: -3, rotation: 'nope', border: -2, color: 'red' },
      soul: { speed: -1, slowSpeed: 'a', mode: 5, color: 'nope' },
    }),
  );
  ok(a.settings.duration > 0, 'duration 非法 → 由時間軸推算或預設');
  eq(a.settings.seed, 1, 'seed 非法 → 1');
  eq(a.box.rotation, 0, 'box.rotation 非法 → 0');
  eq(a.box.color, '#00c000', '非法顏色 → 預設');
  ok(a.box.w >= 1 && a.box.h >= 1, 'box 寬高至少 1');
  eq(a.box.border, 0, '負數 border 夾成 0');
  eq(a.soul.speed, 0, '負速度夾成 0');
  eq(a.soul.slowSpeed, 0, '非法 slowSpeed 夾成 0');
  eq(a.soul.mode, 'red', '未知模式回退 red');
  eq(a.settings.invincibleFrames, 0, '負無敵幀夾成 0');
});

test('normalizeAttack 回傳新物件（不與輸入共用參考）', () => {
  const src = minimal();
  const a = normalizeAttack(src);
  deepNotEq(a.box, src.box, 'box 應為複本');
  ok(a.box !== src.box, 'box 不是同一個物件');
  ok(a.timeline !== src.timeline, 'timeline 不是同一個陣列');
  a.box.w = 999;
  eq(src.box.w, 100, '修改結果不影響輸入');
});

test('原始欄位會保留（編輯器存檔不得掉資料）', () => {
  const a = normalizeAttack(
    minimal({
      meta: { name: '測試', author: 'me', extra: { a: 1 } },
      customTop: '保留我',
      timeline: [
        { id: 'e1', at: 0.5, type: 'shake', duration: 0.2, amount: 3, myNote: '備註' },
      ],
    }),
  );
  eq(a.meta.name, '測試', 'meta.name 保留');
  eq(a.meta.extra.a, 1, 'meta 的未知欄位保留');
  eq(a.customTop, '保留我', '頂層未知欄位保留');
  eq(a.timeline[0].myNote, '備註', '事件未知欄位保留');
});

test('缺少 id 的事件會依序補上 ev_N', () => {
  const a = normalizeAttack(
    minimal({
      timeline: [
        { at: 0, type: 'shake' },
        { at: 1, type: 'shake' },
        { id: 'keep', at: 2, type: 'shake' },
      ],
    }),
  );
  eq(a.timeline[0].id, 'ev_0', '第 0 個事件補 ev_0');
  eq(a.timeline[1].id, 'ev_1', '第 1 個事件補 ev_1');
  eq(a.timeline[2].id, 'keep', '既有 id 不動');
});

test('spawn 事件會補齊 §5 全部生成欄位', () => {
  const a = normalizeAttack(
    minimal({ timeline: [{ id: 's', at: 0, type: 'spawn', bullet: 'dot', count: 3 }] }),
  );
  const ev = a.timeline[0];
  eq(ev.count, 3, 'count 保留');
  for (const key of SPAWN_FIELDS) {
    hasKey(ev, key, 'spawn 事件缺少生成欄位');
  }
  eq(ev.scale, 1, 'scale 預設 1');
  eq(ev.alpha, 1, 'alpha 預設 1');
  eq(ev.life, null, 'life 預設 null');
  eq(ev.pathX, null, 'pathX 預設 null');
});

test('count 為 0 / 負數 / 小數時修正為 >= 1 的整數', () => {
  const mk = (count) =>
    normalizeAttack(
      minimal({ timeline: [{ id: 's', at: 0, type: 'spawn', bullet: 'dot', count }] }),
    ).timeline[0].count;
  eq(mk(0), 1, 'count=0 → 1');
  eq(mk(-8), 1, 'count=-8 → 1');
  eq(mk(2.7), 2, 'count=2.7 → 2（截斷）');
});

test('emitter 會補 duration / interval / count / spawn', () => {
  const a = normalizeAttack(
    minimal({ timeline: [{ id: 'em', at: 0, type: 'emitter', duration: 1, interval: 0.2, count: 2 }] }),
  );
  const ev = a.timeline[0];
  eq(ev.duration, 1, 'duration 保留');
  eq(ev.interval, 0.2, 'interval 保留');
  eq(ev.count, 2, 'count 保留');
  isObj(ev.spawn, 'spawn 補成物件');
  eq(ev.spawn.bullet, '', 'spawn.bullet 預設空字串');
  eq(ev.spawn.scale, 1, 'spawn 生成欄位預設齊全');
});

test('emitter interval 為 0 時夾成 1 幀，避免無限迴圈', () => {
  const a = normalizeAttack(
    minimal({ timeline: [{ id: 'em', at: 0, type: 'emitter', duration: 1, interval: 0, count: 1 }] }),
  );
  ok(a.timeline[0].interval >= 1 / 30 - 1e-9, 'interval 至少一個模擬幀');
});

test('box 事件只保留數字的 to 欄位', () => {
  const a = normalizeAttack(
    minimal({
      timeline: [{ id: 'b', at: 0, type: 'box', duration: 1, ease: 'quadOut', to: { w: 200, x: 'abc', y: null } }],
    }),
  );
  const to = a.timeline[0].to;
  eq(to.w, 200, 'to.w 保留');
  eq(to.x, undefined, 'to.x 非數字 → 移除');
  eq(to.y, undefined, 'to.y 為 null → 移除');
  eq(a.timeline[0].ease, 'quadOut', 'ease 保留');
  eq(a.timeline[0].duration, 1, 'duration 保留');
});

test('bulletTypes 的 hitbox 正規化為 circle 或 rect', () => {
  const a = normalizeAttack(
    minimal({
      bulletTypes: {
        c: { hitbox: { shape: 'circle', r: 9 } },
        r: { hitbox: { shape: 'rect', w: 20, h: 4 } },
        weird: { hitbox: { shape: 'triangle', r: 3 } },
        broken: { hitbox: 'x' },
      },
    }),
  );
  eq(a.bulletTypes.c.hitbox.shape, 'circle', 'circle 保留');
  eq(a.bulletTypes.c.hitbox.r, 9, 'circle 半徑保留');
  eq(a.bulletTypes.r.hitbox.shape, 'rect', 'rect 保留');
  eq(a.bulletTypes.r.hitbox.w, 20, 'rect 寬保留');
  eq(a.bulletTypes.weird.hitbox.shape, 'circle', '未知 shape → circle');
  eq(a.bulletTypes.broken.hitbox.shape, 'circle', 'hitbox 非物件 → circle 預設');
  eq(a.bulletTypes.c.grazeable, true, 'grazeable 預設 true');
  eq(a.bulletTypes.c.destroyOnHit, true, 'destroyOnHit 預設 true');
  eq(a.bulletTypes.c.offscreen, 'destroy', 'offscreen 預設 destroy');
  eq(a.bulletTypes.c.maskToBox, false, 'maskToBox 預設 false');
  eq(a.bulletTypes.c.damage, null, 'damage 預設 null');
});

test('soul.x / soul.y 為 null 時保留 null（代表框中心）', () => {
  const a = normalizeAttack(minimal({ soul: { x: null, y: null } }));
  eq(a.soul.x, null, 'x 為 null');
  eq(a.soul.y, null, 'y 為 null');
  const b = normalizeAttack(minimal({ soul: { x: 100 } }));
  eq(b.soul.x, 100, '給了 x 就保留');
  eq(b.soul.y, null, '沒給 y 仍為 null');
});

test('settings.duration 缺漏時由時間軸推算', () => {
  eq(deriveDuration([{ type: 'emitter', at: 1, duration: 2 }]), 3.5, 'emitter 結束時間 + 0.5');
  eq(deriveDuration([{ type: 'spawn', at: 4, count: 1 }]), 4.5, '只有 spawn 時取 at + 0.5');
  eq(deriveDuration([]), 8, '空時間軸 → 8 秒');
  eq(deriveDuration(undefined), 8, 'undefined → 8 秒');
  const a = normalizeAttack({ format: 'dr-battle-attack/1', timeline: [{ id: 'e', at: 2, type: 'spawn', bullet: 'b' }] });
  eq(a.settings.duration, 2.5, 'normalizeAttack 會套用推算值');
});

test('事件類型清單與 SPEC §4 一致', () => {
  eq(EVENT_TYPES.join(','), 'spawn,emitter,box,soul,soulProfile,soulAppearance,soulTeleport,soulDrift,clear,shake,sfx,anim,end', '事件類型');
});

/* ------------------------------------------------------------------ */

group('validateAttack：錯誤回報（SPEC §6）');

test('正常攻擊回傳空陣列', () => {
  eq(validateAttack(minimal()).length, 0, '最小合法攻擊沒有錯誤');
  eq(validateAttack(normalizeAttack(minimal())).length, 0, '正規化後仍無錯誤');
});

test('非物件輸入回傳 $ 錯誤而非丟例外', () => {
  for (const bad of [null, undefined, 'x', 5, []]) {
    const errs = validateAttack(bad);
    isArray(errs, '回傳陣列');
    ok(errs.length >= 1, `${String(bad)} 應有錯誤`);
    eq(errs[0].path, '$', 'path 為 $');
    ok(typeof errs[0].message === 'string' && errs[0].message, 'message 非空');
  }
});

test('每個錯誤都有 path 與 message 字串', () => {
  const errs = validateAttack({
    format: 'wrong/1',
    settings: { duration: -1, seed: 'x' },
    box: { w: 0, h: 0, color: 'garbage' },
    party: [],
    timeline: [{ id: 'a', at: 0, type: 'nope' }],
  });
  ok(errs.length >= 5, `應抓到多個錯誤（實際 ${errs.length}）`);
  for (const e of errs) {
    ok(e && typeof e === 'object', '錯誤項目是物件');
    ok(typeof e.path === 'string' && e.path.length > 0, 'path 非空字串');
    ok(typeof e.message === 'string' && e.message.length > 0, 'message 非空字串');
  }
});

test('format 錯誤會回報', () => {
  const errs = validateAttack(minimal({ format: 'dr-battle-attack/2' }));
  ok(errs.some((e) => e.path === 'format'), '應有 format 錯誤');
});

test('settings 數值域錯誤會回報', () => {
  const errs = validateAttack(minimal({ settings: { duration: 0, seed: 'a', damage: -1, invincibleFrames: -1, grazeTP: -2 } }));
  const paths = errs.map((e) => e.path);
  ok(paths.includes('settings.duration'), 'duration');
  ok(paths.includes('settings.seed'), 'seed');
  ok(paths.includes('settings.damage'), 'damage');
  ok(paths.includes('settings.invincibleFrames'), 'invincibleFrames');
  ok(paths.includes('settings.grazeTP'), 'grazeTP');
});

test('box 尺寸 / 顏色錯誤會回報', () => {
  const errs = validateAttack(minimal({ box: { w: 0, h: -1, color: '#xyz' } }));
  const paths = errs.map((e) => e.path);
  ok(paths.includes('box.w'), 'box.w');
  ok(paths.includes('box.h'), 'box.h');
  ok(paths.includes('box.color'), 'box.color');
});

test('party 空陣列 / hp 超過 maxHp 會回報', () => {
  const empty = validateAttack(minimal({ party: [] }));
  ok(empty.some((e) => e.path === 'party'), '空 party 回報');
  const over = validateAttack(minimal({ party: [{ name: 'K', hp: 200, maxHp: 90 }] }));
  ok(over.some((e) => e.path === 'party[0].hp'), 'hp > maxHp 回報');
  const noName = validateAttack(minimal({ party: [{ hp: 10, maxHp: 10 }] }));
  ok(noName.some((e) => e.path === 'party[0].name'), '缺名字回報');
});

test('timeline 非陣列 / 事件缺 type / 未知 type 會回報', () => {
  ok(validateAttack(minimal({ timeline: {} })).some((e) => e.path === 'timeline'), 'timeline 非陣列');
  const noType = validateAttack(minimal({ timeline: [{ id: 'a', at: 0 }] }));
  ok(noType.some((e) => e.path === 'timeline[0].type'), '缺 type');
  const badType = validateAttack(minimal({ timeline: [{ id: 'a', at: 0, type: 'teleport' }] }));
  ok(badType.some((e) => e.path === 'timeline[0].type'), '未知 type');
});

test('at 為負數或非數字會回報', () => {
  ok(validateAttack(minimal({ timeline: [{ id: 'a', at: -1, type: 'shake' }] })).some((e) => e.path === 'timeline[0].at'), '負數 at');
  ok(validateAttack(minimal({ timeline: [{ id: 'a', at: 'x', type: 'shake' }] })).some((e) => e.path === 'timeline[0].at'), '非數字 at');
});

test('事件 id 重複 / 空字串會回報', () => {
  const dup = validateAttack(
    minimal({
      timeline: [
        { id: 'same', at: 0, type: 'shake' },
        { id: 'same', at: 1, type: 'shake' },
      ],
    }),
  );
  ok(dup.some((e) => e.path === 'timeline[1].id'), '重複 id 回報在後出現的事件');
  ok(dup.some((e) => e.id === 'same'), '錯誤項目帶 id 方便編輯器定位');
  const empty = validateAttack(minimal({ timeline: [{ id: '', at: 0, type: 'shake' }] }));
  ok(empty.some((e) => e.path === 'timeline[0].id'), '空 id 回報');
});

test('spawn 指向不存在的子彈類型會回報', () => {
  const errs = validateAttack(
    minimal({ timeline: [{ id: 's', at: 0, type: 'spawn', bullet: 'nope', count: 1 }] }),
  );
  ok(errs.some((e) => e.path === 'timeline[0].bullet'), '應回報 bullet');
  ok(errs.some((e) => e.id === 's'), '錯誤帶事件 id');
});

test('emitter 缺 spawn / duration / interval 會回報', () => {
  const errs = validateAttack(minimal({ timeline: [{ id: 'em', at: 0, type: 'emitter' }] }));
  const paths = errs.map((e) => e.path);
  ok(paths.includes('timeline[0].duration'), 'duration');
  ok(paths.includes('timeline[0].interval'), 'interval');
  ok(paths.includes('timeline[0].spawn'), 'spawn');
});

test('box 事件缺 to 或 to 全空會回報', () => {
  ok(validateAttack(minimal({ timeline: [{ id: 'b', at: 0, type: 'box', duration: 1 }] })).some((e) => e.path === 'timeline[0].to'), '缺 to');
  ok(validateAttack(minimal({ timeline: [{ id: 'b', at: 0, type: 'box', duration: 1, to: {} }] })).some((e) => e.path === 'timeline[0].to'), '空 to');
});

test('未知 easing 會回報', () => {
  const errs = validateAttack(
    minimal({ timeline: [{ id: 'b', at: 0, type: 'box', duration: 1, ease: 'bounce', to: { w: 10 } }] }),
  );
  ok(errs.some((e) => e.path === 'timeline[0].ease'), '應回報 ease');
});

test('表達式語法錯誤會在驗證階段被抓到', () => {
  const bad = validateAttack(
    minimal({
      timeline: [
        { id: 's', at: 0, type: 'spawn', bullet: 'dot', count: 1, x: '1 +', angle: 'sin(' },
      ],
    }),
  );
  ok(bad.some((e) => e.path === 'timeline[0].x'), 'x 語法錯誤');
  ok(bad.some((e) => e.path === 'timeline[0].angle'), 'angle 語法錯誤');
  ok(bad.some((e) => e.id === 's'), '帶事件 id');
});

test('合法的表達式不會被誤報', () => {
  const errs = validateAttack(
    minimal({
      timeline: [
        {
          id: 's',
          at: 0,
          type: 'spawn',
          bullet: 'dot',
          count: 4,
          x: 'rand(box.left, box.right)',
          y: 'box.top - 10',
          angle: 'aim(box.x, box.y) + i * (360 / n)',
          pathX: 'sin(age * 90) * 20',
        },
      ],
    }),
  );
  eq(errs.length, 0, `合法表達式不該報錯（實際：${JSON.stringify(errs)}）`);
});

test('bulletTypes 的 hitbox / offscreen 錯誤會回報', () => {
  const errs = validateAttack(
    minimal({
      bulletTypes: {
        a: { hitbox: { shape: 'circle', r: -1 } },
        b: { hitbox: { shape: 'rect', w: 10 } },
        c: { hitbox: { shape: 'star' } },
        d: { hitbox: { shape: 'circle', r: 4 }, offscreen: 'bounce' },
      },
    }),
  );
  const paths = errs.map((e) => e.path);
  ok(paths.includes('bulletTypes.a.hitbox.r'), 'circle r');
  ok(paths.includes('bulletTypes.b.hitbox.h'), 'rect h');
  ok(paths.includes('bulletTypes.c.hitbox.shape'), 'shape');
  ok(paths.includes('bulletTypes.d.offscreen'), 'offscreen');
});

test('soul.mode 非 red 會回報（Phase 1 限制）', () => {
  const errs = validateAttack(minimal({ soul: { mode: 'blue' } }));
  ok(errs.some((e) => e.path === 'soul.mode'), '應提示僅支援 red');
});

test('越過 1000 個錯誤也不會爆掉（防止編輯器卡死）', () => {
  const timeline = [];
  for (let i = 0; i < 400; i += 1) {
    timeline.push({ id: `e${i}`, at: -1, type: 'spawn', bullet: 'nope', x: '1 +' });
  }
  const errs = validateAttack(minimal({ timeline }));
  ok(errs.length > 400, `應抓到大量錯誤（實際 ${errs.length}）`);
  ok(errs.length < 20000, '錯誤數量有上限，不會無限膨脹');
});

test('attackHints：bpm 已設定、其他事件用拍點，但 clear/end 是秒數 → info 提示（不是錯誤）', () => {
  const mixed = minimal({
    settings: { duration: 8, seed: 1, bpm: 120 },
    timeline: [
      { id: 'a', at: '2b', type: 'shake', duration: 0.2, amount: 2 },
      { id: 'b', at: '4b', type: 'shake', duration: 0.2, amount: 2 },
      { id: 'c', at: '6b', type: 'shake', duration: 0.2, amount: 2 },
      { id: 'clear', at: 11, type: 'clear', fade: 0.2 },
      { id: 'end', at: 12, type: 'end' },
    ],
  });
  eq(validateAttack(mixed).length, 0, '混用秒與拍是合法的（不是錯誤）');
  const hints = attackHints(mixed);
  eq(hints.length, 2, 'clear 與 end 各一則');
  eq(hints[0].path, 'timeline[3].at');
  eq(hints[0].level, 'info');
  ok(hints[0].message.includes('第 22 拍'), hints[0].message);
  ok(hints[1].message.includes('"24b"'), hints[1].message);

  // 全部用拍點 → 沒提示
  const allBeats = JSON.parse(JSON.stringify(mixed));
  allBeats.timeline[3].at = '14.5b';
  allBeats.timeline[4].at = '15.8b';
  eq(attackHints(allBeats).length, 0, '全拍點');
  // 沒設 bpm → 沒提示
  const noBpm = minimal({ timeline: [{ id: 'end', at: 1.5, type: 'end' }] });
  eq(attackHints(noBpm).length, 0, '沒 bpm');
  // 其他事件也多用秒 → 作者就是用秒，不提示
  const seconds = JSON.parse(JSON.stringify(mixed));
  seconds.timeline[0].at = 1;
  seconds.timeline[1].at = 2;
  eq(attackHints(seconds).length, 0, '多數用秒');
  eq(attackHints(null).length, 0, '壞輸入');
});

/* ------------------------------------------------------------ 小工具 */

function equalsState(a, b, message) {
  eq(a, b, message);
}
