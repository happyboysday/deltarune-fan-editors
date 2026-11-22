// 逐格编辑：把房间看成一张格子地图，供编辑器（画笔、橡皮、矩形）和命令行（文字地图）共用。
// 写回普通房间实体和 room.tiles。地下城的 back / actor / front 方块各自独立占格。
//   地形层  每格一个符号，连成一片的同种地形写回时自动合并成最少的矩形。
//   物件层  每个物件占一块矩形格子（门默认 1×2），保留自己的 ID、事件和全部属性。
// 不对齐格子的旧物件（例如从官方房间导入的碰撞）标成「锁定」，画笔不会覆盖它们，文字地图里显示为 ?。

import {rectOf} from './format.mjs';
import {projectPlugins} from './plugins.mjs';

export const DEFAULT_SIZE = 20;
export const SIZES = [8, 10, 12, 16, 20, 24, 32, 40, 48, 64];

// 零件表：顺序就是编辑器调色盘的顺序，前十个对应数字键 1–9、0。
export const PARTS = [
  {id:'wall', sym:'#', label:'墙', kind:'wall', terrain:true, solid:true, color:'#9a8fc6'},
  {id:'oneway', sym:'-', label:'单向平台', kind:'wall', props:{oneWay:true}, terrain:true, solid:true, color:'#d6b36f',
    tip:'横版跳跃房间里只挡住向下落地'},
  {id:'slide', sym:'~', label:'滑行区', kind:'mode', props:{mode:'slide'}, terrain:true, color:'#73d6ea'},
  {id:'climb', sym:'=', label:'攀爬区', kind:'mode', props:{mode:'climb'}, terrain:true, color:'#93d68b'},
  {id:'entry', sym:'@', label:'入口', entry:true, color:'#a3f2ba', tip:'进入房间时玩家站的格子'},
  {id:'npc', sym:'N', label:'NPC', kind:'npc', props:{name:'新角色', solid:true}, color:'#f2b56b'},
  {id:'enemy', sym:'E', label:'敌人', kind:'enemy', props:{name:'新敌人', auto:true}, color:'#ef7f93'},
  {id:'door', sym:'D', label:'门', kind:'door', cells:[1, 2], props:{name:'新门'}, color:'#c99bff'},
  {id:'block', sym:'B', label:'推块', kind:'block', color:'#c1a27f'},
  {id:'switch', sym:'S', label:'踏板', kind:'switch', props:{latch:false}, color:'#9fe0c8'},
  {id:'checkpoint', sym:'C', label:'检查点', kind:'checkpoint', color:'#7fb8ff'},
  {id:'savepoint', sym:'P', label:'存档点', kind:'savepoint', props:{name:'星光存档点'}, color:'#ffe27a'},
  {id:'prop', sym:'O', label:'物件', kind:'prop', color:'#d9c9b0'},
  {id:'zone', sym:'Z', label:'触发区', kind:'zone', color:'#ff9ed8', area:true, tip:'用矩形工具可拉出任意大小'},
  {id:'hold', sym:'K', label:'长按机关', kind:'hold', props:{name:'长按机关', ticks:45, decay:1}, color:'#f6a36a'},
];
export const PART = Object.fromEntries(PARTS.map(p => [p.id, p]));
const BY_SYM = Object.fromEntries(PARTS.map(p => [p.sym, p]));
const OBJECT_BY_KIND = Object.fromEntries(PARTS.filter(p => !p.terrain && !p.entry).map(p => [p.kind, p]));
export const EMPTY = '.', LOCKED = '?';

