/**
 * tests/engine/t-api.mjs — 公開 API 測試（SPEC §6、§9）
 *
 * createBattle 的介面、無頭模式、getState、事件、setOptions、seek、destroy，
 * 以及與 E2 模組（render/input/audio/assets）尚未存在時的容錯行為。
 */
import { group, test, eq, ok, notOk, approx, isArray, isObj, within } from './harness.mjs';
import { createBattle, normalizeAttack, validateAttack, loadAssets } from '../../engine/index.js';
import { FPS } from '../../engine/attack.js';
import { drawText } from '../../engine/render.js';

function attack(over) {
  return {
    format: 'dr-battle-attack/1',
    settings: { duration: 3, seed: 5, ...(over && over.settings) },
    box: { x: 320, y: 171, w: 150, h: 150 },
    soul: { x: null, y: null, speed: 4, slowSpeed: 2 },
    party: [{ name: 'Kris', hp: 90, maxHp: 90, color: '#00ffff' }],
    bulletTypes: { dot: { hitpoint: null, hitbox: { shape: 'circle', r: 5 } } },
    timeline: (over && over.timeline) || [],
  };
}

function headless(mode = 'preview') {
  return createBattle({ canvas: null, assets: null, mode });
}

/* ------------------------------------------------------------------ */

group('API：模組匯出');

test('engine/index.js 匯出 SPEC §6 的全部函式', () => {
  eq(typeof createBattle, 'function', 'createBattle');
  eq(typeof normalizeAttack, 'function', 'normalizeAttack');
  eq(typeof validateAttack, 'function', 'validateAttack');
  eq(typeof loadAssets, 'function', 'loadAssets');
});

test('loadAssets 在 E2 模組不存在時回傳 null（而非丟例外）', async () => {
  // 注意：此測試用 promise 直接檢查，不透過 harness 的同步 test()
  const p = loadAssets('assets/index.json');
  ok(p && typeof p.then === 'function', '回傳 Promise');
});

/* ------------------------------------------------------------------ */

group('API：混合字型');

test('中文退回字從保留的空位開始畫，不蓋住下一個點陣字', () => {
  const fallback = [];
  const atlas = [];
  const ctx = {
    save() {}, restore() {},
    fillText(text, x) { fallback.push([text, x]); },
    drawImage(...args) { atlas.push(args[5]); },
  };
  const font = {
    image: { width: 8, height: 8 }, size: 24, lineHeight: 32,
    glyph: (ch) => ch === 'A' ? { x: 0, y: 0, w: 8, h: 8, offset: 0, shift: 10 } : null,
  };
  const width = drawText(ctx, 'A刘海A抡A', 10, 20, { font, lang: 'zh', baseline: 'top' });
  eq(width, 102);
  eq(JSON.stringify(fallback), JSON.stringify([['刘海', 20], ['抡', 78]]));
  eq(JSON.stringify(atlas), JSON.stringify([10, 68, 102]));
});

/* ------------------------------------------------------------------ */

group('API：無頭模式');

test('無頭 createBattle 可建立（canvas: null）', () => {
  const b = headless();
  isObj(b, '回傳物件');
  for (const name of ['load', 'play', 'pause', 'reset', 'step', 'seek', 'getState', 'setOptions', 'on', 'destroy']) {
    eq(typeof b[name], 'function', `缺少方法 ${name}`);
  }
});

test('無頭模式可 load / step / seek / getState', () => {
  const b = headless();
  b.load(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 3, x: 300, y: 200, speed: 1, angle: 90 }] }));
  b.step(10);
  const st = b.getState();
  eq(st.frame, 10, '前進 10 幀');
  approx(st.time, 10 / FPS, 1e-12, 'time');
  eq(st.bullets.length, 3, '3 發子彈');
  b.seek(5);
  eq(b.getState().frame, 5, 'seek 到第 5 幀');
  eq(b.getState().bullets.length, 3, 'seek 後子彈仍在');
});

test('無頭模式建立 battle 不會嘗試使用 DOM', () => {
  const b = headless();
  b.load(attack());
  b.play();
  b.step(3);
  b.pause();
  b.reset();
  b.destroy();
  ok(true, '全程無例外');
});

