#!/usr/bin/env node
/**
 * tools/agent/mcp-server.mjs — 零依賴 MCP 伺服器（SPEC-AGENT §4）。
 *
 * 為什麼要手寫：
 *   MCP 的 stdio 傳輸就是「一行一個 JSON-RPC 2.0 訊息」，用 Node 內建 readline 就能講，
 *   不需要 @modelcontextprotocol/sdk。這樣 Claude Code / DSH 掛上去就能用，
 *   不必 npm install、不必建置。
 *
 * 架構：
 *   MCP 客戶端（Claude Code / DSH）
 *        │ stdio（JSON-RPC 2.0）
 *        ▼
 *   mcp-server.mjs ──HTTP──▶ serve.py（W2 的 /api：作品 CRUD、素材搜尋、schema、editor state）
 *        └─ 直接 import ──▶ sim.mjs / difficulty.mjs / render.mjs（本行程內跑，不另外 spawn）
 *
 * 降級：找不到伺服器時，作品 CRUD 與素材搜尋改為直接讀寫磁碟（attacks/、encounters/、
 *       assets/index.json），並用「檔案位元組的 sha256」當 etag（與 serve.py 一致）。
 *
 * 安全邊界：只連 127.0.0.1；寫入只限 attacks/、encounters/；不提供任意檔案/任意程式執行。
 *
 * 用法：
 *   node tools/agent/mcp-server.mjs                  # stdio MCP（一般由客戶端 spawn）
 *   node tools/agent/mcp-server.mjs --print-tools    # 印出工具清單（除錯用）
 *   node tools/agent/mcp-server.mjs --http           # 先探測伺服器狀態再印可用性（除錯用）
 *   DR_SERVER_URL=http://127.0.0.1:18900 node tools/agent/mcp-server.mjs
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';

import {
  ATTACKS_DIR,
  BATTLE_EDITOR,
  DOCS_DIR,
  ENCOUNTERS_DIR,
  GENERATED_DIR,
  HERE,
  SAMPLES_DIR,
  SCHEMA_DIR,
  applyCliPaths,
  cliEntry,
  isFile,
  numArg,
  parseArgs,
  readJSON,
  readJSONOrNull,
  resolveInputFile,
  writeJSON,
} from './lib.mjs';

const SERVER_NAME = 'dr-battle-agent';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

const ATTACK_FORMAT = 'dr-battle-attack/1';
const ENCOUNTER_FORMAT = 'dr-battle-encounter/1';

/** 伺服器探測候選（第一個命中就用）。DR_SERVER_URL/DR_BASE_URL 優先，其次慣例埠。 */
function serverCandidates() {
  return [process.env.DR_SERVER_URL, process.env.DR_BASE_URL, 'http://127.0.0.1:18900'].filter(Boolean);
}

/* ==================================================================== */
/* 日誌（只能寫 stderr，stdout 是協定通道）                               */
/* ==================================================================== */

function log(...args) {
  if (process.env.DR_MCP_QUIET) return;
  process.stderr.write(`[dr-mcp] ${args.join(' ')}\n`);
}

/* ==================================================================== */
/* HTTP 客戶端（帶探測與降級）                                            */
/* ==================================================================== */

const serverState = {
  base: null,
  checkedAt: 0,
  /** 探測結果快取 5 秒，避免每個工具呼叫都打一次。 */
  ttlMs: 5000,
  lastError: null,
};

async function detectServer(force = false) {
  // 測試/離線演練用：強制走降級路徑
  if (process.env.DR_SERVER_OFFLINE === '1') {
    serverState.base = null;
    serverState.checkedAt = Date.now();
    return null;
  }
  const now = Date.now();
  if (!force && now - serverState.checkedAt < serverState.ttlMs) return serverState.base;
  serverState.checkedAt = now;
  for (const base of serverCandidates()) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 800);
      const response = await fetch(`${base}/api`, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload && payload.ok !== false) {
        serverState.base = base;
        serverState.lastError = null;
        return base;
      }
    } catch (err) {
      serverState.lastError = err && err.message ? err.message : String(err);
    }
  }
  serverState.base = null;
  return null;
}