// 自定义零件：工程的 gridParts 里登记，适合导入的大素材（例如 4×1 格的长椅）。
//   "gridParts": {"long_bench": {"sym":"L", "label":"长椅", "kind":"prop", "sprite":"bench_png", "cells":[4,1], "props":{"solid":true}}}
// 用了这个素材的同种物件会被认成这个零件；文字地图里用它的字母（L 后面接 lll）。
export const CUSTOM_KINDS = ['wall', 'npc', 'enemy', 'door', 'zone', 'switch', 'block', 'checkpoint', 'savepoint', 'hold', 'prop'];
export const FREE_SYMBOLS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter(s => !BY_SYM[s]);
export const projectParts=p=>registry(p?.gridParts,p?.tileParts,p?.enemyTypes);
export function registry(custom, tileParts, enemyTypes) {
  for(const [id,p] of Object.entries(custom??{})){
    if(p && BY_SYM[p.sym])throw new Error('gridParts.'+id+' 与内置符号冲突：'+p.sym);
  }
  const extra = Object.entries(custom ?? {})
    .filter(([id, c]) => c && !PART[id] && FREE_SYMBOLS.includes(c.sym) && CUSTOM_KINDS.includes(c.kind))
    .map(([id, c]) => ({id, sym: c.sym, label: c.label ?? id, kind: c.kind, sprite: c.sprite, custom: true,
      cells: Array.isArray(c.cells) ? c.cells : undefined, props: c.props, color: c.color ?? '#e9c3ff'}));
  for (const [key,p] of Object.entries(tileParts ?? {})) {
    if (typeof p.sym!=='string' || !/^[a-z0-9]$/.test(p.sym) || !TILE_LAYERS.includes(p.layer)) throw new Error('tileParts.'+key+' 的符号或图层无效');
    extra.push({...p,id:'tile:'+key,tileKey:key,label:p.label??key,color:p.color??'#a49aca'});
  }
  for (const [key,p] of Object.entries(enemyTypes ?? {})) {
    if (!FREE_SYMBOLS.includes(p.sym)) throw new Error('enemyTypes.'+key+' 的符号无效或与内置符号冲突');
    extra.push({id:'enemy:'+key,sym:p.sym,label:p.label??key,cells:p.cells,color:p.color??'#ef7f93',
      kind:'actionEnemy',props:{enemyType:key},thumbnail:p.anims?.idle??p.anims?.move});
  }
  const list = [...PARTS, ...extra], seen=new Set();
  for (const p of list) {
    if(p.cells!==undefined && (!Array.isArray(p.cells) || p.cells.length!==2 || !p.cells.every(n=>Number.isSafeInteger(n)&&n>=1)))
      throw new Error(p.id+' 的 cells 应为两个正整数');
    if (seen.has(p.sym)) throw new Error('零件符号冲突：'+p.sym);
    seen.add(p.sym);
  }
  return {list, extra, byId: Object.fromEntries(list.map(p => [p.id, p])), bySym: Object.fromEntries(list.map(p => [p.sym, p])),
    objectFor: e => extra.find(p=>e.kind==='actionEnemy' && e.enemyType && p.props?.enemyType===e.enemyType) ?? extra.find(p => p.kind === e.kind && p.sprite && p.sprite === e.sprite) ?? OBJECT_BY_KIND[e.kind]};
}
export const TILE_LAYERS = ['back','actor','front'];
export const partLayer = p => p.layer ?? (p.terrain ? 'collision' : 'objects');
export function footprint(part) {return part.terrain || part.entry ? [1, 1] : part.cells ?? [1, 1];}

export function gridSize(room) {
  const n = room?.grid?.size;
  return Number.isInteger(n) && n >= 8 && n <= 64 ? n : DEFAULT_SIZE;
}

// 地形实体必须「干净」：对齐格子，且只有地形本身的字段。带事件、条件、名称、素材的墙属于物件，保持原样。
const TERRAIN_KEYS = {wall: new Set(['id', 'kind', 'x', 'y', 'w', 'h', 'oneWay']), mode: new Set(['id', 'kind', 'x', 'y', 'w', 'h', 'mode'])};
function aligned(e, size, room) {
  const {x, y, w, h} = rectOf(e);
  return x % size === 0 && y % size === 0 && w > 0 && h > 0 &&
    (w % size === 0 || x + w === room.w) && (h % size === 0 || y + h === room.h);
}
function terrainPart(e, size, room) {
  const keys = TERRAIN_KEYS[e.kind];
  if (!keys || !Object.keys(e).every(k => keys.has(k)) || !aligned(e, size, room)) return null;
  if (e.kind === 'wall') return e.oneWay === true ? PART.oneway : e.oneWay === undefined || e.oneWay === false ? PART.wall : null;
  return e.mode === 'slide' ? PART.slide : e.mode === 'climb' ? PART.climb : null;
}
function span(rect, size, room) {
  const c0 = Math.floor(rect.x / size), r0 = Math.floor(rect.y / size);
  const c1 = Math.ceil(Math.min(rect.x + rect.w, room.w) / size), r1 = Math.ceil(Math.min(rect.y + rect.h, room.h) / size);
  return {c: c0, r: r0, cw: Math.max(1, c1 - c0), ch: Math.max(1, r1 - r0)};
}

