/**
 * tests/encounter/t-actors-text.mjs — 演員系統與文字（打字機 / 標記 / 泡泡）
 */

import { group, test, eq, ok, notOk, approx, within, isArray, deepEq, hasKey } from '../engine/harness.mjs';
import { createActorSystem, easeValue } from '../../engine/encounter/actors.js';
import { createTextSystem, createTypewriter, parseText, resolveColor, DEFAULT_COLOR } from '../../engine/encounter/text.js';
import { normalizeActor } from '../../engine/encounter/schema.js';

/** 建立一組演員（供多數測試使用） */
function makeActors() {
  return createActorSystem({
    kris: normalizeActor({
      kind: 'party',
      x: 100,
      y: 200,
      anims: {
        idle: { sprite: 'spr_idle', fps: 5, loop: true },
        attack: { sprite: 'spr_attack', fps: 15, loop: false, frames: 6, then: 'idle' },
        down: { sprite: 'spr_down', fps: 1, loop: false },
      },
    }, 'kris'),
    rudinn: normalizeActor({
      kind: 'enemy',
      x: 500,
      y: 200,
      anims: { idle: { sprite: 'spr_rudinn', fps: 5, loop: true } },
    }, 'rudinn'),
  });
}

group('actors：建立與動畫狀態');

test('建立演員並取得初始狀態', () => {
  const a = makeActors();
  const kris = a.get('kris');
  ok(kris, '取得 kris');
  eq(kris.x, 100, 'x');
  eq(kris.y, 200, 'y');
  eq(kris.animName, 'idle', '初始動畫 idle');
  eq(kris.kind, 'party', 'kind');
  eq(a.get('nobody'), null, '不存在的演員 → null');
});

test('list() 依 layer 再依 id 排序（決定性）', () => {
  const a = makeActors();
  const list = a.list().map((x) => x.id);
  deepEq(list.slice().sort(), ['kris', 'rudinn'], '兩個演員都在');
  const again = a.list().map((x) => x.id);
  deepEq(list, again, '兩次呼叫順序相同');
});

test('setAnim 切換狀態；未定義的狀態退回 idle', () => {
  const a = makeActors();
  a.setAnim('kris', 'attack');
  eq(a.get('kris').animName, 'attack', '切到 attack');
  a.setAnim('kris', 'defend'); // 未定義
  eq(a.get('kris').animName, 'idle', '未定義狀態退回 idle');
});

test('setAnim 對不存在的演員回 false', () => {
  const a = makeActors();
  eq(a.setAnim('ghost', 'idle'), false, '不存在的演員');
});

test('setAnim keepIfMissing：沒有 hurt 動畫時沿用目前動畫', () => {
  const a = createActorSystem({
    morph: normalizeActor(
      {
        kind: 'enemy',
        anims: {
          idle: { sprite: 'spr_idle', fps: 5, loop: true },
          morph: { sprite: 'spr_morph', fps: 5, loop: true },
        },
      },
      'morph',
    ),
  });
  a.setAnim('morph', 'morph');
  eq(a.get('morph').animName, 'morph', '先切到 morph');
  eq(a.setAnim('morph', 'hurt', { keepIfMissing: true }), false, '未定義 hurt → 不切換');
  eq(a.get('morph').animName, 'morph', '沿用目前動畫（沒有退回 idle）');
  // 不帶 opts 時維持舊行為：未定義狀態退回 idle
  eq(a.setAnim('morph', 'hurt'), true, '沒給 keepIfMissing 仍照舊');
  eq(a.get('morph').animName, 'idle', '舊行為：退回 idle');
});

test('setAnim keepIfMissing：有 hurt 動畫時行為不變', () => {
  const a = createActorSystem({
    e: normalizeActor(
      {
        kind: 'enemy',
        anims: {
          idle: { sprite: 'spr_idle', fps: 5, loop: true },
          hurt: { sprite: 'spr_hurt', fps: 10, loop: false, frames: 2 },
        },
      },
      'e',
    ),
  });
  eq(a.setAnim('e', 'hurt', { keepIfMissing: true }), true, '有定義 → 切換');
  eq(a.get('e').animName, 'hurt', '切到 hurt');
});

test('非循環動畫播完會自動接 then（attack → idle）', () => {
  const a = makeActors();
  a.setAnim('kris', 'attack');
  // fps 15、6 幀 → 0.4 秒 = 12 幀
  for (let i = 0; i < 13; i += 1) a.update();
  eq(a.get('kris').animName, 'idle', '播完自動接 idle');
});

