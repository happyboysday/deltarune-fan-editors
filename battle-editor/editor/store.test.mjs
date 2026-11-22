/**
 * editor/store.test.mjs — store 單元測試（ED1 擁有）
 *
 * 執行：node --test editor/store.test.mjs
 * 或   node editor/store.test.mjs
 *
 * 只測 store.js 的純邏輯（不碰 DOM / localStorage → 傳 storage:null）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, deepClone, jsonEqual, diffPaths } from './store.js';

/* ---------------------------------------------------------------- 測試資料 */

function sampleAttack() {
  return {
    format: 'dr-battle-attack/1',
    meta: { name: '測試攻擊', author: '' },
    settings: { duration: 8, seed: 1, damage: 10, invincibleFrames: 30, grazeTP: 1 },
    // 戰鬥框預設值：SPEC-LAYOUT §5 實機量測（= engine/attack.js 的 BOX_DEFAULTS）
    box: { x: 320, y: 190, w: 144, h: 158, rotation: 0, border: 3, color: '#00c000' },
    soul: { x: null, y: null, speed: 4, slowSpeed: 2, mode: 'red', color: '#ff0000' },
    party: [{ name: 'Kris', hp: 90, maxHp: 90, color: '#00ffff', icon: null }],
    enemies: [],
    bulletTypes: {
      spade: {
        sprite: 'spr_spadebullet',
        frameRate: 0,
        scale: 1,
        color: null,
        hitbox: { shape: 'circle', r: 6 },
        damage: null,
        grazeable: true,
        destroyOnHit: true,
        faceVelocity: true,
        offscreen: 'destroy',
        maskToBox: false,
      },
    },
    timeline: [
      { id: 'ev_a', at: 0.5, type: 'spawn', bullet: 'spade', x: 100, y: 100, speed: 2, angle: 90 },
      { id: 'ev_b', at: 2.0, type: 'shake', duration: 0.4, amount: 3 },
    ],
  };
}

function makeStore() {
  return createStore(sampleAttack(), { storage: null });
}

/* -------------------------------------------------------------------- 基礎 */

test('deepClone 是深拷貝（巢狀物件互不影響）', () => {
  const src = sampleAttack();
  const copy = deepClone(src);
  assert.notEqual(copy, src);
  assert.notEqual(copy.timeline, src.timeline);
  assert.notEqual(copy.timeline[0], src.timeline[0]);
  copy.timeline[0].speed = 99;
  assert.equal(src.timeline[0].speed, 2);
  copy.bulletTypes.spade.hitbox.r = 42;
  assert.equal(src.bulletTypes.spade.hitbox.r, 6);
});

test('createStore 會深拷貝初始攻擊（不改到來源物件）', () => {
  const src = sampleAttack();
  const store = createStore(src, { storage: null });
  store.update((draft) => {
    draft.meta.name = '改過的';
  }, { label: '改名' });
  assert.equal(src.meta.name, '測試攻擊');
  assert.equal(store.attack.meta.name, '改過的');
});

/* -------------------------------------------------------------- update/undo */

test('update 提交變更並通知訂閱者', () => {
  const store = makeStore();
  const seen = [];
  const unsub = store.subscribe((_s, change) => seen.push(change.label));
  assert.equal(store.canUndo(), false);

  const changed = store.update((draft) => {
    draft.settings.duration = 12;
  }, { label: '改長度' });

  assert.equal(changed, true);
  assert.equal(store.attack.settings.duration, 12);
  assert.equal(store.canUndo(), true);
  assert.ok(seen.includes('改長度'));

  unsub();
  store.update((draft) => {
    draft.settings.duration = 13;
  }, { label: '改長度2' });
  assert.equal(seen.filter((l) => l === '改長度2').length, 0, '取消訂閱後不應再收到通知');
});

test('無實際變更的 update 不推入復原堆疊', () => {
  const store = makeStore();
  const before = store.historySize().undo;
  const changed = store.update((draft) => {
    // 指派相同值
    draft.settings.duration = 8;
  }, { label: '沒變' });
  assert.equal(changed, false);
  assert.equal(store.historySize().undo, before);
  assert.equal(store.canRedo(), false);
});

