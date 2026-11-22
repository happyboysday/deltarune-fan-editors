// editor/encounter/timeline.test.mjs  (V2-07)
//
// 時間軸總覽的純資料測試（不碰 DOM、不跑引擎）：
//   台詞估算、攻擊長度、bpm 拍線、cue 標記、模擬事件合併、估算退回、決定性。
//
// 執行：node --test editor/encounter/timeline.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIMELINE_FPS,
  textOf,
  turnTalkTexts,
  estimateTypingMs,
  attackNameOf,
  attackDurationMs,
  computeBeats,
  collectTurnCueChips,
  cueChipLabel,
  groupSimEvents,
  buildTimelineRows,
  collectTimelineAttackNames,
  simulateTimeline,
  orderSegments,
  formatSeconds,
} from './timeline.js';
import STRINGS, { LOCALE_IDS, findKeyMismatches } from '../locales/encounter-timeline.js';

const near = (actual, expected, eps = 0.75) =>
  assert.ok(Math.abs(actual - expected) <= eps, `預期 ${expected} ± ${eps}，實際 ${actual}`);

const doc = {
  format: 'dr-battle-encounter/1',
  settings: { seed: 1 },
  turns: [
    {
      id: 't1',
      talk: [{ actor: 'e', text: '一二三四五' }, { actor: 'e', text: { zh: '六七八', en: 'six' } }],
      attack: 'demo-attack',
      start: [
        { cmd: 'form', actor: 'e', name: 'angry' },
        { cmd: 'bgm', track: null },
        {
          cmd: 'if',
          cond: 'vars.flag >= 1',
          then: [{ cmd: 'form', actor: 'e', name: 'calm' }],
          else: [{ cmd: 'set', var: 'flag', value: 1 }],
        },
      ],
      end: [],
    },
    {
      id: 't2',
      talk: [],
      attack: { name: 'fast-attack' },
      start: [],
      end: [{ cmd: 'anim', actor: 'e', anim: 'idle' }],
    },
  ],
};

const attacks = new Map([
  ['demo-attack', { settings: { duration: 2.0, bpm: 120, beatOffset: 0 } }],
  ['fast-attack', { settings: { duration: 1.5 } }],
]);

/** 兩回合的假模擬事件（frame 為 30fps） */
function fakeSim() {
  return {
    events: [
      { type: 'turnStart', frame: 0, turn: 0, payload: { turn: 0 } },
      { type: 'say', frame: 10, turn: 0, payload: { turn: 0, speaker: 'E', text: '一二三四五' } },
      { type: 'attackStart', frame: 40, turn: 0, payload: { turn: 0, name: 'demo-attack' } },
      { type: 'attackEnd', frame: 100, turn: 0, payload: { turn: 0 } },
      { type: 'turnEnd', frame: 130, turn: 0, payload: { turn: 0 } },
      { type: 'turnStart', frame: 130, turn: 1, payload: { turn: 1 } },
      { type: 'attackStart', frame: 160, turn: 1, payload: { turn: 1, name: 'fast-attack' } },
      { type: 'attackEnd', frame: 205, turn: 1, payload: { turn: 1 } },
      { type: 'turnEnd', frame: 205, turn: 1, payload: { turn: 1 } },
    ],
    loadErrors: [],
    errors: [],
    pilotError: '',
    result: 'victory',
    frames: 205,
  };
}

test('textOf：字串與雙語物件', () => {
  assert.equal(textOf('abc'), 'abc');
  assert.equal(textOf({ zh: '中文', en: 'EN' }), '中文');
  assert.equal(textOf({ en: 'EN' }), 'EN');
  assert.equal(textOf(null), '');
});

test('turnTalkTexts：雙語文字只取一種', () => {
  assert.deepEqual(turnTalkTexts(doc.turns[0]), ['一二三四五', '六七八']);
  assert.deepEqual(turnTalkTexts(doc.turns[1]), []);
  assert.deepEqual(turnTalkTexts({}), []);
});

test('estimateTypingMs：字數 ÷（fps×字/幀）＋每句停頓', () => {
  const ms = estimateTypingMs(doc.turns[0], { fps: 30, holdMs: 0 });
  near(ms, ((5 + 3) / 30) * 1000, 0.5); // 8 字 / 30 = 266.7ms
  const withHold = estimateTypingMs(doc.turns[0], { fps: 30, holdMs: 100 });
  near(withHold, ms + 200, 0.5); // 兩句
  near(estimateTypingMs({ talk: [] }), 0, 0.001);
});

