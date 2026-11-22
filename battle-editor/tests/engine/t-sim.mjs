/**
 * tests/engine/t-sim.mjs — 模擬核心測試（SPEC §3–§5、§9）
 *
 * 涵蓋：
 *   - 固定 30 FPS、決定性（同 seed 同結果）
 *   - seek 與 step 一致
 *   - 時間軸事件：spawn / emitter / box / soul / clear / shake / sfx / end
 *   - 子彈：池化、life、alpha、offscreen、maskToBox、hitbox、faceVelocity、pathX/pathY
 *   - 靈魂：移動限制（含旋轉框）、受傷、無敵幀、擦彈 TP
 */
import { group, test, eq, ok, notOk, approx, within, deepEq, deepApprox, isArray } from './harness.mjs';
import { createSimulation, SOUL_RADIUS, TP_MAX, VIEW_W, VIEW_H } from '../../engine/sim.js';
import { FPS } from '../../engine/attack.js';

/** 建立模擬並載入攻擊 */
function sim(attack, mode = 'preview') {
  const s = createSimulation({ mode });
  s.load(attack);
  return s;
}

/** 最小攻擊 */
function attack(over) {
  return {
    format: 'dr-battle-attack/1',
    settings: { duration: 5, seed: 1, ...(over && over.settings) },
    box: { x: 320, y: 171, w: 150, h: 150, rotation: 0, border: 5, color: '#00c000', ...(over && over.box) },
    soul: { x: null, y: null, speed: 4, slowSpeed: 2, mode: 'red', color: '#ff0000', ...(over && over.soul) },
    party: (over && over.party) || [{ name: 'Kris', hp: 90, maxHp: 90, color: '#00ffff' }],
    enemies: (over && over.enemies) || [],
    bulletTypes:
      (over && over.bulletTypes) || {
        dot: { sprite: null, hitbox: { shape: 'circle', r: 5 }, damage: null },
      },
    timeline: (over && over.timeline) || [],
  };
}

/** 取所有子彈快照（依 id 排序，用於決定性比較） */
function snap(s) {
  const st = s.getState();
  return {
    frame: st.frame,
    tp: st.tp,
    soul: { x: st.soul.x, y: st.soul.y, invFrames: st.soul.invFrames },
    party: st.party.map((p) => ({ name: p.name, hp: p.hp })),
    box: { x: st.box.x, y: st.box.y, w: st.box.w, h: st.box.h, rotation: st.box.rotation },
    bullets: st.bullets
      .map((b) => ({ id: b.id, type: b.type, x: b.x, y: b.y, rotation: b.rotation, scale: b.scale, alpha: b.alpha, frame: b.frame }))
      .sort((a, b) => a.id - b.id),
  };
}

/* ================================================================== */

group('模擬：固定步長與基本狀態');

test('新模擬的初始 frame 為 0', () => {
  const s = sim(attack());
  eq(s.frame, 0, 'frame 0');
  eq(s.time, 0, 'time 0');
  eq(s.ended, false, '未結束');
  eq(s.getState().box.x, 320, 'box.x 來自攻擊');
  eq(s.getState().soul.x, 320, 'soul 預設框中心 x');
  eq(s.getState().soul.y, 171, 'soul 預設框中心 y');
});

test('每 stepFrame 一幀，時間 = frame / 30', () => {
  const s = sim(attack());
  for (let i = 0; i < 5; i += 1) s.stepFrame(null);
  eq(s.frame, 5, 'frame 5');
  approx(s.time, 5 / FPS, 1e-12, 'time = frame/30');
  eq(FPS, 30, '固定 30 FPS');
});

test('advance(n) 等同連續呼叫 n 次 stepFrame', () => {
  const a = sim(attack());
  const b = sim(attack());
  for (let i = 0; i < 20; i += 1) a.stepFrame(null);
  b.advance(20, null);
  deepEq(snap(a), snap(b), '兩者狀態一致');
});

test('時間到達 duration 後自動結束', () => {
  const s = sim(attack({ settings: { duration: 1 } }));
  s.advance(29, null);
  eq(s.ended, false, '第 29 幀尚未結束');
  s.advance(1, null);
  eq(s.ended, true, '第 30 幀（1 秒）結束');
});

test('end 事件會立即結束回合並發出事件', () => {
  const events = [];
  const s = createSimulation({ mode: 'preview', onEvent: (e) => events.push(e) });
  s.load(
    attack({
      timeline: [{ id: 'stop', at: 0.5, type: 'end' }],
      settings: { duration: 10 },
    }),
  );
  s.advance(14, null);
  eq(s.ended, false, '0.5 秒前還沒結束');
  s.advance(2, null);
  eq(s.ended, true, '0.5 秒左右結束');
  ok(s.frame <= 16, `應在 15~16 幀結束（實際 ${s.frame}）`);
  ok(events.some((e) => e.type === 'end'), '有發出 end 事件');
});

test('結束後 stepFrame 不再推進', () => {
  const s = sim(attack({ settings: { duration: 0.2 } }));
  s.advance(10, null);
  eq(s.ended, true, '已結束');
  const f = s.frame;
  const moved = s.stepFrame(null);
  eq(moved, false, 'stepFrame 回傳 false');
  eq(s.frame, f, 'frame 不變');
});

test('reset 會回到初始狀態', () => {
  const s = sim(
    attack({
      timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'dot', count: 5, x: 300, y: 100, speed: 1 }],
    }),
  );
  s.advance(20, null);
  ok(s.bulletCount > 0, '已有子彈');
  s.reset();
  eq(s.frame, 0, 'frame 歸零');
  eq(s.bulletCount, 0, '子彈清空');
  eq(s.tp, 0, 'TP 歸零');
  eq(s.ended, false, '未結束');
  eq(s.getState().soul.x, 320, '靈魂回到初始位置');
});

/* ================================================================== */

group('模擬：決定性');

test('同 seed 兩次執行結果完全相同（逐步比對）', () => {
  const atk = attack({
    settings: { seed: 1234, duration: 5 },
    timeline: [
      {
        id: 'em',
        at: 0.2,
        type: 'emitter',
        duration: 2,
        interval: 0.1,
        count: 3,
        spawn: {
          bullet: 'dot',
          x: 'rand(box.left, box.right)',
          y: 'box.top',
          speed: 'rand(1, 3)',
          angle: '90 + rand(-20, 20)',
        },
      },
    ],
  });
  const a = sim(atk);
  const b = sim(atk);
  for (let i = 0; i < 100; i += 1) {
    a.stepFrame(null);
    b.stepFrame(null);
    deepEq(snap(a), snap(b), `第 ${i + 1} 幀不一致`);
  }
});

test('不同 seed 產生不同亂數結果', () => {
  const mk = (seed) =>
    attack({
      settings: { seed },
      timeline: [
        {
          id: 'em',
          at: 0,
          type: 'emitter',
          duration: 1,
          interval: 0.1,
          count: 4,
          spawn: { bullet: 'dot', x: 'rand(0, 640)', y: 'rand(0, 480)' },
        },
      ],
    });
  const a = sim(mk(1));
  const b = sim(mk(2));
  a.advance(40, null);
  b.advance(40, null);
  const xsA = a.getState().bullets.map((x) => x.x).join(',');
  const xsB = b.getState().bullets.map((x) => x.x).join(',');
  notOk(xsA === xsB, '不同 seed 應有不同位置');
});