test('復原／重做可正確還原多步（含巢狀陣列）', () => {
  const store = makeStore();

  store.update((d) => {
    d.timeline[0].speed = 5;
  }, { label: '步驟1' });
  store.update((d) => {
    d.timeline.push({ id: 'ev_c', at: 3, type: 'end' });
  }, { label: '步驟2' });
  store.update((d) => {
    d.bulletTypes.spade.hitbox.r = 12;
  }, { label: '步驟3' });

  assert.equal(store.attack.timeline.length, 3);
  assert.equal(store.attack.timeline[0].speed, 5);
  assert.equal(store.attack.bulletTypes.spade.hitbox.r, 12);

  assert.equal(store.undo(), true); // 還原步驟3
  assert.equal(store.attack.bulletTypes.spade.hitbox.r, 6);
  assert.equal(store.attack.timeline.length, 3);

  assert.equal(store.undo(), true); // 還原步驟2
  assert.equal(store.attack.timeline.length, 2);

  assert.equal(store.undo(), true); // 還原步驟1
  assert.equal(store.attack.timeline[0].speed, 2);
  assert.equal(store.canUndo(), false);
  assert.equal(store.undo(), false, '堆疊空了要回傳 false');

  assert.equal(store.canRedo(), true);
  assert.equal(store.redo(), true);
  assert.equal(store.attack.timeline[0].speed, 5);
  assert.equal(store.redo(), true);
  assert.equal(store.attack.timeline.length, 3);
  assert.equal(store.redo(), true);
  assert.equal(store.attack.bulletTypes.spade.hitbox.r, 12);
  assert.equal(store.canRedo(), false);
  assert.equal(store.redo(), false);
});

test('新的 update 會清空重做堆疊', () => {
  const store = makeStore();
  store.update((d) => {
    d.settings.damage = 20;
  }, { label: 'A' });
  store.update((d) => {
    d.settings.damage = 30;
  }, { label: 'B' });
  store.undo();
  assert.equal(store.canRedo(), true);
  store.update((d) => {
    d.settings.damage = 40;
  }, { label: 'C' });
  assert.equal(store.canRedo(), false);
  assert.equal(store.attack.settings.damage, 40);
});

test('復原堆疊上限 200 步', () => {
  const store = makeStore();
  for (let i = 0; i < 240; i += 1) {
    store.update((d) => {
      d.settings.damage = i;
    }, { label: `步${i}` });
  }
  assert.equal(store.historySize().undo, 200);
  // 一路復原到底，值應該是第 39 步之後（i=39 → 40 步被丟掉）
  let guard = 0;
  while (store.undo() && guard < 500) guard += 1;
  assert.equal(guard, 200);
  assert.equal(store.attack.settings.damage, 39);
});

/* ---------------------------------------------------------------- coalesce */

test('同 coalesceKey 連續更新合併為一步復原；換 key 則新增一步', () => {
  const store = makeStore();

  for (let i = 1; i <= 10; i += 1) {
    store.update((d) => {
      d.box.x = 300 + i;
    }, { label: '拖曳戰鬥框', coalesceKey: 'box:move' });
  }
  assert.equal(store.attack.box.x, 310);
  assert.equal(store.historySize().undo, 1, '10 次拖曳應合併成 1 步');

  store.update((d) => {
    d.box.w = 200;
  }, { label: '縮放戰鬥框', coalesceKey: 'box:resize:se' });
  assert.equal(store.historySize().undo, 2, '換 coalesceKey 應是新的 1 步');

  // 復原一步 → 回到拖曳結束後的狀態（x=310、w 回到 BOX_DEFAULTS.w）
  store.undo();
  assert.equal(store.attack.box.w, 144);
  assert.equal(store.attack.box.x, 310);

  // 再復原一步 → 拖曳前的原始狀態
  store.undo();
  assert.equal(store.attack.box.x, 320);
});