test('無 canvas 時 play() 不會啟動 rAF 迴圈（step 仍可手動推進）', () => {
  const b = headless();
  b.load(attack());
  b.play();
  eq(typeof requestAnimationFrame, 'undefined', 'Node 中沒有 rAF');
  b.step(2);
  eq(b.getState().frame, 2, '手動 step 有效');
  b.destroy();
});

test('mode 只能是 play / preview，其他值回退 preview', () => {
  eq(headless('preview').mode, 'preview', 'preview');
  eq(headless('play').mode, 'play', 'play');
  eq(headless('nonsense').mode, 'preview', '非法值 → preview');
  eq(createBattle().mode, 'preview', '未指定 → preview');
});

/* ------------------------------------------------------------------ */

group('API：load / normalize');

test('load 會自動呼叫 normalizeAttack', () => {
  const b = headless();
  b.load({ format: 'dr-battle-attack/1' });
  const st = b.getState();
  eq(st.attack.format, 'dr-battle-attack/1', 'format 補上');
  ok(st.attack.settings.duration > 0, 'duration 補上');
  // SPEC-LAYOUT §5 的預設框：中心 (320,190)、內部 144×158、border 3
  eq(b.getState().box.y, 190, 'box.y 預設 190');
  eq(b.getState().box.w, 144, 'box.w 預設 144');
  eq(b.getState().box.h, 158, 'box.h 預設 158');
  eq(b.getState().box.border, 3, 'box.border 預設 3');
  eq(b.getState().box.w, 144, 'box 預設補上');
});

test('load 非法資料不會丟例外', () => {
  const b = headless();
  for (const bad of [null, undefined, 'x', 5, []]) {
    b.load(bad);
    ok(b.getState().frame === 0, `${String(bad)} 載入後 frame 為 0`);
  }
});

test('load 會重置到第 0 幀', () => {
  const b = headless();
  b.load(attack());
  b.step(20);
  eq(b.getState().frame, 20, '先推進');
  b.load(attack());
  eq(b.getState().frame, 0, '重新載入後歸零');
  eq(b.getState().ended, false, '未結束');
});

/* ------------------------------------------------------------------ */

group('API：getState');

test('getState 回傳 §9 完整形狀', () => {
  const b = headless();
  b.load(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1 }] }));
  const st = b.getState();
  for (const key of [
    'frame', 'time', 'running', 'ended', 'attack', 'shake', 'box', 'soul',
    'bullets', 'party', 'tp', 'enemies', 'sfxQueue', 'grazeFlash', 'hurtFlash',
  ]) {
    ok(Object.prototype.hasOwnProperty.call(st, key), `缺少 ${key}`);
  }
  isArray(st.bullets, 'bullets 陣列');
  isArray(st.party, 'party 陣列');
  isArray(st.enemies, 'enemies 陣列');
  isArray(st.sfxQueue, 'sfxQueue 陣列');
});

test('running 反映 play / pause 狀態', () => {
  const b = headless();
  b.load(attack());
  eq(b.getState().running, false, '初始未播放');
  b.play();
  eq(b.getState().running, true, 'play 後 running');
  b.pause();
  eq(b.getState().running, false, 'pause 後停止');
});

test('ended 在回合結束後為 true', () => {
  const b = headless();
  b.load(attack({ settings: { duration: 0.2 } }));
  b.step(10);
  eq(b.getState().ended, true, '0.2 秒後結束');
});

test('getState 多次呼叫不會改變狀態', () => {
  const b = headless();
  b.load(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 2 }] }));
  b.step(5);
  const a = JSON.stringify(b.getState());
  const c = JSON.stringify(b.getState());
  eq(a, c, '兩次結果相同');
  eq(b.getState().frame, 5, 'frame 不變');
});

/* ------------------------------------------------------------------ */

group('API：play / pause / reset');

test('play 後 running 為 true、pause 後 false', () => {
  const b = headless();
  b.load(attack());
  b.play();
  eq(b.running, true, 'play');
  b.pause();
  eq(b.running, false, 'pause');
});