/** 呼叫 serve.py 的 API；回傳 {ok,status,json,etag,offline,error}。 */
async function api(path, options = {}) {
  const base = options.base || (await detectServer(options.forceDetect));
  if (!base) {
    return { ok: false, offline: true, error: '沒有可用的本機伺服器（已降級為直接讀寫檔案）' };
  }
  const headers = { 'X-Client': options.client || 'agent', ...(options.headers || {}) };
  let body;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
    const response = await fetch(`${base}${path}`, {
      method: options.method || 'GET',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_err) {
      json = null;
    }
    const etag = response.headers.get('x-etag') || (response.headers.get('etag') || '').replace(/"/g, '') || null;
    return { ok: response.ok, status: response.status, json, etag, text, base };
  } catch (err) {
    serverState.base = null;
    serverState.checkedAt = 0;
    return { offline: true, ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/* ==================================================================== */
/* 磁碟降級層                                                            */
/* ==================================================================== */

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function canonicalText(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function kindSpec(kind) {
  if (kind === 'encounter') {
    return { kind, dir: ENCOUNTERS_DIR, format: ENCOUNTER_FORMAT, label: '遭遇', sampleDir: join(SAMPLES_DIR, 'encounters') };
  }
  return { kind: 'attack', dir: ATTACKS_DIR, format: ATTACK_FORMAT, label: '攻擊', sampleDir: SAMPLES_DIR };
}

function listLocal(kind) {
  const spec = kindSpec(kind);
  const items = [];
  const seen = new Set();
  for (const [folder, source] of [
    [spec.dir, 'workspace'],
    [spec.sampleDir, 'sample'],
  ]) {
    let names = [];
    try {
      names = readdirSync(folder).filter((n) => n.toLowerCase().endsWith('.json'));
    } catch (_err) {
      names = [];
    }
    for (const name of names) {
      const base = name.replace(/\.json$/i, '');
      if (seen.has(base)) continue;
      if (base === 'index') continue;
      seen.add(base);
      const path = join(folder, name);
      try {
        const raw = readFileSync(path);
        const doc = JSON.parse(raw.toString('utf8'));
        items.push({
          name: base,
          source,
          size: raw.length,
          etag: sha256(raw),
          metaName: doc && doc.meta ? doc.meta.name : null,
          duration: doc && doc.settings ? doc.settings.duration : null,
          turns: doc && Array.isArray(doc.turns) ? doc.turns.length : undefined,
          enemies: doc && Array.isArray(doc.enemies) ? doc.enemies.length : undefined,
        });
      } catch (_err) {
        items.push({ name: base, source, size: 0, etag: null, error: '讀取失敗' });
      }
    }
  }
  return items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function readLocal(kind, name) {
  const spec = kindSpec(kind);
  const candidates = [
    join(spec.dir, `${name}.json`),
    join(spec.sampleDir, `${name}.json`),
  ];
  for (const path of candidates) {
    if (isFile(path)) {
      const raw = readFileSync(path);
      return {
        name,
        path,
        etag: sha256(raw),
        raw: raw.toString('utf8'),
        doc: JSON.parse(raw.toString('utf8')),
        source: path.startsWith(spec.dir) ? 'workspace' : 'sample',
      };
    }
  }
  return null;
}

function validateName(name) {
  if (typeof name !== 'string' || !name.trim()) return '缺少作品名稱（name）';
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/.test(name)) {
    return '名稱只能含英數、底線、減號與中文（不可有空白、斜線或 .json）';
  }
  return null;
}

function saveLocal(kind, name, doc, ifMatch) {
  const spec = kindSpec(kind);
  const path = join(spec.dir, `${name}.json`);
  mkdirSync(spec.dir, { recursive: true });
  let current = null;
  if (isFile(path)) current = sha256(readFileSync(path));
  if (ifMatch) {
    const wanted = String(ifMatch).replace(/^W\//, '').replace(/"/g, '');
    if (wanted !== '*' && wanted !== current) {
      return {
        ok: false,
        conflict: true,
        status: 409,
        etag: current,
        current: current ? readJSONOrNull(path) : null,
        error: 'If-Match 與目前版本不符（檔案已被修改）',
      };
    }
  }
  const text = canonicalText(doc);
  const etag = sha256(Buffer.from(text, 'utf8'));
  if (text === (isFile(path) ? readFileSync(path, 'utf8') : null)) {
    return { ok: true, unchanged: true, name, etag, path, previousEtag: current };
  }
  writeFileSync(path, text, 'utf8');
  return { ok: true, name, etag, previousEtag: current, path, size: Buffer.byteLength(text) };
}

/** 極簡 RFC 6902 套用（fallback 模式用；伺服器有就用伺服器的）。 */
function applyJsonPatch(document, operations) {
  if (!Array.isArray(operations)) throw new Error('patch 必須是 JSON Patch 陣列');
  const clone = JSON.parse(JSON.stringify(document));
  const parsePointer = (pointer) => {
    if (typeof pointer !== 'string') throw new Error('JSON Pointer 必須是字串');
    if (pointer === '') return [];
    if (!pointer.startsWith('/')) throw new Error(`JSON Pointer 必須以 / 開頭：${pointer}`);
    return pointer
      .slice(1)
      .split('/')
      .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  };
  const getParent = (tokens) => {
    let node = clone;
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const token = tokens[i];
      if (node === null || typeof node !== 'object') throw new Error(`路徑不存在：/${tokens.join('/')}`);
      if (!(token in node)) throw new Error(`路徑不存在：/${tokens.join('/')}`);
      node = node[token];
    }
    return node;
  };
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') throw new Error('patch 項目必須是物件');
    const tokens = parsePointer(operation.path);
    switch (operation.op) {
      case 'add': {
        const parent = getParent(tokens);
        const key = tokens[tokens.length - 1];
        if (Array.isArray(parent)) {
          if (key === '-') parent.push(operation.value);
          else parent.splice(Number(key), 0, operation.value);
        } else if (parent && typeof parent === 'object') {
          parent[key] = operation.value;
        } else throw new Error(`無法新增到：${operation.path}`);
        break;
      }
      case 'remove': {
        const parent = getParent(tokens);
        const key = tokens[tokens.length - 1];
        if (Array.isArray(parent)) parent.splice(Number(key), 1);
        else if (parent && typeof parent === 'object') delete parent[key];
        else throw new Error(`無法刪除：${operation.path}`);
        break;
      }
      case 'replace': {
        const parent = getParent(tokens);
        const key = tokens[tokens.length - 1];
        if (Array.isArray(parent)) parent[Number(key)] = operation.value;
        else if (parent && typeof parent === 'object' && key in parent) parent[key] = operation.value;
        else throw new Error(`無法取代不存在的路徑：${operation.path}`);
        break;
      }
      case 'move':
      case 'copy': {
        const fromTokens = parsePointer(operation.from);
        const fromParent = getParent(fromTokens);
        const fromKey = fromTokens[fromTokens.length - 1];
        const value = Array.isArray(fromParent) ? fromParent[Number(fromKey)] : fromParent[fromKey];
        const copied = JSON.parse(JSON.stringify(value === undefined ? null : value));
        if (operation.op === 'move') {
          if (Array.isArray(fromParent)) fromParent.splice(Number(fromKey), 1);
          else delete fromParent[fromKey];
        }
        const parent = getParent(tokens);
        const key = tokens[tokens.length - 1];
        if (Array.isArray(parent)) parent.splice(Number(key), 0, copied);
        else parent[key] = copied;
        break;
      }
      case 'test': {
        const parent = getParent(tokens);
        const key = tokens[tokens.length - 1];
        const actual = Array.isArray(parent) ? parent[Number(key)] : parent[key];
        if (JSON.stringify(actual) !== JSON.stringify(operation.value)) {
          throw new Error(`test 失敗：${operation.path} 的值不相同`);
        }
        break;
      }
      default:
        throw new Error(`不支援的 patch op：${operation.op}`);
    }
  }
  return clone;
}

function searchAssetsLocal(query) {
  const indexPath = join(process.env.DR_ASSETS || join(BATTLE_EDITOR, 'assets'), 'index.json');
  const index = readJSONOrNull(indexPath);
  if (!index) return [];
  const text = String(query.q || '').trim().toLowerCase();
  const tag = String(query.tag || '').trim().toLowerCase();
  const kind = String(query.kind || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, Math.round(numArg(query.limit, 30))));
  const wanted = [];
  const kindToKind = { sfx: 'audio', music: 'audio', audio: 'audio', sprite: 'sprite', font: 'font', preset: 'preset' };
  const bucket = kindToKind[kind] || null;
  if (!bucket || bucket === 'sprite') wanted.push(['sprite', index.sprites || {}]);
  if (!bucket || bucket === 'audio') wanted.push(['audio', index.audio || {}]);
  if (!bucket || bucket === 'font') wanted.push(['font', index.fonts || {}]);
  const items = [];
  for (const [type, table] of wanted) {
    for (const [name, entry] of Object.entries(table)) {
      if (text && !String(name).toLowerCase().includes(text) && !JSON.stringify(entry).toLowerCase().includes(text)) continue;
      const tags = Array.isArray(entry.tags) ? entry.tags.map((t) => String(t).toLowerCase()) : [];
      if (tag && !tags.includes(tag)) continue;
      if (kind === 'sfx' && entry.kind !== 'sfx') continue;
      if (kind === 'music' && entry.kind !== 'music') continue;
      items.push({ name, type, ...entry });
      if (items.length >= limit * 3) break;
    }
  }
  return items.slice(0, limit);
}

/* ==================================================================== */
/* 工具實作                                                              */
/* ==================================================================== */

function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

function jsonResult(value) {
  return textResult(JSON.stringify(value, null, 2));
}

function errorResult(message) {
  return { content: [{ type: 'text', text: `錯誤：${message}` }], isError: true };
}

/** dr_docs */
async function toolDocs(args = {}) {
  const docs = {
    agent: { file: join(DOCS_DIR, 'SPEC-AGENT.md'), title: 'Agent 介面 Spec（SPEC-AGENT.md）' },
    spec: { file: join(DOCS_DIR, 'SPEC.md'), title: '主 Spec（SPEC.md）' },
    p2: { file: join(DOCS_DIR, 'SPEC-P2.md'), title: 'Phase 2 Spec（SPEC-P2.md）' },
    guide: { file: join(DOCS_DIR, 'AGENT-GUIDE.md'), title: 'Agent 創作指南（AGENT-GUIDE.md）' },
    coordination: { file: join(DOCS_DIR, 'COORDINATION.md'), title: '工作協調（COORDINATION.md）' },
  };

  // 列出可讀文件
  if (args.list || (!args.doc && !args.schema)) {
    const rows = [];
    for (const [key, meta] of Object.entries(docs)) {
      rows.push({ key, title: meta.title, available: isFile(meta.file), path: meta.file.replace(`${BATTLE_EDITOR}/`, '') });
    }
    for (const name of ['attack', 'encounter', 'cues']) {
      rows.push({
        key: `schema-${name}`,
        title: `JSON Schema：${name}`,
        available: isFile(join(SCHEMA_DIR, `${name}.json`)),
        path: `generated/schema/${name}.json`,
      });
    }
    return jsonResult({
      hint: '用 doc="agent"|"spec"|"p2"|"guide"|"coordination" 取文件（可加 section="3" 只取某章），或用 schema="attack"|"encounter"|"cues" 取 JSON Schema。',
      docs: rows,
    });
  }

  // JSON Schema
  if (args.schema) {
    const name = String(args.schema);
    const file = join(SCHEMA_DIR, `${name}.json`);
    if (!isFile(file)) {
      return errorResult(`找不到 schema：${name}（請先執行 node tools/agent/export-schema.mjs）`);
    }
    const schema = readJSON(file);
    return jsonResult(schema);
  }

  const key = String(args.doc || 'agent');
  const meta = docs[key];
  if (!meta) return errorResult(`未知文件：${key}（可用：${Object.keys(docs).join('、')}）`);
  if (!isFile(meta.file)) {
    if (key === 'guide') {
      return textResult(
        'docs/AGENT-GUIDE.md 尚未由協調者建立。可先用 dr_docs doc="spec" / doc="agent" / schema="cues" 取得格式與指令說明。\n\n' +
          '建議工作流程（暫時版）：\n' +
          '1) dr_docs schema="attack"｜schema="encounter"｜schema="cues" 讀格式\n' +
          '2) dr_assets_search 找 sprite / 音效\n' +
          '3) dr_write 寫檔 → dr_validate 驗證\n' +
          '4) dr_simulate 跑統計 → dr_difficulty 看難度 → dr_render 看畫面\n' +
          '5) 依數據調整後重複 3–4',
      );
    }
    return errorResult(`文件不存在：${meta.title}（${meta.file}）`);
  }
  const text = readFileSync(meta.file, 'utf8');
  const section = args.section !== undefined ? String(args.section).replace(/^[§#\s]+/, '') : null;
  if (!section) return textResult(text);

  // 取指定章節（## 3 / §3 都接受）
  const lines = text.split('\n');
  const headingPattern = new RegExp(`^#{2,3}\\s*(?:§\\s*)?${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.|\\s|$)`);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (headingPattern.test(lines[i])) {
      start = i;
      level = (lines[i].match(/^#+/) || ['##'])[0].length;
      break;
    }
  }
  if (start < 0) return errorResult(`文件 ${key} 找不到章節 ${section}`);
  const collected = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const heading = lines[i].match(/^(#+)\s/);
    if (heading && heading[1].length <= level) break;
    collected.push(lines[i]);
  }
  return textResult(collected.join('\n').trim());
}

/** dr_assets_search */
async function toolAssetsSearch(args = {}) {
  const query = {
    q: args.q || args.query || '',
    tag: args.tag || '',
    kind: args.kind || '',
    limit: numArg(args.limit, 30),
  };
  const response = await api(
    `/api/assets/search?${new URLSearchParams({ q: String(query.q), tag: String(query.tag), kind: String(query.kind), limit: String(query.limit) })}`,
  );
  if (response.ok && response.json) {
    return jsonResult({ source: 'api', ...response.json });
  }
  const items = searchAssetsLocal(query);
  return jsonResult({
    source: 'disk',
    offline: Boolean(response.offline),
    note: response.offline ? '伺服器未啟動，已直接讀 assets/index.json' : `API 失敗：${response.error || response.status}`,
    query,
    count: items.length,
    items,
  });
}

/** dr_list */
async function toolList(args = {}) {
  const kind = args.kind === 'encounter' ? 'encounter' : 'attack';
  if (args.kind !== 'encounter' && args.kind !== 'attack' && args.kind !== undefined) {
    return errorResult('kind 必須是 attack 或 encounter');
  }
  // samples/ 是唯讀範例，不在 /api 的清單裡，但 Agent 很需要它們當起點 → 一律補上
  const samples = listLocal(kind).filter((item) => item.source === 'sample');
  const response = await api(`/api/${kind === 'encounter' ? 'encounters' : 'attacks'}`);
  if (response.ok && response.json) {
    const items = [...((response.json.items) || [])];
    const known = new Set(items.map((item) => item.name));
    for (const sample of samples) {
      if (!known.has(sample.name)) items.push(sample);
    }
    return jsonResult({ source: 'api', kind, ...response.json, items, count: items.length, samples: samples.length });
  }
  const items = listLocal(kind);
  return jsonResult({
    source: 'disk',
    note: response.offline ? '伺服器未啟動，已直接列出磁碟檔案' : `API 失敗：${response.error || response.status}`,
    kind,
    count: items.length,
    samples: samples.length,
    items,
  });
}

/** dr_read */
async function toolRead(args = {}) {
  const kind = args.kind === 'encounter' ? 'encounter' : 'attack';
  const name = String(args.name || '').replace(/\.json$/i, '');
  const nameError = validateName(name);
  if (nameError) return errorResult(nameError);

  // 允許直接給路徑（方便讀 samples/ 或專案內其他檔案）
  if (args.path) {
    const file = resolveInputFile(String(args.path));
    if (!file) return errorResult(`找不到檔案：${args.path}`);
    const raw = readFileSync(file, 'utf8');
    return jsonResult({ source: 'file', path: file.replace(`${BATTLE_EDITOR}/`, ''), etag: sha256(Buffer.from(raw, 'utf8')), document: JSON.parse(raw) });
  }

  const response = await api(`/api/${kind === 'encounter' ? 'encounters' : 'attacks'}/${encodeURIComponent(name)}.json`);
  if (response.ok && response.json) {
    return jsonResult({ source: 'api', kind, name, etag: response.etag, document: response.json });
  }
  const local = readLocal(kind, name);
  if (!local) {
    return errorResult(
      `找不到${kind === 'encounter' ? '遭遇' : '攻擊'}：${name}` +
        (response.offline ? '（伺服器未啟動，已改查磁碟）' : `（API ${response.status}）`),
    );
  }
  return jsonResult({
    source: 'disk',
    kind,
    name,
    origin: local.source,
    etag: local.etag,
    path: local.path.replace(`${BATTLE_EDITOR}/`, ''),
    document: local.doc,
  });
}

/** dr_write */
async function toolWrite(args = {}) {
  const kind = args.kind === 'encounter' ? 'encounter' : 'attack';
  const name = String(args.name || '').replace(/\.json$/i, '');
  const nameError = validateName(name);
  if (nameError) return errorResult(nameError);
  let doc = args.doc || args.document || args.json;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch (err) {
      return errorResult(`doc 不是合法 JSON：${err.message}`);
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return errorResult('doc 必須是 JSON 物件');
  const spec = kindSpec(kind);
  const withFormat = { ...doc };
  if (withFormat.format === undefined) withFormat.format = spec.format;
  const ifMatch = args.ifMatch || args.etag || null;
  const headers = ifMatch ? { 'If-Match': String(ifMatch).startsWith('"') ? String(ifMatch) : `"${ifMatch}"` } : {};

  const response = await api(`/api/${kind === 'encounter' ? 'encounters' : 'attacks'}/${encodeURIComponent(name)}.json`, {
    method: 'PUT',
    body: withFormat,
    headers,
  });
  if (response.ok) return jsonResult({ source: 'api', ...response.json });
  if (response.status === 409 && response.json) {
    return {
      content: [
        {
          type: 'text',
          text:
            `版本衝突（409）：${name} 已被其他人修改。\n` +
            `目前 etag：${response.json.etag}\n` +
            '下面是磁碟上的現版本；請合併後用新的 ifMatch 重寫：\n\n' +
            JSON.stringify(response.json.current, null, 2),
        },
      ],
      isError: true,
    };
  }
  if (!response.offline) {
    return errorResult(`寫入失敗（HTTP ${response.status}）：${(response.json && response.json.error) || response.text || '未知錯誤'}`);
  }
  // 降級：直接寫檔
  let result;
  try {
    result = saveLocal(kind, name, withFormat, ifMatch);
  } catch (err) {
    return errorResult(`寫入失敗：${err.message}`);
  }
  if (result.conflict) {
    return {
      content: [
        {
          type: 'text',
          text:
            `版本衝突（409）：${name} 已被其他人修改。\n目前 etag：${result.etag}\n` +
            '下面是磁碟上的現版本；請合併後用新的 ifMatch 重寫：\n\n' +
            JSON.stringify(result.current, null, 2),
        },
      ],
      isError: true,
    };
  }
  return jsonResult({ source: 'disk', ...result });
}

/** dr_patch */
async function toolPatch(args = {}) {
  const kind = args.kind === 'encounter' ? 'encounter' : 'attack';
  const name = String(args.name || '').replace(/\.json$/i, '');
  const nameError = validateName(name);
  if (nameError) return errorResult(nameError);
  let patch = args.patch || args.operations || args.ops;
  if (typeof patch === 'string') {
    try {
      patch = JSON.parse(patch);
    } catch (err) {
      return errorResult(`patch 不是合法 JSON：${err.message}`);
    }
  }
  if (!Array.isArray(patch)) return errorResult('patch 必須是 RFC 6902 陣列，例如 [{"op":"replace","path":"/settings/duration","value":9}]');
  const ifMatch = args.ifMatch || args.etag || null;
  const headers = ifMatch ? { 'If-Match': String(ifMatch).startsWith('"') ? String(ifMatch) : `"${ifMatch}"` } : {};

  const response = await api(`/api/${kind === 'encounter' ? 'encounters' : 'attacks'}/${encodeURIComponent(name)}.json`, {
    method: 'PATCH',
    body: patch,
    headers,
  });
  if (response.ok) return jsonResult({ source: 'api', ...response.json });
  if (response.status === 409 && response.json) {
    return {
      content: [
        {
          type: 'text',
          text: `版本衝突（409）：${name} 已被修改。目前 etag：${response.json.etag}\n現版本：\n\n${JSON.stringify(response.json.current, null, 2)}`,
        },
      ],
      isError: true,
    };
  }
  if (!response.offline) {
    return errorResult(`patch 失敗（HTTP ${response.status}）：${(response.json && response.json.error) || response.text || '未知錯誤'}`);
  }
  // 降級：讀 → 套用 → 寫
  const local = readLocal(kind, name);
  if (!local) return errorResult(`找不到${kind === 'encounter' ? '遭遇' : '攻擊'}：${name}（伺服器未啟動，已改查磁碟）`);
  if (ifMatch) {
    const wanted = String(ifMatch).replace(/^W\//, '').replace(/"/g, '');
    if (wanted !== '*' && wanted !== local.etag) {
      return {
        content: [
          {
            type: 'text',
            text: `版本衝突（409）：目前 etag ${local.etag}，你帶的是 ${ifMatch}。現版本：\n\n${JSON.stringify(local.doc, null, 2)}`,
          },
        ],
        isError: true,
      };
    }
  }
  let document;
  try {
    document = applyJsonPatch(local.doc, patch);
  } catch (err) {
    return errorResult(`patch 套用失敗：${err.message}`);
  }
  const result = saveLocal(kind, name, document, null);
  return jsonResult({ source: 'disk', ...result, applied: patch.length });
}

/** dr_delete */
async function toolDelete(args = {}) {
  const kind = args.kind === 'encounter' ? 'encounter' : 'attack';
  const name = String(args.name || '').replace(/\.json$/i, '');
  const nameError = validateName(name);
  if (nameError) return errorResult(nameError);
  const ifMatch = args.ifMatch || args.etag || null;
  const headers = ifMatch ? { 'If-Match': String(ifMatch).startsWith('"') ? String(ifMatch) : `"${ifMatch}"` } : {};
  const response = await api(`/api/${kind === 'encounter' ? 'encounters' : 'attacks'}/${encodeURIComponent(name)}.json`, {
    method: 'DELETE',
    headers,
  });
  if (response.ok) return jsonResult({ source: 'api', ...response.json });
  if (response.status === 409 && response.json) {
    return { content: [{ type: 'text', text: `版本衝突（409）：目前 etag ${response.json.etag}。請先用 dr_read 取得最新版。` }], isError: true };
  }
  if (!response.offline) {
    return errorResult(`刪除失敗（HTTP ${response.status}）：${(response.json && response.json.error) || response.text || '未知錯誤'}`);
  }
  // 降級：搬到 tools/agent/.tmp/deleted/（可復原，不動 W2 的 trash/）
  const local = readLocal(kind, name);
  if (!local) return errorResult(`找不到${kind === 'encounter' ? '遭遇' : '攻擊'}：${name}（伺服器未啟動，已改查磁碟）`);
  if (local.source === 'sample') return errorResult('samples/ 是唯讀範例，不能刪除（請先 dr_write 成自己的作品）');
  const trashDir = join(HERE, '.tmp', 'deleted');
  mkdirSync(trashDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(trashDir, `${kind}-${name}-${stamp}.json`);
  renameSync(local.path, target);
  return jsonResult({ source: 'disk', ok: true, kind, name, movedTo: target.replace(`${BATTLE_EDITOR}/`, ''), restoreHint: '把檔案搬回 attacks/ 或 encounters/ 即可' });
}

/** dr_validate */
async function toolValidate(args = {}) {
  const errors = [];
  const warnings = [];
  /** info 級提示（不算錯誤也不算警告）：[{ path, message }] */
  const hints = [];
  let kind = args.kind === 'encounter' ? 'encounter' : args.kind === 'attack' ? 'attack' : null;
  let doc = args.doc || args.document || args.json || null;
  let name = args.name ? String(args.name).replace(/\.json$/i, '') : null;

  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch (err) {
      return errorResult(`doc 不是合法 JSON：${err.message}`);
    }
  }
  if (!doc && name) {
    const guessKind = kind || 'attack';
    const local = readLocal(guessKind, name) || readLocal(guessKind === 'attack' ? 'encounter' : 'attack', name);
    if (!local) return errorResult(`找不到作品：${name}`);
    doc = local.doc;
    kind = local.doc.format === ENCOUNTER_FORMAT ? 'encounter' : kind || 'attack';
  }
  if (!doc) return errorResult('需要 doc（JSON 物件）或 name');

  if (!kind) kind = doc.format === ENCOUNTER_FORMAT || Array.isArray(doc.turns) ? 'encounter' : 'attack';

  if (kind === 'encounter') {
    const { validateEncounter } = await import('../../engine/encounter/schema.js');
    const list = validateEncounter(doc) || [];
    for (const entry of list) errors.push({ path: entry.path || '', message: entry.message || '' });
    // 攻擊參照是否存在
    const { makeAttackResolver } = await import('./sim.mjs');
    const resolveAttack = makeAttackResolver();
    const refs = new Set();
    const collect = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) collect(item);
        return;
      }
      if (!value || typeof value !== 'object') return;
      if (value.cmd === 'attack' && typeof value.attack === 'string') refs.add(value.attack);
      for (const child of Object.values(value)) collect(child);
    };
    collect(doc);
    for (const turn of Array.isArray(doc.turns) ? doc.turns : []) {
      if (turn && typeof turn.attack === 'string') refs.add(turn.attack);
    }
    for (const ref of refs) {
      const resolved = await resolveAttack(ref);
      if (!resolved) errors.push({ path: `attack:${ref}`, message: `找不到攻擊檔：${ref}（attacks/ 或 samples/）` });
    }
  } else {
    const { validateAttack, attackHints } = await import('../../engine/attack.js');
    const list = validateAttack(doc) || [];
    for (const entry of list) errors.push({ path: entry.path || '', message: entry.message || '' });
    for (const entry of attackHints(doc)) hints.push({ path: entry.path, message: entry.message });
    // 素材是否存在（只警告，不當錯誤——缺素材引擎會用洋紅佔位）
    const index = readJSONOrNull(join(process.env.DR_ASSETS || join(BATTLE_EDITOR, 'assets'), 'index.json'));
    if (index) {
      const sprites = index.sprites || {};
      const audio = index.audio || {};
      const bulletTypes = doc.bulletTypes || {};
      for (const [key, type] of Object.entries(bulletTypes)) {
        if (type && typeof type.sprite === 'string' && !sprites[type.sprite]) {
          warnings.push(`bulletTypes.${key}.sprite「${type.sprite}」不在 assets/index.json（會顯示洋紅佔位方塊）`);
        }
      }
      if (doc.settings && typeof doc.settings.bgm === 'string' && !audio[doc.settings.bgm]) {
        warnings.push(`settings.bgm「${doc.settings.bgm}」不是已知音樂（會靜音）`);
      }
      for (const enemy of Array.isArray(doc.enemies) ? doc.enemies : []) {
        if (enemy && typeof enemy.sprite === 'string' && !sprites[enemy.sprite]) {
          warnings.push(`enemies 的 sprite「${enemy.sprite}」不在 assets/index.json`);
        }
      }
      for (const event of Array.isArray(doc.timeline) ? doc.timeline : []) {
        if (event && event.type === 'sfx' && typeof event.sound === 'string' && !audio[event.sound]) {
          warnings.push(`timeline 事件「${event.id || '?'}」的音效「${event.sound}」不在 assets/index.json`);
        }
      }
    }
  }

  return jsonResult({
    ok: errors.length === 0,
    kind,
    errors,
    warnings,
    hints,
    errorCount: errors.length,
    warningCount: warnings.length,
    hintCount: hints.length,
  });
}

/** dr_simulate */
async function toolSimulate(args = {}) {
  const { simulate } = await import('./sim.mjs');
  let target = args.doc || args.document || null;
  if (!target) {
    if (!args.name) return errorResult('需要 name（作品名）或 doc（JSON 物件）');
    const name = String(args.name).replace(/\.json$/i, '');
    const kind = args.kind === 'encounter' ? 'encounter' : 'attack';
    const local = readLocal(kind, name);
    if (!local) return errorResult(`找不到作品：${name}`);
    target = local.doc;
  }
  if (typeof target === 'string') {
    try {
      target = JSON.parse(target);
    } catch (err) {
      return errorResult(`doc 不是合法 JSON：${err.message}`);
    }
  }
  const options = {
    frames: args.frames !== undefined ? Math.round(numArg(args.frames, 0)) : 0,
    // 新參數：自動演示（SPEC-AUTOPLAY）。有 autoplay 時不再建立舊 bot。
    autoplay: args.autoplay === 'demo' || args.autoplay === 'bot' ? args.autoplay : null,
    bot: args.autoplay ? null : args.bot || 'idle',
    seed: numArg(args.seed, 1),
    horizon: numArg(args.horizon, 14),
    grazeBias: numArg(args.grazeBias, 0),
  };
  if (args.inputs && Array.isArray(args.inputs)) {
    // 輸入腳本優先於自動演示 / 舊 bot（與 CLI 相同）。
    options.inputs = args.inputs;
    options.autoplay = null;
    options.bot = null;
  }
  const result = await simulate(target, options);
  // 事件清單可能很長：只回前 200 筆，其餘用計數
  const events = (result.events || []).slice(0, 200);
  return jsonResult({
    kind: result.kind,
    name: result.name,
    frames: result.frames,
    totalFrames: result.totalFrames,
    ended: result.ended,
    result: result.result,
    hits: result.hits,
    grazes: result.grazes,
    damageTaken: result.damageTaken,
    tpGained: result.tpGained,
    maxBullets: result.maxBullets,
    avgBullets: result.avgBullets,
    party: result.party,
    enemies: result.enemies,
    perTurn: result.perTurn,
    autoplay: result.autoplay,
    errors: result.errors,
    sfx: result.sfx,
    events,
    eventsTotal: (result.events || []).length,
    eventCounts: result.eventCounts || null,
    trace: result.trace,
  });
}

/** dr_render */
async function toolRender(args = {}) {
  const { renderFrames } = await import('./render.mjs');
  const { findEdge } = await import('./render.mjs');
  if (!findEdge()) {
    return errorResult('找不到 Edge（headless 截圖需要 Edge；可用環境變數 MSEDGE_PATH 指定 msedge.exe）');
  }
  let target = args.doc || args.document || null;
  if (!target) {
    if (!args.name) return errorResult('需要 name（作品名）或 doc（JSON 物件）');
    const name = String(args.name).replace(/\.json$/i, '');
    const kind = args.kind === 'encounter' ? 'encounter' : 'attack';
    const local = readLocal(kind, name);
    if (!local) return errorResult(`找不到作品：${name}`);
    target = local.doc;
  }
  const frames = Array.isArray(args.frames)
    ? args.frames.map((n) => Math.round(numArg(n, 0)))
    : typeof args.frames === 'string'
      ? args.frames.split(',').map((n) => Math.round(Number(n))).filter((n) => Number.isFinite(n))
      : [0, 60, 150];
  const autoplay = args.autoplay === 'demo' || args.autoplay === 'bot' ? args.autoplay : null;
  const result = await renderFrames(target, {
    frames,
    lang: args.lang === 'en' ? 'en' : 'zh',
    scale: numArg(args.scale, 2),
    sheet: args.sheet !== false,
    hitboxes: Boolean(args.hitboxes),
    autoplay,
  });

  const autoLine = result.autoplay
    ? `\n自動演示：${result.autoplay.mode}` +
      (result.autoplay.describe && result.autoplay.describe.dodge ? `（${result.autoplay.describe.dodge}）` : '') +
      (result.autoplay.warnings && result.autoplay.warnings.length
        ? `；腳本警告：${result.autoplay.warnings.join('；')}`
        : '')
    : '';

  const content = [
    {
      type: 'text',
      text:
        `已截圖 ${result.frames.length} 張（${result.kind === 'encounter' ? '遭遇' : '攻擊'}）。\n` +
        result.frames
          .map((shot) => {
            const state = shot.state || {};
            const requested = shot.requested !== undefined ? shot.requested : shot.frame;
            const actual = shot.actualFrame !== undefined ? shot.actualFrame : shot.frame;
            const frameLabel = requested === actual ? `f=${actual}` : `f=${requested}→${actual}（實際）`;
            return `- ${frameLabel} ${shot.size.width}×${shot.size.height}${state.bullets !== undefined ? ` 子彈=${state.bullets}` : ''}${state.phase ? ` phase=${state.phase}` : ''} → ${shot.file}`;
          })
          .join('\n') +
        `\nactualFrames：[${(result.actualFrames || []).join(', ')}]` +
        (result.frameMismatches && result.frameMismatches.length
          ? `（不一致：${result.frameMismatches.map((m) => `${m.requested}→${m.actual}`).join('、')}）`
          : '') +
        (result.sheet ? `\n聯絡表：${result.sheet}` : '') +
        autoLine +
        (result.warnings.length ? `\n警告：${result.warnings.join('；')}` : ''),
    },
  ];
  // MCP image content：讓 Agent 真的「看見」畫面
  const wanted = result.sheet ? [result.sheet] : result.frames.map((shot) => shot.file);
  for (const file of wanted.slice(0, 4)) {
    try {
      const data = readFileSync(file);
      content.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/png' });
    } catch (_err) {
      /* 讀不到就只回路徑 */
    }
  }
  return { content };
}

/** dr_record */
async function toolRecord(args = {}) {
  const { recordTarget } = await import('../record.mjs');
  const { findEdge } = await import('./render.mjs');
  if (!findEdge()) {
    return errorResult('找不到 Edge（逐幀錄影需要 headless Edge；可用環境變數 MSEDGE_PATH 指定 msedge.exe）');
  }
  let target = args.doc || args.document || null;
  let name = null;
  let kind = args.kind === 'encounter' ? 'encounter' : 'attack';
  if (!target) {
    if (!args.name) return errorResult('需要 name（作品名）或 doc（JSON 物件）');
    name = String(args.name).replace(/\.json$/i, '');
    const local = readLocal(kind, name);
    if (!local) return errorResult(`找不到作品：${name}`);
    target = local.doc;
  } else {
    name = typeof args.name === 'string' && args.name ? String(args.name).replace(/\.json$/i, '') : null;
  }
  if (name) {
    try {
      const { detectKind } = await import('./sim.mjs');
      kind = detectKind(target) === 'encounter' ? 'encounter' : kind;
    } catch (_err) {
      /* 判斷不出來就用 args.kind */
    }
  }

  const scale = Math.max(1, Math.min(3, Math.round(numArg(args.scale, 2))));
  const autoplay = args.autoplay === 'demo' || args.autoplay === 'bot' ? args.autoplay : null;
  // 三種輸出至少要一種；MCP 沒給時預設輸出 MP4 到 generated/record/（與 CLI 的 --out 等價）
  let out = typeof args.out === 'string' && args.out.trim() ? args.out.trim() : null;
  const pngDir = typeof args.pngDir === 'string' && args.pngDir.trim() ? args.pngDir.trim() : null;
  let wav = typeof args.wav === 'string' && args.wav.trim() ? args.wav.trim() : null;
  if (!out && !pngDir && !wav) {
    const stem = String(name || 'record').replace(/[\\/:*?"<>|\s]+/g, '_');
    out = join(GENERATED_DIR, 'record', `${stem}-${scale}x.mp4`);
  }
  if (wav) wav = resolve(process.cwd(), wav);

  const options = {
    scale,
    autoplay,
    lang: args.lang === 'en' ? 'en' : 'zh',
    seed: args.seed === undefined || args.seed === null ? null : Math.round(numArg(args.seed, 0)),
    maxFrames: args.maxFrames === undefined || args.maxFrames === null ? null : Math.max(1, Math.round(numArg(args.maxFrames, 1))),
    out,
    pngDir,
    wav,
    noAudio: args.noAudio === true,
    keepFrames: pngDir !== null,
    capture: 'screenshot',
    preset: typeof args.preset === 'string' && args.preset ? args.preset : 'medium',
    crf: Math.max(0, Math.min(51, Math.round(numArg(args.crf, 18)))),
  };
  if (options.maxFrames === null) delete options.maxFrames;

  let result = null;
  try {
    result = await recordTarget(target, options);
  } catch (err) {
    if (err && err.code === 'NO_FFMPEG') {
      return errorResult(
        `${err.message}\n（在 MCP 裡也可以用 pngDir / wav 只輸出素材：dr_record { kind, name, pngDir, wav }）`,
      );
    }
    return errorResult(err && err.message ? err.message : String(err));
  }

  const lines = [];
  lines.push(
    `已錄影 ${result.frames} 幀（${result.frames === 0 ? '0' : `#0–#${result.lastFrame - 1}`}，${result.seconds}s @ ${result.fps}fps，${result.size.width}×${result.size.height}，${result.kind === 'encounter' ? '遭遇' : '攻擊'}）`,
  );
  lines.push(`速度：擷取 ${result.captureMs}ms（${result.framesPerSecond} 幀/秒）／總計 ${(result.elapsedMs / 1000).toFixed(1)}s`);
  if (result.ended) lines.push('狀態：已到結果畫面');
  if (result.outputs.mp4) lines.push(`MP4：${result.outputs.mp4}`);
  if (result.outputs.wav) lines.push(`WAV：${result.outputs.wav}`);
  if (result.outputs.pngDir) lines.push(`PNG 序列：${result.outputs.pngDir}`);
  lines.push(`音訊事件表：${result.outputs.events}`);
  if (result.audio) {
    lines.push(
      `音訊：BGM ${result.audio.bgmSegments} 段／音效 ${result.audio.sfxEvents} 筆（事件 ${result.audio.events} 筆，音檔 ${Array.isArray(result.audio.files) ? result.audio.files.length : result.audio.files} 個 ${(result.audio.bytes / 1024).toFixed(0)}KB）` +
        (result.audio.silent ? '（無事件 → 靜音軌）' : ''),
    );
  } else {
    lines.push('音訊：未混音（沒有 --out / --wav）');
  }
  if (result.verify) {
    lines.push(
      result.verify.ok
        ? `ffprobe 驗證：OK（${result.verify.probe.video.codec} ${result.verify.probe.video.width}×${result.verify.probe.video.height} ${result.verify.probe.video.fps}fps ${result.verify.probe.video.frames} 幀，音軌 ${result.verify.probe.audio ? result.verify.probe.audio.codec : '無'}）`
        : `ffprobe 驗證：失敗（${result.verify.errors.join('；')}）`,
    );
  }
  if (result.warnings.length) lines.push(`警告：${result.warnings.join('；')}`);

  const content = [{ type: 'text', text: lines.join('\n') }];
  return { content };
}

/** dr_difficulty */
async function toolDifficulty(args = {}) {
  const { analyzeDifficulty } = await import('./difficulty.mjs');
  let target = args.doc || args.document || null;
  if (!target) {
    if (!args.name) return errorResult('需要 name（作品名）或 doc（JSON 物件）');
    const name = String(args.name).replace(/\.json$/i, '');
    const kind = args.kind === 'encounter' ? 'encounter' : 'attack';
    const local = readLocal(kind, name);
    if (!local) return errorResult(`找不到作品：${name}`);
    target = local.doc;
  }
  const report = await analyzeDifficulty(target, {
    runs: Math.max(1, Math.min(200, Math.round(numArg(args.runs, 20)))),
    bot: args.bot === true ? 'dodge' : args.bot || undefined,
    autoplay: args.autoplay === undefined || args.autoplay === null ? null : args.autoplay === true ? 'bot' : args.autoplay,
    frames: args.frames !== undefined ? Math.round(numArg(args.frames, 0)) : 0,
    seed: numArg(args.seed, 1),
    compare: Boolean(args.compare),
  });
  return jsonResult(report);
}

/** dr_editor_state */
async function toolEditorState(args = {}) {
  const query = args.clientId ? `?clientId=${encodeURIComponent(String(args.clientId))}` : '';
  const response = await api(`/api/editor/state${query}`);
  if (!response.ok) {
    return jsonResult({
      offline: true,
      note: response.offline
        ? '伺服器未啟動 → 沒有開著的編輯器可查（編輯器需要 serve.py 才有 API）'
        : `讀取失敗（HTTP ${response.status}）：${response.error || response.text || ''}`,
    });
  }
  const payload = response.json;
  const items = (payload && payload.items) || [];
  const lines = [`開著的編輯器：${items.length} 個（TTL ${payload.ttlMs}ms）`];
  for (const item of items) {
    const focus = item.state && item.state.focus ? JSON.stringify(item.state.focus) : item.focus ? JSON.stringify(item.focus) : '-';
    lines.push(`- ${item.clientId}  最後回報 ${Math.max(0, Math.round((payload.now - item.updatedMs) / 1000))}s 前  焦點：${focus}`);
  }
  return textResult(lines.join('\n') + '\n\n' + JSON.stringify(payload, null, 2));
}

/** dr_editor_focus */
async function toolEditorFocus(args = {}) {
  const focus = {};
  if (args.kind) focus.kind = args.kind === 'encounter' ? 'encounter' : 'attack';
  if (args.name) focus.name = String(args.name).replace(/\.json$/i, '');
  if (args.frame !== undefined) focus.frame = Math.max(0, Math.round(numArg(args.frame, 0)));
  if (args.eventId) focus.eventId = String(args.eventId);
  if (args.turn !== undefined) focus.turn = Math.round(numArg(args.turn, 0));
  if (args.lang) focus.lang = args.lang === 'en' ? 'en' : 'zh';
  if (args.note) focus.note = String(args.note);
  if (Object.keys(focus).length === 0) return errorResult('至少要給 name、frame、eventId 或 note 其中一項');
  const body = { focus, state: { focus }, kind: focus.kind || null, name: focus.name || null, frame: focus.frame === undefined ? null : focus.frame, note: focus.note || null };
  const response = await api('/api/editor/state', { method: 'PUT', body, client: 'agent' });
  if (!response.ok) {
    return jsonResult({
      ok: false,
      offline: Boolean(response.offline),
      focus,
      note: response.offline
        ? '伺服器未啟動 → 無法推給編輯器（已記錄你要指的位置，可稍後重試）'
        : `推播失敗（HTTP ${response.status}）：${response.error || response.text || ''}`,
    });
  }
  return jsonResult({ ok: true, focus, ...response.json });
}

/** dr_history */
async function toolHistory(args = {}) {
  const params = new URLSearchParams();
  if (args.kind) params.set('kind', args.kind === 'encounter' ? 'encounter' : 'attack');
  if (args.name) params.set('name', String(args.name).replace(/\.json$/i, ''));
  if (args.client) params.set('client', String(args.client));
  if (args.limit !== undefined) params.set('limit', String(Math.max(1, Math.min(500, Math.round(numArg(args.limit, 50))))));
  const response = await api(`/api/history?${params.toString()}`);
  if (!response.ok) {
    return jsonResult({
      offline: Boolean(response.offline),
      note: response.offline ? '伺服器未啟動 → 沒有審計紀錄（history/ 由 serve.py 維護）' : `讀取失敗：${response.error || response.text || ''}`,
    });
  }
  const payload = response.json;
  const items = (payload && payload.items) || [];
  const lines = [`修改紀錄 ${items.length} 筆：`];
  for (const entry of items.slice(0, 40)) {
    lines.push(
      `- ${entry.at || entry.time || '?'}  ${entry.client || '?'}  ${entry.method || '?'}  ${entry.kind || ''}/${entry.name || ''}  ` +
        `${entry.beforeEtag ? String(entry.beforeEtag).slice(0, 8) : '(無)'} → ${entry.afterEtag ? String(entry.afterEtag).slice(0, 8) : '(無)'}` +
        `${entry.id ? `  id=${entry.id}` : ''}`,
    );
  }
  return textResult(lines.join('\n') + '\n\n' + JSON.stringify(payload, null, 2));
}

/** dr_restore */
async function toolRestore(args = {}) {
  if (args.historyId || args.entryId) {
    const id = String(args.historyId || args.entryId);
    const response = await api(`/api/history/${encodeURIComponent(id)}/restore`, { method: 'POST', body: {} });
    if (!response.ok) return errorResult(response.offline ? '伺服器未啟動 → 歷史還原需要 serve.py' : `還原失敗（HTTP ${response.status}）：${response.error || response.text}`);
    return jsonResult({ source: 'api', ...response.json });
  }
  if (args.trashId) {
    const response = await api('/api/restore', { method: 'POST', body: { trashId: String(args.trashId), kind: args.kind, overwrite: args.overwrite !== false } });
    if (!response.ok) return errorResult(response.offline ? '伺服器未啟動 → 垃圾桶還原需要 serve.py' : `還原失敗（HTTP ${response.status}）：${response.error || response.text}`);
    return jsonResult({ source: 'api', ...response.json });
  }
  if (args.kind && args.name && args.etag) {
    const response = await api('/api/restore', {
      method: 'POST',
      body: { kind: args.kind === 'encounter' ? 'encounter' : 'attack', name: String(args.name).replace(/\.json$/i, ''), etag: String(args.etag), overwrite: args.overwrite !== false },
    });
    if (!response.ok) return errorResult(response.offline ? '伺服器未啟動 → 歷史還原需要 serve.py' : `還原失敗（HTTP ${response.status}）：${response.error || response.text}`);
    return jsonResult({ source: 'api', ...response.json });
  }
  return errorResult('需要 historyId、trashId，或 kind+name+etag 其中一組');
}

/* ==================================================================== */
/* 工具註冊表                                                            */
/* ==================================================================== */

function workspaceOnlySchema(extra = {}) {
  return { type: 'object', properties: { kind: { type: 'string', enum: ['attack', 'encounter'], description: '作品類型（預設 attack）' }, name: { type: 'string', description: '作品名稱（不含 .json；可含中文）' }, ...extra }, required: ['name'] };
}

export const TOOLS = [
  {
    name: 'dr_docs',
    description:
      '取得規格與格式說明（自我說明入口）。可用 doc 讀 SPEC-AGENT.md / SPEC.md / SPEC-P2.md / AGENT-GUIDE.md（可只取某章），或用 schema 取 JSON Schema（attack/encounter/cues）。不帶參數則列出可讀文件。',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string', enum: ['agent', 'spec', 'p2', 'guide', 'coordination'], description: '要讀的文件（預設 agent）' },
        schema: { type: 'string', enum: ['attack', 'encounter', 'cues'], description: '改讀 JSON Schema（含每個欄位的中文說明與範例）' },
        section: { type: 'string', description: '只取某一章，例如 "3" 或 "§4"' },
        list: { type: 'boolean', description: '列出可讀文件與 schema' },
      },
      additionalProperties: false,
    },
    handler: toolDocs,
  },
  {
    name: 'dr_assets_search',
    description: '搜尋素材：sprite / 音效（sfx）/ 音樂（music）/ 字體（font）。回傳名稱、路徑、尺寸、幀數、tag 等。寫攻擊時用它找子彈圖與音效名。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '關鍵字（比對名稱；空 = 全部）' },
        tag: { type: 'string', description: 'tag 篩選（soul/bullet/battlebg/enemy/ui/party）' },
        kind: { type: 'string', enum: ['sprite', 'audio', 'font', 'preset', 'sfx', 'music'], description: '素材類型' },
        limit: { type: 'number', description: '回傳上限（預設 30、最大 200）' },
      },
      additionalProperties: false,
    },
    handler: toolAssetsSearch,
  },
  {
    name: 'dr_list',
    description: '列出作品（attacks/ 或 encounters/，含 samples/ 唯讀範例）。回傳名稱、etag、大小、metaName、時長等。',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['attack', 'encounter'], description: '作品類型（預設 attack）' } },
      additionalProperties: false,
    },
    handler: toolList,
  },
  {
    name: 'dr_read',
    description: '讀取一份作品（回傳完整 JSON 與 etag）。寫入前先讀可以拿到 etag，避免覆蓋別人的修改。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['attack', 'encounter'], description: '作品類型（預設 attack）' },
        name: { type: 'string', description: '作品名稱（不含 .json）' },
        path: { type: 'string', description: '也可直接給路徑（例如 samples/spade-rain.json）' },
      },
      additionalProperties: false,
    },
    handler: toolRead,
  },
  {
    name: 'dr_write',
    description:
      '整檔寫入作品（自動補 format、帶樂觀鎖）。若檔案已被他人修改會回傳 409 與現版本內容，請合併後用新的 ifMatch 重寫。會即時同步給開著的編輯器。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['attack', 'encounter'], description: '作品類型（預設 attack）' },
        name: { type: 'string', description: '作品名稱（不含 .json）' },
        doc: { type: 'object', description: '完整作品 JSON（攻擊格式 dr-battle-attack/1 或遭遇 dr-battle-encounter/1）' },
        ifMatch: { type: 'string', description: '（選用）期望的 etag；給了就會做版本檢查' },
      },
      required: ['name', 'doc'],
      additionalProperties: false,
    },
    handler: toolWrite,
  },
  {
    name: 'dr_patch',
    description: '區域修改（RFC 6902 JSON Patch），適合小幅調整。例如 [{"op":"replace","path":"/settings/duration","value":9}]。同樣支援 ifMatch 與 409 衝突回傳。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['attack', 'encounter'], description: '作品類型（預設 attack）' },
        name: { type: 'string', description: '作品名稱' },
        patch: { type: 'array', description: 'RFC 6902 操作陣列（add/remove/replace/move/copy/test）' },
        ifMatch: { type: 'string', description: '（選用）期望的 etag' },
      },
      required: ['name', 'patch'],
      additionalProperties: false,
    },
    handler: toolPatch,
  },
  {
    name: 'dr_delete',
    description: '刪除作品（伺服器模式會移到 trash/ 可還原；無伺服器時移到 tools/agent/.tmp/deleted/）。samples/ 唯讀不可刪。',
    inputSchema: workspaceOnlySchema({ ifMatch: { type: 'string', description: '（選用）期望的 etag' } }),
    handler: toolDelete,
  },
  {
    name: 'dr_validate',
    description: '驗證作品（不寫檔）：回傳帶 path 的錯誤清單與素材缺失警告。寫完一定要跑，0 錯誤再模擬。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['attack', 'encounter'], description: '作品類型（不確定可省略，會依 format 判斷）' },
        name: { type: 'string', description: '作品名稱（讀磁碟上的檔案來驗證）' },
        doc: { type: 'object', description: '直接驗證一份 JSON（還不用存檔）' },
      },
      additionalProperties: false,
    },
    handler: toolValidate,
  },
  {
    name: 'dr_simulate',
    description:
      '無頭模擬：跑攻擊或遭遇，回傳受傷/擦彈/TP/子彈數/每回合統計/事件。autoplay=demo 用作品 demo 腳本（攻擊讀 path/inputs、遭遇讀選單/FIGHT/躲避），autoplay=bot 全程 AI；不給 autoplay 時沿用舊 bot（bot=idle 是不動的基準線，dodge 會自動閃避）。Agent 用它確認作品跑得起來、demo 腳本真的能過、數據合理。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['attack', 'encounter'], description: '作品類型（預設 attack）' },
        name: { type: 'string', description: '作品名稱（讀磁碟）' },
        doc: { type: 'object', description: '直接模擬一份 JSON（尚未存檔也可）' },
        frames: { type: 'number', description: '最多跑幾幀（預設用作品長度）' },
        autoplay: {
          type: 'string',
          enum: ['demo', 'bot'],
          description: '自動演示模式：demo = 作品的 demo 腳本（SPEC-AUTOPLAY §2）；bot = 全程 AI（遭遇用 default 規則）',
        },
        bot: { type: 'string', enum: ['idle', 'random', 'dodge'], description: '舊玩家模型（沒有 autoplay 時才用；預設 idle）' },
        seed: { type: 'number', description: '亂數種子（預設 1）' },
        inputs: { type: 'array', description: '輸入腳本 [{frame, press, hold}] 或 [{frame, dx, dy, slow}]（優先於 autoplay）' },
      },
      additionalProperties: false,
    },
    handler: toolSimulate,
  },
  {
    name: 'dr_render',
    description:
      '無頭截圖：用 headless Edge 開 play.html / encounter-play.html，在指定幀截 PNG 並以 MCP image content 回傳（Agent 真的看得見畫面）。需要本機有 Edge。可加 autoplay=demo|bot：攻擊頁與遭遇頁都會在每一幀前餵自動演示輸入（畫面才是腳本跑出來的樣子；遭遇頁走 __drEncounterPlay.tick 逐幀推進）。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['attack', 'encounter'], description: '作品類型（預設 attack）' },
        name: { type: 'string', description: '作品名稱（讀磁碟）' },
        doc: { type: 'object', description: '直接渲染一份 JSON' },
        frames: { type: 'array', items: { type: 'number' }, description: '要截的幀（預設 [0,60,150]）' },
        lang: { type: 'string', enum: ['zh', 'en'], description: '介面語言（預設 zh）' },
        scale: { type: 'number', description: '整數縮放（1–6，預設 2）' },
        sheet: { type: 'boolean', description: '是否拼聯絡表（預設 true）' },
        hitboxes: { type: 'boolean', description: '是否顯示碰撞盒' },
        autoplay: {
          type: 'string',
          enum: ['demo', 'bot'],
          description: '自動演示：demo（作品腳本）或 bot（全程 AI）；攻擊頁與遭遇頁都支援（遭遇頁走 __drEncounterPlay.tick 逐幀推進後截圖）',
        },
      },
      additionalProperties: false,
    },
    handler: toolRender,
  },
  {
    name: 'dr_record',
    description:
      '逐幀錄影（V2-11）：用 headless Edge 開 play.html / encounter-play.html，凍結 rAF 後用引擎的 tick()+draw() 固定步進，每幀擷取 canvas（1×/2×/3× 最近鄰），再用引擎記錄的音訊事件表在 Node 端混成 WAV、與 PNG 序列合成 H.264+AAC 的 MP4。輸出可選 MP4 / PNG 序列 / WAV。需要本機有 Edge 與 ffmpeg（沒有 ffmpeg 仍可用 pngDir/wav 取素材）。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['attack', 'encounter'], description: '作品類型（預設 attack）' },
        name: { type: 'string', description: '作品名稱（讀磁碟；不含 .json）' },
        doc: { type: 'object', description: '直接錄一份 JSON（不讀磁碟）' },
        autoplay: {
          type: 'string',
          enum: ['demo', 'bot'],
          description: '自動演示：demo（作品錄的輸入腳本，畫面可重現）或 bot（全程 AI）',
        },
        scale: { type: 'number', description: '整數縮放（1–3，最近鄰；預設 2）' },
        out: { type: 'string', description: 'MP4 輸出路徑（預設 generated/record/<name>-<scale>x.mp4）' },
        pngDir: { type: 'string', description: 'PNG 序列輸出目錄（保留逐幀原圖，給剪輯軟體）' },
        wav: { type: 'string', description: 'WAV 混音輸出路徑' },
        lang: { type: 'string', enum: ['zh', 'en'], description: '介面語言（預設 zh）' },
        seed: { type: 'number', description: '覆寫作品的亂數種子（寫暫存複本，原檔不動）' },
        maxFrames: { type: 'number', description: '最多錄幾幀（預設攻擊 900、遭遇 3600；到結果畫面會提早停）' },
        noAudio: { type: 'boolean', description: '不混音（只出影像）' },
        preset: { type: 'string', description: 'libx264 preset（預設 medium）' },
        crf: { type: 'number', description: 'libx264 CRF（預設 18；越小越清晰越大檔）' },
      },
      additionalProperties: false,
    },
    handler: toolRecord,
  },
  {
    name: 'dr_difficulty',
    description:
      '難度分析：多個亂數種子各跑一次，回傳受傷分佈、0 受傷機率、危險曲線、是否可通過與建議。' +
      '遭遇戰會額外回傳逐回合受傷分佈、最危險回合、勝/饒恕/敗比例與總時長（encounter 欄位）。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['attack', 'encounter'], description: '作品類型（預設 attack）' },
        name: { type: 'string', description: '作品名稱（讀磁碟）' },
        doc: { type: 'object', description: '直接分析一份 JSON' },
        runs: { type: 'number', description: '跑幾次（預設 20）' },
        bot: { type: 'string', enum: ['dodge', 'idle'], description: '舊版玩家模型（預設 dodge；遭遇戰未指定時走 autoplay bot）' },
        autoplay: {
          type: 'string',
          enum: ['demo', 'bot'],
          description: '用引擎的自動演示（demo=作品錄的輸入；bot=全 AI）。遭遇戰整場分析建議用 bot。',
        },
        frames: { type: 'number', description: '每次模擬最多幾幀（遭遇戰預設 3600）' },
        seed: { type: 'number', description: '起始亂數種子（預設 1）' },
        compare: { type: 'boolean', description: '同時回傳 idle 基準線（baseline 欄位）' },
      },
      additionalProperties: false,
    },
    handler: toolDifficulty,
  },
  {
    name: 'dr_editor_state',
    description: '讀取「人正在編輯器裡看什麼」（哪個檔案、選取、時間游標、語言）。Agent 接手前先看，避免打斷人的操作。',
    inputSchema: {
      type: 'object',
      properties: { clientId: { type: 'string', description: '（選用）只看某個編輯器' } },
      additionalProperties: false,
    },
    handler: toolEditorState,
  },
  {
    name: 'dr_editor_focus',
    description: '「指給人看」：要求開著的編輯器切換到某個檔案 / 選取某事件 / 跳到某幀（透過 SSE 推 focus）。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['attack', 'encounter'], description: '作品類型' },
        name: { type: 'string', description: '作品名稱' },
        frame: { type: 'number', description: '跳到第幾幀' },
        eventId: { type: 'string', description: '選取某個時間軸事件（事件 id）' },
        turn: { type: 'number', description: '遭遇戰的回合編號' },
        lang: { type: 'string', enum: ['zh', 'en'], description: '切換語言' },
        note: { type: 'string', description: '給人看的提示文字' },
      },
      additionalProperties: false,
    },
    handler: toolEditorFocus,
  },
  {
    name: 'dr_history',
    description: '查看修改紀錄（誰在什麼時候改了哪個檔案、前後 etag）。可依 kind/name/client 過濾。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['attack', 'encounter'], description: '作品類型' },
        name: { type: 'string', description: '作品名稱' },
        client: { type: 'string', description: '依用戶端過濾（human/agent/<id>）' },
        limit: { type: 'number', description: '回傳筆數（預設 50）' },
      },
      additionalProperties: false,
    },
    handler: toolHistory,
  },
  {
    name: 'dr_restore',
    description: '還原：可以指定歷史紀錄 id 還原到那次修改前，或用垃圾桶 id 復原被刪的作品。',
    inputSchema: {
      type: 'object',
      properties: {
        historyId: { type: 'string', description: '歷史紀錄 id（還原到該筆之前）' },
        trashId: { type: 'string', description: '垃圾桶項目 id' },
        kind: { type: 'string', enum: ['attack', 'encounter'], description: '搭配 etag 還原時的作品類型' },
        name: { type: 'string', description: '搭配 etag 還原時的作品名稱' },
        etag: { type: 'string', description: '要還原的歷史版本 etag（history/blobs）' },
      },
      additionalProperties: false,
    },
    handler: toolRestore,
  },
];