// 读出格子模型。模型是纯数据，可以随意修改后交给 writeGrid。
export function readGrid(room, {parts,project,layer,tileParts,enemyTypes} = {}) {
  if (layer && !['collision','objects',...TILE_LAYERS].includes(layer)) throw new Error('未知图层：'+layer);
  const reg = registry(parts??project?.gridParts,tileParts??project?.tileParts,enemyTypes??project?.enemyTypes);
  const size = gridSize(room), cols = Math.ceil(room.w / size), rows = Math.ceil(room.h / size);
  const terrain = Array.from({length: rows}, () => Array(cols).fill(EMPTY));
  const objects = [], locked = [];
  for (const e of room.entities ?? []) {
    const t = terrainPart(e, size, room);
    if (t) {
      const s = span(rectOf(e), size, room);
      for (let r = s.r; r < s.r + s.ch; r++) for (let c = s.c; c < s.c + s.cw; c++) terrain[r][c] = t.sym;
      continue;
    }
    const part = reg.objectFor(e);
    if (part && aligned(e, size, room)) objects.push({part: part.id, entity: e, ...span(rectOf(e), size, room)});
    else locked.push({entity: e, ...span(rectOf(e), size, room)});
  }
  // 和锁定物件重叠的格子物件也一起锁定：同一格只能有一个主人，文字地图才不会有歧义。
  const overlaps = (a, b) => a.c < b.c + b.cw && b.c < a.c + a.cw && a.r < b.r + b.ch && b.r < a.r + a.ch;
  if(layer==='objects'){
    const ambiguous=objects.filter(o=>objects.some(other=>other!==o && overlaps(o,other)) ||
      Object.values(room.entries??{}).some(e=>inside(o,Math.floor(e.x/size),Math.floor(e.y/size))));
    for(const o of ambiguous){objects.splice(objects.indexOf(o),1);locked.push(o);}
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const o of [...objects]) if (locked.some(l => overlaps(l, o))) {
      objects.splice(objects.indexOf(o), 1); locked.push({entity: o.entity, c: o.c, r: o.r, cw: o.cw, ch: o.ch}); changed = true;
    }
  }
  const entries = Object.entries(room.entries ?? {}).map(([id, v]) => {
    const c = Math.min(cols - 1, Math.floor(v.x / size)), r = Math.min(rows - 1, Math.floor(v.y / size));
    return {id, entry: v, c, r, locked: locked.some(l => inside(l, c, r))};
  });
  if(layer==='objects')for(const e of entries)
    if(entries.some(other=>other!==e && other.c===e.c && other.r===e.r))e.locked=true;
  const tiles=(room.tiles??[]).map(tile=>{
    const p=reg.byId['tile:'+tile.part];
    const [cw,ch]=p?footprint(p):[1,1];
    const rect={...tile,w:tile.w??cw*size,h:tile.h??ch*size};
    const outside=rect.x<0 || rect.y<0 || rect.x+rect.w>room.w || rect.y+rect.h>room.h;
    return {tile,part:p?.id,layer:tile.layer??p?.layer??(tile.front?'front':'back'),
      locked:!p||outside||!aligned(rect,size,room),...span(rect,size,room)};
  });
  const occupied=new Map();
  for(const o of tiles)eachTileCell({rows,cols},o,(c,r)=>{
    const key=o.layer+':'+(r*cols+c),other=occupied.get(key);
    if(other)other.locked=o.locked=true;
    else occupied.set(key,o);
  });
  return {originalTerrain:terrain.map(row=>[...row]), tiles, layer, size, cols, rows, w: room.w, h: room.h, terrain, objects, locked, entries, reg};
}

const inside = (o, c, r) => c >= o.c && c < o.c + o.cw && r >= o.r && r < o.r + o.ch;
export function at(model, c, r) {
  return {
    entry: model.entries.find(e => e.c === c && e.r === r) ?? null,
    object: [...model.objects].reverse().find(o => inside(o, c, r)) ?? null,
    locked: [...model.locked].reverse().find(o => inside(o, c, r)) ?? null,
    terrain: model.terrain[r]?.[c] ?? null,
  };
}
const valid = (model, c, r) => c >= 0 && r >= 0 && c < model.cols && r < model.rows;
function free(model, c, r, cw, ch, ignore) {
  for (let y = r; y < r + ch; y++) for (let x = c; x < c + cw; x++) {
    if (!valid(model, x, y)) return false;
    const hit = at(model, x, y);
    if (hit.entry && hit.entry !== ignore || hit.object && hit.object !== ignore || hit.locked) return false;
  }
  return true;
}
function clearSolid(model, c, r, cw, ch) {
  for (let y = r; y < r + ch; y++) for (let x = c; x < c + cw; x++)
    if (BY_SYM[model.terrain[y][x]]?.solid) model.terrain[y][x] = EMPTY;
}