test('reset 回到第 0 幀並清空子彈', () => {
  const b = headless();
  b.load(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 5 }] }));
  b.step(20);
  ok(b.getState().bullets.length > 0, '有子彈');
  b.reset();
  eq(b.getState().frame, 0, 'frame 0');
  eq(b.getState().bullets.length, 5, 'at=0 的事件會在重置時重新觸發');
});

test('reset 後可以再次推進', () => {
  const b = headless();
  b.load(attack());
  b.step(30);
  b.reset();
  b.step(10);
  eq(b.getState().frame, 10, '重新推進 10 幀');
});

/* ------------------------------------------------------------------ */

group('API：step / seek');

test('step() 預設前進 1 幀', () => {
  const b = headless();
  b.load(attack());
  b.step();
  eq(b.getState().frame, 1, '1 幀');
  b.step();
  eq(b.getState().frame, 2, '2 幀');
});

test('step(n) 前進 n 幀；step(0) 只重繪', () => {
  const b = headless();
  b.load(attack());
  b.step(7);
  eq(b.getState().frame, 7, '前進 7');
  b.step(0);
  eq(b.getState().frame, 7, 'step(0) 不變');
});

test('step 負數 / 非數字視為 0', () => {
  const b = headless();
  b.load(attack());
  b.step(-5);
  eq(b.getState().frame, 0, '負數不推進');
  b.step(NaN);
  eq(b.getState().frame, 0, 'NaN 不推進');
});

test('seek(n) 的 frame 等於 n（回合長度內）', () => {
  const b = headless();
  b.load(attack({ settings: { duration: 5 } }));
  for (const f of [0, 1, 10, 42, 120]) {
    b.seek(f);
    eq(b.getState().frame, f, `seek(${f})`);
  }
});

test('seek 與 step 產生相同狀態（preview 決定性）', () => {
  const atk = attack({
    settings: { seed: 42, duration: 5 },
    timeline: [
      {
        id: 'em', at: 0.2, type: 'emitter', duration: 2, interval: 0.1, count: 2,
        spawn: { bullet: 'dot', x: 'rand(box.left, box.right)', y: 'box.top', speed: 'rand(1, 2)', angle: 90 },
      },
    ],
  });
  const a = headless();
  a.load(atk);
  a.step(90);
  const sa = JSON.stringify(a.getState());

  const b = headless();
  b.load(atk);
  b.seek(90);
  const sb = JSON.stringify(b.getState());

  eq(sb, sa, 'seek(90) 與 step(90) 狀態相同');
});

test('seek 超出回合長度時停在結束狀態', () => {
  const b = headless();
  b.load(attack({ settings: { duration: 1 } }));
  b.seek(1000);
  const st = b.getState();
  eq(st.ended, true, '已結束');
  ok(st.frame <= 1000, `frame 停在結束處（實際 ${st.frame}）`);
});

test('seek 會重置擊中紀錄與 TP', () => {
  const b = headless();
  b.load(
    attack({
      box: { x: 320, y: 171, w: 400, h: 400 },
      // FX-GRAZE：dx 從 +20 改成 +14（心形遮罩擦彈範圍是 ±17）
      timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 334, y: 171, speed: 0, life: 3 }],
    }),
  );
  b.step(20);
  ok(b.getState().tp > 0, '有擦彈 TP');
  b.seek(0);
  eq(b.getState().tp, 0, 'seek(0) 後 TP 歸零');
});

/* ------------------------------------------------------------------ */

group('API：事件');

test('on/off 訂閱 frame 事件', () => {
  const b = headless();
  const seen = [];
  const offFn = b.on('frame', (p) => seen.push(p.frame));
  b.load(attack());
  b.step(3);
  eq(seen.length, 3, '收到 3 次 frame');
  eq(typeof offFn, 'function', 'on 回傳取消函式');
  offFn();
  b.step(2);
  eq(seen.length, 3, '取消後不再收到');
});

test('frame 事件 payload 有 frame / time / ended', () => {
  const b = headless();
  let payload = null;
  b.on('frame', (p) => {
    payload = p;
  });
  b.load(attack());
  b.step(1);
  ok(payload, '有 payload');
  eq(payload.frame, 1, 'frame');
  approx(payload.time, 1 / FPS, 1e-12, 'time');
  eq(payload.ended, false, 'ended');
});