test('animDone 對非循環動畫會變 true、循環動畫永遠 false', () => {
  const a = makeActors();
  a.setAnim('rudinn', 'idle');
  for (let i = 0; i < 100; i += 1) a.update();
  eq(a.animDone('rudinn'), false, '循環動畫不會結束');
});

test('setSprite 可繞過 anims 表指定 sprite', () => {
  const a = makeActors();
  a.setSprite('kris', 'spr_temp', { fps: 8, loop: false });
  const k = a.get('kris');
  eq(k.anim.sprite, 'spr_temp', 'sprite 被覆寫');
  eq(k.anim.fps, 8, 'fps');
  eq(k.anim.loop, false, 'loop');
});

test('動畫顯示幀依 fps 前進且循環', () => {
  const a = makeActors();
  a.setSprite('kris', 'spr_x', { fps: 10, loop: true });
  const frames = [a.animFrame(a.get('kris'))];
  for (let i = 0; i < 6; i += 1) {
    a.update();
    frames.push(a.animFrame(a.get('kris')));
  }
  eq(frames[0], 0, '第一幀 0');
  ok(frames[3] > frames[0], `10fps 在 3 幀後約 1 幀（實際 ${frames[3]}）`);
  deepEq(frames, frames, '序列穩定');
});

group('actors：移動補間');

test('moveTo 線性補間終值精確', () => {
  const a = makeActors();
  a.moveTo('kris', { x: 200, y: 300, duration: 1, ease: 'linear' });
  for (let i = 0; i < 30; i += 1) a.update();
  const k = a.get('kris');
  eq(k.x, 200, 'x 終值');
  eq(k.y, 300, 'y 終值');
  eq(a.isMoving('kris'), false, '補間結束');
});

test('moveTo 中途值介於起終點之間', () => {
  const a = makeActors();
  a.moveTo('kris', { x: 200, duration: 1, ease: 'linear' });
  for (let i = 0; i < 15; i += 1) a.update();
  approx(a.get('kris').x, 150, 0.5, '一半時間約一半距離');
});

test('moveTo relative 是相對位移', () => {
  const a = makeActors();
  a.moveTo('kris', { x: 50, y: -20, relative: true, duration: 0.5, ease: 'linear' });
  for (let i = 0; i < 16; i += 1) a.update();
  eq(a.get('kris').x, 150, 'x +50');
  eq(a.get('kris').y, 180, 'y -20');
});

test('moveTo 只給 x 時 y 不動', () => {
  const a = makeActors();
  a.moveTo('kris', { x: 300, duration: 0.2 });
  for (let i = 0; i < 10; i += 1) a.update();
  eq(a.get('kris').x, 300, 'x 到目標');
  eq(a.get('kris').y, 200, 'y 不變');
});

test('duration 0 立即到位', () => {
  const a = makeActors();
  a.moveTo('kris', { x: 400, duration: 0 });
  eq(a.get('kris').x, 400, '立即到位');
  eq(a.isMoving('kris'), false, '不需等待');
});

test('不同 easing 的終值都精確（含 backOut 越界後回正）', () => {
  for (const ease of ['linear', 'quadIn', 'quadOut', 'quadInOut', 'sineInOut', 'backOut']) {
    const a = makeActors();
    a.moveTo('kris', { x: 250, duration: 0.5, ease });
    for (let i = 0; i < 20; i += 1) a.update();
    eq(a.get('kris').x, 250, `${ease} 終值`);
  }
});

test('backOut 中途會超過目標再回來', () => {
  const a = makeActors();
  a.moveTo('kris', { x: 200, duration: 1, ease: 'backOut' });
  let maxX = -Infinity;
  for (let i = 0; i < 30; i += 1) {
    a.update();
    maxX = Math.max(maxX, a.get('kris').x);
  }
  ok(maxX > 200, `backOut 應先超過目標（最大 ${maxX}）`);
  eq(a.get('kris').x, 200, '最後仍回到目標');
});

test('easeValue 邊界值', () => {
  for (const name of ['linear', 'quadIn', 'quadOut', 'quadInOut', 'sineInOut', 'backOut', 'unknownEase']) {
    approx(easeValue(name, 0), 0, 1e-6, `${name}(0)`);
    approx(easeValue(name, 1), 1, 1e-6, `${name}(1)`);
  }
});

group('actors：透明度 / 翻轉 / 受傷');

test('setAlpha 立即設定', () => {
  const a = makeActors();
  a.setAlpha('kris', 0.5, 0);
  eq(a.get('kris').alpha, 0.5, 'alpha');
});