// —— 编辑操作（都会就地修改模型；返回 true 表示有变化）——
export function paint(model, c, r, partId, {cw, ch} = {}) {
  const part = model.reg.byId[partId];
  if (!part || !valid(model, c, r)) return false;
  if(model.layer && model.layer!==partLayer(part)) return false;
  if(part.tileKey){
    const [dw,dh]=footprint(part),w=cw??dw,h=ch??dh;
    if(!valid(model,c+w-1,r+h-1) || model.tiles.some(o=>o.layer===part.layer && o.c<c+w && c<o.c+o.cw && o.r<r+h && r<o.r+o.ch)) return false;
    model.tiles.push({part:part.id,layer:part.layer,c,r,cw:w,ch:h});return true;
  }
  const hit = at(model, c, r);
  if (part.terrain) {
    if (!model.layer && (hit.locked || hit.object || part.solid && hit.entry) || model.terrain[r][c] === part.sym) return false;
    model.terrain[r][c] = part.sym;
    return true;
  }
  if (part.entry) {
    if (!free(model, c, r, 1, 1)) return false;
    if (!model.layer) clearSolid(model, c, r, 1, 1);
    model.entries.push({c, r});
    return true;
  }
  const [dw, dh] = footprint(part);
  const w = cw ?? dw, h = ch ?? dh;
  if (!free(model, c, r, w, h)) return false;
  if (!model.layer) clearSolid(model, c, r, w, h);
  model.objects.push({part: part.id, c, r, cw: w, ch: h});
  return true;
}
export function erase(model, c, r) {
  if (!valid(model, c, r)) return false;
  const hit = at(model, c, r);
  if(TILE_LAYERS.includes(model.layer)){
    const i=model.tiles.findIndex(o=>o.layer===model.layer && !o.locked && inside(o,c,r));
    if(i<0)return false;
    model.tiles.splice(i,1);return true;
  }
  if(model.layer==='collision'){
    if(model.terrain[r][c]===EMPTY)return false;
    model.terrain[r][c]=EMPTY;return true;
  }
  if (hit.entry) {
    if (model.entries.length <= 1) return false;
    model.entries.splice(model.entries.indexOf(hit.entry), 1);
    return true;
  }
  if (hit.object) {model.objects.splice(model.objects.indexOf(hit.object), 1); return true;}
  if (hit.locked) {model.locked.splice(model.locked.indexOf(hit.locked), 1); return true;}
  if (model.layer !== 'objects' && model.terrain[r][c] !== EMPTY) {model.terrain[r][c] = EMPTY; return true;}
  return false;
}
// 矩形：地形整片填满；触发区这种「区域物件」拉成一个大物件；其他物件按自己的大小铺满。
export function fill(model, c0, r0, c1, r1, partId, size) {
  const part = model.reg.byId[partId];
  const [a, b] = [Math.min(c0, c1), Math.max(c0, c1)], [d, e] = [Math.min(r0, r1), Math.max(r0, r1)];
  if (!part) return false;
  if (part.area) return paint(model, a, d, partId, {cw: b - a + 1, ch: e - d + 1});
  let changed = false;
  const [dw, dh] = part.terrain || part.entry ? [1, 1] : size ?? footprint(part);
  for (let r = d; r + dh - 1 <= e; r += dh) for (let c = a; c + dw - 1 <= b; c += dw)
    changed = paint(model, c, r, partId, part.terrain || part.entry ? {} : {cw: dw, ch: dh}) || changed;
  return changed;
}
// 改物件占的格子数（左上角不动）。
export function resize(model, item, cw, ch) {
  if (!item || !Number.isInteger(cw) || !Number.isInteger(ch) || cw < 1 || ch < 1 || item.cw === cw && item.ch === ch) return false;
  if (!free(model, item.c, item.r, cw, ch, item)) return false;
  if (!model.layer) clearSolid(model, item.c, item.r, cw, ch);
  item.cw = cw; item.ch = ch; item.moved = true;
  return true;
}
export function eraseRect(model, c0, r0, c1, r1) {
  let changed = false;
  for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++)
    for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) while (erase(model, c, r)) changed = true;
  return changed;
}
export function move(model, item, c, r) {
  if (!item || item.c === c && item.r === r) return false;
  const cw = item.cw ?? 1, ch = item.ch ?? 1;
  if (!free(model, c, r, cw, ch, item)) return false;
  item.c = c; item.r = r; item.moved = true;
  return true;
}

