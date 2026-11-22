/**
 * tests/encounter/t-anim.mjs — 演員動畫：非循環只播一次 / 停最後一幀 / then 切換
 *
 * SPEC-P2 §3「演員動畫狀態」：loop:false = 播一次；有 then 播完切過去；
 * 沒有 then 停在最後一幀；frames 省略時用素材實際幀數（spriteFrames 查詢）。
 */

import { group, test, eq, ok, notOk } from '../engine/harness.mjs';
import { createCueRunner } from '../../engine/encounter/cues.js';
import { createActorSystem } from '../../engine/encounter/actors.js';
import { animDuration, animTotalFrames, normalizeActor } from '../../engine/encounter/schema.js';
import { resolveActorFrame } from '../../engine/render-encounter.js';

/** 建立單一演員（anims 經 normalizeActor 正規化；可給 spriteFrames 查詢） */
function makeActors(anims, spriteFrames) {
  return createActorSystem(
    { kris: normalizeActor({ kind: 'party', anims }, 'kris') },
    spriteFrames ? { spriteFrames } : {},
  );
}

const ATTACK = { sprite: 'spr_attack', fps: 10, loop: false, frames: 7, then: 'idle' };
const DEFEND = { sprite: 'spr_defend', fps: 8, loop: false };

group('anim：幀數與長度（frames 省略 → 素材實際幀數）');

test('animTotalFrames：frames 優先、其次素材幀數、未知回 0', () => {
  eq(animTotalFrames({ frames: 6 }, 9), 6, 'frames 優先');
  eq(animTotalFrames({}, 9), 9, '省略 frames → 素材幀數');
  eq(animTotalFrames({ frames: 0 }, 0), 0, '都未知 → 0');
  eq(animTotalFrames({}, 0), 0, '素材也未知 → 0');
});

test('animDuration：素材幀數參與計算', () => {
  eq(animDuration({ frames: 7, fps: 10 }, 99), 0.7, 'frames/fps');
  eq(animDuration({ fps: 10 }, 7), 0.7, '素材 7 幀 / fps 10');
  eq(animDuration({ fps: 10, duration: 0.9 }, 0), 0.9, '未知幀數 → duration');
  eq(animDuration({ fps: 10 }, 0), 1, '全未知 → 退回 1 秒');
});

group('anim：非循環動畫只播一次');

test('frames:7 非循環：0..6 後停在最後一幀，播完切 then', () => {
  const a = makeActors({ idle: { sprite: 'spr_idle', fps: 5, loop: true }, attack: ATTACK });
  a.setAnim('kris', 'attack');
  const k = () => a.get('kris');
  eq(a.animFrame(k()), 0, '初始第 0 幀');
  for (let i = 0; i < 4; i += 1) a.update();
  eq(a.animFrame(k()), 1, '4 幀後第 1 格（fps 10）');
  for (let i = 0; i < 15; i += 1) a.update(); // 共 19 幀 = 0.633 秒
  eq(a.animFrame(k()), 6, '夾在最後一格');
  eq(k().animName, 'attack', '還沒播完');
  for (let i = 0; i < 4; i += 1) a.update(); // 共 23 幀 > 0.7 秒
  eq(k().animName, 'idle', '播完自動切 then=idle');
  eq(a.animDone('kris'), false, 'idle 是循環動畫，不算 done');
});

test('沒有 then 的非循環動畫停在最後一幀（defend，素材 6 幀）', () => {
  const a = makeActors(
    { idle: { sprite: 'spr_idle', fps: 5, loop: true }, defend: DEFEND },
    (name) => (name === 'spr_defend' ? 6 : 4),
  );
  a.setAnim('kris', 'defend');
  for (let i = 0; i < 24; i += 1) a.update(); // 0.8 秒 > 6/8 = 0.75 秒
  const k = a.get('kris');
  eq(k.animName, 'defend', '停在 defend（沒有 then）');
  eq(a.animDone('kris'), true, '非循環已播完');
  eq(a.animFrame(k), 5, '停在最後一幀（6 幀 → index 5）');
  for (let i = 0; i < 60; i += 1) a.update();
  eq(a.animFrame(k), 5, '之後仍是最後一幀，不會循環回 0');
});

test('setSprite 直接指定的非循環 sprite 也停在最後一幀', () => {
  const a = makeActors({ idle: { sprite: 'spr_idle', fps: 5, loop: true } }, (name) =>
    name === 'spr_defend' ? 6 : 4,
  );
  a.setSprite('kris', 'spr_defend', { fps: 8, loop: false });
  for (let i = 0; i < 24; i += 1) a.update();
  eq(a.animFrame(a.get('kris')), 5, '停在素材最後一幀');
  eq(a.animDone('kris'), true, '已播完');
});

test('frames 省略時用素材幀數決定播完時機（不是退回的 1 秒）', () => {
  const a = makeActors(
    {
      idle: { sprite: 'spr_idle', fps: 5, loop: true },
      attack: { sprite: 'spr_attack', fps: 10, loop: false, then: 'idle' },
    },
    (name) => (name === 'spr_attack' ? 7 : 4),
  );
  a.setAnim('kris', 'attack');
  for (let i = 0; i < 20; i += 1) a.update(); // 0.667 秒
  eq(a.get('kris').animName, 'attack', '0.667 秒時還在播');
  eq(a.animFrame(a.get('kris')), 6, '夾在素材最後一幀');
  for (let i = 0; i < 5; i += 1) a.update(); // 0.833 秒
  eq(a.get('kris').animName, 'idle', '0.7 秒播完切 idle（遠早於 1 秒）');
});