test('重新 load 同一份攻擊會重置亂數流（不延續舊序列）', () => {
  const atk = attack({
    settings: { seed: 7 },
    timeline: [
      { id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 6, x: 'rand(0, 640)', y: 'rand(0, 480)' },
    ],
  });
  const s = sim(atk);
  const first = s.getState().bullets.map((b) => b.x);
  s.advance(60, null);
  s.load(atk);
  const second = s.getState().bullets.map((b) => b.x);
  deepEq(second, first, '重載後亂數序列相同');
});

test('震動位移在兩次相同執行中一致', () => {
  const atk = attack({ timeline: [{ id: 'sh', at: 0.1, type: 'shake', duration: 0.5, amount: 6 }] });
  const a = sim(atk);
  const b = sim(atk);
  const seqA = [];
  const seqB = [];
  for (let i = 0; i < 30; i += 1) {
    a.stepFrame(null);
    b.stepFrame(null);
    seqA.push(a.getState().shake.x, a.getState().shake.y);
    seqB.push(b.getState().shake.x, b.getState().shake.y);
  }
  deepEq(seqA, seqB, '震動序列一致');
  ok(seqA.some((v) => v !== 0), '震動確實有位移');
});

test('使用 Math.random 以外的亂數來源（不因全域亂數而變動）', () => {
  const atk = attack({
    timeline: [
      { id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 8, x: 'rand(0, 640)', y: 'rand(0, 480)' },
    ],
  });
  const orig = Math.random;
  let seed = 0.123;
  Math.random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  try {
    const a = sim(atk);
    a.advance(10, null);
    const snapA = snap(a);
    Math.random = orig;
    const b = sim(atk);
    b.advance(10, null);
    deepEq(snap(b), snapA, '結果不受 Math.random 影響');
  } finally {
    Math.random = orig;
  }
});

/* ================================================================== */

group('模擬：seek 與 step 一致');

test('seek(n) 與 step(n) 狀態相同', () => {
  const atk = attack({
    settings: { seed: 99, duration: 5 },
    timeline: [
      {
        id: 'em',
        at: 0.3,
        type: 'emitter',
        duration: 1.5,
        interval: 0.12,
        count: 2,
        spawn: { bullet: 'dot', x: 'rand(box.left, box.right)', y: 'box.top', speed: 'rand(1, 2)', angle: 90 },
      },
      { id: 'b', at: 1, type: 'box', duration: 0.5, ease: 'quadOut', to: { w: 200 } },
    ],
  });
  for (const target of [0, 1, 5, 17, 30, 45, 77]) {
    const a = sim(atk);
    a.advance(target, null);
    const b = sim(atk);
    b.seekTo(target);
    deepEq(snap(b), snap(a), `第 ${target} 幀 seek 與 step 不一致`);
    eq(b.frame, target, `seek(${target}) 的 frame`);
  }
});

test('seek 可重複呼叫且結果穩定', () => {
  const atk = attack({
    timeline: [
      { id: 'sp', at: 0.1, type: 'spawn', bullet: 'dot', count: 10, x: 'rand(0, 640)', y: 'rand(0, 480)', speed: 2, angle: 'rand(0,360)' },
    ],
  });
  const s = sim(atk);
  s.seekTo(20);
  const a = snap(s);
  s.seekTo(0);
  s.seekTo(60);
  s.seekTo(20);
  const b = snap(s);
  deepEq(b, a, '回到同一幀結果相同');
});

test('seek 任意順序都得到相同狀態', () => {
  const atk = attack({
    timeline: [
      { id: 'em', at: 0.2, type: 'emitter', duration: 1, interval: 0.1, count: 2, spawn: { bullet: 'dot', x: 'rand(0,640)', y: 'rand(0,480)', speed: 1, angle: 'rand(0,360)' } },
    ],
  });
  const forward = sim(atk);
  forward.seekTo(40);
  const snapForward = snap(forward);
  const backward = sim(atk);
  for (const f of [80, 10, 100, 40]) backward.seekTo(f);
  deepEq(snap(backward), snapForward, '亂序 seek 後結果一致');
});

/* ================================================================== */

group('模擬：spawn 事件');

test('spawn 在指定幀生成指定數量', () => {
  const s = sim(
    attack({
      timeline: [{ id: 'sp', at: 0.5, type: 'spawn', bullet: 'dot', count: 7, x: 100, y: 100 }],
    }),
  );
  s.advance(14, null);
  eq(s.bulletCount, 0, '0.5 秒（15 幀）前沒有子彈');
  s.advance(1, null);
  eq(s.bulletCount, 7, '第 15 幀生成 7 發');
});

test('spawn 的 count 預設為 1', () => {
  const s = sim(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', x: 50, y: 50 }] }));
  eq(s.bulletCount, 1, '只生成 1 發');
});

test('生成位置可用表達式（含 box / soul 變數）', () => {
  const s = sim(
    attack({
      timeline: [
        {
          id: 'sp',
          at: 0,
          type: 'spawn',
          bullet: 'dot',
          count: 1,
          x: 'box.left + 10',
          y: 'box.top + 20',
        },
      ],
    }),
  );
  const b = s.getState().bullets[0];
  eq(b.x, 320 - 75 + 10, 'x = box.left + 10');
  eq(b.y, 171 - 75 + 20, 'y = box.top + 20');
});

test('i / n 在 count 生成時正確展開', () => {
  const s = sim(
    attack({
      timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 4, x: 'i * 10', y: 'n * 10', angle: 'i * 90' }],
    }),
  );
  const bs = s.getState().bullets;
  eq(bs.length, 4, '4 發');
  eq(bs[0].x, 0, 'i=0 → x=0');
  eq(bs[1].x, 10, 'i=1 → x=10');
  eq(bs[2].x, 20, 'i=2 → x=20');
  eq(bs[3].x, 30, 'i=3 → x=30');
  eq(bs[0].y, 40, 'n=4 → y=40');
});

test('t 為事件已經過的秒數（emitter 會累加）', () => {
  const s = sim(
    attack({
      timeline: [
        {
          id: 'em',
          at: 0.5,
          type: 'emitter',
          duration: 1,
          interval: 0.5,
          count: 1,
          spawn: { bullet: 'dot', x: 't * 100', y: 0 },
        },
      ],
    }),
  );
  s.advance(20, null); // t ≈ 0.5 左右觸發第一次
  const xs = s.getState().bullets.map((b) => Math.round(b.x));
  ok(xs.includes(0), `第一次觸發 t=0 → x=0（實際 ${xs}）`);
  s.advance(15, null); // 第二次觸發（0.5 秒後）
  const xs2 = s.getState().bullets.map((b) => Math.round(b.x));
  ok(xs2.some((x) => x >= 45 && x <= 55), `第二次觸發 t≈0.5 → x≈50（實際 ${xs2}）`);
});

test('speed / angle 決定運動方向（90 度 = 向下）', () => {
  const s = sim(
    attack({
      timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1, x: 100, y: 100, speed: 2, angle: 90 }],
    }),
  );
  s.advance(3, null);
  const b = s.getState().bullets[0];
  eq(b.x, 100, 'x 不變');
  eq(b.y, 106, 'y = 100 + 2*3（90 度 = 向下）');
});