// —— 写回 ——
function mergeTerrain(model) {
  const used = model.terrain.map(row => row.map(() => false)), rects = [];
  for (let r = 0; r < model.rows; r++) for (let c = 0; c < model.cols; c++) {
    const sym = model.terrain[r][c];
    if (sym === EMPTY || used[r][c]) continue;
    let w = 1;
    while (c + w < model.cols && model.terrain[r][c + w] === sym && !used[r][c + w]) w++;
    let h = 1;
    grow: while (r + h < model.rows) {
      for (let x = c; x < c + w; x++) if (model.terrain[r + h][x] !== sym || used[r + h][x]) break grow;
      h++;
    }
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) used[y][x] = true;
    rects.push({sym, c, r, cw: w, ch: h});
  }
  return rects;
}
function pixelRect(model, o) {
  const x = o.c * model.size, y = o.r * model.size;
  return {x, y, w: Math.min(o.cw * model.size, model.w - x), h: Math.min(o.ch * model.size, model.h - y)};
}
function nextId(prefix, taken) {let i = 1; while (taken.has(prefix + '_' + i)) i++; const id = prefix + '_' + i; taken.add(id); return id;}

// 把模型写回房间（回传新的房间对象，不修改原工程）。taken 是整个工程已用的实体 ID，用来生成不重复的新 ID。
export function writeGrid(room, model, taken, {radius = 6} = {}) {
  const tiles=model.tiles.map(o=>o.tile??{part:model.reg.byId[o.part].tileKey,...pixelRect(model,o)});
  const tileFields=room.tiles||tiles.length?{tiles}:{};
  if(TILE_LAYERS.includes(model.layer))return {...room,...tileFields};
  const originalWalls=(room.entities??[]).filter(e=>terrainPart(e,model.size,room));
  const sameTerrain=model.layer==='objects' || model.originalTerrain.every((row,r)=>row.every((v,c)=>v===model.terrain[r][c]));
  const ids = new Set(taken);
  const keepIds = new Set([...model.objects, ...model.locked].map(o => o.entity?.id).filter(Boolean));
  for (const e of room.entities ?? []) if (!keepIds.has(e.id) && !(sameTerrain && originalWalls.includes(e))) ids.delete(e.id); // 删掉的物件、旧地形的 ID 可以重用
  const terrain = sameTerrain ? originalWalls : mergeTerrain(model).map(t => {
    const part = BY_SYM[t.sym];
    return {id: nextId(part.kind, ids), kind: part.kind, ...pixelRect(model, t), ...(part.props ?? {})};
  });
  const objects = [];
  const order = new Map((room.entities ?? []).map((e, i) => [e.id, i]));
  const kept = [...model.locked.map(o => o.entity), ...model.objects.filter(o => o.entity).map(o => {
    const rect = pixelRect(model, o), e = {...o.entity};
    // 原本就在这一格的物件保留原像素位置（例如 20×22 的 NPC），移动或改大小时才对齐到格子。
    const old = rectOf(o.entity), same = span(old, model.size, model);
    if (o.moved || same.c !== o.c || same.r !== o.r || same.cw !== o.cw || same.ch !== o.ch) Object.assign(e, rect);
    return e;
  })].sort((a, b) => order.get(a.id) - order.get(b.id));
  objects.push(...kept);
  for (const o of model.objects.filter(o => !o.entity)) {
    const part = model.reg.byId[o.part], id = nextId(part.kind, ids);
    const e = {kind: part.kind, id, ...pixelRect(model, o), ...(part.props ?? {}), ...(part.sprite ? {sprite: part.sprite} : {})};
    if (part.kind === 'switch') e.flag = id;
    objects.push(e);
  }
  const entries = {}, entryIds = new Set(model.entries.map(e => e.id).filter(Boolean));
  const entryOrder = Object.keys(room.entries ?? {});
  const rank = en => en.id && entryOrder.includes(en.id) ? entryOrder.indexOf(en.id) : Infinity;
  for (const en of [...model.entries].sort((a, b) => rank(a) - rank(b))) {
    const original = en.id && room.entries?.[en.id];
    const stays = original && !en.moved && Math.min(model.cols - 1, Math.floor(original.x / model.size)) === en.c &&
      Math.min(model.rows - 1, Math.floor(original.y / model.size)) === en.r;
    const id = en.id ?? nextId('entry', entryIds);
    const cx = Math.min(en.c * model.size + model.size / 2, (en.c * model.size + model.w) / 2);
    const cy = Math.min(en.r * model.size + model.size / 2, (en.r * model.size + model.h) / 2);
    const clampTo = (v, max) => Math.max(radius, Math.min(max - radius, Math.round(v)));
    entries[id] = stays ? original : {...(original ?? {face: 'down'}), x: clampTo(cx, model.w), y: clampTo(cy, model.h)};
  }
  const entities=[...terrain,...objects];
  entities.sort((a,b)=>(order.get(a.id)??Infinity)-(order.get(b.id)??Infinity));
  return {...room,...tileFields,entries,entities};
}

