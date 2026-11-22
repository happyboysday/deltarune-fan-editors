/**
 * engine/autoplay/validate-encounter.js — 遭遇 demo 驗證（SPEC-AUTOPLAY §3 / §5）
 *
 * 為什麼獨立一支檔案：`engine/autoplay/validate.js` 由 AP1 平行開發（含
 * `validateAttackDemo`），為了避免兩個工作階段同時改同一個檔案，這裡只放
 * `validateEncounterDemo`，完成後由協調者把 validate.js 接上（或直接 import 本檔）。
 *
 *   import { validateEncounterDemo } from './validate-encounter.js';
 *
 * 回傳 `[{ path, message }]`，path 格式與 Phase 1 / SPEC-P2 相同（例如
 * `demo.turns[0].choices[1].option`）。永不 throw：資料壞掉就回一筆錯誤。
 *
 * 檢查內容（SPEC-AUTOPLAY §2.2）：
 *   - demo / demo.text / demo.turns / demo.default 的型別
 *   - text.auto 布林、text.delay 非負數
 *   - menuDelay 非負整數
 *   - turns[i].turn：1 起算的正整數、不可重複（依實際進行的回合計數）
 *   - turns[i].choices[j]：member 是否存在於 encounter.party
 *         command 是否合法且在該隊員的 party[].commands 內
 *         target / option 是否存在于該敵人（ACT / 法術 / 道具）
 *         fight：perfect/good/miss/ok 或 0..1 數值
 *         dodge：path/inputs/bot/none
 *   - default.choices：'fight' 等指令字串，或 { member, command, ... } 陣列
 *   - 未知欄位只警告？→ 這裡不檢查（保持與引擎的寬鬆度一致）
 */

/* ------------------------------------------------------------------ 常數 */

export const DEMO_COMMANDS = ['fight', 'act', 'magic', 'item', 'spare', 'defend'];
export const DEMO_FIGHT_MODES = ['perfect', 'good', 'ok', 'miss'];
export const DEMO_DODGE_MODES = ['path', 'inputs', 'bot', 'none'];

/* ------------------------------------------------------------- 小工具 */

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isTextValue(v) {
  if (typeof v === 'string') return true;
  if (!isObj(v)) return false;
  const zh = v.zh;
  const en = v.en;
  return (zh === undefined || typeof zh === 'string') && (en === undefined || typeof en === 'string');
}

/** 多語文字 → 全部可能的字串（給 id / 名稱比對） */
function textsOf(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (isObj(value)) {
    const out = [];
    for (const key of ['zh', 'en']) {
      if (typeof value[key] === 'string' && value[key]) out.push(value[key]);
    }
    return out;
  }
  if (isFiniteNum(value)) return [String(value)];
  return [];
}

function norm(s) {
  return String(s === null || s === undefined ? '' : s).trim().toLowerCase();
}

/** ref 是否等於某個項目（id 或名稱；大小寫不敏感） */
function matches(item, ref) {
  if (!item || ref === null || ref === undefined || ref === '') return false;
  const needles = textsOf(ref).map(norm).filter(Boolean);
  if (needles.length === 0) return false;
  const values = [item.id, ...textsOf(item.name)].map(norm).filter(Boolean);
  for (const v of values) {
    if (needles.includes(v)) return true;
  }
  return false;
}

function refText(ref) {
  if (ref === null || ref === undefined) return '';
  if (isObj(ref)) {
    const t = textsOf(ref);
    return t.length > 0 ? t[0] : JSON.stringify(ref);
  }
  return String(ref);
}

function arraysOf(doc, key) {
  return doc && Array.isArray(doc[key]) ? doc[key] : [];
}

/* --------------------------------------------------------------- 主函式 */

/**
 * 驗證遭遇檔的 `demo`（SPEC-AUTOPLAY §2.2）。
 *
 * @param {object} demo      遭遇檔的 `demo` 欄位（undefined / null 都合法 = 沒有腳本）
 * @param {object} encounter 遭遇檔原始 JSON（用來檢查 member / command / target / option）
 * @returns {{path:string, message:string}[]}
 */