test('attackNameOf：字串 / 物件 / 空值', () => {
  assert.equal(attackNameOf({ attack: 'a' }), 'a');
  assert.equal(attackNameOf({ attack: { name: 'b' } }), 'b');
  assert.equal(attackNameOf({ attack: { ref: 'c' } }), 'c');
  assert.equal(attackNameOf({ attack: null }), null);
  assert.equal(attackNameOf({}), null);
});

test('attackDurationMs：settings.duration 秒 → 毫秒；缺值 2s', () => {
  const map = new Map([['a', { settings: { duration: 1.25 } }], ['b', {}]]);
  assert.equal(attackDurationMs(map, 'a'), 1250);
  assert.equal(attackDurationMs(map, 'b'), 2000);
  assert.equal(attackDurationMs(map, 'missing'), 2000);
});

test('computeBeats：120 BPM → 每 500ms 一拍，每 4 拍一個小節線', () => {
  const info = computeBeats({ settings: { bpm: 120 } }, 2000);
  assert.equal(info.bpm, 120);
  assert.equal(info.beatMs, 500);
  assert.deepEqual(
    info.beats.map((b) => b.ms),
    [0, 500, 1000, 1500, 2000],
  );
  assert.deepEqual(
    info.beats.map((b) => b.bar),
    [true, false, false, false, true],
  );
});

test('computeBeats：beatOffset 以拍為單位；沒有 bpm 回 null', () => {
  const info = computeBeats({ settings: { bpm: 120, beatOffset: 0.5 } }, 2000);
  assert.equal(info.beats[0].ms, 250);
  assert.equal(computeBeats({ settings: { duration: 2 } }, 2000), null);
  const none = computeBeats({ settings: { bpm: 120 } }, 0);
  assert.deepEqual(none.beats, []);
});

test('collectTurnCueChips：form / bgm / if（含巢狀）都收，且分類正確', () => {
  const chips = collectTurnCueChips(doc.turns[0]);
  const labels = chips.map((c) => c.label);
  assert.ok(labels.includes('form: e→angry'), labels.join(' | '));
  assert.ok(labels.includes('bgm: ∅'), labels.join(' | '));
  assert.ok(labels.some((l) => l.startsWith('if: vars.flag')), labels.join(' | '));
  assert.ok(labels.includes('form: e→calm'), 'if.then 內層也收');
  assert.ok(labels.includes('set: flag=1'), 'if.else 內層也收');
  assert.equal(chips.find((c) => c.label === 'form: e→angry').kind, 'form');
});

test('cueChipLabel：未知指令退回 cmd', () => {
  assert.equal(cueChipLabel('wait', { seconds: 1 }), 'wait');
  assert.match(cueChipLabel('if', { cond: 'x'.repeat(60) }), /^if: x+…$/);
});

test('groupSimEvents：配對 turnStart/turnEnd 與 attackStart/attackEnd', () => {
  const groups = groupSimEvents(fakeSim());
  assert.equal(groups.length, 2);
  assert.equal(groups[0].startFrame, 0);
  assert.equal(groups[0].endFrame, 130);
  assert.equal(groups[0].attacks.length, 1);
  assert.equal(groups[0].attacks[0].startFrame, 40);
  assert.equal(groups[0].attacks[0].endFrame, 100);
  assert.equal(groups[0].says.length, 1);
  assert.equal(groups[1].startFrame, 130);
  assert.equal(groups[1].attacks[0].endFrame, 205);
});

test('buildTimelineRows：用模擬影格算實際時間，並在攻擊段畫拍線', () => {
  const out = buildTimelineRows({ doc, sim: fakeSim(), attacks, fps: 30 });
  assert.equal(out.rows.length, 2);
  assert.equal(out.simulated, true);
  const [r1, r2] = out.rows;
  assert.equal(r1.turn, 1);
  assert.equal(r1.simulated, true);
  assert.equal(r1.id, 't1');
  near(r1.durationMs, (130 / 30) * 1000);
  assert.equal(r1.frames, 130);
  const attackSeg = r1.segments.find((s) => s.kind === 'attack');
  assert.ok(attackSeg, '有攻擊段');
  assert.equal(attackSeg.bpm, 120);
  near(attackSeg.startMs, (40 / 30) * 1000);
  near(attackSeg.endMs, (100 / 30) * 1000);
  assert.equal(attackSeg.beats.length, 5); // 0/500/1000/1500/2000ms（含結尾拍）
  assert.equal(attackSeg.beats[0].bar, true);
  assert.equal(attackSeg.beats[4].bar, true, '第 5 拍 = 下一個小節線');
  const saySeg = r1.segments.find((s) => s.kind === 'say');
  assert.ok(saySeg, '有台詞段');
  near(saySeg.startMs, (10 / 30) * 1000);
  near(r2.durationMs, (75 / 30) * 1000);
  near(out.totals.ms, ((130 + 75) / 30) * 1000);
  assert.equal(out.totals.frames, 205);
  assert.equal(out.simResult, 'victory');
});