export function projectIds(project) {
  return new Set(Object.values(project.rooms ?? {}).flatMap(r => (r.entities ?? []).map(e => e.id)));
}
// 一步完成：读格子 → 交给 edit 修改 → 写回。回传新工程（edit 回传 false 时回传 null）。
export function editRoom(project, key, edit, options = {}) {
  const room = project.rooms[key], model = readGrid(room, {project,...options});
  if (edit(model) === false) return null;
  const written = writeGrid(room, model, projectIds(project), {radius: project.player?.radius ?? 6});
  return {...project, rooms: {...project.rooms, [key]: written}};
}

// —— 文字地图 ——
export function legend(parts,project) {
  const reg = registry(parts,project?.tileParts,project?.enemyTypes);
  const t = PARTS.filter(p => p.terrain).map(p => p.sym + ' ' + p.label).join('  ');
  const o = PARTS.filter(p => !p.terrain).map(p => p.sym + ' ' + p.label).join('  ');
  const x = reg.extra.map(p => `${p.sym} ${p.label}（${footprint(p).join('×')} 格${p.sprite ? '·' + p.sprite : ''}）`).join('  ');
  return [
    '; 地形：' + t + '  . 空地',
    '; 物件：' + o,
    ...(x ? ['; 自定义：' + x] : []),
    '; 物件写大写字母在左上角，同一个物件占的其余格子写同一个字母的小写（门默认 1×2：D 下面一格写 d）。',
    '; ? 是不对齐格子的旧物件，只能在编辑器或工程 JSON 里修改；文字地图里请原样保留。',
    '; 以 ; 开头的行和每行空格后面的内容都是注释。',
  ];
}
export function toText(room, key = '', options = {}) {
  const m = readGrid(room, options), {layer}=m;
  const out = m.terrain.map(row => [...row]);
  if(layer && layer!=='collision')out.forEach(row=>row.fill(EMPTY));
  for(const o of m.tiles.filter(o=>o.layer===layer)) eachTileCell(m,o,(c,r)=>{out[r][c]=o.locked?LOCKED:m.reg.byId[o.part].sym;});
  if(!layer || layer==='objects'){
    for (const o of m.objects) {
      const sym = m.reg.byId[o.part].sym;
      eachTileCell(m,o,(c,r)=>{out[r][c]=r===o.r && c===o.c?sym:sym.toLowerCase();});
    }
    for (const e of m.entries) if (!e.locked || layer==='objects') out[e.r][e.c] = e.locked ? LOCKED : '@';
    for (const o of m.locked) eachTileCell(m,o,(c,r)=>{out[r][c]=LOCKED;});
  }
  return [
    `; 房间 ${key || room.title || ''} · ${m.cols}×${m.rows} 格 · 每格 ${m.size} 像素 · 房间 ${room.w}×${room.h} 像素`,
    ...legend(options.parts??options.project?.gridParts,options.project??options),
    ...(layer?['; 当前图层 '+layer+'；方块占格全部写同一个符号。']:[]),
    ...out.map((row, i) => row.join('') + '  ; ' + i),
  ].join('\n') + '\n';
}

