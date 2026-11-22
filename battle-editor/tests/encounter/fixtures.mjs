/**
 * tests/encounter/fixtures.mjs — 測試用遭遇 / 攻擊資料
 *
 * 全部為純資料；不依賴 samples/（那些由 W2 維護，可能隨時變動）。
 */

/** 最小可用攻擊：中央向八方發射，用來測擦彈 / 命中 / TP */
export function demoAttack(over = {}) {
  return {
    format: 'dr-battle-attack/1',
    meta: { name: '測試彈幕' },
    settings: { duration: 1.0, seed: 3, damage: 5, grazeTP: 2, invincibleFrames: 10 },
    box: { x: 320, y: 240, w: 200, h: 140, border: 5, color: '#00c000' },
    party: [{ name: 'kris', hp: 90, maxHp: 90 }],
    bulletTypes: {
      b: { sprite: 'spr_smallbullet', hitbox: { shape: 'circle', r: 4 }, grazeable: true, destroyOnHit: true },
    },
    timeline: [
      { id: 'e1', at: 0, type: 'spawn', bullet: 'b', count: 8, x: 320, y: 240, speed: 1.2, angle: 'i * (360 / n)' },
    ],
    ...over,
  };
}

/** 擦彈專用：一發靜止子彈停在靈魂上方（距中心 10px → 擦得到、不會命中） */
export function grazeAttack(over = {}) {
  return {
    format: 'dr-battle-attack/1',
    meta: { name: '擦彈測試' },
    settings: { duration: 2.0, seed: 5, damage: 5, grazeTP: 3, invincibleFrames: 5 },
    box: { x: 320, y: 240, w: 300, h: 200 },
    party: [{ name: 'kris', hp: 90, maxHp: 90 }],
    bulletTypes: {
      g: { sprite: 'spr_smallbullet', hitbox: { shape: 'circle', r: 4 }, grazeable: true, destroyOnHit: true },
    },
    timeline: [
      // 靈魂在戰鬥框中間 (320,240)；這發停在正上方 10px：
      // 舊幾何擦彈（pad 16）與新心形遮罩擦彈（遮罩半徑 ~12 + hitbox 4）都擦得到；
      // 命中需要 dist < 8 → 10 不成立
      { id: 'g1', at: 0, type: 'spawn', bullet: 'g', count: 1, x: 320, y: 230, speed: 0, angle: 0 },
    ],
    ...over,
  };
}

/** 基礎遭遇（一個隊員、一個敵人、一回合、無彈幕） */
export function baseEncounter(over = {}) {
  const base = {
    format: 'dr-battle-encounter/1',
    meta: { name: '測試遭遇' },
    settings: { seed: 7, introText: '* 魯丁擋住了去路！', canFlee: false },
    actors: {
      kris: {
        kind: 'party',
        x: 92,
        y: 160,
        anims: {
          idle: { sprite: 'spr_krisb_idle', fps: 5, loop: true },
          hurt: { sprite: 'spr_krisb_hurt', fps: 10, loop: false, frames: 4, then: 'idle' },
          down: { sprite: 'spr_krisb_down', fps: 1, loop: false },
          attack: { sprite: 'spr_krisb_attack', fps: 15, loop: false, frames: 6, then: 'idle' },
        },
      },
      rudinn: {
        kind: 'enemy',
        x: 520,
        y: 200,
        anims: {
          idle: { sprite: 'spr_rudinn_idle', fps: 5, loop: true },
          hurt: { sprite: 'spr_rudinn_hurt', fps: 10, loop: false, frames: 4, then: 'idle' },
          happy: { sprite: 'spr_rudinn_happy', fps: 5, loop: true },
        },
      },
    },
    party: [
      {
        id: 'kris',
        actor: 'kris',
        name: 'Kris',
        hp: 90,
        maxHp: 90,
        atk: 10,
        def: 2,
        color: '#00ffff',
        commands: ['fight', 'act', 'item', 'spare', 'defend'],
      },
    ],
    enemies: [
      {
        id: 'rudinn',
        actor: 'rudinn',
        name: 'Rudinn',
        hp: 120,
        maxHp: 120,
        atk: 5,
        def: 0,
        mercy: 0,
        spareAt: 100,
        acts: [
          { id: 'check', name: 'Check', text: '* RUDINN — 攻擊 5 防禦 0', cues: [] },
          {
            id: 'compliment',
            name: 'Compliment',
            mercy: 50,
            cues: [
              { cmd: 'say', text: '* 你稱讚了魯丁的光澤。' },
              { cmd: 'mercy', enemy: 'rudinn', amount: 50 },
            ],
          },
        ],
        onHurt: [],
        onSpare: [],
        onDefeat: [],
      },
    ],
    items: [
      { id: 'darkburger', name: 'Dark Burger', count: 2, heal: 70, target: 'party', text: '* Kris 吃了黑暗漢堡。' },
    ],
    turns: [{ id: 't1', flavor: '* 魯丁在閃閃發光。', attack: null, start: [], end: [] }],
    turnOrder: 'loop-last',
    hooks: { intro: [], victory: [], spared: [], defeat: [], flee: [] },
    vars: { complimented: 0 },
  };
  // 淺層覆寫（測試只會覆寫頂層欄位）
  return { ...base, ...over };
}

/** 兩個回合 + intro hook 的遭遇 */
export function twoTurnEncounter(over = {}) {
  return baseEncounter({
    turns: [
      { id: 't1', flavor: '* 第一回合', attack: null, start: [{ cmd: 'wait', seconds: 0.1 }], end: [] },
      { id: 't2', flavor: '* 第二回合', attack: null, start: [], end: [{ cmd: 'sfx', sound: 'snd_end' }] },
    ],
    hooks: { intro: [{ cmd: 'say', text: '* 戰鬥開始！' }], victory: [], spared: [], defeat: [], flee: [] },
    ...over,
  });
}

/** 簡化輸入腳本工具：n 幀、每 k 幀按一次 confirm */
export function scriptedInputs(frames, { confirmEvery = 0, hold = null } = {}) {
  const out = [];
  for (let i = 0; i < frames; i += 1) {
    const press = [];
    if (confirmEvery > 0 && i % confirmEvery === 0) press.push('confirm');
    out.push({ press, hold: hold || {} });
  }
  return out;
}
