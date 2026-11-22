/**
 * engine/encounter/menu.js — 選單回合（SPEC-P2 §2 menu / §5 menu 形狀）
 *
 * 職責：只做「選單狀態機」——隊員輪流選指令、按鈕列、清單（敵人 / ACT / 法術 /
 * 道具 / 隊員）、分頁、X 回上一層 / 上一位、被 ACT 佔用的隊員跳過。
 * 不碰 DOM、不碰模擬；資料一律透過 provider 函式取得，方便無頭測試與 fake world。
 *
 * 輸出（§5）：
 *   {
 *     member,                 // 目前正在選的隊員索引
 *     buttons: [{ id, enabled }],
 *     cursor,                 // 按鈕游標
 *     list: null | { kind: 'enemy'|'act'|'magic'|'item'|'party',
 *                    title, items: [{ label, sub, enabled, mercy?, hpPct? }],
 *                    cursor, page }
 *   }
 *
 * 輸入：input.press 內含 'confirm' | 'cancel' | 'up' | 'down' | 'left' | 'right'
 *
 * 選單完成後 actions = 每位隊員的選擇（依隊員順序）：
 *   { member, memberId, command, target?, actId?, spellId?, itemIndex?, itemId?,
 *     targetMember?, occupied? }
 *
 * 本模組不 import 任何 E1 檔案，所有文字/數值自行處理，缺資料時安靜降級。
 */

/** 清單每頁列數（與 render-encounter.js 的 LIST_BOX.perPage 一致） */
export const PAGE_SIZE = 5;

/** §5 的按鈕 id 順序（顯示順序仍依隊員 commands） */
export const MENU_BUTTON_IDS = ['fight', 'act', 'magic', 'item', 'spare', 'defend'];

/** 取多語文字：字串原樣，{zh,en} 依語言 */
export function textOf(value, lang = 'zh') {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const v = value[lang];
    if (typeof v === 'string' && v) return v;
    if (typeof value.zh === 'string' && value.zh) return value.zh;
    if (typeof value.en === 'string' && value.en) return value.en;
    return '';
  }
  return String(value);
}

/** 安全取數字 */
function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 清單標題（渲染器通常有自己的字串表；這裡仍提供 §5 要求的 title） */
const LIST_TITLES = {
  zh: { enemy: '敌人', act: '行动', magic: '法术', item: '道具', party: '队伍' },
  en: { enemy: 'TARGET', act: 'ACT', magic: 'MAGIC', item: 'ITEM', party: 'PARTY' },
};

/** 對外訊息字串（流程回報用；語言由 encounter/flow 決定） */
export const MENU_MESSAGES = {
  zh: {
    noEnemies: '* 没有可以瞄准的敌人。',
    noItems: '* 没有可以使用的道具。',
    noMagic: '* 没有可以使用的法术。',
    spareFail: '* 你试图饶恕……但没有成功。',
    flee: '* 你逃跑了。',
  },
  en: {
    noEnemies: '* There is no target.',
    noItems: '* You have no items.',
    noMagic: '* You have no spells.',
    spareFail: '* You tried to spare... but nothing happened.',
    flee: '* You fled.',
  },
};

/** 建立選單所需的資料來源；全部接受函式或靜態陣列 */
function resolveProvider(value, fallback) {
  if (typeof value === 'function') return value;
  if (Array.isArray(value)) return () => value;
  return fallback;
}

/**
 * 建立選單狀態機。
 *
 * @param {object} options
 * @param {object} options.encounter 正規化後的遭遇（party / enemies / items / settings）
 * @param {Array|Function} options.party   隊伍「執行期」陣列（hp/down/…) — 預設 encounter.party
 * @param {Array|Function} options.enemies 敵人執行期陣列（hp/removed/mercy/…) — 預設 encounter.enemies
 * @param {Array|Function} options.items   道具執行期陣列（count/…) — 預設 encounter.items
 * @param {number|Function} [options.tp]   TP（法術可用性）
 * @param {string} [options.lang]          'zh' | 'en'
 * @param {(entry:object)=>void} [options.onAction] 每選定一個行動時回呼（flow 用來寫回世界狀態）
 * @param {(name:string)=>void} [options.onSfx]    音效（游標移動 / 確定 / 取消）
 * @returns {object} menu
 */