/* ==================================================================== */
/* MCP 協定（stdio JSON-RPC 2.0，一行一個訊息）                          */
/* ==================================================================== */

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function handleRequest(message) {
  const { id, method, params } = message;
  const hasId = id !== undefined && id !== null;

  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
          },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            'DR Battle Editor 的 Agent 工具。建議流程：dr_docs（讀格式）→ dr_assets_search（找素材）→ dr_write/dr_patch（寫）→ dr_validate → dr_simulate → dr_difficulty → dr_render（看畫面）→ 依數據調整。作品就是 attacks/、encounters/ 下的 JSON。',
        });
        return;

      case 'notifications/initialized':
      case 'initialized':
        return; // 通知不需要回應

      case 'ping':
        reply(id, {});
        return;

      case 'tools/list':
        reply(id, {
          tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        });
        return;

      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const tool = TOOLS.find((item) => item.name === name);
        if (!tool) {
          reply(id, { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true });
          return;
        }
        try {
          const result = await tool.handler(args);
          reply(id, result);
        } catch (err) {
          reply(id, {
            content: [{ type: 'text', text: `工具 ${name} 執行失敗：${err && err.stack ? err.stack : String(err)}` }],
            isError: true,
          });
        }
        return;
      }

      case 'resources/list': {
        const resources = [];
        for (const [key, file] of [
          ['agent', join(DOCS_DIR, 'SPEC-AGENT.md')],
          ['spec', join(DOCS_DIR, 'SPEC.md')],
          ['p2', join(DOCS_DIR, 'SPEC-P2.md')],
          ['guide', join(DOCS_DIR, 'AGENT-GUIDE.md')],
        ]) {
          if (isFile(file)) {
            resources.push({
              uri: `dr://docs/${key}`,
              name: key,
              description: file.replace(`${BATTLE_EDITOR}/`, ''),
              mimeType: 'text/markdown',
            });
          }
        }
        for (const name of ['attack', 'encounter', 'cues']) {
          const file = join(SCHEMA_DIR, `${name}.json`);
          if (isFile(file)) {
            resources.push({ uri: `dr://schema/${name}`, name: `schema-${name}`, description: `JSON Schema：${name}`, mimeType: 'application/json' });
          }
        }
        reply(id, { resources });
        return;
      }

      case 'resources/read': {
        const uri = String((params && params.uri) || '');
        const match = uri.match(/^dr:\/\/(docs|schema)\/(.+)$/);
        if (!match) {
          replyError(id, -32602, `不支援的資源 URI：${uri}`);
          return;
        }
        const file =
          match[1] === 'docs'
            ? join(DOCS_DIR, { agent: 'SPEC-AGENT.md', spec: 'SPEC.md', p2: 'SPEC-P2.md', guide: 'AGENT-GUIDE.md' }[match[2]] || '')
            : join(SCHEMA_DIR, `${match[2]}.json`);
        if (!file || !isFile(file)) {
          replyError(id, -32602, `資源不存在：${uri}`);
          return;
        }
        reply(id, {
          contents: [{ uri, mimeType: match[1] === 'docs' ? 'text/markdown' : 'application/json', text: readFileSync(file, 'utf8') }],
        });
        return;
      }

      case 'prompts/list':
        reply(id, { prompts: [] });
        return;

      default:
        if (hasId) replyError(id, -32601, `不支援的方法：${method}`);
        return;
    }
  } catch (err) {
    if (hasId) replyError(id, -32603, `內部錯誤：${err && err.message ? err.message : String(err)}`);
  }
}

