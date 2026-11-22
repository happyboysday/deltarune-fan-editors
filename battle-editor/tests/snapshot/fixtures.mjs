/**
 * tests/snapshot/fixtures.mjs — V2-08 快照測試的共用素材
 *
 * 全部照 SPEC-P2 §5 / SPEC §6 的公開介面操作：
 *   - 攻擊：createSimulation({ mode:'play' }) + load(sample) + stepFrame()
 *   - 遭遇：createEncounter({ canvas:null, resolveAttack }) + await load(sample) + step(1, input)
 *
 * 這裡不碰私有狀態，確保測試驗證的是「對外可觀察的狀態」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');

/** 四個攻擊範例（tests/autoplay 也用同一組） */
export const ATTACK_SAMPLES = ['spade-rain', 'ring-burst', 'box-shrink-aim', 'sine-wave'];

/** 三個遭遇範例（涵蓋一般戰鬥、演出、形態切換） */
export const ENCOUNTER_SAMPLES = ['rudinn', 'showcase', 'forms-demo'];

export async function loadModule(rel) {
  return import(pathToFileURL(path.join(ROOT, rel)).href);
}

export function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

export function readAttackSample(name) {
  return readJson(`samples/${name}.json`);
}

export function readEncounterSample(name) {
  return readJson(`samples/encounters/${name}.json`);
}

/**
 * 建立一個「乾淨的」攻擊模擬實例。
 * @param {object} doc 攻擊 JSON
 */
export async function makeSimulation(doc) {
  const { createSimulation } = await loadModule('engine/sim.js');
  const sim = createSimulation({ mode: 'play' });
  sim.load(doc);
  return sim;
}

/**
 * 建立一個乾淨的遭遇實例（無頭；攻擊檔從 samples/ 讀）。
 * @param {object} doc 遭遇 JSON
 */
export async function makeEncounter(doc) {
  const { createEncounter } = await loadModule('engine/encounter/index.js');
  const enc = createEncounter({
    canvas: null,
    assets: null,
    mode: 'play',
    resolveAttack: async (name) => {
      const p = path.join(ROOT, 'samples', `${name}.json`);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    },
  });
  await enc.load(doc);
  return enc;
}

/**
 * 決定性的「假玩家」輸入（攻擊模擬）：
 * 每 3 幀往右、每 5 幀往左下，偶爾慢速 → 足以讓靈魂擦彈 / 受傷。
 * @param {number} frame
 */
export function attackInput(frame) {
  const hold = {
    right: frame % 3 === 0,
    left: frame % 7 === 3,
    down: frame % 5 === 0,
    up: frame % 11 === 6,
    slow: frame % 13 === 0,
  };
  return {
    dx: (hold.right ? 1 : 0) - (hold.left ? 1 : 0),
    dy: (hold.down ? 1 : 0) - (hold.up ? 1 : 0),
    slow: hold.slow,
  };
}

/**
 * 決定性的「假玩家」輸入（遭遇戰）：方向鍵 + 週期性 Z / X，
 * 讓選單、行動結算、彈幕、對話都真的被推進到。
 * @param {number} frame
 */
export function encounterInput(frame) {
  const press = [];
  if (frame % 30 === 10) press.push('down');
  if (frame % 30 === 20) press.push('right');
  if (frame % 12 === 0) press.push('confirm');
  if (frame % 90 === 45) press.push('cancel');
  return {
    press,
    hold: {
      right: frame % 7 < 3,
      left: frame % 9 === 4,
      down: frame % 11 < 5,
      up: frame % 17 === 8,
      slow: frame % 13 === 0,
    },
  };
}

/** JSON 來回（模擬「存檔 → 讀檔」） */
export function roundTripJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 深層差異清單（測試失敗時顯示第一處不同的路徑）。
 * 回傳：['a.b[0].c: 1 != 2', ...]
 */
export function diffPaths(a, b, prefix = '', out = []) {
  if (Object.is(a, b)) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    out.push(`${prefix || '(root)'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${prefix}: 型別不一致（${Array.isArray(a) ? 'array' : 'object'} vs ${Array.isArray(b) ? 'array' : 'object'}）`);
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${prefix}.length: ${a.length} != ${b.length}`);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      diffPaths(a[i], b[i], `${prefix}[${i}]`, out);
    }
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    diffPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

/** 兩個值在 JSON 層級完全相等（含 key 順序） */
export function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 「直跑」錄製每一幀的對外狀態。
 * @param {object} sim 已經 load 的模擬
 * @param {number} frames 要走的幀數
 * @param {(frame:number)=>object} inputAt
 * @returns {object[]} states[i] = 走完第 i 幀後的 getState()
 */
export function recordSimulation(sim, frames, inputAt) {
  const states = [];
  for (let f = 0; f < frames; f += 1) {
    if (sim.ended) break;
    sim.stepFrame(inputAt(f));
    states.push(sim.getState());
  }
  return states;
}

/**
 * 「直跑」錄製每一幀的對外狀態（遭遇）。
 * @param {object} enc 已經 load 的遭遇
 * @param {number} frames
 * @param {(frame:number)=>object} inputAt
 */
export function recordEncounter(enc, frames, inputAt) {
  const states = [];
  for (let f = 0; f < frames; f += 1) {
    if (enc.result) break;
    enc.step(1, inputAt(f));
    states.push(enc.getState());
  }
  return states;
}