test('buildTimelineRows：沒有模擬時退回估算（台詞＋攻擊長度）', () => {
  const out = buildTimelineRows({ doc, sim: null, attacks, fps: 30 });
  assert.equal(out.rows.length, 2);
  assert.equal(out.simulated, false);
  const [r1, r2] = out.rows;
  assert.equal(r1.simulated, false);
  assert.ok(r1.durationMs >= 2000, '至少包含攻擊 2 秒');
  assert.ok(r1.segments.every((s) => s.endMs >= s.startMs));
  assert.ok(r2.durationMs >= 1500);
  assert.equal(r1.segments.find((s) => s.kind === 'attack').bpm, 120);
  assert.equal(r2.segments.find((s) => s.kind === 'attack').bpm, null);
});

test('buildTimelineRows：缺攻擊檔會標記 missingAttack 與警告', () => {
  const out = buildTimelineRows({
    doc: { turns: [{ id: 't1', attack: 'nope' }] },
    sim: null,
    attacks: new Map(),
  });
  assert.equal(out.rows[0].missingAttack, true);
  assert.ok(out.warnings.some((w) => w.kind === 'attack' && w.text === 'nope'));
});

test('buildTimelineRows：模擬只有部分回合 → partial 警告', () => {
  const sim = fakeSim();
  sim.events = sim.events.filter((e) => e.turn !== 1 && e.payload.turn !== 1);
  const out = buildTimelineRows({ doc, sim, attacks });
  assert.ok(out.warnings.some((w) => w.kind === 'partial'));
  assert.equal(out.rows[1].simulated, false);
});

test('orderSegments：重疊時往後推，保持不重疊且落在總長內', () => {
  const segs = orderSegments(
    [
      { kind: 'say', startMs: 0, endMs: 1000 },
      { kind: 'say', startMs: 500, endMs: 1600 },
      { kind: 'attack', startMs: 300, endMs: 900 },
    ],
    1600,
  );
  let last = 0;
  for (const seg of segs) {
    assert.ok(seg.startMs >= last, `重疊：${JSON.stringify(segs)}`);
    assert.ok(seg.endMs <= 1600, '不超出總長');
    last = seg.endMs;
  }
});

test('timeline keeps simulating the Doppeldoll ending after the final turn ends', async () => {
  const { readFile } = await import('node:fs/promises');
  const root = new URL('../../works/doppeldoll/', import.meta.url);
  const read = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
  const encounter = await read('encounters/doppeldoll.json');
  const resolveAttack = (name) => read(`attacks/${name}.json`);
  const short = await simulateTimeline(encounter, { resolveAttack, maxFrames: 5855 });
  assert.equal(short.sim.finished, false);
  assert.equal(short.sim.frames, 5855);
  const full = await simulateTimeline(encounter, { resolveAttack });
  assert.equal(full.sim.result, 'spared');
  assert.equal(full.sim.frames, 5986);
  assert.equal(full.sim.events.filter((event) => event.type === 'attackStart').length, 9);
});

test('formatSeconds', () => {
  assert.equal(formatSeconds(1500), '1.5s');
  assert.equal(formatSeconds(null), '0.0s');
  assert.equal(TIMELINE_FPS, 30);
});

test('encTimeline：三語鍵集合一致、英文表沒有 CJK', () => {
  assert.deepEqual(findKeyMismatches(STRINGS), []);
  for (const lang of LOCALE_IDS) assert.ok(STRINGS[lang], `缺少 ${lang}`);
  for (const [key, value] of Object.entries(STRINGS.en)) {
    assert.equal(typeof value, 'string', `en.${key} 不是字串`);
    assert.ok(!/[\u3400-\u9fff]/.test(value), `en.${key} 含中日韓字元：${value}`);
  }
});

/* ------------------------------------------------------------------
 * REALTEST-2 V2 / V14：回合內 attack cue 的攻擊、sim.errors、提早 break
 * ------------------------------------------------------------------ */