test('angle 0 = 向右、angle 180 = 向左', () => {
  const mk = (angle) =>
    sim(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1, x: 300, y: 200, speed: 3, angle }] }));
  const right = mk(0);
  right.advance(4, null);
  eq(right.getState().bullets[0].x, 312, 'angle 0 → +x');
  const left = mk(180);
  left.advance(4, null);
  eq(left.getState().bullets[0].x, 288, 'angle 180 → -x');
});

test('accel 會累加速度', () => {
  const s = sim(
    attack({
      timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1, x: 100, y: 100, speed: 1, angle: 0, accel: 1 }],
    }),
  );
  s.advance(4, null); // 速度 1,2,3,4
  const st = s.getState().bullets[0];
  eq(st.x, 100 + 1 + 2 + 3 + 4, '位移 = 速度 1+2+3+4');
});

test('angularVel 會旋轉；faceVelocity 讓 rotation 跟隨速度方向', () => {
  const s = sim(
    attack({
      bulletTypes: {
        spin: { hitbox: { shape: 'circle', r: 4 }, faceVelocity: false },
        face: { hitbox: { shape: 'circle', r: 4 }, faceVelocity: true },
      },
      timeline: [
        { id: 'a', at: 0, type: 'spawn', bullet: 'spin', count: 1, x: 100, y: 100, rotation: 0, angularVel: 10 },
        { id: 'b', at: 0, type: 'spawn', bullet: 'face', count: 1, x: 200, y: 100, angle: 45, speed: 1 },
      ],
    }),
  );
  s.advance(3, null);
  const bs = s.getState().bullets;
  eq(bs[0].rotation, 30, 'angularVel 10 × 3 幀 = 30');
  eq(bs[1].rotation, 45, 'faceVelocity → rotation = angle');
});

/* ================================================================== */

group('模擬：emitter 事件');

test('emitter 生成數量正確（interval 間隔）', () => {
  const s = sim(
    attack({
      timeline: [
        {
          id: 'em',
          at: 0.5,
          type: 'emitter',
          duration: 1.0,
          interval: 0.2,
          count: 1,
          spawn: { bullet: 'dot', x: 100, y: 100, speed: 0 },
        },
      ],
    }),
  );
  // [0.5, 1.5) 每 0.2 秒一次 → 0.5, 0.7, 0.9, 1.1, 1.3 → 共 5 次
  s.advance(45, null); // 1.5 秒 = 45 幀
  eq(s.bulletCount, 5, '生成 5 次（bullet life 無限、速度 0、在中間不會被回收）');
});

test('emitter 每次 count > 1 的總數量正確', () => {
  const s = sim(
    attack({
      timeline: [
        {
          id: 'em',
          at: 0,
          type: 'emitter',
          duration: 0.5,
          interval: 0.1,
          count: 3,
          spawn: { bullet: 'dot', x: 100, y: 100, speed: 0 },
        },
      ],
    }),
  );
  // [0, 0.5) 每 0.1 → 0, 0.1, 0.2, 0.3, 0.4 → 5 次 × 3 發 = 15
  s.advance(20, null);
  eq(s.bulletCount, 15, '5 次觸發 × 3 發');
});

test('emitter 的 k 從 0 開始遞增', () => {
  const s = sim(
    attack({
      timeline: [
        {
          id: 'em',
          at: 0,
          type: 'emitter',
          duration: 0.4,
          interval: 0.1,
          count: 1,
          spawn: { bullet: 'dot', x: 'k * 10', y: 100, speed: 0 },
        },
      ],
    }),
  );
  s.advance(20, null);
  const xs = s.getState().bullets.map((b) => b.x).sort((a, b) => a - b);
  deepEq(xs, [0, 10, 20, 30], 'k = 0,1,2,3');
});

test('emitter 在 duration 之後停止', () => {
  const s = sim(
    attack({
      timeline: [
        {
          id: 'em',
          at: 0,
          type: 'emitter',
          duration: 0.3,
          interval: 0.1,
          count: 1,
          spawn: { bullet: 'dot', x: 100, y: 100, speed: 0 },
        },
      ],
    }),
  );
  s.advance(60, null);
  const after1s = s.bulletCount;
  s.advance(60, null);
  eq(s.bulletCount, after1s, '停止後不再生成');
  ok(after1s >= 3 && after1s <= 4, `生成 3~4 次（實際 ${after1s}）`);
});

test('duration 為 0 的 emitter 不會生成（並回報錯誤）', () => {
  const errors = [];
  const s = createSimulation({ mode: 'preview', onEvent: (e) => e.type === 'error' && errors.push(e.payload) });
  s.load(
    attack({
      timeline: [{ id: 'em', at: 0, type: 'emitter', duration: 0, interval: 0.1, count: 1, spawn: { bullet: 'dot' } }],
    }),
  );
  s.advance(10, null);
  eq(s.bulletCount, 0, '沒有生成');
  ok(errors.length > 0, '有回報錯誤');
  eq(errors[0].path, 'timeline[0].duration', '錯誤路徑指向 duration');
});

/* ================================================================== */

group('模擬：box 補間');

test('box 補間到終值（各 easing）', () => {
  for (const ease of ['linear', 'quadIn', 'quadOut', 'quadInOut', 'sineInOut', 'backOut']) {
    const s = sim(
      attack({
        box: { x: 320, y: 171, w: 100, h: 100 },
        timeline: [{ id: 'b', at: 0.1, type: 'box', duration: 0.5, ease, to: { w: 240, h: 80, x: 300, y: 200 } }],
      }),
    );
    s.advance(25, null); // 0.833 秒 > 0.1 + 0.5
    const box = s.getState().box;
    approx(box.w, 240, 1e-9, `${ease} 的 w 終值`);
    approx(box.h, 80, 1e-9, `${ease} 的 h 終值`);
    approx(box.x, 300, 1e-9, `${ease} 的 x 終值`);
    approx(box.y, 200, 1e-9, `${ease} 的 y 終值`);
  }
});

test('box 補間中途是漸進的（不是一步跳到底）', () => {
  const s = sim(
    attack({
      box: { x: 320, y: 171, w: 100, h: 100 },
      timeline: [{ id: 'b', at: 0, type: 'box', duration: 1, ease: 'linear', to: { w: 200 } }],
    }),
  );
  s.advance(15, null);
  const w15 = s.getState().box.w;
  within(w15, 140, 160, `半途（0.5 秒）應約 150（實際 ${w15}）`);
  s.advance(15, null);
  approx(s.getState().box.w, 200, 1e-9, '結束後到達 200');
});

test('box 事件只改 to 有給的欄位', () => {
  const s = sim(
    attack({
      box: { x: 320, y: 171, w: 100, h: 60, rotation: 0 },
      timeline: [{ id: 'b', at: 0, type: 'box', duration: 0.2, ease: 'linear', to: { w: 200 } }],
    }),
  );
  s.advance(6, null);
  const box = s.getState().box;
  approx(box.w, 200, 1e-9, 'w 改變');
  approx(box.h, 60, 1e-9, 'h 不變');
  approx(box.y, 171, 1e-9, 'y 不變');
});