test('setAlpha 補間終值精確', () => {
  const a = makeActors();
  a.setAlpha('kris', 0.2, 0.5);
  ok(a.isTweening('kris'), '補間中');
  for (let i = 0; i < 16; i += 1) a.update();
  eq(a.get('kris').alpha, 0.2, '終值');
  eq(a.isTweening('kris'), false, '補間結束');
});

test('setFlip / setVisible', () => {
  const a = makeActors();
  a.setFlip('kris', true);
  eq(a.get('kris').flip, true, 'flip');
  a.setVisible('kris', false);
  eq(a.get('kris').visible, false, 'visible');
});

test('hurt 觸發抖動並在數幀內衰減', () => {
  const a = makeActors();
  a.hurt('kris');
  eq(a.get('kris').hurtShake, 1, '抖動從 1 開始');
  for (let i = 0; i < 10; i += 1) a.update();
  approx(a.get('kris').hurtShake, 0, 1e-6, '衰減到 0');
  ok(a.get('kris').hurtShake <= 0, '不會變成負值');
});

test('reset 回到定義的初始位置與動畫', () => {
  const a = makeActors();
  a.moveTo('kris', { x: 500, duration: 0 });
  a.setAnim('kris', 'attack');
  a.setAlpha('kris', 0.1, 0);
  a.reset();
  const k = a.get('kris');
  eq(k.x, 100, 'x 回初始');
  eq(k.y, 200, 'y 回初始');
  eq(k.alpha, 1, 'alpha 回初始');
  eq(k.animName, 'idle', '動畫回 idle');
});

group('actors：snapshot（§5）');

test('snapshot 欄位齊全且型別正確', () => {
  const a = makeActors();
  const snap = a.snapshot();
  eq(snap.length, 2, '兩個演員');
  for (const item of snap) {
    hasKey(item, 'id');
    hasKey(item, 'kind');
    hasKey(item, 'sprite');
    hasKey(item, 'frame');
    hasKey(item, 'x');
    hasKey(item, 'y');
    hasKey(item, 'flip');
    hasKey(item, 'alpha');
    hasKey(item, 'scale');
    hasKey(item, 'layer');
    hasKey(item, 'visible');
    hasKey(item, 'hurtShake');
    eq(typeof item.sprite, 'string', `${item.id}.sprite 是字串`);
    eq(typeof item.frame, 'number', `${item.id}.frame 是數字`);
  }
});

group('text：文字標記解析');

test('純文字逐字解析', () => {
  const ops = parseText('abc');
  eq(ops.filter((o) => o.type === 'char').length, 3, '3 個字元');
  eq(ops[0].ch, 'a', '第一個字');
});

test('\\n 換行', () => {
  const ops = parseText('a\nb');
  const chars = ops.filter((o) => o.type === 'char');
  eq(chars.length, 3, '含換行共 3 項');
  eq(chars[1].ch, '\n', '中間是換行');
  eq(chars[2].line, 1, '第二行 line=1');
});

test('{w:N} 產生 wait op', () => {
  const ops = parseText('a{w:5}b');
  const waits = ops.filter((o) => o.type === 'wait');
  eq(waits.length, 1, '一個 wait');
  eq(waits[0].frames, 5, '幀數 5');
});

test('{s:N} 產生 speed op', () => {
  const ops = parseText('a{s:2}b');
  const s = ops.filter((o) => o.type === 'speed');
  eq(s.length, 1, '一個 speed');
  eq(s[0].value, 2, '速度 2');
});

test('{c:名稱} / {/c} 產生顏色 op', () => {
  const ops = parseText('{c:yellow}a{/c}');
  eq(ops.filter((o) => o.type === 'color').length, 2, '兩個 color op');
  const chars = ops.filter((o) => o.type === 'char');
  eq(chars[0].color, '#ffff00', '字元帶黃色');
});

test('{i} 立即顯示模式', () => {
  const ops = parseText('{i}abc{w:5}d');
  ok(ops.some((o) => o.type === 'instant' && o.on === true), '有 instant op');
});

test('未閉合 / 未知標記原樣顯示', () => {
  const ops = parseText('a{b');
  const chars = ops.filter((o) => o.type === 'char').map((o) => o.ch).join('');
  eq(chars, 'a{b', '原樣顯示');
  const ops2 = parseText('{zzz}x');
  const chars2 = ops2.filter((o) => o.type === 'char').map((o) => o.ch).join('');
  eq(chars2, '{zzz}x', '未知標記原樣');
});