test('collectTimelineAttackNames：turn.attack ＋ 遞迴掃 attack cue', () => {
  const names = collectTimelineAttackNames({
    turns: [
      { attack: 'a1' },
      {
        attack: null,
        start: [
          { cmd: 'if', cond: 'vars.x', then: [{ cmd: 'attack', attack: 'a2' }], else: [{ cmd: 'attack', attack: 'a3' }] },
          { cmd: 'parallel', cues: [{ cmd: 'attack', attack: 'a4' }] },
          { cmd: 'attack', attack: { settings: {} } },
        ],
        end: [{ cmd: 'attack', attack: 'a5' }],
      },
    ],
    hooks: { onStart: [{ cmd: 'attack', attack: 'a6' }] },
    enemies: [{ acts: [{ cues: [{ cmd: 'attack', attack: 'a7' }] }] }],
  });
  assert.deepEqual([...names].sort(), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
  assert.deepEqual([...collectTimelineAttackNames(null)], []);
});

test('buildTimelineRows：sim.errors 轉成 engine 警告（不再被吞掉）', () => {
  const sim = fakeSim();
  sim.errors = [
    { path: 'attack', message: '找不到攻擊檔 "x"' },
    { path: 'attack', message: '找不到攻擊檔 "x"' },
  ];
  const out = buildTimelineRows({ doc, sim, attacks });
  const engine = out.warnings.filter((w) => w.kind === 'engine');
  assert.equal(engine.length, 1, '相同訊息只列一次');
  assert.match(engine[0].text, /找不到攻擊檔 "x"/);
});

test('buildTimelineRows：attack cue 的攻擊（turn.attack 為 null）有名字、長度與拍線', () => {
  const cueDoc = {
    turns: [{ id: 't1', attack: null, start: [{ cmd: 'attack', attack: 'cue-attack' }] }],
  };
  const sim = {
    frames: 200,
    result: 'spared',
    events: [
      { type: 'turnStart', frame: 0, turn: 0, payload: { turn: 0 } },
      { type: 'attackStart', frame: 30, turn: 0, payload: { ref: 'cue-attack', duration: 90 } },
      { type: 'attackEnd', frame: 120, turn: 0, payload: {} },
      { type: 'turnEnd', frame: 150, turn: 0, payload: { turn: 0 } },
    ],
  };
  const out = buildTimelineRows({
    doc: cueDoc,
    sim,
    attacks: new Map([['cue-attack', { settings: { duration: 3, bpm: 120 } }]]),
    fps: 30,
  });
  const seg = out.rows[0].segments.find((s) => s.kind === 'attack');
  assert.ok(seg, '應該有攻擊段');
  assert.equal(seg.attackName, 'cue-attack');
  near(seg.endMs - seg.startMs, 3000, 1);
  assert.equal(seg.bpm, 120);
  assert.equal(out.rows[0].attackName, 'cue-attack');
  assert.deepEqual(out.rows[0].attackNames, ['cue-attack']);
  assert.equal(out.simResult, 'spared');
  assert.equal(out.simFrames, 200);
});

test('simulateTimeline：attack cue 的攻擊會被預載並播完，且拿得到結果（rudinn 範例）', async () => {
  const { readFile } = await import('node:fs/promises');
  const root = new URL('../../samples/', import.meta.url);
  const enc = JSON.parse(await readFile(new URL('encounters/rudinn.json', root), 'utf8'));
  // 把第 2 回合的攻擊搬進 start 的 attack cue（turn.attack = null）
  const name = enc.turns[1].attack;
  enc.turns[1].attack = null;
  enc.turns[1].start = [...(enc.turns[1].start || []), { cmd: 'attack', attack: name }];
  const asked = [];
  const resolveAttack = async (n) => {
    asked.push(n);
    return JSON.parse(await readFile(new URL(`${n}.json`, root), 'utf8'));
  };
  const out = await simulateTimeline(enc, { resolveAttack, mode: 'demo' });
  assert.ok(asked.includes(name), `應預載 ${name}：${asked.join(',')}`);
  assert.deepEqual(out.sim.errors, [], JSON.stringify(out.sim.errors));
  assert.ok(out.sim.result, `應取得結果（實際 ${out.sim.result}）`);
  const built = buildTimelineRows({ doc: enc, sim: out.sim, attacks: out.attacks });
  const seg = built.rows[1].segments.find((s) => s.kind === 'attack');
  assert.ok(seg, '第 2 回合應該有攻擊段');
  assert.equal(seg.attackName, name);
  assert.ok(seg.endMs - seg.startMs > 1000, '攻擊段應有實際長度');
  assert.equal(built.warnings.filter((w) => w.kind === 'engine').length, 0);
  assert.equal(built.simResult, out.sim.result);
  assert.equal(built.simFrames, out.sim.frames);

  // 沒預載時（舊行為）：錯誤要出現在 warnings
  const broken = await simulateTimeline(enc, { resolveAttack: async (n) => (n === name ? null : resolveAttack(n)), mode: 'demo' });
  const brokenRows = buildTimelineRows({ doc: enc, sim: broken.sim, attacks: broken.attacks });
  assert.ok(brokenRows.warnings.some((w) => w.kind === 'engine' && w.text.includes(name)), JSON.stringify(brokenRows.warnings));
});