export class GridTextError extends Error {}
// 按文字地图重建房间的格子内容。已有物件按「同一种零件、同一个左上角」认回来，保留 ID 和属性。
export function fromText(room, text, options = {}) {
  const prev = readGrid(room, options), rows = [], SYM = prev.reg.bySym;
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    rows.push(line.split(/\s/)[0]);
  }
  const fail = (r, c, msg) => {throw new GridTextError(`第 ${r} 行第 ${c} 列：${msg}`);};
  if (rows.length !== prev.rows) throw new GridTextError(`需要 ${prev.rows} 行（房间 ${room.h} 像素 ÷ 每格 ${prev.size}），收到 ${rows.length} 行`);
  rows.forEach((row, r) => {if ([...row].length !== prev.cols) fail(r, [...row].length, `每行需要 ${prev.cols} 个字符，这一行有 ${[...row].length} 个`);});
  const grid = rows.map(row => [...row]);
  if(prev.layer==='collision'){
    for(const [r,row] of grid.entries())for(const [c,ch] of row.entries())
      if(ch!==EMPTY && !SYM[ch]?.terrain)fail(r,c,'不是碰撞层符号：'+ch);
    return {...prev,terrain:grid};
  }
  if(TILE_LAYERS.includes(prev.layer))return parseTiles(prev,grid,fail);
  const layered=projectPlugins(options.project).modes.get(room.mode)?.hooks.layeredGrid;
  const model = {...prev, terrain: prev.terrain.map(row => [...row]), objects: [], entries: prev.entries.filter(e => e.locked), locked: prev.locked};
  const lockedAt = (c, r) => prev.locked.find(o => inside(o,c,r)) ?? (prev.layer==='objects' && prev.entries.find(e=>e.locked && e.c===c && e.r===r));
  const used = grid.map(row => row.map(() => false));
  // 相邻、错位的同种多格物件可能有连续的小写符号。保留仍可辨认的原实例边界。
  const owners = grid.map(row => row.map(() => null));
  for(const o of prev.objects){
    const sym=prev.reg.byId[o.part].sym;
    let matches=grid[o.r]?.[o.c]===sym;
    eachTileCell(prev,o,(x,y)=>{
      if((x!==o.c || y!==o.r) && grid[y][x]!==sym.toLowerCase())matches=false;
    });
    if(matches)eachTileCell(prev,o,(x,y)=>{owners[y][x]=o;});
  }
  for (let r = 0; r < prev.rows; r++) for (let c = 0; c < prev.cols; c++) {
    const ch = grid[r][c], lock = lockedAt(c, r);
    if (lock && ch !== LOCKED) fail(r, c, `这一格是旧物件 ${lock.entity?.id??lock.id}（显示为 ?），请保留 ?，要改它请用编辑器或工程 JSON`);
    if (!lock && ch === LOCKED) fail(r, c, '? 只能出现在旧物件所在的格子');
    if (ch === LOCKED || used[r][c]) continue;
    const terrainPartHere = BY_SYM[ch]?.terrain ? BY_SYM[ch] : null;
    if (terrainPartHere && prev.layer) fail(r,c,'不是物件层符号：'+ch);
    if (ch === EMPTY || terrainPartHere) {model.terrain[r][c] = ch; continue;}
    if (ch === '@') {
      const old = prev.entries.find(e => e.c === c && e.r === r && !model.entries.some(n => n.id === e.id));
      model.entries.push(old ? {...old} : {c, r});
      if (!layered) model.terrain[r][c] = BY_SYM[prev.terrain[r][c]]?.solid ? EMPTY : prev.terrain[r][c];
      continue;
    }
    const part = SYM[ch];
    if (!part || part.tileKey) {
      if (SYM[ch.toUpperCase()] && ch !== ch.toUpperCase()) fail(r, c, `小写 ${ch} 前面（左边或上面）缺少大写 ${ch.toUpperCase()}`);
      fail(r, c, `不认识的符号「${ch}」`);
    }
    // 大写字母：往右、往下找同字母的小写，组成这个物件的矩形
    const low = ch.toLowerCase();
    const owner=owners[r][c];
    const available=(x,y)=>grid[y][x]===low && !used[y][x] && (!owners[y][x] || owners[y][x]===owner);
    let cw = 1; while (c + cw < prev.cols && available(c+cw,r)) cw++;
    let chh = 1; while (r + chh < prev.rows && available(c,r+chh)) chh++;
    for (let y = r; y < r + chh; y++) for (let x = c; x < c + cw; x++) {
      if (y === r && x === c) continue;
      if (!available(x,y)) fail(y, x, `${ch} 物件应是 ${cw}×${chh} 的矩形，这一格应写 ${low}`);
    }
    for (let y = r; y < r + chh; y++) for (let x = c; x < c + cw; x++) {
      used[y][x] = true;
      // 物件底下的地形文字地图看不见，沿用原来的（墙会被挖开）
      if (!layered) model.terrain[y][x] = BY_SYM[prev.terrain[y][x]]?.solid ? EMPTY : prev.terrain[y][x];
    }
    const old = prev.objects.find(o => o.part === part.id && o.c === c && o.r === r && !model.objects.includes(o));
    model.objects.push(old ? {...old, cw, ch: chh} : {part: part.id, c, r, cw, ch: chh});
  }
  // 搬家：同一种零件里没认回来的旧物件和新出现的物件数量一样时，按阅读顺序一一对上，
  // 这样只是把物件挪到别的格子，它的 ID、名字、事件都还在。
  for (const part of prev.reg.list) {
    const fresh = model.objects.filter(o => o.part === part.id && !o.entity);
    const lost = prev.objects.filter(o => o.part === part.id && !model.objects.some(n => n.entity === o.entity));
    if (fresh.length && fresh.length === lost.length) fresh.forEach((o, i) => {o.entity = lost[i].entity; o.moved = true;});
  }
  const freshEntries = model.entries.filter(e => !e.id);
  const lostEntries = prev.entries.filter(e => !model.entries.some(n => n.id === e.id));
  if (freshEntries.length && freshEntries.length === lostEntries.length)
    freshEntries.forEach((e, i) => {e.id = lostEntries[i].id; e.entry = lostEntries[i].entry; e.moved = true;});
  if(prev.layer==='objects')model.terrain=prev.terrain;
  if (!model.entries.length) throw new GridTextError('至少要有一个入口 @');
  return model;
}