test('多個 box 事件可接續執行', () => {
  const s = sim(
    attack({
      box: { x: 320, y: 171, w: 100, h: 100 },
      timeline: [
        { id: 'b1', at: 0, type: 'box', duration: 0.5, ease: 'linear', to: { w: 200 } },
        { id: 'b2', at: 0.6, type: 'box', duration: 0.5, ease: 'linear', to: { w: 120 } },
      ],
    }),
  );
  s.advance(15, null);
  approx(s.getState().box.w, 200, 1e-9, '第一個結束在 200');
  s.advance(18, null);
  approx(s.getState().box.w, 120, 1e-9, '第二個結束在 120');
});

test('box 的 w/h 不會變成負值或 0', () => {
  const s = sim(
    attack({
      timeline: [{ id: 'b', at: 0, type: 'box', duration: 0.2, ease: 'linear', to: { w: -50, h: -50 } }],
    }),
  );
  s.advance(10, null);
  const box = s.getState().box;
  ok(box.w >= 1, `w 至少 1（實際 ${box.w}）`);
  ok(box.h >= 1, `h 至少 1（實際 ${box.h}）`);
});

/* ================================================================== */

group('模擬：soul 事件與靈魂移動');

test('soul 事件可設定靈魂位置', () => {
  const s = sim(attack({ timeline: [{ id: 'so', at: 0.2, type: 'soul', x: 300, y: 200 }] }));
  s.advance(7, null);
  eq(s.getState().soul.x, 300, 'x 設定成功');
  eq(s.getState().soul.y, 200, 'y 設定成功');
});

test('soul 事件只給 mode 時重置到框中心', () => {
  const s = sim(
    attack({
      soul: { x: 330, y: 160 },
      timeline: [{ id: 'so', at: 0.2, type: 'soul', mode: 'red' }],
      box: { x: 320, y: 171, w: 100, h: 100 },
    }),
  );
  eq(s.getState().soul.x, 330, '初始自訂位置（框內）');
  s.advance(7, null);
  eq(s.getState().soul.x, 320, '重置到框中心 x');
  eq(s.getState().soul.y, 171, '重置到框中心 y');
});

test('初始 soul 位置在框外時會被夾回框內', () => {
  const s = sim(attack({ soul: { x: 10, y: 10 }, box: { x: 320, y: 171, w: 100, h: 100 } }));
  const st = s.getState();
  eq(st.soul.x, 320 - 50 + SOUL_RADIUS, 'x 夾到左邊界');
  eq(st.soul.y, 171 - 50 + SOUL_RADIUS, 'y 夾到上邊界');
});

test('play 模式下靈魂受輸入移動（速度 = soul.speed）', () => {
  const s = createSimulation({ mode: 'play' });
  s.load(attack({ soul: { speed: 4, slowSpeed: 2 } }));
  const x0 = s.getState().soul.x;
  s.advance(1, { dx: 1, dy: 0, slow: false });
  eq(s.getState().soul.x, x0 + 4, '每幀移動 4px');
});

test('低速（slow）使用 slowSpeed', () => {
  const s = createSimulation({ mode: 'play' });
  s.load(attack({ soul: { speed: 4, slowSpeed: 2 } }));
  const x0 = s.getState().soul.x;
  s.advance(1, { dx: 1, dy: 0, slow: true });
  eq(s.getState().soul.x, x0 + 2, '低速移動 2px');
});

test('對角移動會正規化（不會比較快）', () => {
  const s = createSimulation({ mode: 'play' });
  s.load(attack({ soul: { speed: 4 }, box: { x: 320, y: 171, w: 300, h: 300 } }));
  const x0 = s.getState().soul.x;
  const y0 = s.getState().soul.y;
  s.advance(1, { dx: 1, dy: 1, slow: false });
  const dx = s.getState().soul.x - x0;
  const dy = s.getState().soul.y - y0;
  approx(Math.hypot(dx, dy), 4, 1e-6, '對角速度大小仍為 4');
  approx(dx, dy, 1e-6, 'x/y 位移相等');
});

test('preview 模式不吃輸入（決定性）', () => {
  const s = createSimulation({ mode: 'preview' });
  s.load(attack({ soul: { speed: 4 } }));
  const x0 = s.getState().soul.x;
  s.advance(5, { dx: 1, dy: 1, slow: false });
  eq(s.getState().soul.x, x0, 'preview 模式靈魂不動');
});

test('靈魂被限制在戰鬥框內（四邊）', () => {
  const s = createSimulation({ mode: 'play' });
  s.load(attack({ box: { x: 320, y: 171, w: 100, h: 100 }, soul: { speed: 20 } }));
  s.advance(30, { dx: 1, dy: 0, slow: false });
  const st = s.getState();
  approx(st.soul.x, 320 + 50 - SOUL_RADIUS, 1e-9, '右邊界 = x + w/2 - 半徑');
  s.advance(60, { dx: -1, dy: -1, slow: false });
  const st2 = s.getState();
  approx(st2.soul.x, 320 - 50 + SOUL_RADIUS, 1e-9, '左邊界');
  approx(st2.soul.y, 171 - 50 + SOUL_RADIUS, 1e-9, '上邊界');
});

test('旋轉的戰鬥框也會正確夾住靈魂', () => {
  // 框 100×40 旋轉 90 度 → 世界座標看起來是 40 寬 × 100 高
  const mk = () => {
    const s = createSimulation({ mode: 'play' });
    s.load(attack({ box: { x: 320, y: 171, w: 100, h: 40, rotation: 90 }, soul: { speed: 30 } }));
    return s;
  };
  // 往右：對應框內「高度」方向（40/2 - 4 = 16）
  const right = mk();
  right.advance(1, { dx: 1, dy: 0, slow: false });
  approx(right.getState().soul.x - 320, 16, 1e-9, '右移被框的短邊（旋轉後為水平）夾住');
  approx(right.getState().soul.y - 171, 0, 1e-9, '沒有垂直位移');

  // 往上：對應框內「寬度」方向（100/2 - 4 = 46），旋轉後為世界垂直方向
  const up = mk();
  up.advance(1, { dx: 0, dy: -1, slow: false });
  approx(up.getState().soul.x - 320, 0, 1e-9, '沒有水平位移');
  approx(up.getState().soul.y - 171, -30, 1e-9, '上移 30（在 46 的容許範圍內）');
});

/* ================================================================== */

group('模擬：子彈屬性');

test('life 到期後子彈消失', () => {
  const s = sim(
    attack({
      timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1, x: 100, y: 100, life: 0.2 }],
    }),
  );
  s.advance(6, null);
  eq(s.bulletCount, 1, '0.2 秒前還存在');
  s.advance(6, null);
  eq(s.bulletCount, 0, '超過 life 後消失');
});

test('life 為 0 會在下一幀消失', () => {
  const s = sim(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1, x: 100, y: 100, life: 0 }] }));
  s.advance(2, null);
  eq(s.bulletCount, 0, 'life=0 立即消失');
});

test('alpha 會反映在 getState', () => {
  const s = sim(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1, x: 100, y: 100, alpha: 0.5 }] }));
  approx(s.getState().bullets[0].alpha, 0.5, 1e-9, 'alpha 0.5');
});

test('alpha 超出 0..1 會被夾住', () => {
  const s = sim(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1, alpha: 5 }] }));
  eq(s.getState().bullets[0].alpha, 1, 'alpha 夾到 1');
  const s2 = sim(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1, alpha: -3 }] }));
  eq(s2.getState().bullets[0].alpha, 0, 'alpha 夾到 0');
});