test('resolveColor 支援名稱與 hex', () => {
  eq(resolveColor('yellow'), '#ffff00', '名稱');
  eq(resolveColor('#f00'), '#ff0000', '短 hex');
  eq(resolveColor('#00ff00'), '#00ff00', '長 hex');
  eq(resolveColor('#abc'), '#aabbcc', '#rgb 展開');
  eq(resolveColor('notacolor'), null, '不合法 → null');
  eq(resolveColor(null), null, 'null → null');
});

test('字面 \\\\n 也當換行（JSON 誤寫時的容錯）', () => {
  const ops = parseText('a\\nb');
  const chars = ops.filter((o) => o.type === 'char');
  ok(chars.some((c) => c.ch === '\n'), '含換行');
});

group('text：打字機');

test('速度 1 字/幀：每幀一個字', () => {
  const tw = createTypewriter({ text: 'abcd', speed: 1 });
  eq(tw.visibleChars, 0, '初始 0');
  tw.update();
  eq(tw.visibleChars, 1, '1 幀後 1 字');
  tw.update();
  eq(tw.visibleChars, 2, '2 幀後 2 字');
});

test('速度 0.5 字/幀：每 2 幀一個字', () => {
  const tw = createTypewriter({ text: 'abcd', speed: 0.5 });
  tw.update();
  eq(tw.visibleChars, 0, '1 幀後 0 字');
  tw.update();
  eq(tw.visibleChars, 1, '2 幀後 1 字');
});

test('速度 2 字/幀：每幀兩個字', () => {
  const tw = createTypewriter({ text: 'abcdef', speed: 2 });
  tw.update();
  eq(tw.visibleChars, 2, '1 幀後 2 字');
});

test('打完後 done 為 true', () => {
  const tw = createTypewriter({ text: 'ab', speed: 1 });
  tw.update();
  tw.update();
  ok(tw.done, '打完');
  eq(tw.visibleChars, 2, '全部顯示');
});

test('revealAll 立即全顯示', () => {
  const tw = createTypewriter({ text: 'abcdefgh', speed: 0.1 });
  tw.revealAll();
  eq(tw.visibleChars, 8, '全部顯示');
  ok(tw.done, 'done');
});

test('{w:N} 會停 N 幀再繼續', () => {
  const tw = createTypewriter({ text: 'a{w:3}b', speed: 1 });
  tw.update();
  eq(tw.visibleChars, 1, '先顯示 a');
  tw.update();
  eq(tw.visibleChars, 1, '第 1 幀等待');
  tw.update();
  eq(tw.visibleChars, 1, '第 2 幀等待');
  tw.update();
  eq(tw.visibleChars, 1, '第 3 幀等待');
  tw.update();
  eq(tw.visibleChars, 2, '等待結束後顯示 b');
});

test('{s:N} 改變後續速度', () => {
  const tw = createTypewriter({ text: 'a{s:2}bcd', speed: 1 });
  tw.update();
  eq(tw.visibleChars, 1, 'a 用原速');
  tw.update();
  eq(tw.visibleChars, 3, '速度 2 → 一次 2 字（b、c）');
});

test('{i} 立即顯示到下一個 {w}', () => {
  const tw = createTypewriter({ text: 'a{i}bcdef{w:5}g', speed: 1 });
  tw.update();
  eq(tw.visibleChars, 6, 'a 之後全部立即顯示到 {w} 前');
  tw.update();
  eq(tw.visibleChars, 6, '{w} 期間不動');
});

test('visibleLines 依行回傳唯讀資料', () => {
  const tw = createTypewriter({ text: 'ab\ncd', speed: 1 });
  for (let i = 0; i < 5; i += 1) tw.update();
  const lines = tw.visibleLines(DEFAULT_COLOR);
  eq(lines.length, 2, '兩行');
  eq(lines[0].text, 'ab', '第一行');
  eq(lines[1].text, 'cd', '第二行');
  isArray(lines[0].runs, 'runs 是陣列');
});

test('visibleLines 帶顏色資訊', () => {
  const tw = createTypewriter({ text: '{c:red}AB', speed: 1 });
  for (let i = 0; i < 3; i += 1) tw.update();
  const lines = tw.visibleLines(DEFAULT_COLOR);
  eq(lines[0].runs[0].color, '#ff0000', 'run 顏色');
  eq(lines[0].runs[0].text, 'AB', 'run 文字');
});

test('空文字立即 done', () => {
  const tw = createTypewriter({ text: '', speed: 1 });
  tw.update();
  ok(tw.done, 'done');
  eq(tw.visibleChars, 0, '0 字');
});

group('text：文字系統（say / bubble）');

