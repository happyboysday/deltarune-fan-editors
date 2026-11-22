/**
 * editor/demo-overlay.js — 攻擊編輯器的演示路徑疊加層（AP4）
 *
 * 只在編輯器 overlay（#editor-overlay）內繪製，不進引擎畫面：
 *   - 路徑點圓圈 + 連線 + 每個點的時間標籤
 *   - 時間軸游標對應的插值目標點高亮（SPEC-AUTOPLAY §4）
 *   - 編輯模式（preview、未播放）下可拖曳路徑點；拖曳寫回 demo.path[i].x / y
 *     （一筆 store.update + coalesceKey，放開滑鼠後 endCoalesce）
 *
 * 樣式由本檔以 <style> 注入（editor/styles.css 不在本任務可改範圍）。
 */

import { buildDemoTimeline, demoPathTargetAt, demoFrameToTime, clampDemoPoint, formatDemoTime, normalizeDemoPoint } from './demo-path.js';
import { normalizeTiming } from './beat.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const STYLE_ID = 'dr-demo-overlay-style';
const VIEW_W = 640;
const VIEW_H = 480;

const STYLE_TEXT = `
.dr-demo-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:4;overflow:visible}
.dr-demo-svg .dr-demo-line{fill:none;stroke:rgba(120,220,255,.85);stroke-width:1.6;stroke-dasharray:5 4;vector-effect:non-scaling-stroke}
.dr-demo-svg .dr-demo-point{fill:rgba(10,30,46,.88);stroke:rgba(120,220,255,.95);stroke-width:1.6;pointer-events:auto;cursor:grab;vector-effect:non-scaling-stroke}
.dr-demo-svg .dr-demo-point:hover{fill:rgba(120,220,255,.35)}
.dr-demo-svg .dr-demo-point.is-dragging{fill:rgba(255,209,102,.45);stroke:#ffd166;cursor:grabbing}
.dr-demo-svg .dr-demo-label{fill:#cfe9ff;font-family:var(--font-mono,monospace);font-size:10px;text-anchor:middle;paint-order:stroke;stroke:rgba(4,8,12,.75);stroke-width:2px;pointer-events:none;user-select:none}
.dr-demo-svg .dr-demo-target{fill:none;stroke:#ffd166;stroke-width:2;stroke-dasharray:3 3;pointer-events:none;vector-effect:non-scaling-stroke}
.dr-demo-svg .dr-demo-target-dot{fill:#ffd166;stroke:rgba(60,40,0,.9);stroke-width:1;pointer-events:none;vector-effect:non-scaling-stroke}
/* V2-06 實際軌跡（traceDemo 跑出來的跟隨器軌跡）與命中幀 */
.dr-demo-svg .dr-demo-actual{fill:none;stroke:rgba(255,138,196,.92);stroke-width:1.8;pointer-events:none;vector-effect:non-scaling-stroke}
.dr-demo-svg .dr-demo-hit{fill:rgba(255,75,75,.85);stroke:rgba(40,0,0,.9);stroke-width:1;pointer-events:none;vector-effect:non-scaling-stroke}
.dr-demo-svg .dr-demo-hit-label{fill:#ffb3c1;font-family:var(--font-mono,monospace);font-size:9px;text-anchor:middle;paint-order:stroke;stroke:rgba(4,8,12,.8);stroke-width:2px;pointer-events:none;user-select:none}
.dr-demo-svg .dr-demo-start{fill:#7dffb3;stroke:rgba(0,40,20,.9);stroke-width:1;pointer-events:none;vector-effect:non-scaling-stroke}
/* 路徑點很多時（自動產生的路徑）只留圓點，避免時間標籤蓋住軌跡；hover 才顯示該點時間 */
.dr-demo-svg.is-dense .dr-demo-label{display:none}
.dr-demo-svg.is-dense .dr-demo-point-group:hover .dr-demo-label{display:inline}
`;

function ensureOverlayStyles(doc) {
  if (!doc || !doc.getElementById) return;
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  (doc.head || doc.documentElement || doc.body).appendChild(style);
}

function isFinitePoint(point) {
  return Boolean(
    point &&
      typeof point === 'object' &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Number.isFinite(point.t),
  );
}