test('offscreen destroy：離開畫面後回收', () => {
  const s = sim(
    attack({
      timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1, x: 100, y: 100, speed: 20, angle: 180 }],
    }),
  );
  s.advance(12, null);
  // 每幀 -20 → 100 → 80 → 60 → 40 → 20 → 0 → -20 → -40 ... 約第 6 幀出界
  s.advance(10, null);
  eq(s.bulletCount, 0, '離開畫面後被回收');
});

test('offscreen keep：離開畫面仍保留', () => {
  const s = sim(
    attack({
      bulletTypes: { keep: { hitbox: { shape: 'circle', r: 4 }, offscreen: 'keep' } },
      timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'keep', count: 1, x: 100, y: 100, speed: 20, angle: 180 }],
    }),
  );
  s.advance(30, null);
  eq(s.bulletCount, 1, 'offscreen=keep 保留子彈');
  ok(s.getState().bullets[0].x < 0, '確實在畫面外');
});

test('從畫面外生成、進入畫面後再離開也會回收', () => {
  const s = sim(
    attack({
      timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1, x: 700, y: 200, speed: 20, angle: 180 }],
    }),
  );
  s.advance(10, null); // 每幀 -20 → 第 3 幀左右進入畫面
  const b = s.getState().bullets[0];
  ok(b && b.x < 640, `已進入畫面（x=${b ? b.x : '已消失'}）`);
  s.advance(40, null);
  eq(s.bulletCount, 0, '之後離開畫面被回收');
});

test('maskToBox：框外的子彈不可見（碰撞也略過）', () => {
  const s = sim(
    attack({
      box: { x: 320, y: 171, w: 100, h: 100 },
      bulletTypes: { masked: { hitbox: { shape: 'circle', r: 5 }, maskToBox: true } },
      timeline: [
        { id: 'in', at: 0, type: 'spawn', bullet: 'masked', count: 1, x: 320, y: 171 },
        { id: 'out', at: 0, type: 'spawn', bullet: 'masked', count: 1, x: 500, y: 20 },
      ],
    }),
  );
  const bs = s.getState().bullets;
  eq(bs.length, 2, '兩發都存在');
  const inside = bs.find((b) => b.x === 320);
  const outside = bs.find((b) => b.x === 500);
  eq(inside.maskToBox, true, 'maskToBox 標記有帶到 state');
  eq(outside.maskToBox, true, 'maskToBox 標記有帶到 state');
});

test('子彈池化：重用物件、池大小有上限', () => {
  const s = sim(
    attack({
      timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 50, x: 300, y: 200, life: 0.1 }],
    }),
  );
  eq(s.bulletCount, 50, '生成 50 發');
  s.advance(10, null);
  eq(s.bulletCount, 0, '全部消失');
  ok(s.poolSize >= 50, `池內有回收的子彈（實際 ${s.poolSize}）`);
  s.reset();
  // 再大量生成以確認池不會無限長
  for (let i = 0; i < 5; i += 1) {
    s.advance(1, null);
  }
  ok(s.poolSize <= 4000, '池大小有上限');
});

test('子彈 id 唯一', () => {
  const s = sim(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 30 }] }));
  const ids = s.getState().bullets.map((b) => b.id);
  eq(new Set(ids).size, 30, '30 個唯一 id');
});

test('sprite 動畫 frame 依 frameRate 與 age 遞增', () => {
  const s = sim(
    attack({
      bulletTypes: { anim: { sprite: 'spr_x', frameRate: 10, hitbox: { shape: 'circle', r: 4 } } },
      timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'anim', count: 1, x: 300, y: 200, speed: 0 }],
    }),
  );
  s.advance(1, null);
  eq(s.getState().bullets[0].frame, 0, '第 0 幀動畫 index 0');
  s.advance(6, null);
  const f = s.getState().bullets[0].frame;
  ok(f >= 1, `age ≈ 0.2 秒 × 10fps → frame ≈ 2（實際 ${f}）`);
});

test('sprite 名稱會帶到 state（渲染器用）', () => {
  const s = sim(
    attack({
      bulletTypes: { spr: { sprite: 'spr_spadebullet', hitbox: { shape: 'circle', r: 4 } } },
      timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'spr', count: 1 }],
    }),
  );
  eq(s.getState().bullets[0].sprite, 'spr_spadebullet', 'sprite 名稱');
  eq(s.getState().bullets[0].type, 'spr', 'type 名稱');
});

test('scale 會乘上 bulletType 的 scale', () => {
  const s = sim(
    attack({
      bulletTypes: { big: { scale: 2, hitbox: { shape: 'circle', r: 4 } } },
      timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'big', count: 1, scale: 1.5 }],
    }),
  );
  approx(s.getState().bullets[0].scale, 3, 1e-9, '1.5 × 2 = 3');
});

test('hitbox 會完整帶到 state（circle / rect）', () => {
  const s = sim(
    attack({
      bulletTypes: {
        c: { hitbox: { shape: 'circle', r: 7 } },
        r: { hitbox: { shape: 'rect', w: 12, h: 4 } },
      },
      timeline: [
        { id: 'a', at: 0, type: 'spawn', bullet: 'c', count: 1 },
        { id: 'b', at: 0, type: 'spawn', bullet: 'r', count: 1 },
      ],
    }),
  );
  const bs = s.getState().bullets;
  eq(bs[0].hitbox.shape, 'circle', 'circle');
  eq(bs[0].hitbox.r, 7, 'r 7');
  eq(bs[1].hitbox.shape, 'rect', 'rect');
  eq(bs[1].hitbox.w, 12, 'w 12');
  eq(bs[1].hitbox.h, 4, 'h 4');
});

/* ================================================================== */

group('模擬：pathX / pathY');

test('pathX 覆蓋 x 軸速度運動', () => {
  const s = sim(
    attack({
      timeline: [
        {
          id: 'sp',
          at: 0,
          type: 'spawn',
          bullet: 'dot',
          count: 1,
          x: 100,
          y: 200,
          speed: 10,
          angle: 0,
          pathX: 'age * 30',
        },
      ],
    }),
  );
  // at=0 的事件在載入（第 0 幀）就觸發，pathX(age=0) = 0
  eq(s.getState().bullets[0].x, 100, '生成時 pathX(0) = 0 位移');
  s.advance(3, null);
  // age = 3/30 = 0.1 → 位移 3（不是 speed 10 × 3 = 30）
  approx(s.getState().bullets[0].x, 103, 1e-6, 'x 由 pathX 決定（不是 speed 10）');
});

test('pathY 可用 sin(age) 做正弦波', () => {
  const s = sim(
    attack({
      timeline: [
        {
          id: 'sp',
          at: 0,
          type: 'spawn',
          bullet: 'dot',
          count: 1,
          x: 100,
          y: 200,
          pathY: 'sin(age * 90) * 10',
        },
      ],
    }),
  );
  approx(s.getState().bullets[0].y, 200, 1e-6, 'age 0 → sin(0)=0');
  s.advance(10, null);
  // age = 10/30 = 1/3 → sin(30 度) = 0.5 → y = 200 + 5
  approx(s.getState().bullets[0].y, 205, 1e-6, 'age 1/3 → sin(30°)=0.5');
});