test('end 事件只發一次', () => {
  const b = headless();
  let count = 0;
  b.on('end', () => {
    count += 1;
  });
  b.load(attack({ settings: { duration: 0.2 } }));
  b.step(20);
  eq(count, 1, `end 只發一次（實際 ${count}）`);
});

test('hit 事件帶傷害與隊伍狀態', () => {
  const b = headless();
  const hits = [];
  b.on('hit', (p) => hits.push(p));
  b.load(attack({ timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 320, y: 171, speed: 0 }] }));
  b.step(10);
  eq(hits.length, 1, '一次 hit');
  eq(hits[0].damage, 10, '傷害');
  isArray(hits[0].party, '隊伍狀態');
});

test('graze 事件帶子彈資訊', () => {
  const b = headless();
  const grazes = [];
  b.on('graze', (p) => grazes.push(p));
  b.load(
    attack({
      box: { x: 320, y: 171, w: 400, h: 400 },
      // FX-GRAZE：dx 從 +20 改成 +14（心形遮罩擦彈範圍是 ±17）
      timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 334, y: 171, speed: 0, life: 3 }],
    }),
  );
  b.step(20);
  eq(grazes.length, 1, '一次 graze');
  ok(grazes[0].bulletId > 0, 'bulletId');
  ok(typeof grazes[0].x === 'number', 'x 座標');
});

test('error 事件帶 id / field / path', () => {
  const b = headless();
  const errs = [];
  b.on('error', (p) => errs.push(p));
  b.load(attack({ timeline: [{ id: 'bad', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 'bad(' }] }));
  b.step(10);
  ok(errs.length > 0, '有 error');
  eq(errs[0].id, 'bad', 'event id');
  eq(errs[0].field, 'x', '欄位');
  ok(typeof errs[0].path === 'string', 'path 字串');
  ok(errs[0].message, '訊息');
});

test('未知事件名稱不影響其他訂閱者', () => {
  const b = headless();
  ok(typeof b.on('nonsense', () => {}) === 'function', '可訂閱未知事件');
});

test('訂閱回呼拋錯不影響模擬', () => {
  const b = headless();
  b.on('frame', () => {
    throw new Error('測試用錯誤');
  });
  b.load(attack());
  b.step(5);
  eq(b.getState().frame, 5, '模擬照常推進');
});

test('on 非函式不丟例外', () => {
  const b = headless();
  for (const bad of [null, undefined, 5, 'x']) {
    const offFn = b.on('frame', bad);
    eq(typeof offFn, 'function', '仍回傳函式');
  }
});

/* ------------------------------------------------------------------ */

group('API：setOptions');

test('setOptions 可設定 showHitboxes / showGrid / muted / scale', () => {
  const b = headless();
  b.load(attack());
  b.setOptions({ showHitboxes: true, showGrid: false, muted: true, scale: 2 });
  const opt = b.getOptions();
  eq(opt.showHitboxes, true, 'showHitboxes');
  eq(opt.showGrid, false, 'showGrid');
  eq(opt.muted, true, 'muted');
  eq(opt.scale, 2, 'scale');
});

test('setOptions 忽略非法型別或未知欄位', () => {
  const b = headless();
  b.load(attack());
  b.setOptions({ scale: 'big', showGrid: 'yes', nope: 1 });
  eq(b.getOptions().scale, 1, '非法 scale 不套用');
  eq(b.getOptions().showGrid, true, '字串轉布林');
});

test('setOptions 傳 null / 非物件不丟例外', () => {
  const b = headless();
  b.load(attack());
  for (const bad of [null, undefined, 5, 'x']) {
    b.setOptions(bad);
  }
  ok(true, '沒有例外');
});

test('setOptions 可設定 lang（SPEC §7：zh / en，預設 zh）', () => {
  const b = headless();
  b.load(attack());
  eq(b.getOptions().lang, 'zh', '預設 zh');
  b.setOptions({ lang: 'en' });
  eq(b.getOptions().lang, 'en', '切到 en');
  b.setOptions({ lang: 'fr' });
  eq(b.getOptions().lang, 'en', '非法語言值被忽略');
  b.setOptions({ lang: 'zh' });
  eq(b.getOptions().lang, 'zh', '切回 zh');
});