export function createMenu(options = {}) {
  const encounter = options.encounter || {};
  const getParty = resolveProvider(options.party, () => encounter.party || []);
  const getEnemies = resolveProvider(options.enemies, () => encounter.enemies || []);
  const getItems = resolveProvider(options.items, () => encounter.items || []);
  const getTp = typeof options.tp === 'function' ? options.tp : () => num(options.tp, 0);
  const getLang = typeof options.lang === 'function' ? options.lang : () => (options.lang === 'en' ? 'en' : 'zh');
  const onAction = typeof options.onAction === 'function' ? options.onAction : () => {};
  const onSfx = typeof options.onSfx === 'function' ? options.onSfx : () => {};

  /** 目前狀態 */
  const state = {
    /** 'buttons' | 'list' */
    mode: 'buttons',
    /** 目前隊員索引 */
    member: 0,
    /** 按鈕游標（member.commands 的索引） */
    cursor: 0,
    /** 目前的清單 */
    list: null,
    /** 已完成的選擇：memberIndex → entry */
    picked: new Map(),
    /** 被 ACT 佔用（不需自己選）的隊員索引 */
    occupied: new Set(),
    /** 全部完成 */
    done: false,
    /** 取消鍵在第一層按下的提示（flow 可讀；例如 canFlee） */
    event: null,
  };

  const lang = () => (getLang() === 'en' ? 'en' : 'zh');
  const L = () => LIST_TITLES[lang()] || LIST_TITLES.zh;
  const M = () => MENU_MESSAGES[lang()] || MENU_MESSAGES.zh;

  /* ------------------------------------------------------------ 查詢 */

  function partyList() {
    return Array.isArray(getParty()) ? getParty() : [];
  }
  function enemyList() {
    const list = getEnemies();
    return Array.isArray(list) ? list : [];
  }
  function itemList() {
    const list = getItems();
    return Array.isArray(list) ? list : [];
  }

  /** 活著的敵人（ACT / FIGHT / SPARE 的目標） */
  function livingEnemies() {
    return enemyList().filter((e) => e && !e.removed && num(e.hp, 0) > 0);
  }

  /** 存活隊員索引 */
  function aliveMembers() {
    const list = partyList();
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const p = list[i];
      if (p && num(p.hp, 0) > 0 && !p.down) out.push(i);
    }
    return out;
  }

  /** 一位隊員的可用世界內指令（filter 過 encounter 的 commands） */
  function commandsOf(index) {
    const list = partyList();
    const p = list[index];
    if (!p) return [];
    const raw = Array.isArray(p.commands) ? p.commands : [];
    const out = [];
    for (const id of raw) {
      if (!MENU_BUTTON_IDS.includes(id)) continue;
      if (!out.includes(id)) out.push(id);
    }
    // items / magic 只有在真的有內容時才給按鈕；footnote：仍然顯示但 disabled
    return out;
  }

  /** 隊員的法術清單 */
  function spellsOf(index) {
    const p = partyList()[index];
    return p && Array.isArray(p.spells) ? p.spells : [];
  }

  /** 某個指令按鈕是否可用 */
  function commandEnabled(index, id) {
    const p = partyList()[index];
    if (!p || num(p.hp, 0) <= 0) return false;
    switch (id) {
      case 'fight':
      case 'act':
      case 'spare':
        return livingEnemies().length > 0;
      case 'magic':
        return spellsOf(index).length > 0;
      case 'item':
        return itemList().some((it) => it && num(it.count, 0) > 0);
      case 'defend':
        return true;
      default:
        return false;
    }
  }

  /* ------------------------------------------------------- 隊員輪替 */

  /** 從 from 之後找下一個可以選的隊員（跳過倒下 / 被佔用） */
  function nextMemberIndex(from) {
    const list = partyList();
    for (let i = Math.max(0, from); i < list.length; i += 1) {
      const p = list[i];
      if (!p) continue;
      if (num(p.hp, 0) <= 0 || p.down) continue;
      if (state.occupied.has(i)) continue;
      return i;
    }
    return -1;
  }

  /** 從 from 之前找上一個可以選的隊員 */
  function prevMemberIndex(from) {
    for (let i = Math.min(from, partyList().length - 1); i >= 0; i -= 1) {
      const p = partyList()[i];
      if (!p) continue;
      if (num(p.hp, 0) <= 0 || p.down) continue;
      if (state.occupied.has(i)) continue;
      return i;
    }
    return -1;
  }

  /** 目前隊員的按鈕清單 */
  function buttonsOf(index) {
    return commandsOf(index).map((id) => ({ id, enabled: commandEnabled(index, id) }));
  }

  /** 把游標移到指定方向最近的可用按鈕；全部不可用時回 -1 */
  function moveCursor(buttons, from, dir) {
    if (buttons.length === 0) return -1;
    let i = from;
    for (let n = 0; n < buttons.length * 2; n += 1) {
      i += dir;
      if (i < 0) i = buttons.length - 1;
      if (i >= buttons.length) i = 0;
      if (buttons[i].enabled) return i;
    }
    return -1;
  }

  /* --------------------------------------------------------- 清單 */

  /** 建立清單資料（§5 list 形狀） */
  function makeList(kind, extra = {}) {
    const title = typeof extra.title === 'string' ? extra.title : L()[kind] || '';
    return {
      kind,
      title,
      items: Array.isArray(extra.items) ? extra.items : [],
      cursor: 0,
      page: 0,
      /** 內部：清單來源與後續動作 */
      source: extra.source || null,
      back: extra.back || null,
      depth: num(extra.depth, 1),
      data: extra.data || null,
    };
  }

  function enemyEntries() {
    return livingEnemies().map((e) => ({
      label: textOf(e.name, lang()),
      sub: `${Math.max(0, Math.round(num(e.hp, 0)))}/${Math.max(1, Math.round(num(e.maxHp, 1)))}`,
      enabled: true,
      mercy: Math.max(0, Math.min(100, num(e.mercy, 0))),
      hpPct: (Math.max(0, num(e.hp, 0)) / Math.max(1, num(e.maxHp, 1))) * 100,
      enemyId: e.id,
    }));
  }

  function partyEntries(canRevive = false) {
    const list = partyList();
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const p = list[i];
      if (!p) continue;
      const hp = Math.max(0, num(p.hp, 0));
      out.push({
        label: textOf(p.name, lang()),
        sub: `${hp}/${Math.max(1, Math.round(num(p.maxHp, 1)))}`,
        enabled: hp > 0 || canRevive,
        hpPct: (hp / Math.max(1, num(p.maxHp, 1))) * 100,
        member: i,
      });
    }
    return out;
  }

  /** 打開第一層清單（依按鈕 id） */
  function openListFor(command) {
    const index = state.member;
    switch (command) {
      case 'fight':
      case 'spare': {
        const items = enemyEntries();
        if (items.length === 0) return false;
        state.list = makeList('enemy', { items, depth: 1, data: { command } });
        state.mode = 'list';
        return true;
      }
      case 'act': {
        const items = enemyEntries();
        if (items.length === 0) return false;
        state.list = makeList('enemy', { items, depth: 1, data: { command } });
        state.mode = 'list';
        return true;
      }
      case 'magic': {
        const spells = spellsOf(index);
        if (spells.length === 0) return false;
        const tp = num(getTp(), 0);
        const items = spells.map((sp) => ({
          label: textOf(sp.name, lang()),
          sub: `TP ${Math.max(0, Math.round(num(sp.tp, 0)))}`,
          enabled: tp >= num(sp.tp, 0),
          spellId: sp.id,
        }));
        state.list = makeList('magic', { items, depth: 1, data: { command } });
        state.mode = 'list';
        return true;
      }
      case 'item': {
        const items = itemEntries();
        if (items.length === 0) return false;
        state.list = makeList('item', { items, depth: 1, data: { command } });
        state.mode = 'list';
        return true;
      }
      default:
        return false;
    }
  }

  /** 道具清單（count > 0；index 指向 world.items 的原始索引） */
  function itemEntries() {
    const list = itemList();
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const it = list[i];
      if (!it) continue;
      const count = Math.max(0, Math.round(num(it.count, 0)));
      if (count <= 0) continue;
      out.push({
        label: textOf(it.name, lang()),
        sub: `x${count}`,
        enabled: true,
        itemIndex: i,
        itemId: it.id,
      });
    }
    return out;
  }

  /* ------------------------------------------------------- 完成選擇 */

  /** 記錄 choice 並推進到下一位；沒有下一位就完成 */
  function commit(entry) {
    if (!entry) return;
    state.picked.set(state.member, entry);
    // ACT 佔用的隊員：記錄起來並標記
    if (Array.isArray(entry.occupiedMembers)) {
      for (const m of entry.occupiedMembers) {
        if (m === state.member) continue;
        if (m >= 0 && m < partyList().length) state.occupied.add(m);
      }
    }
    try {
      onAction(entry);
    } catch (_e) {
      /* 回呼錯誤不影響選單 */
    }
    onSfx('snd_select');
    const next = nextMemberIndex(state.member + 1);
    if (next < 0) {
      state.done = true;
      state.mode = 'buttons';
      state.list = null;
      return;
    }
    state.member = next;
    state.mode = 'buttons';
    state.list = null;
    state.cursor = firstEnabledCursor(buttonsOf(state.member));
  }

  function firstEnabledCursor(buttons) {
    for (let i = 0; i < buttons.length; i += 1) if (buttons[i].enabled) return i;
    return -1;
  }

  /** 從清單選擇當前項目 */
  function confirmList() {
    const list = state.list;
    if (!list || list.items.length === 0) return;
    const item = list.items[list.cursor];
    if (!item) return;
    if (item.enabled === false) {
      onSfx('snd_nosound');
      return;
    }
    const data = list.data || {};
    const command = data.command;

    /* ---- 第一層：選敵人（fight / spare → 完成；act → ACT 清單） ---- */
    if (list.kind === 'enemy' && list.depth <= 1) {
      if (command === 'act') {
        openActList(item.enemyId);
        return;
      }
      commit({
        member: state.member,
        memberId: memberId(state.member),
        command: command === 'spare' ? 'spare' : 'fight',
        target: item.enemyId,
      });
      return;
    }

    /* ---- ACT 清單 ---- */
    if (list.kind === 'act') {
      const acts = Array.isArray(data.acts) ? data.acts : [];
      const act = acts.find((a) => a.id === item.actId);
      if (!act) return;
      const occupiedMembers = [];
      const party = partyList();
      for (let i = 0; i < party.length; i += 1) {
        if (i === state.member) continue;
        const p = party[i];
        if (!p) continue;
        if (Array.isArray(act.party) && act.party.includes(p.id)) occupiedMembers.push(i);
      }
      commit({
        member: state.member,
        memberId: memberId(state.member),
        command: 'act',
        target: data.enemyId,
        actId: act.id,
        actName: textOf(act.name, lang()),
        actParty: Array.isArray(act.party) ? act.party.slice() : [],
        occupiedMembers,
      });
      return;
    }

    /* ---- 法術清單 → 依 spell.target 決定是否再選目標 ---- */
    if (list.kind === 'magic') {
      const spell = (spellsOf(state.member) || []).find((s) => s.id === item.spellId) || null;
      if (!spell) return;
      if (spell.target === 'enemy') {
        const items = enemyEntries();
        if (items.length === 0) {
          onSfx('snd_nosound');
          return;
        }
        pushList(makeList('enemy', {
          items,
          depth: 2,
          data: { command: 'magic', spellId: spell.id, spell },
        }));
        return;
      }
      if (spell.target === 'party') {
        pushList(makeList('party', {
          items: partyEntries(),
          depth: 2,
          data: { command: 'magic', spellId: spell.id, spell },
        }));
        return;
      }
      commit({
        member: state.member,
        memberId: memberId(state.member),
        command: 'magic',
        spellId: spell.id,
      });
      return;
    }

    /* ---- 道具清單 → 依 item.target 決定是否再選目標 ---- */
    if (list.kind === 'item') {
      const rawItem = itemList()[item.itemIndex];
      if (!rawItem) return;
      if (rawItem.target === 'enemy') {
        const items = enemyEntries();
        if (items.length === 0) {
          onSfx('snd_nosound');
          return;
        }
        pushList(makeList('enemy', {
          items,
          depth: 2,
          data: { command: 'item', itemIndex: item.itemIndex },
        }));
        return;
      }
      pushList(makeList('party', {
        items: partyEntries(rawItem.revive),
        depth: 2,
        data: { command: 'item', itemIndex: item.itemIndex },
      }));
      return;
    }

    /* ---- 第二層：選敵人（魔法 / 道具的敵方目標） ---- */
    if (list.kind === 'enemy' && list.depth >= 2) {
      if (command === 'magic') {
        commit({
          member: state.member,
          memberId: memberId(state.member),
          command: 'magic',
          spellId: data.spellId,
          target: item.enemyId,
        });
        return;
      }
      if (command === 'item') {
        commit({
          member: state.member,
          memberId: memberId(state.member),
          command: 'item',
          itemIndex: data.itemIndex,
          target: item.enemyId,
        });
      }
      return;
    }

    /* ---- 第二層：選隊員（魔法 / 道具的己方目標） ---- */
    if (list.kind === 'party') {
      if (command === 'magic') {
        commit({
          member: state.member,
          memberId: memberId(state.member),
          command: 'magic',
          spellId: data.spellId,
          targetMember: item.member,
        });
        return;
      }
      if (command === 'item') {
        commit({
          member: state.member,
          memberId: memberId(state.member),
          command: 'item',
          itemIndex: data.itemIndex,
          targetMember: item.member,
        });
      }
    }
  }

  function memberId(index) {
    const p = partyList()[index];
    return p && p.id ? p.id : String(index);
  }

  function pushList(list) {
    list.back = state.list;
    state.list = list;
    state.mode = 'list';
    state.list.cursor = 0;
  }

  /** 選擇敵人後打開該敵人的 ACT 清單 */
  function openActList(enemyId) {
    const enemy = livingEnemies().find((e) => e.id === enemyId);
    if (!enemy) return;
    const acts = Array.isArray(enemy.acts) ? enemy.acts : [];
    if (acts.length === 0) {
      onSfx('snd_nosound');
      return;
    }
    const party = partyList();
    const chooser = memberId(state.member);
    const items = acts.map((act) => {
      const required = Array.isArray(act.party) ? act.party : [];
      const enabled = required.every((id) => party.some((p) => p && p.id === id && num(p.hp, 0) > 0));
      const collaboratorId = required.find((id) => id !== chooser);
      const collaborator = party.findIndex((p) => p?.id === collaboratorId);
      return {
        label: textOf(act.name, lang()),
        sub: num(act.mercy, 0) > 0 ? `+${num(act.mercy, 0)}` : '',
        enabled,
        actId: act.id,
        ...(collaborator >= 0 ? { member: collaborator } : {}),
      };
    });
    pushList(makeList('act', {
      items,
      depth: 2,
      title: L().act,
      data: { command: 'act', enemyId, acts },
      back: state.list,
    }));
  }

  /* --------------------------------------------------------- 更新 */

  /** 在按鈕層按確定 */
  function confirmButton() {
    const buttons = buttonsOf(state.member);
    if (buttons.length === 0) {
      // 沒有可用按鈕 → 視為防禦
      commit({ member: state.member, memberId: memberId(state.member), command: 'defend' });
      return;
    }
    const btn = buttons[state.cursor];
    if (!btn) return;
    if (!btn.enabled) {
      onSfx('snd_nosound');
      return;
    }
    if (btn.id === 'defend') {
      commit({ member: state.member, memberId: memberId(state.member), command: 'defend' });
      return;
    }
    if (!openListFor(btn.id)) {
      onSfx('snd_nosound');
    }
  }

  /** 在按鈕層按取消：回上一位；第一位 → 交給 flow（可能逃跑） */
  function cancelButton() {
    const prev = prevMemberIndex(state.member - 1);
    if (prev < 0) {
      state.event = { type: 'cancelFirst' };
      return;
    }
    // 清掉上一位的選擇與佔用
    const entry = state.picked.get(prev);
    state.picked.delete(prev);
    if (entry && Array.isArray(entry.occupiedMembers)) {
      for (const m of entry.occupiedMembers) state.occupied.delete(m);
    }
    state.member = prev;
    state.cursor = firstEnabledCursor(buttonsOf(prev));
    state.mode = 'buttons';
    state.list = null;
    onSfx('snd_cancel');
  }

  /** 在清單層按取消：回上一層；第一層就回按鈕列 */
  function cancelList() {
    const list = state.list;
    if (!list) return;
    if (list.back) {
      state.list = list.back;
      state.list.back = null;
      state.mode = 'list';
    } else {
      state.list = null;
      state.mode = 'buttons';
    }
    onSfx('snd_cancel');
  }

  /**
   * 每幀推進選單。
   * @param {{press?:string[], has?:(k:string)=>boolean}} [input]
   * @returns {{done:boolean, event:object|null}}
   */
  function update(input) {
    state.event = null;
    if (state.done) return { done: true, event: null };
    const press = input && Array.isArray(input.press) ? input.press : [];
    const has = (k) => press.includes(k);

    if (state.mode === 'list' && state.list) {
      const list = state.list;
      if (has('up')) {
        list.cursor = list.cursor > 0 ? list.cursor - 1 : Math.max(0, list.items.length - 1);
        list.page = Math.floor(list.cursor / PAGE_SIZE);
        onSfx('snd_move');
      } else if (has('down')) {
        list.cursor = list.cursor + 1 < list.items.length ? list.cursor + 1 : 0;
        list.page = Math.floor(list.cursor / PAGE_SIZE);
        onSfx('snd_move');
      } else if (has('left')) {
        // 分頁：左右鍵跨頁
        const total = list.items.length;
        if (total > PAGE_SIZE) {
          list.cursor = Math.max(0, list.cursor - PAGE_SIZE);
          list.page = Math.floor(list.cursor / PAGE_SIZE);
          onSfx('snd_move');
        }
      } else if (has('right')) {
        const total = list.items.length;
        if (total > PAGE_SIZE) {
          list.cursor = Math.min(total - 1, list.cursor + PAGE_SIZE);
          list.page = Math.floor(list.cursor / PAGE_SIZE);
          onSfx('snd_move');
        }
      } else if (has('confirm')) {
        confirmList();
      } else if (has('cancel')) {
        cancelList();
      }
      return { done: state.done, event: state.event };
    }

    // 按鈕層
    const buttons = buttonsOf(state.member);
    if (has('left')) {
      const next = moveCursor(buttons, state.cursor < 0 ? 0 : state.cursor, -1);
      if (next >= 0) state.cursor = next;
      onSfx('snd_move');
    } else if (has('right')) {
      const next = moveCursor(buttons, state.cursor < 0 ? buttons.length - 1 : state.cursor, 1);
      if (next >= 0) state.cursor = next;
      onSfx('snd_move');
    } else if (has('up') || has('down')) {
      // 按鈕列為橫向；上下鍵同樣左右移動（部分玩家習慣）
      const dir = has('down') ? 1 : -1;
      const next = moveCursor(buttons, state.cursor < 0 ? 0 : state.cursor, dir);
      if (next >= 0) state.cursor = next;
      onSfx('snd_move');
    } else if (has('confirm')) {
      confirmButton();
    } else if (has('cancel')) {
      cancelButton();
    }
    return { done: state.done, event: state.event };
  }


  /* --------------------------------------------------------- 快照 */

  /** 深拷貝成純資料 */
  function plainClone(value) {
    if (Array.isArray(value)) return value.map(plainClone);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) out[key] = plainClone(value[key]);
      return out;
    }
    return value;
  }

  /** 把清單堆疊攤平成陣列（最底層在前；back 鏈在還原時重建） */
  function listChain(list) {
    const out = [];
    let cur = list;
    while (cur) {
      out.unshift(cur);
      cur = cur.back || null;
    }
    return out;
  }

  function listSnapshot(list) {
    if (!list) return null;
    return {
      kind: list.kind,
      title: list.title,
      items: plainClone(list.items),
      cursor: list.cursor,
      page: list.page,
      depth: list.depth,
      source: list.source === undefined ? null : list.source,
      data: plainClone(list.data),
    };
  }

  /**
   * 選單完整執行期狀態（V2-08 snapshot 用）。
   *
   * 清單的 items 是「開啟清單當下」從 world 物化的資料 → 直接存下來，
   * 還原時不必重算（也就不會因為 world 狀態而漂移）。
   */
  function snapshotState() {
    return {
      mode: state.mode,
      member: state.member,
      cursor: state.cursor,
      done: state.done === true,
      event: plainClone(state.event),
      picked: Array.from(state.picked.entries()).map(([k, v]) => [k, plainClone(v)]),
      occupied: Array.from(state.occupied),
      lists: listChain(state.list).map(listSnapshot),
    };
  }

  /** 還原 snapshotState()（必須在 world 還原之後；items 已是快照值） */
  function restoreState(snap) {
    const s = snap && typeof snap === 'object' ? snap : null;
    if (!s) return false;
    state.mode = s.mode === 'list' ? 'list' : 'buttons';
    state.member = Math.max(0, Math.round(num(s.member, 0)));
    state.cursor = Math.round(num(s.cursor, 0));
    state.done = s.done === true;
    state.event = s.event === undefined ? null : plainClone(s.event);
    state.picked.clear();
    for (const pair of Array.isArray(s.picked) ? s.picked : []) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      state.picked.set(Math.round(num(pair[0], 0)), plainClone(pair[1]));
    }
    state.occupied.clear();
    for (const i of Array.isArray(s.occupied) ? s.occupied : []) {
      state.occupied.add(Math.round(num(i, 0)));
    }
    state.list = null;
    for (const src of Array.isArray(s.lists) ? s.lists : []) {
      const list = {
        kind: src.kind,
        title: src.title,
        items: plainClone(src.items || []),
        cursor: Math.round(num(src.cursor, 0)),
        page: Math.round(num(src.page, 0)),
        source: src.source === undefined ? null : src.source,
        back: state.list,
        depth: Math.round(num(src.depth, 1)),
        data: plainClone(src.data),
      };
      state.list = list;
    }
    return true;
  }

  /* --------------------------------------------------------- 快照 */

  /** §5 的 menu 形狀（不在選單時回 null 由 flow 決定） */
  function snapshot() {
    if (state.done) return null;
    const buttons = buttonsOf(state.member);
    const list = state.list
      ? {
          kind: state.list.kind,
          title: state.list.title,
          items: state.list.items.map((it) => ({
            label: it.label,
            sub: it.sub,
            enabled: it.enabled !== false,
            ...(it.member !== undefined ? { member: it.member } : {}),
            ...(it.mercy !== undefined ? { mercy: it.mercy } : {}),
            ...(it.hpPct !== undefined ? { hpPct: it.hpPct } : {}),
          })),
          cursor: state.list.cursor,
          page: state.list.page,
        }
      : null;
    return {
      member: state.member,
      buttons: buttons.map((b) => ({ id: b.id, enabled: b.enabled })),
      cursor: Math.max(0, state.cursor),
      list,
    };
  }

  /** 已完成的選擇（依隊員順序） */
  function actions() {
    const out = [];
    const list = partyList();
    for (let i = 0; i < list.length; i += 1) {
      const entry = state.picked.get(i);
      if (entry) out.push(entry);
    }
    // 被佔用的隊員也產生一筆（命令 act、不重複演出；flow 會跳過它的獨立行動）
    for (const i of Array.from(state.occupied).sort((a, b) => a - b)) {
      if (state.picked.has(i)) continue;
      out.push({
        member: i,
        memberId: memberId(i),
        command: 'act',
        occupied: true,
      });
    }
    return out;
  }

  /* --------------------------------------------------------- 生命週期 */

  function start() {
    state.mode = 'buttons';
    state.member = 0;
    state.cursor = 0;
    state.list = null;
    state.picked.clear();
    state.occupied.clear();
    state.done = false;
    state.event = null;
    const first = nextMemberIndex(0);
    if (first < 0) {
      state.done = true;
      return;
    }
    state.member = first;
    state.cursor = firstEnabledCursor(buttonsOf(first));
  }

  function reset() {
    start();
  }

  return {
    start,
    reset,
    update,
    snapshot,
    actions,
    // V2-08：完整執行期狀態（serialization 用；不改行為）
    snapshotState,
    restoreState,
    /** 選單是否完成 */
    get done() {
      return state.done;
    },
    /** 目前隊員索引（完成後為最後一位） */
    get member() {
      return state.member;
    },
    /** 目前模式（除錯用） */
    get mode() {
      return state.mode;
    },
    /** 最近一次 update 的事件（cancelFirst 等） */
    get event() {
      return state.event;
    },
    /** 內部狀態（測試 / 除錯用；勿直接改） */
    get state() {
      return state;
    },
  };
}

export default createMenu;