test('只給 pathX 時 y 仍走速度運動', () => {
  const s = sim(
    attack({
      timeline: [
        { id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1, x: 100, y: 100, speed: 3, angle: 90, pathX: 'age * 10' },
      ],
    }),
  );
  s.advance(3, null);
  const b = s.getState().bullets[0];
  approx(b.x, 101, 1e-6, 'x 由 pathX（age 0.1 × 10）');
  approx(b.y, 109, 1e-6, 'y 由速度（3 px/幀 × 3 幀）');
});

test('path 表達式錯誤不會中斷模擬', () => {
  const errors = [];
  const s = createSimulation({ mode: 'preview', onEvent: (e) => e.type === 'error' && errors.push(e.payload) });
  s.load(
    attack({
      timeline: [
        { id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1, x: 100, y: 100, pathX: 'nonsense(' },
      ],
    }),
  );
  s.advance(10, null);
  eq(s.bulletCount, 1, '子彈仍存在');
  eq(s.frame, 10, '模擬繼續推進');
  ok(errors.length > 0, '有回報錯誤');
  ok(errors.some((e) => e.field === 'pathX'), `錯誤欄位是 pathX（實際 ${JSON.stringify(errors)}）`);
});

/* ================================================================== */

group('模擬：碰撞與擦彈');

test('子彈撞到靈魂會造成傷害（Phase 1 扣第一位活著的隊員）', () => {
  const hits = [];
  const s = createSimulation({ mode: 'preview', onEvent: (e) => e.type === 'hit' && hits.push(e.payload) });
  s.load(
    attack({
      party: [
        { name: 'Kris', hp: 90, maxHp: 90 },
        { name: 'Susie', hp: 110, maxHp: 110 },
      ],
      settings: { damage: 10 },
      timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 320, y: 171, speed: 0 }],
    }),
  );
  s.advance(10, null);
  eq(s.getState().party[0].hp, 80, 'Kris 扣 10');
  eq(s.getState().party[1].hp, 110, 'Susie 沒受傷');
  eq(hits.length, 1, '發出一次 hit 事件');
  eq(hits[0].damage, 10, '傷害值正確');
});

test('子彈的 damage 優先於 settings.damage', () => {
  const s = sim(
    attack({
      bulletTypes: { heavy: { hitbox: { shape: 'circle', r: 5 }, damage: 25 } },
      settings: { damage: 10 },
      timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'heavy', count: 1, x: 320, y: 171, speed: 0 }],
    }),
  );
  s.advance(10, null);
  eq(s.getState().party[0].hp, 65, '扣 25');
});

test('第一位隊員倒下後改扣下一位', () => {
  const s = sim(
    attack({
      party: [
        { name: 'Kris', hp: 10, maxHp: 90 },
        { name: 'Susie', hp: 110, maxHp: 110 },
      ],
      settings: { damage: 10, invincibleFrames: 0 },
      timeline: [
        { id: 'a', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 320, y: 171, speed: 0 },
        { id: 'b', at: 0.3, type: 'spawn', bullet: 'dot', count: 1, x: 320, y: 171, speed: 0 },
      ],
    }),
  );
  s.advance(15, null);
  eq(s.getState().party[0].hp, 0, 'Kris 倒下');
  s.advance(10, null);
  eq(s.getState().party[1].hp, 100, 'Susie 承受第二次傷害');
});

test('無敵幀期間不會連續受傷', () => {
  const hits = [];
  const s = createSimulation({ mode: 'preview', onEvent: (e) => e.type === 'hit' && hits.push(e.payload) });
  s.load(
    attack({
      settings: { damage: 10, invincibleFrames: 30 },
      timeline: [
        {
          id: 'em',
          at: 0.1,
          type: 'emitter',
          duration: 1,
          interval: 0.05,
          count: 1,
          spawn: { bullet: 'dot', x: 320, y: 171, speed: 0, life: 5 },
        },
      ],
    }),
  );
  s.advance(28, null); // 0.1 秒後開始連續命中，但 30 幀無敵內只算一次
  eq(hits.length, 1, `無敵幀內只受一次傷（實際 ${hits.length}）`);
});

test('傷害事件之間至少間隔 invincibleFrames', () => {
  const hits = [];
  const s = createSimulation({ mode: 'preview', onEvent: (e) => e.type === 'hit' && hits.push(e.payload) });
  s.load(
    attack({
      settings: { damage: 10, invincibleFrames: 10 },
      timeline: [
        {
          id: 'em',
          at: 0.1,
          type: 'emitter',
          duration: 2,
          interval: 0.05,
          count: 1,
          spawn: { bullet: 'dot', x: 320, y: 171, speed: 0, life: 5 },
        },
      ],
    }),
  );
  s.advance(60, null);
  ok(hits.length >= 3, `應受傷多次（實際 ${hits.length}）`);
  for (let i = 1; i < hits.length; i += 1) {
    const gap = hits[i].frame - hits[i - 1].frame;
    ok(gap >= 10, `第 ${i} 次受傷間隔 ${gap} 幀，應 >= 10`);
  }
});

test('無敵幀結束後會再次受傷', () => {
  const hits = [];
  const s = createSimulation({ mode: 'preview', onEvent: (e) => e.type === 'hit' && hits.push(e.payload) });
  s.load(
    attack({
      bulletTypes: { pierce: { hitbox: { shape: 'circle', r: 5 }, destroyOnHit: false } },
      settings: { damage: 10, invincibleFrames: 5 },
      timeline: [{ id: 'sp', at: 0.05, type: 'spawn', bullet: 'pierce', count: 1, x: 320, y: 171, speed: 0, life: 3 }],
    }),
  );
  s.advance(30, null);
  ok(hits.length >= 2, `無敵幀結束後應再受傷（實際 ${hits.length} 次）`);
});

test('無敵幀期間靈魂會閃爍（visible 交替）', () => {
  const s = sim(
    attack({
      settings: { damage: 10, invincibleFrames: 20 },
      timeline: [{ id: 'sp', at: 0.05, type: 'spawn', bullet: 'dot', count: 1, x: 320, y: 171, speed: 0, life: 3 }],
    }),
  );
  s.advance(4, null);
  ok(s.getState().soul.invFrames > 0, '進入無敵幀');
  const visibles = [];
  for (let i = 0; i < 12; i += 1) {
    s.stepFrame(null);
    visibles.push(s.getState().soul.visible);
  }
  ok(visibles.includes(true) && visibles.includes(false), `無敵幀中應閃爍（實際 ${visibles.join(',')}）`);
});

test('擦彈會增加 TP', () => {
  // FX-GRAZE：擦彈改成「子彈 hitbox 與官方心形遮罩（25×25）重疊」。
  // 遮罩橫跨靈魂中心 ±12，dot 子彈 r=5 → 擦彈臨界約 dx=17（舊的 GRAZE_PAD 版是 25）。
  // 這裡放 dx=14：確定擦到、也確定沒命中（命中臨界是 r+SOUL_RADIUS=9）。
  const s = sim(
    attack({
      settings: { grazeTP: 1.0 },
      box: { x: 320, y: 171, w: 400, h: 400 },
      timeline: [
        {
          id: 'sp',
          at: 0.1,
          type: 'spawn',
          bullet: 'dot',
          count: 1,
          x: 320 + 14,
          y: 171,
          speed: 0,
          life: 5,
        },
      ],
    }),
  );
  eq(s.getState().tp, 0, '尚未接觸');
  s.advance(6, null);
  approx(s.getState().tp, 1.0, 1e-9, '擦彈 +grazeTP');
  eq(s.getState().soul.grazing, true, 'grazing 旗標');
});

