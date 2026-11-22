// editor/encounter/actor-forms.test.mjs  (V2-07)
//
// 演員形態（actor.forms）的純邏輯與 UI 接線測試（不碰 DOM）。
// 執行：node --test editor/encounter/actor-forms.test.mjs
//
// 覆蓋：
//   1. formsOf / formNamesOf / animsOfGroup 的退回語意
//   2. animPathOf：基礎 / 形態動畫欄位路徑
//   3. nextFormName / copyFormName 的不衝突命名
//   4. 三語字串：forms 相關鍵都存在且鍵集合一致
//   5. 原始碼接線：actor-editor 有形態 UI、engines 有 form cue

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  formsOf,
  formNamesOf,
  animsOfGroup,
  animPathOf,
  nextFormName,
  copyFormName,
  stateNames,
} from './actor-editor.js';
import STRINGS, { LOCALE_IDS, findKeyMismatches } from '../locales/encounter-panels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const sourceOf = (rel) => readFileSync(path.join(root, rel), 'utf8');

const ACTOR = {
  kind: 'enemy',
  anims: {
    idle: { sprite: 'spr_base_idle', fps: 5, loop: true },
    hurt: { sprite: 'spr_base_hurt', fps: 10, loop: false, then: 'idle' },
  },
  form: 'normal',
  forms: {
    normal: { anims: { idle: { sprite: 'spr_n_idle', fps: 5, loop: true } } },
    angry: {
      anims: { idle: { sprite: 'spr_a_idle', fps: 8, loop: true } },
      scale: 2,
      offset: { x: 10, y: -20 },
    },
  },
};

test('formsOf：沒有 forms / 非物件 → null', () => {
  assert.equal(formsOf(null), null);
  assert.equal(formsOf({ anims: {} }), null);
  assert.equal(formsOf({ forms: [] }), null);
  assert.equal(formsOf({ forms: 'x' }), null);
  assert.deepEqual(Object.keys(formsOf(ACTOR)), ['normal', 'angry']);
});

test('formNamesOf：保留宣告順序', () => {
  assert.deepEqual(formNamesOf(ACTOR), ['normal', 'angry']);
  assert.deepEqual(formNamesOf({ anims: {} }), []);
});

test('animsOfGroup：形態動畫正規化；沒定義 → 空；未知形態 → 基礎', () => {
  const normal = animsOfGroup(ACTOR, 'normal');
  assert.deepEqual(Object.keys(normal), ['idle']);
  assert.equal(normal.idle.sprite, 'spr_n_idle');
  assert.equal(normal.idle.then, null, '缺 then 補 null');
  assert.deepEqual(Object.keys(animsOfGroup(ACTOR, 'angry')), ['idle']);
  assert.deepEqual(Object.keys(animsOfGroup(ACTOR, 'ghost')), ['idle', 'hurt'], '未知形態退回基礎');
  assert.deepEqual(Object.keys(animsOfGroup(ACTOR, null)), ['idle', 'hurt'], 'null = 基礎');
});

test('形態動畫組可用 stateNames 排序（內建在前）', () => {
  const names = stateNames({ kind: 'enemy', anims: { hurt: {}, idle: {}, zzz: {} } });
  assert.deepEqual(names, ['idle', 'hurt', 'zzz']);
});

test('animPathOf：基礎與形態路徑', () => {
  assert.equal(animPathOf('kris', null, 'idle'), 'actors.kris.anims.idle');
  assert.equal(animPathOf('kris', 'angry', 'hurt'), 'actors.kris.forms.angry.anims.hurt');
  assert.equal(animPathOf('enemy-1', 'form2', 'idle'), 'actors.["enemy-1"].forms.form2.anims.idle', '非識別字 id 用括號路徑（同 quoteKey）');
});

test('nextFormName：避開既有名字', () => {
  assert.equal(nextFormName([]), 'form1');
  assert.equal(nextFormName(['form1']), 'form2');
  assert.equal(nextFormName(['form1', 'form3']), 'form2');
  assert.equal(nextFormName(['a'], 'form'), 'form1');
});

test('copyFormName：name-copy、name-copy2…', () => {
  assert.equal(copyFormName(['normal'], 'normal'), 'normal-copy');
  assert.equal(copyFormName(['normal', 'normal-copy'], 'normal'), 'normal-copy2');
  assert.equal(copyFormName(['normal', 'normal-copy', 'normal-copy2'], 'normal'), 'normal-copy3');
});

test('encPanels：三語都有形態字串且鍵集合一致', () => {
  const keys = [
    'ae.forms',
    'ae.formsHint',
    'ae.formNone',
    'ae.formInitial',
    'ae.formInitialHint',
    'ae.formsEmpty',
    'ae.formEditTip',
    'ae.formPreview',
    'ae.formPreviewOk',
    'ae.formPreviewFail',
    'ae.duplicateForm',
    'ae.deleteForm',
    'ae.confirmDeleteForm',
    'ae.addForm',
    'ae.formAnims',
    'ae.formBase',
    'ae.formScale',
    'ae.formFallbackHint',
    'ae.formInherited',
    'ae.formPrompt',
    'ae.dupForm',
  ];
  for (const lang of LOCALE_IDS) {
    for (const key of keys) {
      assert.equal(typeof STRINGS[lang][key], 'string', `${lang} 缺少 ${key}`);
      assert.ok(STRINGS[lang][key].length > 0, `${lang}.${key} 是空的`);
    }
  }
  assert.deepEqual(findKeyMismatches(STRINGS), [], '三語鍵集合一致');
});

test('actor-editor 原始碼：形態 UI 與 cue 預覽接線', () => {
  const src = sourceOf('editor/encounter/actor-editor.js');
  assert.match(src, /enc-formlist/, '有形態清單');
  assert.match(src, /enc-formgroups/, '有動畫組切換');
  assert.match(src, /setEditForm/, '動畫組切換');
  assert.match(src, /previewFormInStage/, '形態預覽');
  assert.match(src, /cmd: 'form'/, '預覽走 cue:form');
  assert.match(src, /forms\./, '形態欄位路徑');
});

test('引擎原始碼：form cue 與 forms 正規化', () => {
  const schema = sourceOf('engine/encounter/schema.js');
  const cues = sourceOf('engine/encounter/cues.js');
  const actors = sourceOf('engine/encounter/actors.js');
  assert.match(schema, /form:\s*\{[\s\S]{0,120}?category:\s*'actor'/, 'CUE_COMMANDS 有 form');
  assert.match(schema, /src\.forms/, 'normalizeActor 處理 forms');
  assert.match(cues, /case 'form'/, 'cues.js 有 form 分支');
  assert.match(cues, /setForm\(/, 'cue 呼叫 setForm');
  assert.match(actors, /mergeFormAnims/, 'actors.js 有形態合併');
});