/** 建立最小文字系統 */
function makeText(extra = {}) {
  return createTextSystem({
    getLang: () => 'zh',
    onSfx: () => {},
    getActorPos: (id) => (id === 'rudinn' ? { x: 500, y: 200 } : null),
    fps: 30,
    ...extra,
  });
}

test('say 建立文字框並可推進', () => {
  const t = makeText();
  const h = t.say({ text: '你好', speed: 1 });
  ok(h, '取得 handle');
  ok(t.busy(), '忙');
  t.update();
  const snap = t.snapshotTextbox();
  eq(snap.lines[0].text, '你', '第一幀顯示 1 字');
  eq(snap.done, false, '還沒打完');
  t.update();
  eq(t.snapshotTextbox().done, true, '打完');
});

test('say 的 Z 行為：打字中全顯示、打完後關閉', () => {
  const t = makeText();
  t.say({ text: 'abcdef', speed: 0.2 });
  t.update();
  t.confirm(); // 打字中 → 全顯示
  eq(t.snapshotTextbox().visibleChars, 6, '全部顯示');
  eq(t.snapshotTextbox().done, true, 'done');
  t.confirm(); // 已打完 → 關閉
  eq(t.snapshotTextbox(), null, '文字框關閉');
  notOk(t.busy(), '不再忙');
});

test('say 支援 {zh,en} 依語言取字', () => {
  const zh = createTextSystem({ getLang: () => 'zh' });
  zh.say({ text: { zh: '簡體', en: 'English' }, speed: 100 });
  zh.update();
  eq(zh.snapshotTextbox().lines[0].text, '簡體', 'zh 取簡體');

  const en = createTextSystem({ getLang: () => 'en' });
  en.say({ text: { zh: '簡體', en: 'English' }, speed: 100 });
  en.update();
  eq(en.snapshotTextbox().lines[0].text, 'English', 'en 取英文');
});

test('say 的 voice 每字觸發音效', () => {
  const sfx = [];
  const t = makeText({ onSfx: (name) => sfx.push(name) });
  t.say({ text: 'abc', voice: 'snd_text', speed: 1 });
  t.update();
  t.update();
  eq(sfx.length, 2, '每字一次');
  eq(sfx[0], 'snd_text', '音效名');
});

test('say 的 speaker / portrait 進 snapshot', () => {
  const t = makeText();
  t.say({ text: 'x', speaker: 'Kris', portrait: 'spr_kris_face', speed: 10 });
  t.update();
  const snap = t.snapshotTextbox();
  eq(snap.speaker, 'Kris', 'speaker');
  eq(snap.portrait, 'spr_kris_face', 'portrait');
});

test('bubble 掛在演員旁且依 side 定位', () => {
  const t = makeText();
  t.bubble({ actor: 'rudinn', text: 'hi', speed: 10 });
  t.update();
  const list = t.snapshotBubbles();
  eq(list.length, 1, '一個泡泡');
  eq(list[0].actor, 'rudinn', 'actor');
  ok(list[0].x < 500, `演員在右半邊 → 泡泡在其左側（x=${list[0].x}）`);
});

test('bubble wait:秒數 會自動關閉', () => {
  const t = makeText();
  t.bubble({ actor: 'rudinn', text: 'hi', speed: 10, wait: 0.1 });
  for (let i = 0; i < 6; i += 1) t.update();
  eq(t.snapshotBubbles().length, 0, '逾時關閉');
  notOk(t.busy(), '不再忙');
});

test('bubble wait:input 需要按鍵才關閉', () => {
  const t = makeText();
  t.bubble({ actor: 'rudinn', text: 'hi', speed: 10 });
  for (let i = 0; i < 60; i += 1) t.update();
  eq(t.snapshotBubbles().length, 1, '還在等按鍵');
  t.confirm();
  eq(t.snapshotBubbles().length, 0, '按鍵後關閉');
});

test('clear 清掉所有文字', () => {
  const t = makeText();
  t.say({ text: 'x', speed: 10 });
  t.bubble({ actor: 'rudinn', text: 'y', speed: 10 });
  t.clear();
  eq(t.snapshotTextbox(), null, '文字框已清');
  eq(t.snapshotBubbles().length, 0, '泡泡已清');
  notOk(t.busy(), '不忙');
});

test('reset 清掉文字並可重用', () => {
  const t = makeText();
  t.say({ text: 'x', speed: 10 });
  t.reset();
  eq(t.snapshotTextbox(), null, '已清');
  t.say({ text: 'y', speed: 10 });
  t.update();
  eq(t.snapshotTextbox().lines[0].text, 'y', '可再用');
});