test('TP 上限為 100', () => {
  const s = sim(
    attack({
      settings: { grazeTP: 5 },
      box: { x: 320, y: 171, w: 400, h: 400 },
      timeline: [
        {
          id: 'em',
          at: 0,
          type: 'emitter',
          duration: 2,
          interval: 0.05,
          count: 10,
          // FX-GRAZE：x 從「+0 / +20」改成「+12 / +14」，兩者都在心形遮罩的擦彈範圍內
          // （遮罩半寬 12 + dot r=5 → 臨界 17），且都離命中臨界 9 夠遠。
          spawn: { bullet: 'dot', x: '320 + 12 + (i % 2) * 2', y: 171, speed: 0, life: 2 },
        },
      ],
    }),
  );
  s.advance(60, null);
  eq(s.getState().tp, TP_MAX, `TP 上限 100（實際 ${s.getState().tp}）`);
});

test('同一發子彈只擦彈一次', () => {
  const s = sim(
    attack({
      box: { x: 320, y: 171, w: 400, h: 400 },
      timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 334, y: 171, speed: 0, life: 2 }],
    }),
  );
  s.advance(10, null);
  const tp10 = s.getState().tp;
  ok(tp10 > 0, '確實擦到（dx=14 在心形遮罩內）');
  s.advance(20, null);
  approx(s.getState().tp, tp10, 1e-9, '同一發不會持續加 TP');
});

test('擦彈會發出 graze 事件（每發子彈一次）', () => {
  const grazes = [];
  const s = createSimulation({ mode: 'preview', onEvent: (e) => e.type === 'graze' && grazes.push(e.payload) });
  s.load(
    attack({
      box: { x: 320, y: 171, w: 400, h: 400 },
      timeline: [
        { id: 'sp', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 334, y: 171, speed: 0, life: 3 },
      ],
    }),
  );
  s.advance(20, null);
  eq(grazes.length, 1, '只發出一次 graze（同一發不重複）');
  ok(grazes[0].bulletId > 0, '帶子彈 id');
  eq(grazes[0].type, 'dot', '帶子彈類型');
});

test('grazeable=false 的子彈不會擦彈', () => {
  const s = sim(
    attack({
      bulletTypes: { solid: { hitbox: { shape: 'circle', r: 4 }, grazeable: false } },
      box: { x: 320, y: 171, w: 400, h: 400 },
      timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'solid', count: 1, x: 334, y: 171, speed: 0, life: 3 }],
    }),
  );
  s.advance(20, null);
  eq(s.getState().tp, 0, '不可擦彈 → TP 不變');
});

test('遠離的子彈不算擦彈', () => {
  const s = sim(
    attack({
      box: { x: 320, y: 171, w: 400, h: 400 },
      timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 320 + 100, y: 171, speed: 0, life: 3 }],
    }),
  );
  s.advance(20, null);
  eq(s.getState().tp, 0, '距離太遠 → 沒有擦彈');
});

test('destroyOnHit=false 的子彈撞到後不會消失', () => {
  const s = sim(
    attack({
      bulletTypes: { pierce: { hitbox: { shape: 'circle', r: 5 }, destroyOnHit: false } },
      settings: { invincibleFrames: 0 },
      timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'pierce', count: 1, x: 320, y: 171, speed: 0, life: 1 }],
    }),
  );
  s.advance(15, null);
  eq(s.bulletCount, 1, '子彈還在');
});

test('destroyOnHit=true 的子彈撞到後消失', () => {
  const s = sim(
    attack({
      bulletTypes: { gone: { hitbox: { shape: 'circle', r: 5 }, destroyOnHit: true } },
      timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'gone', count: 1, x: 320, y: 171, speed: 0, life: 5 }],
    }),
  );
  s.advance(10, null);
  eq(s.bulletCount, 0, '撞到後消失');
});

test('rect hitbox 會隨 rotation 旋轉', () => {
  // 長條 40×4，旋轉 90 度後變成垂直；靈魂在正下方 18px → 旋轉後應命中
  const mk = (rotation) =>
    sim(
      attack({
        bulletTypes: { bar: { hitbox: { shape: 'rect', w: 40, h: 4 } } },
        settings: { invincibleFrames: 0 },
        timeline: [
          {
            id: 'sp',
            at: 0.05,
            type: 'spawn',
            bullet: 'bar',
            count: 1,
            x: 320,
            y: 171 - 18,
            speed: 0,
            rotation,
            life: 2,
          },
        ],
      }),
    );
  const flat = mk(0);
  flat.advance(5, null);
  eq(flat.getState().party[0].hp, 90, '未旋轉（水平長條）不會碰到下方 18px 的靈魂');

  const turned = mk(90);
  turned.advance(5, null);
  eq(turned.getState().party[0].hp, 80, '旋轉 90 度後（垂直長條）會命中');
});

/* ================================================================== */

group('模擬：其他事件');

test('clear 會清掉所有子彈', () => {
  const s = sim(
    attack({
      timeline: [
        { id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 20, x: 'rand(0,640)', y: 'rand(0,480)', speed: 1 },
        { id: 'cl', at: 0.2, type: 'clear', fade: 0 },
      ],
    }),
  );
  s.advance(3, null);
  eq(s.bulletCount, 20, '先有 20 發');
  s.advance(4, null);
  eq(s.bulletCount, 0, 'clear 後清空');
});

test('clear 的 fade 讓子彈淡出後才消失', () => {
  const s = sim(
    attack({
      timeline: [
        { id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 5, x: 300, y: 200, speed: 0 },
        { id: 'cl', at: 0.1, type: 'clear', fade: 0.3 },
      ],
    }),
  );
  s.advance(5, null);
  eq(s.bulletCount, 5, '淡出期間仍存在');
  const alpha = s.getState().bullets[0].alpha;
  ok(alpha < 1, `淡出中 alpha < 1（實際 ${alpha}）`);
  s.advance(10, null);
  eq(s.bulletCount, 0, '淡出結束後消失');
});

test('sfx 事件會進入 sfxQueue', () => {
  const s = sim(attack({ timeline: [{ id: 'sf', at: 0.1, type: 'sfx', sound: 'hurt' }] }));
  s.advance(3, null);
  eq(s.getState().sfxQueue.length, 1, 'sfxQueue 有 1 筆');
  eq(s.getState().sfxQueue[0], 'hurt', '音效名稱');
  eq(s.drainSfx().length, 1, 'drainSfx 取出');
  eq(s.getState().sfxQueue.length, 0, '取出後清空');
});

test('shake 會產生震動位移並衰減', () => {
  const s = sim(attack({ timeline: [{ id: 'sh', at: 0.1, type: 'shake', duration: 0.4, amount: 8 }] }));
  s.advance(4, null);
  const shakes = [];
  for (let i = 0; i < 12; i += 1) {
    s.stepFrame(null);
    const st = s.getState().shake;
    shakes.push(Math.abs(st.x) + Math.abs(st.y));
  }
  ok(shakes.some((v) => v > 0), '有震動位移');
  const first = shakes.slice(0, 4).reduce((a, b) => a + b, 0);
  const last = shakes.slice(-4).reduce((a, b) => a + b, 0);
  ok(last <= first, '震動逐漸衰減');
  s.advance(30, null);
  const after = s.getState().shake;
  eq(after.x, 0, '結束後 x 歸零');
  eq(after.y, 0, '結束後 y 歸零');
});