export function validateEncounterDemo(demo, encounter) {
  /** @type {{path:string, message:string}[]} */
  const errors = [];
  const push = (path, message) => errors.push({ path, message });

  // demo 沒有 = 合法（自動演示關閉時一切照舊，SPEC-AUTOPLAY §1.3）
  if (demo === undefined || demo === null) return errors;

  const path = 'demo';
  if (!isObj(demo)) {
    push(path, 'demo 必須是物件');
    return errors;
  }

  const doc = isObj(encounter) ? encounter : {};

  /* --- text --- */
  if (demo.text !== undefined) {
    if (!isObj(demo.text)) {
      push('demo.text', 'text 必須是物件');
    } else {
      const t = demo.text;
      if (t.auto !== undefined && typeof t.auto !== 'boolean') {
        push('demo.text.auto', 'auto 必須是布林');
      }
      if (t.delay !== undefined) {
        if (!isFiniteNum(t.delay)) push('demo.text.delay', 'delay 必須是數字（秒）');
        else if (t.delay < 0) push('demo.text.delay', 'delay 不可為負');
      }
      for (const key of Object.keys(t)) {
        if (key !== 'auto' && key !== 'delay') {
          push(`demo.text.${key}`, `未知的 text 欄位 "${key}"（可用：auto / delay）`);
        }
      }
    }
  }

  /* --- menuDelay --- */
  if (demo.menuDelay !== undefined) {
    if (!isFiniteNum(demo.menuDelay)) push('demo.menuDelay', 'menuDelay 必須是數字（幀）');
    else if (demo.menuDelay < 0) push('demo.menuDelay', 'menuDelay 不可為負');
    else if (!Number.isInteger(demo.menuDelay)) push('demo.menuDelay', 'menuDelay 必須是整數');
  }

  /* --- 選項清單參考資料 --- */
  const party = arraysOf(doc, 'party').filter(isObj);
  const enemies = arraysOf(doc, 'enemies').filter(isObj);
  const items = arraysOf(doc, 'items').filter(isObj);

  const memberIds = new Set(party.map((p) => (typeof p.id === 'string' ? p.id : '')).filter(Boolean));
  const enemyIds = new Set(enemies.map((e) => (typeof e.id === 'string' ? e.id : '')).filter(Boolean));

  function findMember(ref) {
    if (ref === null || ref === undefined || ref === '') return null;
    if (typeof ref === 'string') {
      for (const p of party) if (p.id === ref) return p;
    }
    return party.find((p) => matches(p, ref)) || null;
  }

  function findEnemy(ref) {
    if (ref === null || ref === undefined || ref === '') return null;
    if (typeof ref === 'string') {
      for (const e of enemies) if (e.id === ref) return e;
    }
    return enemies.find((e) => matches(e, ref)) || null;
  }

  /** 找道具：只找 encounter.items 裡 count > 0 的（本場真的能用的） */
  function findItem(ref) {
    if (ref === null || ref === undefined || ref === '') return null;
    const usable = items.filter((it) => {
      const n = Number(it.count === undefined ? 1 : it.count);
      return !Number.isFinite(n) || n > 0;
    });
    if (typeof ref === 'string') {
      for (const it of usable) if (it.id === ref) return it;
    }
    return usable.find((it) => matches(it, ref)) || null;
  }

  /** 檢查 fight 欄位 */
  function checkFight(value, at) {
    if (value === undefined) return;
    if (typeof value === 'string') {
      if (!DEMO_FIGHT_MODES.includes(value)) {
        push(at, `fight 必須是 ${DEMO_FIGHT_MODES.join(' / ')} 或 0..1 的數字（收到 "${value}"）`);
      }
      return;
    }
    if (!isFiniteNum(value)) {
      push(at, 'fight 必須是字串或 0..1 的數字');
      return;
    }
    if (value < 0 || value > 1) push(at, 'fight 數值必須在 0..1（0 = 判定點正中）');
  }

  /** 檢查 dodge 欄位 */
  function checkDodge(value, at) {
    if (value === undefined) return;
    if (typeof value !== 'string' || !DEMO_DODGE_MODES.includes(value)) {
      push(at, `dodge 必須是 ${DEMO_DODGE_MODES.join(' / ')}`);
    }
  }

  /**
   * 檢查一筆 choice（turns[i].choices[j] 或 default.choices[j]）。
   * @param {object} choice
   * @param {string} at      錯誤路徑前綴
   */
  function checkChoice(choice, at) {
    if (!isObj(choice)) {
      push(at, 'choice 必須是物件');
      return;
    }

    /* member */
    let member = null;
    if (choice.member === undefined || choice.member === null || choice.member === '') {
      push(`${at}.member`, '缺少 member（隊員 id）');
    } else if (typeof choice.member !== 'string') {
      push(`${at}.member`, 'member 必須是隊員 id 字串');
    } else {
      member = findMember(choice.member);
      if (!member) {
        const available = Array.from(memberIds).join(', ') || '(無)';
        push(`${at}.member`, `找不到隊員 "${choice.member}"（可用：${available}）`);
      }
    }

    /* command */
    let command = null;
    if (choice.command === undefined || choice.command === null) {
      push(`${at}.command`, '缺少 command');
    } else if (typeof choice.command !== 'string') {
      push(`${at}.command`, 'command 必須是字串');
    } else if (!DEMO_COMMANDS.includes(choice.command)) {
      push(`${at}.command`, `未知的指令 "${choice.command}"（可用：${DEMO_COMMANDS.join(' / ')}）`);
    } else {
      command = choice.command;
      if (member) {
        const cmds = Array.isArray(member.commands) ? member.commands : null;
        if (cmds && cmds.length > 0 && !cmds.includes(command)) {
          push(
            `${at}.command`,
            `隊員 "${member.id}" 沒有 "${command}" 指令（可用：${cmds.join(' / ')}）`,
          );
        }
      }
    }

    /* 選填欄位型別 */
    if (choice.fight !== undefined) checkFight(choice.fight, `${at}.fight`);
    if (choice.dodge !== undefined) checkDodge(choice.dodge, `${at}.dodge`);

    /* 以下檢查需要 member / command 都合法才有意義 */
    if (!member || !command) return;

    /* defend：不該帶 target / option */
    if (command === 'defend') {
      if (choice.target !== undefined && choice.target !== null) {
        push(`${at}.target`, 'defend 不需要 target');
      }
      if (choice.option !== undefined && choice.option !== null) {
        push(`${at}.option`, 'defend 不需要 option');
      }
      return;
    }

    /* target / option */
    const targetRef = choice.target;
    const optionRef = choice.option;

    if (command === 'fight' || command === 'spare') {
      if (targetRef === undefined || targetRef === null || targetRef === '') {
        // 省略 = 第一個存活敵人（引擎支援），不算錯
      } else if (!findEnemy(targetRef)) {
        push(
          `${at}.target`,
          `找不到敵人 "${refText(targetRef)}"（可用：${Array.from(enemyIds).join(', ') || '(無)'}）`,
        );
      }
      if (optionRef !== undefined && optionRef !== null) {
        push(`${at}.option`, `${command} 不需要 option`);
      }
      return;
    }

    if (command === 'act') {
      const enemy = findEnemy(targetRef);
      if (!enemy) {
        if (targetRef === undefined || targetRef === null || targetRef === '') {
          push(`${at}.target`, 'act 需要 target（敵人 id）');
        } else {
          push(
            `${at}.target`,
            `找不到敵人 "${refText(targetRef)}"（可用：${Array.from(enemyIds).join(', ') || '(無)'}）`,
          );
        }
        return;
      }
      const acts = Array.isArray(enemy.acts) ? enemy.acts : [];
      if (acts.length === 0) {
        push(`${at}.target`, `敵人 "${enemy.id}" 沒有任何 ACT`);
        return;
      }
      // option 省略 = 第一個 ACT（引擎支援）；有給就必須存在
      if (optionRef !== undefined && optionRef !== null && optionRef !== '') {
        const act = acts.find((a) => matches(a, optionRef));
        if (!act) {
          const names = acts.map((a) => (typeof a.id === 'string' ? a.id : refText(a.name))).join(', ');
          push(
            `${at}.option`,
            `敵人 "${enemy.id}" 沒有 ACT "${refText(optionRef)}"（可用：${names || '(無)'}）`,
          );
        }
      }
      return;
    }

    if (command === 'magic') {
      const spells = Array.isArray(member.spells) ? member.spells : [];
      if (spells.length === 0) {
        push(`${at}.command`, `隊員 "${member.id}" 沒有法術（spells 為空）`);
        return;
      }
      let spell = null;
      if (optionRef === undefined || optionRef === null || optionRef === '') {
        spell = spells[0] || null; // 省略 = 第一個法術
      } else {
        spell = spells.find((s) => matches(s, optionRef)) || null;
        if (!spell) {
          const names = spells.map((s) => (typeof s.id === 'string' ? s.id : refText(s.name))).join(', ');
          push(
            `${at}.option`,
            `隊員 "${member.id}" 沒有法術 "${refText(optionRef)}"（可用：${names || '(無)'}）`,
          );
          return;
        }
      }
      if (!spell) return;
      // 法術目標：enemy / party / all
      const targetKind = spell.target === 'party' || spell.target === 'all' ? 'party' : 'enemy';
      if (targetRef === undefined || targetRef === null || targetRef === '') {
        if (targetKind === 'enemy' && enemyIds.size === 0) {
          push(`${at}.target`, '法術需要敵人目標，但遭遇沒有敵人');
        }
        return;
      }
      if (targetKind === 'enemy') {
        if (!findEnemy(targetRef)) {
          push(`${at}.target`, `法術 "${spell.id}" 需要敵人目標，找不到 "${refText(targetRef)}"`);
        }
      } else if (!findMember(targetRef)) {
        push(`${at}.target`, `法術 "${spell.id}" 需要隊員目標，找不到 "${refText(targetRef)}"`);
      }
      return;
    }

    if (command === 'item') {
      const itemList = items.filter((it) => {
        const n = Number(it.count === undefined ? 1 : it.count);
        return !Number.isFinite(n) || n > 0;
      });
      if (itemList.length === 0) {
        push(`${at}.command`, '遭遇沒有任何可用道具（items 為空或 count 全為 0）');
        return;
      }
      let item = null;
      if (optionRef === undefined || optionRef === null || optionRef === '') {
        item = itemList[0] || null; // 省略 = 第一個道具
      } else {
        item = findItem(optionRef);
        if (!item) {
          const names = itemList.map((it) => (typeof it.id === 'string' ? it.id : refText(it.name))).join(', ');
          push(
            `${at}.option`,
            `找不到道具 "${refText(optionRef)}"（可用：${names || '(無)'}）`,
          );
          return;
        }
      }
      if (!item) return;
      // 道具目標：item.target 為 'party'（預設）/ 'enemy' / 'all'
      if (targetRef === undefined || targetRef === null || targetRef === '') return;
      if (item.target === 'enemy') {
        if (!findEnemy(targetRef)) {
          push(`${at}.target`, `道具 "${item.id}" 需要敵人目標，找不到 "${refText(targetRef)}"`);
        }
      } else if (!findMember(targetRef)) {
        push(`${at}.target`, `道具 "${item.id}" 需要隊員目標，找不到 "${refText(targetRef)}"`);
      }
    }
  }

  /* --- turns --- */
  if (demo.turns !== undefined) {
    if (!Array.isArray(demo.turns)) {
      push('demo.turns', 'turns 必須是陣列');
    } else {
      const seen = new Set();
      demo.turns.forEach((entry, i) => {
        const at = `demo.turns[${i}]`;
        if (!isObj(entry)) {
          push(at, 'turn 必須是物件');
          return;
        }
        if (entry.turn === undefined) {
          push(`${at}.turn`, '缺少 turn（1 起算）');
        } else if (!isFiniteNum(entry.turn) || !Number.isInteger(entry.turn) || entry.turn < 1) {
          push(`${at}.turn`, 'turn 必須是 1 起算的正整數');
        } else {
          if (seen.has(entry.turn)) push(`${at}.turn`, `回合 ${entry.turn} 重複指定`);
          seen.add(entry.turn);
        }

        if (entry.fight !== undefined) checkFight(entry.fight, `${at}.fight`);
        if (entry.dodge !== undefined) checkDodge(entry.dodge, `${at}.dodge`);

        if (entry.choices !== undefined) {
          if (!Array.isArray(entry.choices)) {
            push(`${at}.choices`, 'choices 必須是陣列');
          } else {
            const members = new Set();
            entry.choices.forEach((choice, j) => {
              const cp = `${at}.choices[${j}]`;
              checkChoice(choice, cp);
              if (isObj(choice) && typeof choice.member === 'string') {
                if (members.has(choice.member)) push(`${cp}.member`, `隊員 "${choice.member}" 重複指定`);
                members.add(choice.member);
              }
            });
          }
        }
      });
    }
  }

  /* --- default --- */
  if (demo.default !== undefined) {
    if (!isObj(demo.default)) {
      push('demo.default', 'default 必須是物件');
    } else {
      const d = demo.default;
      if (d.choices !== undefined) {
        if (typeof d.choices === 'string') {
          if (!DEMO_COMMANDS.includes(d.choices)) {
            push(
              'demo.default.choices',
              `未知的指令 "${d.choices}"（可用：${DEMO_COMMANDS.join(' / ')}）`,
            );
          }
        } else if (Array.isArray(d.choices)) {
          d.choices.forEach((choice, j) => checkChoice(choice, `demo.default.choices[${j}]`));
        } else {
          push('demo.default.choices', 'choices 必須是指令字串或 choice 陣列');
        }
      }
      if (d.fight !== undefined) checkFight(d.fight, 'demo.default.fight');
      if (d.dodge !== undefined) checkDodge(d.dodge, 'demo.default.dodge');
      for (const key of Object.keys(d)) {
        if (!['choices', 'fight', 'dodge'].includes(key)) {
          push(`demo.default.${key}`, `未知的 default 欄位 "${key}"（可用：choices / fight / dodge）`);
        }
      }
    }
  }

  /* --- 未知的頂層欄位 --- */
  const known = ['text', 'menuDelay', 'turns', 'default'];
  for (const key of Object.keys(demo)) {
    if (!known.includes(key)) push(`demo.${key}`, `未知的 demo 欄位 "${key}"（可用：${known.join(' / ')}）`);
  }

  void isTextValue;
  return errors;
}

export default { validateEncounterDemo, DEMO_COMMANDS, DEMO_FIGHT_MODES, DEMO_DODGE_MODES };