function r1(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

/**
 * @param {{
 *   overlay: HTMLElement,
 *   viewport: HTMLElement,
 *   store: any,
 *   getFrame: () => number,
 *   getAttack: () => any,
 *   getBox: () => any,
 *   isEditable?: () => boolean,
 *   onDragChange?: (dragging:boolean) => void,
 * }} opts
 */
export function createDemoOverlay(opts) {
  const {
    overlay,
    viewport,
    store,
    getFrame,
    getAttack,
    getBox,
    isEditable = () => true,
    onDragChange = null,
  } = opts || {};

  if (!overlay || !viewport || !store || typeof overlay.appendChild !== 'function') {
    return {
      refresh() {},
      setVisible() {},
      isVisible: () => false,
      isDragging: () => false,
      destroy() {},
    };
  }

  const doc = overlay.ownerDocument || (typeof document !== 'undefined' ? document : null);
  ensureOverlayStyles(doc);

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'dr-demo-svg');
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  overlay.appendChild(svg);

  let visible = true;
  let destroyed = false;
  let draggingIndex = -1;
  let dragPointerId = null;
  let lastSig = '';
  let lastPoints = [];
  let lastBox = null;
  let nodeByIndex = new Map();
  let targetGroup = null;
  let traceGroup = null;
  // V2-06：實際軌跡（traceDemo 結果）；null = 尚未計算
  let traceData = null;
  let traceVisible = true;
  let traceSig = '';

  function attack() {
    return getAttack ? getAttack() : store.attack || {};
  }

  function box() {
    return getBox ? getBox() : attack().box || {};
  }

  function demo() {
    const doc0 = attack();
    return doc0 && typeof doc0.demo === 'object' && doc0.demo !== null && !Array.isArray(doc0.demo)
      ? doc0.demo
      : null;
  }

  function rawPoints() {
    const d = demo();
    return d && Array.isArray(d.path) ? d.path : [];
  }

  function buildSig() {
    return JSON.stringify({
      visible,
      box: lastBox,
      points: lastPoints.map((p) => [p.t, p.x, p.y, p.slow === true, p.hold || 0]),
      trace: traceVisible ? traceSig : '',
    });
  }

  function clearSvg() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    nodeByIndex = new Map();
    targetGroup = null;
    traceGroup = null;
  }

  function createEl(tag, attrs) {
    const el = doc.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined) continue;
        el.setAttribute(key, String(value));
      }
    }
    return el;
  }

  function pointScreenPoint(point) {
    return { x: point.x, y: point.y };
  }

  /**
   * V2-06：實際軌跡（traceDemo 的跟隨器位置）＋被擊中的幀。
   * 顏色刻意與預定路線（青）不同：桃紅實線 + 紅點。
   */
  function rebuildTrace() {
    if (!traceVisible || !traceData || !Array.isArray(traceData.frames)) return;
    const frames = traceData.frames.filter((f) => f && f.actual && Number.isFinite(f.actual.x) && Number.isFinite(f.actual.y));
    if (frames.length === 0) return;
    traceGroup = createEl('g', { class: 'dr-demo-trace-group' });
    if (frames.length > 1) {
      // 每 2 幀取一點，200 幀以上的回合也不會讓 DOM 爆掉
      const stride = Math.max(1, Math.ceil(frames.length / 400));
      const pts = [];
      for (let i = 0; i < frames.length; i += stride) {
        pts.push(`${r1(frames[i].actual.x)},${r1(frames[i].actual.y)}`);
      }
      const last = frames[frames.length - 1];
      pts.push(`${r1(last.actual.x)},${r1(last.actual.y)}`);
      traceGroup.appendChild(createEl('polyline', { class: 'dr-demo-actual', points: pts.join(' ') }));
    }
    // 起點
    const first = frames[0];
    traceGroup.appendChild(createEl('circle', {
      class: 'dr-demo-start', cx: r1(first.actual.x), cy: r1(first.actual.y), r: 3,
    }));
    // 被擊中的幀
    const hits = Array.isArray(traceData.hits) ? traceData.hits : [];
    for (const hit of hits) {
      const x = Number(hit && hit.x);
      const y = Number(hit && hit.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      traceGroup.appendChild(createEl('circle', { class: 'dr-demo-hit', cx: r1(x), cy: r1(y), r: 6 }));
      const label = createEl('text', { class: 'dr-demo-hit-label', x: r1(x), y: r1(y) - 10 });
      label.textContent = `f${hit.frame}`;
      traceGroup.appendChild(label);
    }
    svg.appendChild(traceGroup);
  }

  function rebuild() {
    clearSvg();
    if (!visible) return;
    // V2-06：實際軌跡畫在最底層（預定路線在上）
    rebuildTrace();
    if (lastPoints.length === 0) return;

    const valid = [];
    lastPoints.forEach((point, index) => {
      if (!isFinitePoint(point)) return;
      const rawIndex = Number.isInteger(point.__rawIndex) ? point.__rawIndex : index;
      valid.push({ point, rawIndex });
    });
    if (valid.length === 0) return;

    if (valid.length > 1) {
      const line = createEl('polyline', {
        class: 'dr-demo-line',
        points: valid.map(({ point }) => `${r1(point.x)},${r1(point.y)}`).join(' '),
      });
      svg.appendChild(line);
    }

    targetGroup = createEl('g', { class: 'dr-demo-target-group', hidden: 'hidden' });
    targetGroup.appendChild(createEl('circle', { class: 'dr-demo-target', r: 9, cx: 0, cy: 0 }));
    targetGroup.appendChild(createEl('circle', { class: 'dr-demo-target-dot', r: 2.5, cx: 0, cy: 0 }));
    svg.appendChild(targetGroup);

    for (const { point, rawIndex } of valid) {
      const group = createEl('g', { class: 'dr-demo-point-group', 'data-index': rawIndex });
      const circle = createEl('circle', {
        class: 'dr-demo-point',
        cx: r1(point.x),
        cy: r1(point.y),
        r: 4.5,
      });
      circle.setAttribute('data-index', String(rawIndex));
      const label = createEl('text', {
        class: 'dr-demo-label',
        x: r1(point.x),
        y: r1(point.y) - 8,
      });
      label.textContent = formatDemoTime(point.t);
      group.appendChild(circle);
      group.appendChild(label);
      svg.appendChild(group);
      nodeByIndex.set(rawIndex, { circle, label, group });
    }
    // 自動產生的路徑常有 30+ 點：標籤全部顯示會蓋住軌跡疊圖，
    // 密集時只留圓點（滑到點上才顯示時間）。
    svg.classList.toggle('is-dense', valid.length > 12);
  }

  function timelineForCurrent() {
    const a = attack();
    return buildDemoTimeline(lastPoints, { timing: a && a.settings ? a.settings : null });
  }

  function updateTarget() {
    if (!targetGroup) return;
    const timeline = timelineForCurrent();
    const frame = Math.max(0, Math.round(Number(getFrame ? getFrame() : 0) || 0));
    const target = demoPathTargetAt(timeline, demoFrameToTime(frame));
    if (!target) {
      targetGroup.setAttribute('hidden', 'hidden');
      return;
    }
    targetGroup.removeAttribute('hidden');
    const circles = targetGroup.childNodes;
    for (let i = 0; i < circles.length; i += 1) {
      circles[i].setAttribute('cx', String(r1(target.x)));
      circles[i].setAttribute('cy', String(r1(target.y)));
    }
  }

  function refresh() {
    if (destroyed) return;
    // 拖曳中不重建 DOM：pointer capture 綁在 svg 上，重建會讓被拖的圓圈換成新節點；
    // moveDrag 會直接更新那一個圓圈與標籤，放開滑鼠後再重建一次。
    if (draggingIndex >= 0) return;
    const raw = rawPoints();
    const timing = normalizeTiming(attack().settings || null);
    lastPoints = raw
      .map((point, index) => {
        if (!point || typeof point !== 'object') return null;
        // V2-06：t 可為拍點字串（`"2b"`），換算成秒才能畫／排序
        const resolved = { ...point };
        if (typeof resolved.t === 'string') {
          const parsed = normalizeDemoPoint({ ...resolved, t: resolved.t }, { timing });
          if (!parsed) return null;
          resolved.t = parsed.t;
        }
        return isFinitePoint(resolved) ? { ...resolved, __rawIndex: index } : null;
      })
      .filter(Boolean);
    lastBox = box();
    if (traceVisible) traceSig = traceData ? traceData.sig : '';
    const sig = buildSig();
    if (sig !== lastSig) {
      lastSig = sig;
      rebuild();
    }
    updateTarget();
  }

  function logicalFromEvent(ev) {
    const rect = viewport.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    return {
      x: ((ev.clientX - rect.left) / width) * VIEW_W,
      y: ((ev.clientY - rect.top) / height) * VIEW_H,
    };
  }

  function writePoint(index, logical) {
    const clamped = clampDemoPoint(logical.x, logical.y, box());
    if (!store || typeof store.update !== 'function') return;
    store.update(
      (draft) => {
        if (!draft.demo || typeof draft.demo !== 'object') draft.demo = {};
        if (!Array.isArray(draft.demo.path)) draft.demo.path = [];
        const point = draft.demo.path[index];
        if (!point || typeof point !== 'object') return;
        point.x = clamped.x;
        point.y = clamped.y;
      },
      { label: `demo.dragPoint`, coalesceKey: `demo:point:${index}` },
    );
  }

  function moveDrag(ev) {
    if (draggingIndex < 0 || destroyed) return;
    if (dragPointerId !== null && ev.pointerId !== undefined && ev.pointerId !== dragPointerId) return;
    const raw = rawPoints();
    if (!raw[draggingIndex]) return;
    const node = nodeByIndex.get(draggingIndex);
    if (node) {
      const logical = logicalFromEvent(ev);
      const clamped = clampDemoPoint(logical.x, logical.y, box());
      node.circle.setAttribute('cx', String(r1(clamped.x)));
      node.circle.setAttribute('cy', String(r1(clamped.y)));
      node.label.setAttribute('x', String(r1(clamped.x)));
      node.label.setAttribute('y', String(r1(clamped.y) - 8));
    }
    // 寫回 store；preview 的 store 訂閱會觸發 refresh，但拖曳期間 refresh 會跳過重建
    writePoint(draggingIndex, logicalFromEvent(ev));
  }

  function endDrag() {
    if (draggingIndex < 0) return;
    draggingIndex = -1;
    dragPointerId = null;
    try {
      if (store && typeof store.endCoalesce === 'function') store.endCoalesce();
    } catch (_err) {
      /* 忽略 */
    }
    if (onDragChange) onDragChange(false);
    refresh();
  }

  function onPointerDown(ev) {
    if (draggingIndex >= 0 || destroyed) return;
    if (!visible || !(isEditable ? isEditable() : true)) return;
    if (ev.button !== undefined && ev.button !== 0) return;
    const target = ev.target;
    if (!target || typeof target.getAttribute !== 'function') return;
    const index = Number(target.getAttribute('data-index'));
    if (!Number.isInteger(index) || index < 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    draggingIndex = index;
    dragPointerId = ev.pointerId;
    const node = nodeByIndex.get(index);
    if (node) node.circle.classList.add('is-dragging');
    if (onDragChange) onDragChange(true);
    try {
      svg.setPointerCapture(ev.pointerId);
    } catch (_err) {
      /* 忽略 */
    }
    // 立刻寫回一次，讓第一次 undo 步驟就包含拖曳意圖
    const raw = rawPoints();
    if (raw[index]) writePoint(index, logicalFromEvent(ev));
  }

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', moveDrag);
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('lostpointercapture', endDrag);

  function setTrace(trace) {
    // trace = { frames:[{frame,target,actual,hit,pathActive}], hits:[{frame,x,y}], sig? }
    const next = trace && Array.isArray(trace.frames) && trace.frames.length > 0 ? trace : null;
    const sig = next ? (next.sig || `${next.frames.length}:${(next.hits || []).length}`) : '';
    traceData = next;
    if (sig === traceSig && !destroyed) {
      // 資料沒變：只切換顯示狀態
      if (traceGroup) traceGroup.setAttribute('visibility', traceVisible ? 'visible' : 'hidden');
      return;
    }
    traceSig = sig;
    lastSig = ''; // 強制重建
    refresh();
  }

  function setTraceVisible(next) {
    const value = next !== false;
    if (value === traceVisible) return;
    traceVisible = value;
    lastSig = '';
    refresh();
  }

  function hasTrace() {
    return Boolean(traceData && traceData.frames.length > 0);
  }

  function setVisible(next) {
    const value = next !== false;
    if (value === visible) return;
    visible = value;
    refresh();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    try {
      svg.removeEventListener('pointerdown', onPointerDown);
      svg.removeEventListener('pointermove', moveDrag);
      svg.removeEventListener('pointerup', endDrag);
      svg.removeEventListener('pointercancel', endDrag);
      svg.removeEventListener('lostpointercapture', endDrag);
    } catch (_err) {
      /* 忽略 */
    }
    if (svg.parentNode) svg.parentNode.removeChild(svg);
  }

  // 初次同步（等 preview 第一次 updateOverlayGeometry 也會呼叫）
  refresh();

  return {
    refresh,
    setVisible,
    isVisible: () => visible,
    isDragging: () => draggingIndex >= 0,
    setTrace,
    setTraceVisible,
    isTraceVisible: () => traceVisible,
    hasTrace,
    destroy,
  };
}

export default createDemoOverlay;
