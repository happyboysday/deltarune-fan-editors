/**
 * editor/locales/encounter-cue-form.js  (V2-07)
 *
 * 演出指令編輯器「form（演員形態切換）」的介面字串。
 *
 * 追加進 `cues` 命名空間（editor/locales/cues.js 的既有字串表），
 * 讓 editor/encounter/cue-schema.js 的 form 指令有標籤與摘要；
 * registerStrings 是合併式的，不會覆蓋既有鍵。
 * 三語鍵集合必須一致（editor/encounter/cue-editor.test.mjs 會檢查）。
 */

import { registerStrings } from '../i18n.js';

export const LOCALE_IDS = ['zh-Hant', 'zh-Hans', 'en'];

const ZH_HANT = {
  'cmd.form': '切換形態',
  'desc.form': '切換演員形態（整組動畫；可在 if 裡依變數切換）',
  'field.name': '形態名',
  'fieldDesc.name': 'actor.forms 內的形態名',
  'summary.form': '{actor} → 形態 {form}',
  'summary.formAnim': '{actor} → 形態 {form}（{anim}）',
};

const ZH_HANS = {
  'cmd.form': '切换形态',
  'desc.form': '切换演员形态（整组动画；可在 if 里依变量切换）',
  'field.name': '形态名',
  'fieldDesc.name': 'actor.forms 内的形态名',
  'summary.form': '{actor} → 形态 {form}',
  'summary.formAnim': '{actor} → 形态 {form}（{anim}）',
};

const EN = {
  'cmd.form': 'Switch form',
  'desc.form': 'Switch the actor’s form (a whole anim set; use inside if to switch by variable)',
  'field.name': 'Form name',
  'fieldDesc.name': 'A form name defined in actor.forms',
  'summary.form': '{actor} → form {form}',
  'summary.formAnim': '{actor} → form {form} ({anim})',
};

export const STRINGS = {
  'zh-Hant': ZH_HANT,
  'zh-Hans': ZH_HANS,
  en: EN,
};

export default STRINGS;

registerStrings('cues', STRINGS);

/** 三語鍵集合一致性檢查（測試用）。 */
export function findKeyMismatches(strings = STRINGS) {
  const out = [];
  const ids = Object.keys(strings);
  const union = new Set();
  for (const id of ids) for (const key of Object.keys(strings[id] || {})) union.add(key);
  for (const key of union) {
    for (const id of ids) {
      if (!(key in (strings[id] || {}))) out.push({ lang: id, key, reason: 'missing' });
    }
  }
  return out;
}