test('endCoalesce 之後同 key 會開始新的一步', () => {
  const store = makeStore();
  store.update((d) => {
    d.box.y = 200;
  }, { coalesceKey: 'box:move', label: '拖曳1' });
  store.update((d) => {
    d.box.y = 210;
  }, { coalesceKey: 'box:move', label: '拖曳1' });
  assert.equal(store.historySize().undo, 1);

  store.endCoalesce();

  store.update((d) => {
    d.box.y = 220;
  }, { coalesceKey: 'box:move', label: '拖曳2' });
  assert.equal(store.historySize().undo, 2);

  store.undo();
  assert.equal(store.attack.box.y, 210);
  store.undo();
  assert.equal(store.attack.box.y, 190);
});

test('沒有 coalesceKey 的更新永不自動合併', () => {
  const store = makeStore();
  store.update((d) => {
    d.settings.seed = 2;
  }, { label: 'a' });
  store.update((d) => {
    d.settings.seed = 3;
  }, { label: 'b' });
  assert.equal(store.historySize().undo, 2);
});

test('coalesce 合併後 undo 能完整回到最初值', () => {
  const store = makeStore();
  const original = JSON.stringify(store.attack.box);
  for (let i = 0; i < 25; i += 1) {
    store.update((d) => {
      d.box.x += 1;
      d.box.y += 2;
    }, { coalesceKey: 'box:move', label: '拖曳' });
  }
  assert.equal(JSON.stringify(store.attack.box) === original, false);
  store.undo();
  assert.equal(JSON.stringify(store.attack.box), original);
});

/* ------------------------------------------------------------------- select */

test('select 更新選取並通知；相同選取不重複通知', () => {
  const store = makeStore();
  const changes = [];
  store.subscribe((_s, c) => changes.push(c));
  store.select('event', 'ev_a');
  assert.equal(store.selection.kind, 'event');
  assert.equal(store.selection.id, 'ev_a');
  assert.equal(changes.length, 1);
  store.select('event', 'ev_a');
  assert.equal(changes.length, 1, '相同選取不應重複通知');
  store.select('bulletType', 'spade');
  assert.equal(changes.length, 2);
  store.select(null, null);
  assert.equal(store.selection.kind, null);
});

/* ------------------------------------------------------------------- errors */

test('setErrors 接受 Map / 陣列 / 物件，並過濾空值', () => {
  const store = makeStore();
  const seen = [];
  store.subscribe((_s, c) => {
    if (c.errors) seen.push(c.errorCount);
  });

  store.setErrors([
    { path: 'timeline[0].speed', message: '必須是數字' },
    { path: 'timeline[1].at', message: '' }, // 空訊息要忽略
    { path: 'box.w', message: '太小' },
  ]);
  assert.equal(store.errors.size, 2);
  assert.equal(store.errors.get('timeline[0].speed'), '必須是數字');
  assert.equal(store.errors.has('timeline[1].at'), false);
  assert.deepEqual(seen, [2]);

  // 相同的錯誤內容不重複通知
  store.setErrors([
    { path: 'timeline[0].speed', message: '必須是數字' },
    { path: 'box.w', message: '太小' },
  ]);
  assert.deepEqual(seen, [2]);

  const map = new Map([['bulletTypes.spade.sprite', '缺少 sprite']]);
  store.setErrors(map);
  assert.equal(store.errors.size, 1);
  assert.equal(store.errors.get('bulletTypes.spade.sprite'), '缺少 sprite');

  store.setError('meta.name', '不可為空');
  assert.equal(store.errors.size, 2);
  store.clearError('meta.name');
  assert.equal(store.errors.size, 1);
  store.clearErrors();
  assert.equal(store.errors.size, 0);
});

test('update 不會動到 store.errors（錯誤由驗證器另行設定）', () => {
  const store = makeStore();
  store.setErrors([{ path: '$', message: '有錯' }]);
  store.update((d) => {
    d.settings.damage = 1;
  }, { label: '編輯' });
  assert.equal(store.errors.size, 1);
});

/* ------------------------------------------------------------------- newId */