// 新建房间：按文字地图的行列数决定房间大小。
export function roomFromText(text, {size = DEFAULT_SIZE, title, taken = new Set(), radius = 6, parts, project} = {}) {
  const rows = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith(';')).map(l => l.split(/\s/)[0]);
  if (!rows.length) throw new GridTextError('文字地图是空的');
  const cols = [...rows[0]].length;
  const room = {title: title ?? '新房间', w: Math.max(64, cols * size), h: Math.max(64, rows.length * size), style: 'flat',
    grid: {size}, entries: {}, entities: []};
  // 先放一个临时入口让 readGrid 有东西可读，fromText 会以地图里的 @ 为准
  room.entries.__temp = {x: Math.min(size / 2, room.w / 2), y: Math.min(size / 2, room.h / 2)};
  const model = fromText(room, text, {parts,project});
  for (const e of model.entries) if (e.id === '__temp') delete e.id;
  const out = writeGrid(room, model, taken, {radius});
  delete out.entries.__temp;
  return out;
}

function eachTileCell(model,o,visit){
  for(let r=Math.max(0,o.r);r<Math.min(model.rows,o.r+o.ch);r++)
    for(let c=Math.max(0,o.c);c<Math.min(model.cols,o.c+o.cw);c++)visit(c,r);
}
function parseTiles(model,grid,fail){
  const {tiles,layer,reg}=model, saved=new Map(), added=[];
  const used=grid.map(row=>row.map(()=>false));
  const mark=o=>eachTileCell(model,o,(c,r)=>{used[r][c]=true;});
  function matches(o,sym){
    if(o.r<0 || o.c<0 || o.r+o.ch>model.rows || o.c+o.cw>model.cols)return false;
    let ok=true;
    eachTileCell(model,o,(c,r)=>{if(used[r][c] || grid[r][c]!==sym)ok=false;});
    return ok;
  }
  const previous=tiles.filter(o=>o.layer===layer);
  for(const o of previous){
    if(o.locked)eachTileCell(model,o,(c,r)=>{if(grid[r][c]!==LOCKED)fail(r,c,'请保留锁定方块 ?');});
    else if(!matches(o,reg.byId[o.part].sym))continue;
    saved.set(o,o);mark(o);
  }
  for(const [r,row] of grid.entries())for(const [c,sym] of row.entries()){
    if(used[r][c] || sym===EMPTY)continue;
    const p=reg.bySym[sym];
    if(!p?.tileKey)fail(r,c,'不是方块符号：'+sym);
    const old=previous.find(o=>!saved.has(o) && o.part===p.id && matches({...o,r,c},sym));
    if(!old && p.layer!==layer)fail(r,c,'方块属于 '+p.layer+' 层');
    const [cw,ch]=old?[old.cw,old.ch]:footprint(p);
    const o={part:p.id,layer,c,r,cw,ch};
    if(!matches(o,sym))fail(r,c,'需要 '+cw+'×'+ch+' 个 '+sym);
    if(old)saved.set(old,{...o,tile:{...old.tile,...pixelRect(model,o)}});
    else added.push(o);
    mark(o);
  }
  return {...model,tiles:[...tiles.filter(o=>o.layer!==layer || saved.has(o)).map(o=>saved.get(o)??o),...added]};
}