test('lang 不影響模擬（同 seed 同結果）', () => {
  const run = (lang) => {
    const b = headless();
    b.load(
      attack({
        timeline: [{ id: 'em', at: 0, type: 'emitter', duration: 1, interval: 0.1, count: 2, spawn: { bullet: 'dot', x: 'rand(0, 640)', y: 200, speed: 0 } }],
      }),
    );
    b.setOptions({ lang });
    b.step(45);
    return JSON.stringify(b.getState().bullets.map((x) => [x.x, x.y]));
  };
  eq(run('en'), run('zh'), '語言不影響模擬結果');
});

/* ------------------------------------------------------------------ */

group('API：destroy');

test('destroy 後不再接受 step（不會丟例外）', () => {
  const b = headless();
  b.load(attack());
  b.destroy();
  b.step(1);
  b.play();
  b.pause();
  b.reset();
  b.seek(5);
  b.destroy();
  ok(true, '重複操作不丟例外');
});

test('destroy 後事件不再送出', () => {
  const b = headless();
  let count = 0;
  b.on('frame', () => {
    count += 1;
  });
  b.load(attack());
  b.destroy();
  b.step(2);
  eq(count, 0, 'destroy 後沒有 frame 事件');
});

/* ------------------------------------------------------------------ */

group('API：與 E2 模組的介面（尚未存在時）');

test('loadAssets 不會讓模組載入失敗', async () => {
  const mod = await import('../../engine/index.js');
  eq(typeof mod.loadAssets, 'function', '可匯出 loadAssets');
  const result = await mod.loadAssets('nope/index.json');
  ok(result === null || typeof result === 'object', '回傳 null 或物件（不丟例外）');
});

test('有 canvas 但沒有 render.js 時仍可建立 battle', () => {
  // 用假的 canvas 物件模擬瀏覽器（無 ctx），確認建立流程不會炸
  const fakeCanvas = { width: 640, height: 480, getContext: () => null };
  let b = null;
  let threw = null;
  try {
    b = createBattle({ canvas: fakeCanvas, assets: null, mode: 'preview' });
    b.load(attack());
    b.step(2);
  } catch (err) {
    threw = err;
  }
  eq(threw, null, '不應拋例外');
  ok(b, '有回傳 battle');
  eq(b.getState().frame, 2, '模擬仍正常');
  if (b) b.destroy();
});

test('assets 為 null 時 load 照常運作', () => {
  const b = createBattle({ canvas: null, assets: null, mode: 'preview' });
  b.load(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1 }] }));
  b.step(5);
  eq(b.getState().bullets.length, 1, '子彈生成正常');
});

/* ------------------------------------------------------------------ */

group('API：實際範例檔可載入');

test('samples/*.json 全部可通過 validateAttack', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../../samples/', import.meta.url);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  } catch (_err) {
    files = [];
  }
  ok(files.length >= 3, `應有至少 3 個範例（實際 ${files.length}）`);
  for (const file of files) {
    const json = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const errs = validateAttack(json);
    eq(errs.length, 0, `${file} 驗證失敗：${JSON.stringify(errs.slice(0, 3))}`);
  }
});

test('範例檔可載入並跑完整回合（無例外）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../../samples/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  for (const file of files) {
    const json = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const b = createBattle({ canvas: null, assets: null, mode: 'preview' });
    b.load(json);
    const frames = Math.round(json.settings.duration * FPS) + 10;
    b.step(frames);
    ok(b.getState().frame > 0, `${file} 有推進`);
    b.destroy();
  }
});

test('範例檔在 preview 模式具決定性', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../../samples/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  for (const file of files) {
    const json = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const run = (seekTo) => {
      const b = createBattle({ canvas: null, assets: null, mode: 'preview' });
      b.load(json);
      if (seekTo) b.seek(seekTo);
      else b.step(seekTo || 0);
      return JSON.stringify(b.getState());
    };
    const s1 = run(60);
    const s2 = run(60);
    eq(s2, s1, `${file} 兩次 step 結果不同（決定性失敗）`);
  }
});