/* ==================================================================== */
/* 進入點                                                                */
/* ==================================================================== */

async function main() {
  // --root / --works（或 DR_ROOT / DR_WORKS）必須在讀任何路徑之前套用。
  try {
    applyCliPaths(process.argv.slice(2));
  } catch (err) {
    log(err.message);
    process.exitCode = 2;
    return;
  }
  const args = parseArgs(process.argv.slice(2), ['port', 'root', 'works']);

  if (args['print-tools']) {
    for (const tool of TOOLS) {
      const required = (tool.inputSchema.required || []).join(', ');
      console.log(`${tool.name}${required ? `（必填：${required}）` : ''}\n  ${tool.description}\n`);
    }
    console.log(`共 ${TOOLS.length} 個工具。`);
    return;
  }

  if (args.http) {
    const base = await detectServer(true);
    const edge = await import('./render.mjs').then((m) => m.findEdge()).catch(() => null);
    console.log(`MCP：${SERVER_NAME} ${SERVER_VERSION}（stdio，${TOOLS.length} 個工具，Node ${process.version}）`);
    if (base) {
      const info = await api('/api');
      const endpoints = info.ok && info.json && Array.isArray(info.json.endpoints) ? info.json.endpoints.length : null;
      console.log(`伺服器：${base} ✓${endpoints != null ? `（/api 自我發現 OK，${endpoints} 個端點）` : '（/api OK）'}`);
    } else {
      console.log('伺服器：未啟動 → 作品 CRUD 會降級為直接讀寫磁碟（讀/寫/刪仍可用；editor state/history 不可用）');
    }
    console.log(`Edge：${edge || '未找到（dr_render 不可用，其他工具不受影響）'}${edge ? ' ✓' : ''}`);
    const sizes = ['attack', 'encounter', 'cues'].map((name) => {
      const file = join(SCHEMA_DIR, `${name}.json`);
      if (!isFile(file)) return `${name} ✗（請跑 node tools/agent/export-schema.mjs）`;
      return `${name} ${(statSync(file).size / 1024).toFixed(1)}KB ✓`;
    });
    console.log(`schema：${sizes.join(' / ')}`);
    return;
  }

  log(`啟動（${TOOLS.length} 個工具，Node ${process.version}）`);
  const base = await detectServer(true);
  log(base ? `使用伺服器 ${base}` : '沒有伺服器 → 作品 CRUD 降級為直接讀寫磁碟');

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message = null;
    try {
      message = JSON.parse(text);
    } catch (err) {
      log(`收到非 JSON 的一行（已忽略）：${text.slice(0, 120)}`);
      return;
    }
    if (Array.isArray(message)) {
      for (const item of message) void handleRequest(item);
      return;
    }
    void handleRequest(message);
  });
  rl.on('close', () => {
    log('stdin 關閉，結束');
    process.exit(0);
  });
}

if (cliEntry(import.meta.url)) {
  main().catch((err) => {
    log(`致命錯誤：${err && err.stack ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}

export { TOOLS as tools, handleRequest, detectServer, api };