test('幀數完全未知：animFrame 回 raw，繪製端用素材幀數夾住', () => {
  const a = makeActors({
    idle: { sprite: 'spr_idle', fps: 5, loop: true },
    attack: { sprite: 'spr_attack', fps: 10, loop: false, then: 'idle' },
  });
  a.setAnim('kris', 'attack');
  for (let i = 0; i < 22; i += 1) a.update(); // 0.733 秒
  const snap = a.snapshot()[0];
  eq(snap.frame, 7, '未知幀數時回 raw 7（不取模、不夾）');
  eq(resolveActorFrame(snap, 7), 6, '繪製端用素材 7 幀夾成 6');
  for (let i = 0; i < 10; i += 1) a.update(); // > 1 秒
  eq(a.get('kris').animName, 'idle', '退回 1 秒後仍會切 then');
});

group('anim：循環動畫行為不變');

test('循環動畫照樣循環（frames 已知 / 只有素材幀數）', () => {
  const a = makeActors(
    {
      idle: { sprite: 'spr_idle', fps: 5, loop: true, frames: 6 },
      idle2: { sprite: 'spr_idle2', fps: 5, loop: true },
    },
    (name) => (name === 'spr_idle2' ? 4 : 6),
  );
  for (let i = 0; i < 9; i += 1) a.update(); // 0.3 秒 × 5fps = 1.5 → 1
  eq(a.animFrame(a.get('kris')), 1, 'frames:6 循環到第 1 格');
  for (let i = 0; i < 30; i += 1) a.update(); // 共 39 幀 = 1.3 秒
  eq(a.animFrame(a.get('kris')), 0, 'raw 6 % 6 = 0（循環回 0）');
  eq(a.animDone('kris'), false, '循環動畫永遠不算 done');

  a.setAnim('kris', 'idle2');
  for (let i = 0; i < 18; i += 1) a.update(); // 0.6 秒 × 5fps = 3
  eq(a.animFrame(a.get('kris')), 3, '素材 4 幀循環 raw 3');
  for (let i = 0; i < 9; i += 1) a.update(); // 共 27 幀 = 0.9 秒 × 5fps = 4.5
  eq(a.animFrame(a.get('kris')), 0, 'raw 4 % 4 = 0（循環回 0）');
});

group('anim：snapshot 提供繪製端所需欄位');

test('snapshot.animLoop / animFrames 隨動畫狀態更新', () => {
  const a = makeActors(
    { idle: { sprite: 'spr_idle', fps: 5, loop: true }, defend: DEFEND },
    (name) => (name === 'spr_defend' ? 6 : 4),
  );
  const s0 = a.snapshot()[0];
  eq(s0.animLoop, true, 'idle 是循環');
  eq(s0.animFrames, 4, 'idle 素材 4 幀');
  a.setAnim('kris', 'defend');
  for (let i = 0; i < 24; i += 1) a.update();
  const s1 = a.snapshot()[0];
  eq(s1.animLoop, false, 'defend 非循環');
  eq(s1.animFrames, 6, 'defend 素材 6 幀');
  eq(s1.frame, 5, 'snapshot.frame 停在最後一幀');
});

group('anim：繪製端選幀 helper（絕不取模）');

test('resolveActorFrame：非循環夾最後一幀、循環原樣、未知幀數原樣', () => {
  eq(resolveActorFrame({ frame: 12, animLoop: false }, 6), 5, '非循環夾到 count-1');
  eq(resolveActorFrame({ frame: 12, animLoop: true }, 6), 12, '循環原樣（drawSprite 取模）');
  eq(resolveActorFrame({ frame: 12, animLoop: false }, 0), 12, '幀數未知原樣');
  eq(resolveActorFrame({ frame: 12 }, 6), 12, '沒有 animLoop 視為循環');
  eq(resolveActorFrame({ frame: -3, animLoop: false }, 6), 0, '負值歸 0');
  eq(resolveActorFrame({ frame: 0, animLoop: false }, 1), 0, '單幀素材');
});

test('舊的循環動作可由具名 cue 覆寫成只播一次並等到最後一幀', () => {
  const actors = makeActors({
    idle: { sprite: 'idle', fps: 10, frames: 3 },
    attack: { sprite: 'attack', fps: 10, frames: 3, loop: true },
  });
  const runner = createCueRunner({ actors });
  const handle = runner.run([{ cmd: 'anim', actor: 'kris', anim: 'attack', loop: false, fps: 15, waitEnd: true }]);
  eq(handle.done, false);
  runner.update({});
  eq(actors.get('kris').anim.fps, 15);
  for (let i = 0; i < 30; i += 1) {
    actors.update();
    runner.update({});
  }
  eq(handle.done, true);
  eq(actors.animFrame(actors.get('kris')), 2);
  eq(actors.get('kris').anim.loop, false);
  const looping = runner.run([{ cmd: 'anim', actor: 'kris', anim: 'attack', loop: true, waitEnd: true }]);
  runner.update({});
  eq(looping.done, true, '顯式循環不會卡住 cue');
  eq(actors.get('kris').anim.loop, true, '可以明確選擇循環');
});