test('newId 產生不重複且帶前綴的 id，並避開已有 timeline id', () => {
  const attack = sampleAttack();
  attack.timeline = [{ id: 'ev_x1', at: 0, type: 'end' }];
  const store = createStore(attack, { storage: null });

  const ids = new Set();
  for (let i = 0; i < 300; i += 1) ids.add(store.newId('ev'));
  assert.equal(ids.size, 300, 'newId 不可重複');
  for (const id of ids) assert.ok(id.startsWith('ev_'), `id 應帶前綴：${id}`);
  assert.equal(ids.has('ev_x1'), false);
  assert.ok(store.newId('').startsWith('id_') || store.newId('').length > 0);

  // 寫入 timeline 後，新產生的 id 也不再與它撞
  store.update((d) => {
    d.timeline.push({ id: store.newId('ev'), at: 1, type: 'end' });
  }, { label: '新增事件' });
  assert.equal(new Set(store.attack.timeline.map((e) => e.id)).size, 2);
});

/* ------------------------------------------------------------------ replace */

test('replace 換掉整份攻擊並清空復原堆疊，dirty 歸零', () => {
  const store = makeStore();
  store.update((d) => {
    d.settings.damage = 99;
  }, { label: '改' });
  assert.equal(store.canUndo(), true);
  assert.equal(store.isDirty(), true);

  const other = sampleAttack();
  other.meta.name = '另一份';
  store.replace(other, '開檔');

  assert.equal(store.attack.meta.name, '另一份');
  assert.equal(store.canUndo(), false);
  assert.equal(store.canRedo(), false);
  assert.equal(store.isDirty(), false);
  assert.equal(store.selection.kind, null);
  assert.equal(store.errors.size, 0);

  // 外部改動 replace 的來源物件不應影響 store
  other.meta.name = '被外部改了';
  assert.equal(store.attack.meta.name, '另一份');
});

test('replace 會通知訂閱者（reset 標記）', () => {
  const store = makeStore();
  let got = null;
  store.subscribe((_s, c) => {
    got = c;
  });
  store.replace(sampleAttack(), '新建');
  assert.ok(got);
  assert.equal(got.reset, true);
  assert.equal(got.label, '新建');
});

/* ---------------------------------------------------------- markSaved 等 */

test('a save response does not clear edits made after the request was sent', () => {
  const store = createStore({ meta: { name: 'original' } });
  store.setAt('meta.name', 'sent');
  const sent = store.doc;
  store.setAt('meta.name', 'newer');
  assert.equal(store.markSaved('attack.json', sent), false);
  assert.equal(store.isDirty(), true);
  assert.equal(store.doc.meta.name, 'newer');
  assert.equal(store.fileName, 'attack.json');
  assert.equal(store.markSaved('attack.json', store.doc), true);
  store.dispose();
});

test('markSaved 清除 dirty 並設定檔名', () => {
  const store = makeStore();
  store.update((d) => {
    d.settings.seed = 7;
  }, { label: '改' });
  assert.equal(store.isDirty(), true);
  store.markSaved('my-attack.json');
  assert.equal(store.isDirty(), false);
  assert.equal(store.fileName, 'my-attack.json');
  assert.ok(Number.isFinite(store.savedAt));
});

test('update 遇到 fn 拋錯時不破壞 store', () => {
  const store = makeStore();
  const before = JSON.stringify(store.attack);
  const origError = console.error;
  console.error = () => {}; // store 會刻意印出錯誤，測試時靜音
  let changed;
  try {
    changed = store.update(() => {
      throw new Error('測試用的錯誤');
    }, { label: '壞掉' });
  } finally {
    console.error = origError;
  }
  assert.equal(changed, false);
  assert.equal(JSON.stringify(store.attack), before);
  assert.equal(store.canUndo(), false);
});

test('update 允許回傳新物件取代草稿', () => {
  const store = makeStore();
  store.update((d) => {
    d.settings.damage = 5;
    return d;
  }, { label: '就地修改' });
  assert.equal(store.attack.settings.damage, 5);
});