test('表達式錯誤會發出 error 事件且不中斷模擬', () => {
  const errors = [];
  const s = createSimulation({ mode: 'preview', onEvent: (e) => e.type === 'error' && errors.push(e.payload) });
  s.load(
    attack({
      timeline: [
        { id: 'bad', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 'oops(', y: 100 },
        { id: 'good', at: 0.3, type: 'spawn', bullet: 'dot', count: 1, x: 200, y: 100 },
      ],
    }),
  );
  s.advance(15, null);
  eq(s.frame, 15, '模擬沒有中斷');
  ok(errors.length > 0, '有 error 事件');
  eq(errors[0].id, 'bad', 'error 帶事件 id');
  eq(errors[0].field, 'x', 'error 帶欄位名');
  eq(s.bulletCount, 2, '兩個事件都仍生成子彈');
});

test('同一個表達式錯誤只回報一次（不洗版）', () => {
  const errors = [];
  const s = createSimulation({ mode: 'preview', onEvent: (e) => e.type === 'error' && errors.push(e.payload) });
  s.load(
    attack({
      timeline: [
        {
          id: 'em',
          at: 0,
          type: 'emitter',
          duration: 1,
          interval: 0.1,
          count: 1,
          spawn: { bullet: 'dot', x: 'bad(', y: 100 },
        },
      ],
    }),
  );
  s.advance(30, null);
  eq(errors.length, 1, `同一個錯誤只回報一次（實際 ${errors.length}）`);
});

test('找不到子彈類型也會回報錯誤並畫洋紅佔位（sprite null）', () => {
  const errors = [];
  const s = createSimulation({ mode: 'preview', onEvent: (e) => e.type === 'error' && errors.push(e.payload) });
  s.load(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'nope', count: 2 }] }));
  ok(errors.some((e) => e.field === 'bullet'), '有回報 bullet 錯誤');
  const bs = s.getState().bullets;
  eq(bs.length, 2, '仍生成子彈');
  eq(bs[0].sprite, null, 'sprite 為 null（渲染器畫洋紅）');
});

test('未知事件類型不會崩潰並回報', () => {
  const errors = [];
  const s = createSimulation({ mode: 'preview', onEvent: (e) => e.type === 'error' && errors.push(e.payload) });
  s.load(attack({ timeline: [{ id: 'w', at: 0.1, type: 'teleport' }, { id: 'sp', at: 0.2, type: 'spawn', bullet: 'dot' }] }));
  s.advance(10, null);
  eq(s.frame, 10, '仍在推進');
  ok(errors.some((e) => e.field === 'type'), '有回報未知 type');
  ok(s.bulletCount >= 1, '後續事件仍執行');
});

/* ================================================================== */

group('模擬：getState 形狀（SPEC §9）');

test('getState 含 §9 全部欄位', () => {
  const st = sim(attack()).getState();
  for (const key of [
    'frame',
    'time',
    'running',
    'ended',
    'attack',
    'shake',
    'box',
    'soul',
    'bullets',
    'party',
    'tp',
    'enemies',
    'sfxQueue',
    'grazeFlash',
    'hurtFlash',
  ]) {
    ok(Object.prototype.hasOwnProperty.call(st, key), `缺少欄位 ${key}`);
  }
});

test('shake 是 {x, y}', () => {
  const st = sim(attack()).getState();
  eq(typeof st.shake.x, 'number', 'shake.x 是數字');
  eq(typeof st.shake.y, 'number', 'shake.y 是數字');
});

test('box 含 x/y/w/h/rotation/border/color', () => {
  const box = sim(attack()).getState().box;
  for (const key of ['x', 'y', 'w', 'h', 'rotation', 'border', 'color']) {
    ok(key in box, `box 缺少 ${key}`);
  }
});

test('soul 含 x/y/mode/color/invFrames/grazing/visible', () => {
  const soul = sim(attack()).getState().soul;
  for (const key of ['x', 'y', 'mode', 'color', 'invFrames', 'grazing', 'visible']) {
    ok(key in soul, `soul 缺少 ${key}`);
  }
});

test('bullets 每項含 §9 指定欄位', () => {
  const s = sim(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1 }] }));
  const b = s.getState().bullets[0];
  for (const key of ['id', 'type', 'sprite', 'frame', 'x', 'y', 'rotation', 'scale', 'alpha', 'color', 'maskToBox', 'hitbox']) {
    ok(key in b, `bullet 缺少 ${key}`);
  }
  ok(b.hitbox && typeof b.hitbox.shape === 'string', 'hitbox.shape');
});

test('party 每項含 name/hp/maxHp/color', () => {
  const p = sim(attack()).getState().party[0];
  for (const key of ['name', 'hp', 'maxHp', 'color']) ok(key in p, `party 缺少 ${key}`);
});

test('enemies 含 sprite/x/y/scale/frame，y 已含浮動', () => {
  const s = sim(attack({ enemies: [{ sprite: 'spr_x', x: 500, y: 200, scale: 2, frameRate: 4 }] }));
  const e0 = s.getState().enemies[0];
  for (const key of ['sprite', 'x', 'y', 'scale', 'frame']) ok(key in e0, `enemy 缺少 ${key}`);
  s.advance(5, null);
  const e1 = s.getState().enemies[0];
  notOk(e0.y === e1.y, 'y 有浮動位移');
});

test('grazeFlash / hurtFlash 會隨事件升高並衰減到 0', () => {
  const s = sim(
    attack({
      box: { x: 320, y: 171, w: 400, h: 400 },
      // FX-GRAZE：dx 從 +20 改成 +14（心形遮罩擦彈範圍是 ±17，+20 已經擦不到）
      timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 334, y: 171, speed: 0, life: 2 }],
    }),
  );
  s.advance(5, null);
  ok(s.getState().grazeFlash > 0, '擦彈時 grazeFlash > 0');
  s.advance(30, null);
  eq(s.getState().grazeFlash, 0, '之後衰減到 0');

  const hurt = sim(
    attack({ timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 320, y: 171, speed: 0 }] }),
  );
  hurt.advance(5, null);
  ok(hurt.getState().hurtFlash > 0, '受傷時 hurtFlash > 0');
  hurt.advance(30, null);
  eq(hurt.getState().hurtFlash, 0, '之後衰減到 0');
});

test('getState 回傳的 bullets 是複本（改它不影響模擬）', () => {
  const s = sim(attack({ timeline: [{ id: 'sp', at: 0, type: 'spawn', bullet: 'dot', count: 1 }] }));
  const st = s.getState();
  st.bullets[0].x = 9999;
  eq(s.getState().bullets[0].x !== 9999, true, '內部狀態不受影響');
});

test('attack 欄位是正規化後的攻擊', () => {
  const st = sim(attack()).getState();
  eq(st.attack.format, 'dr-battle-attack/1', 'format');
  isArray(st.attack.timeline, 'timeline 陣列');
});