test('jsonEqual / diffPaths 基本行為', () => {
  assert.equal(jsonEqual({ a: 1, b: [2] }, { a: 1, b: [2] }), true);
  assert.equal(jsonEqual({ a: 1 }, { a: 2 }), false);

  const a = { timeline: [{ at: 1, speed: 2 }], box: { x: 1 } };
  const b = { timeline: [{ at: 1, speed: 5 }], box: { x: 1 } };
  const paths = diffPaths(a, b);
  assert.ok(paths.includes('timeline[0].speed'), `應包含 timeline[0].speed，實際：${JSON.stringify(paths)}`);
});

test('訂閱回呼拋錯不影響其他訂閱者與 store', () => {
  const store = makeStore();
  let secondCalled = 0;
  store.subscribe(() => {
    throw new Error('訂閱者爆炸');
  });
  store.subscribe(() => {
    secondCalled += 1;
  });
  // 攔截 console.error 以免測試輸出被洗版
  const origError = console.error;
  console.error = () => {};
  try {
    const changed = store.update((d) => {
      d.settings.damage = 3;
    }, { label: '改' });
    assert.equal(changed, true);
  } finally {
    console.error = origError;
  }
  assert.equal(secondCalled >= 1, true);
  assert.equal(store.attack.settings.damage, 3);
});

/* ----------------------------------------------------------- 變更內容提示 */

test('change.paths 會指出變動的欄位（供檢查器標示）', () => {
  const store = makeStore();
  let change = null;
  store.subscribe((_s, c) => {
    if (!c.selectionOnly && !c.errors) change = c;
  });
  store.update((d) => {
    d.timeline[1].amount = 9;
  }, { label: '改震動' });
  assert.ok(change);
  assert.ok(Array.isArray(change.paths));
  assert.ok(
    change.paths.includes('timeline[1].amount'),
    `paths 應包含 timeline[1].amount，實際 ${JSON.stringify(change.paths)}`,
  );
});

/* -------------------------------------------------- 錯誤重建世代序號（競態） */

test('setErrors 會丟棄比已套用序號舊的結果（非同步競態）', () => {
  const store = makeStore();
  const seen = [];
  store.subscribe((_s, c) => {
    if (c.errors) seen.push(c.label);
  });

  const seq1 = store.nextErrorSeq();
  const seq2 = store.nextErrorSeq();

  // 較新的先到
  assert.equal(store.setErrors([{ path: 'a', message: '新' }], seq2), true);
  assert.equal(store.errors.get('a'), '新');
  // 較舊的晚到 → 丟棄，不得覆蓋
  assert.equal(store.setErrors([{ path: 'a', message: '舊' }], seq1), false);
  assert.equal(store.errors.get('a'), '新');
  assert.deepEqual(seen, ['errors'], '只有一次有效的錯誤通知');

  // 相同序號可重複套用（內容相同時仍不通知）
  assert.equal(store.setErrors([{ path: 'a', message: '新' }], seq2), false);
});

test('錯誤通知的 label 是 errors（面板可據此重繪）', () => {
  const store = makeStore();
  const labels = [];
  store.subscribe((_s, c) => {
    labels.push({ label: c.label, errors: !!c.errors });
  });
  store.setErrors([{ path: '$', message: '有錯' }]);
  store.setError('meta.name', '不可為空');
  store.clearError('meta.name');
  store.clearErrors();
  assert.deepEqual(
    labels.map((l) => l.label),
    ['errors', 'errors', 'errors', 'errors'],
  );
  assert.equal(labels.every((l) => l.errors === true), true);
});

test('直接 setError/clearErrors 會讓進行中的舊重建失效', () => {
  const store = makeStore();
  const stale = store.nextErrorSeq(); // 假設某次重建取號後還在算
  store.setError('meta.name', '面板直接寫入');
  assert.equal(store.errors.has('meta.name'), true);
  // 舊重建現在才回來 → 必須被丟棄，不能清掉面板剛寫的錯誤
  assert.equal(store.setErrors([{ path: 'other', message: '過期' }], stale), false);
  assert.equal(store.errors.has('meta.name'), true);
  assert.equal(store.errors.has('other'), false);
});
