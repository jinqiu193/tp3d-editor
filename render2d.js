// ============================================================
// render2d.js — SVG 渲染 2D 平面图 (借鉴 blueprint3d-babylon Render2D.js)
// 浏览器原生 Skia 渲染,不占 WebGL 主线程
// ============================================================

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD = 24;                  // 内部边距 px
let _svg = null;
let _doc = null;
let _view = { minX: -10, maxX: 10, minZ: -10, maxZ: 10, w: 800, h: 600 };
let _palette = null;
let _dirty = false;
let _rafId = null;
let _panning = false;       // 平移模式：拖动中跳过全量重建，仅用 transform 偏移
let _panTx = 0, _panTy = 0; // 累积平移偏移（SVG px）

// 选中 / 悬停 state(由 main.js 同步过来)
let _sel = null;        // { kind: 'wall'|'floor'|'furn'|'opening', i }
let _hover = null;      // 同上

// 事件回调(由 main.js 注册)
const handlers = {
  pick: null,           // (target, e) => void  target = {kind, i, extra?}
  contextmenu: null,    // (target, e) => void
  pointermove: null,    // ({world, screen}, e) => void
  pointerdown: null,    // ({world, screen, target?}, e) => void
  pointerup: null,      // ({world, screen, target?}, e) => void
  dragmove: null,       // ({world, screen}, e) => void
  wheel: null,          // ({world, screen, deltaY}, e) => void
};

// ============================================================
// 初始化
// ============================================================
// 同时挂到 globalThis 供 main.js 调用(浏览器 ESM import 不会污染 globalThis)
function _expose() {
  if (typeof globalThis !== 'undefined') {
    globalThis.initRender2D = initRender2D;
    globalThis.render2dExports = {
      setViewBounds, getViewBounds, setViewport,
      worldToSvg, svgToWorld, svgPointFromEvent,
      panBy, panByFast, beginPan, endPan, zoomAt, fitToContent,
      setSelection, setHover, getSelection, getHover,
      markDirty, renderPlan, on,
    };
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', _expose, { once: true });
  // 也立即试一次(可能 main.js 在 DOMContentLoaded 后才 import)
  _expose();
}

export function initRender2D({ svg, doc, palette }) {
  _svg = svg;
  _doc = doc;
  _palette = palette || defaultPalette();
  _svg.setAttribute('xmlns', SVG_NS);
  _svg.style.userSelect = 'none';
  _svg.style.touchAction = 'none';
  // 事件绑定(都委托到 svg 根)
  _svg.addEventListener('pointerdown', _onPointerDown);
  _svg.addEventListener('pointermove', _onPointerMove);
  _svg.addEventListener('pointerup', _onPointerUp);
  _svg.addEventListener('wheel', _onWheel, { passive: false });
  _svg.addEventListener('contextmenu', _onContextMenu);
  scheduleRender();
}

function defaultPalette() {
  // 用 CSS 变量读不到内联;落默认值
  return {
    wall: '#a3b1c2',
    wallSel: '#36c2ff',
    wallHover: '#ffd84d',
    wallTarget: '#ff8800',
    wallDraft: '#9ec5ff',
    floor: 'rgba(195, 207, 220, 0.55)',
    floorSel: 'rgba(85, 68, 0, 0.5)',
    furniture: '#cfe6f2',
    furnitureSel: '#36c2ff',
    opening: '#3a4a5e',
    door: '#3a4a5e',
    window: '#82b4e8',
    openingSel: '#36c2ff',
    stair: '#bba478',
    grid: 'rgba(150, 165, 180, 0.35)',
    gridMajor: 'rgba(150, 165, 180, 0.55)',
    axis: 'rgba(255, 130, 60, 0.55)',
    text: '#1f2a37',
    bgHandle: '#ff9f1c',
    bgMarquee: 'rgba(54, 194, 255, 0.18)',
    borderMarquee: '#36c2ff',
  };
}

// ============================================================
// 视图
// ============================================================
export function setViewBounds(bounds) {
  _view.minX = bounds.minX;
  _view.maxX = bounds.maxX;
  _view.minZ = bounds.minZ;
  _view.maxZ = bounds.maxZ;
  scheduleRender();
}

export function getViewBounds() {
  return { ..._view };
}

export function setViewport(w, h) {
  _view.w = w; _view.h = h;
  scheduleRender();
}

// 把屏幕 px → svg 内部坐标(0..view.w / 0..view.h)
export function svgPointFromEvent(e) {
  const rect = _svg.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * _view.w,
    y: ((e.clientY - rect.top) / rect.height) * _view.h,
  };
}

export function worldToSvg(x, z) {
  const innerW = _view.w - PAD * 2;
  const innerH = _view.h - PAD * 2;
  const xRatio = (x - _view.minX) / (_view.maxX - _view.minX);
  const zRatio = (z - _view.minZ) / (_view.maxZ - _view.minZ);
  return {
    x: PAD + xRatio * innerW,
    y: PAD + zRatio * innerH,
  };
}

export function svgToWorld(sx, sy) {
  const innerW = _view.w - PAD * 2;
  const innerH = _view.h - PAD * 2;
  return {
    x: _view.minX + ((sx - PAD) / innerW) * (_view.maxX - _view.minX),
    z: _view.minZ + ((sy - PAD) / innerH) * (_view.maxZ - _view.minZ),
  };
}

// 平移视图(屏幕 px delta)
export function panBy(dxPx, dyPx) {
  const innerW = _view.w - PAD * 2;
  const innerH = _view.h - PAD * 2;
  const worldDx = (dxPx / innerW) * (_view.maxX - _view.minX);
  const worldDz = (dyPx / innerH) * (_view.maxZ - _view.minZ);
  _view.minX -= worldDx; _view.maxX -= worldDx;
  _view.minZ -= worldDz; _view.maxZ -= worldDz;
  scheduleRender();
}

// 平移优化：拖动中仅用 SVG transform 偏移内容，跳过全量 DOM 重建
export function beginPan() {
  _panning = true;
  _panTx = 0; _panTy = 0;
}

export function panByFast(dxPx, dyPx) {
  if (!_panning) { panBy(dxPx, dyPx); return; }
  _panTx += dxPx; _panTy += dyPx;
  const innerW = _view.w - PAD * 2;
  const innerH = _view.h - PAD * 2;
  const worldDx = (dxPx / innerW) * (_view.maxX - _view.minX);
  const worldDz = (dyPx / innerH) * (_view.maxZ - _view.minZ);
  _view.minX -= worldDx; _view.maxX -= worldDx;
  _view.minZ -= worldDz; _view.maxZ -= worldDz;
  const content = _svg.querySelector('#r2d-content');
  if (content) {
    content.setAttribute('transform', `translate(${_panTx},${_panTy})`);
  } else {
    scheduleRender();
  }
}

export function endPan() {
  if (!_panning) return;
  _panning = false;
  _panTx = 0; _panTy = 0;
  scheduleRender();
}

// 缩放(以屏幕点为锚,zoom 是缩放因子 > 1 放大, < 1 缩小)
export function zoomAt(screenX, screenY, zoom) {
  const w = svgToWorld(screenX, screenY);
  const newW = (_view.maxX - _view.minX) / zoom;
  const newH = (_view.maxZ - _view.minZ) / zoom;
  _view.minX = w.x - (screenX - PAD) / (_view.w - PAD * 2) * newW;
  _view.maxX = _view.minX + newW;
  _view.minZ = w.z - (screenY - PAD) / (_view.h - PAD * 2) * newH;
  _view.maxZ = _view.minZ + newH;
  scheduleRender();
}

export function fitToContent(doc, viewportAspect) {
  const xs = [], zs = [];
  (doc.walls || []).forEach(w => { xs.push(w.ax, w.bx); zs.push(w.az, w.bz); });
  (doc.floors || []).forEach(f => { xs.push(f.x1, f.x2); zs.push(f.z1, f.z2); });
  (doc.furniture || []).forEach(f => { xs.push(f.x - 0.5, f.x + 0.5); zs.push(f.z - 0.5, f.z + 0.5); });
  if (!xs.length) {
    _view.minX = -10; _view.maxX = 10; _view.minZ = -10; _view.maxZ = 10;
    return;
  }
  const pad = 1.5;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minZ = Math.min(...zs) - pad, maxZ = Math.max(...zs) + pad;
  const w = maxX - minX, h = maxZ - minZ;
  // 保持 viewport 长宽比
  let w2 = w, h2 = h;
  if (w / h > viewportAspect) {
    h2 = w / viewportAspect;
  } else {
    w2 = h * viewportAspect;
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  _view.minX = cx - w2 / 2; _view.maxX = cx + w2 / 2;
  _view.minZ = cz - h2 / 2; _view.maxZ = cz + h2 / 2;
  scheduleRender();
}

// ============================================================
// 选中 / 悬停(state 由 main.js 写入)
// ============================================================
export function setSelection(sel) {
  _sel = sel;
  scheduleRender();
}

export function setHover(hover) {
  _hover = hover;
  scheduleRender();
}

export function getSelection() { return _sel; }
export function getHover() { return _hover; }

// ============================================================
// Dirty / Render 调度 — 合并多次标记到下一帧
// ============================================================
export function markDirty() { _dirty = true; scheduleRender(); }

function scheduleRender() {
  _dirty = true;
  if (_panning) return;     // 平移中不触发全量重建，由 panByFast 用 transform 处理
  if (_rafId != null) return;
  _rafId = requestAnimationFrame(() => {
    _rafId = null;
    if (_dirty) { _dirty = false; renderPlan(); }
  });
}

export function renderPlan() {
  if (!_svg) return;
  // 全量重建 — 蓝图 Render2D.js 风格;浏览器自动合并重排
  while (_svg.firstChild) _svg.removeChild(_svg.firstChild);
  _svg.setAttribute('viewBox', `0 0 ${_view.w} ${_view.h}`);
  _svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const content = _createSvg('g', { id: 'r2d-content' });
  _svg.appendChild(content);

  const _append = content.appendChild.bind(content);

  _renderGrid(_append);
  _renderFloors(_append);
  _renderStairs(_append);
  _renderWalls(_append);
  _renderOpenings(_append);
  _renderFurniture(_append);
  _renderSelection(_append);
}

// ============================================================
// 渲染层(顺序: 后画的覆盖前画的)
// ============================================================
function _renderGrid(append) {
  const layer = _createSvg('g', { class: 'grid-layer' });
  const step = _autoGridStep();
  // X 方向竖线(世界 x 固定)
  const startX = Math.ceil(_view.minX / step) * step;
  const endX = Math.floor(_view.maxX / step) * step;
  for (let x = startX; x <= endX + 1e-6; x += step) {
    const a = worldToSvg(x, _view.minZ);
    const b = worldToSvg(x, _view.maxZ);
    const isAxis = Math.abs(x) < 1e-6;
    const cls = isAxis ? 'axis-line' : 'grid-line';
    layer.appendChild(_createSvg('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: cls, 'data-grid': 'x', 'data-grid-x': x,
    }));
  }
  // Z 方向横线
  const startZ = Math.ceil(_view.minZ / step) * step;
  const endZ = Math.floor(_view.maxZ / step) * step;
  for (let z = startZ; z <= endZ + 1e-6; z += step) {
    const a = worldToSvg(_view.minX, z);
    const b = worldToSvg(_view.maxX, z);
    const isAxis = Math.abs(z) < 1e-6;
    const cls = isAxis ? 'axis-line' : 'grid-line';
    layer.appendChild(_createSvg('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: cls, 'data-grid': 'z', 'data-grid-z': z,
    }));
  }
  append(layer);
}

function _autoGridStep() {
  const range = Math.max(_view.maxX - _view.minX, _view.maxZ - _view.minZ);
  // 选一个让网格密度合理的 step:范围越大,步长越大
  if (range > 100) return 5;
  if (range > 30) return 2;
  if (range > 10) return 1;
  if (range > 3) return 0.5;
  return 0.25;
}

function _renderFloors(append) {
  const layer = _createSvg('g', { class: 'floor-layer' });
  (_doc.floors || []).forEach((f, fi) => {
    if (_isHidden('floor', fi)) return;
    const x1 = worldToSvg(f.x1, 0).x;
    const z1 = worldToSvg(0, f.z1).y;
    const x2 = worldToSvg(f.x2, 0).x;
    const z2 = worldToSvg(0, f.z2).y;
    const x = Math.min(x1, x2), y = Math.min(z1, z2);
    const w = Math.abs(x2 - x1), h = Math.abs(z2 - z1);
    const isSel = _isSel('floor', fi);
    const cls = `floor-rect${isSel ? ' selected' : ''}`;
    layer.appendChild(_createSvg('rect', {
      x, y, width: w, height: h,
      class: cls,
      'data-floor-id': fi,
      fill: isSel ? _palette.floorSel : (_palette.floor),
      stroke: isSel ? _palette.wallSel : 'transparent',
      'stroke-width': isSel ? 1.5 : 0,
    }));
  });
  append(layer);
}

function _renderStairs(append) {
  const layer = _createSvg('g', { class: 'stairs-layer' });
  (_doc.stairs || []).forEach((s, si) => {
    if (_isHidden('stairs', si)) return;
    const cx = worldToSvg(s.x, 0).x;
    const cz = worldToSvg(0, s.z).y;
    const w = worldToSvg(s.x + (s.w || 1), 0).x - cx;
    const d = worldToSvg(0, s.z + (s.d || 2)).y - cz;
    const isSel = _isSel('stairs', si);
    layer.appendChild(_createSvg('rect', {
      x: cx - w / 2, y: cz - d / 2, width: w, height: d,
      class: `stairs-rect${isSel ? ' selected' : ''}`,
      'data-stairs-id': si,
      fill: _palette.stair,
      stroke: isSel ? _palette.wallSel : 'rgba(0,0,0,.25)',
      'stroke-width': isSel ? 1.5 : 0.5,
    }));
  });
  append(layer);
}

function _renderWalls(append) {
  const layer = _createSvg('g', { class: 'wall-layer' });
  (_doc.walls || []).forEach((w, wi) => {
    if (_isHidden('wall', wi)) return;
    const a = worldToSvg(w.ax, w.az);
    const b = worldToSvg(w.bx, w.bz);
    const isSel = _isSel('wall', wi);
    const isHover = _isHover('wall', wi);
    let cls = 'wall-line';
    if (isSel) cls += ' selected';
    else if (isHover) cls += ' hover';
    const stroke = isSel ? _palette.wallSel
                  : isHover ? _palette.wallHover
                  : _palette.wall;
    layer.appendChild(_createSvg('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: cls,
      'data-wall-id': wi,
      stroke, 'stroke-width': isSel ? 4 : 2.5,
      'stroke-linecap': 'round',
    }));
  });
  append(layer);
}

function _renderOpenings(append) {
  const layer = _createSvg('g', { class: 'opening-layer' });
  (_doc.walls || []).forEach((w, wi) => {
    if (_isHidden('wall', wi)) return;
    (w.openings || []).forEach((op, oi) => {
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1;
      const halfT = (op.width || 0.9) / len / 2;
      const ct = op.t ?? 0.5;
      const t1 = Math.max(0, ct - halfT);
      const t2 = Math.min(1, ct + halfT);
      const a = {
        x: w.ax + (w.bx - w.ax) * t1,
        z: w.az + (w.bz - w.az) * t1,
      };
      const b = {
        x: w.ax + (w.bx - w.ax) * t2,
        z: w.az + (w.bz - w.az) * t2,
      };
      const sa = worldToSvg(a.x, a.z);
      const sb = worldToSvg(b.x, b.z);
      const isSel = _isSel('opening', wi, oi);
      const isDoor = op.type === 'door';
      const cls = (isDoor ? 'door-line' : 'window-line') + (isSel ? ' selected' : '');
      const stroke = isSel ? _palette.openingSel
                    : isDoor ? _palette.door
                    : _palette.window;
      const dashArray = isDoor ? '4 3' : '2 2';
      layer.appendChild(_createSvg('line', {
        x1: sa.x, y1: sa.y, x2: sb.x, y2: sb.y,
        class: cls,
        'data-wall-id': wi,
        'data-opening-id': oi,
        stroke, 'stroke-width': isSel ? 3.5 : 2,
        'stroke-dasharray': dashArray,
        'stroke-linecap': 'butt',
      }));
    });
  });
  append(layer);
}

function _renderFurniture(append) {
  const layer = _createSvg('g', { class: 'furniture-layer' });
  (_doc.furniture || []).forEach((f, fi) => {
    if (_isHidden('furniture', fi)) return;
    const def = (typeof FURN !== 'undefined') ? FURN[f.type] : null;
    if (!def) return;
    const w = def.w || 0.5, d = def.d || 0.5;
    const center = worldToSvg(f.x, f.z);
    const half = {
      x: (w / 2) / (_view.maxX - _view.minX) * (_view.w - PAD * 2),
      y: (d / 2) / (_view.maxZ - _view.minZ) * (_view.h - PAD * 2),
    };
    const isSel = _isSel('furn', fi);
    const isHover = _isHover('furn', fi);
    const cls = `furn-rect${isSel ? ' selected' : ''}${isHover ? ' hover' : ''}`;
    const stroke = isSel ? _palette.furnitureSel : (isHover ? _palette.wallHover : '#5b6b80');
    const rot = ((f.rot || 0) * 180 / Math.PI);
    const g = _createSvg('g', {
      transform: `rotate(${rot} ${center.x} ${center.y})`,
      'data-furn-id': fi,
    });
    g.appendChild(_createSvg('rect', {
      x: center.x - half.x, y: center.y - half.y,
      width: half.x * 2, height: half.y * 2,
      rx: 2, class: cls,
      fill: _palette.furniture,
      stroke, 'stroke-width': isSel ? 2 : 1,
    }));
    layer.appendChild(g);
  });
  append(layer);
}

function _renderSelection(append) {
  if (!_sel) return;
  // 选中态: 加一圈虚线
  if (_sel.kind === 'wall') {
    const w = _doc.walls[_sel.i];
    if (!w) return;
    const a = worldToSvg(w.ax, w.az);
    const b = worldToSvg(w.bx, w.bz);
    // 端点 gizmo
    append(_makeHandle(a.x, a.y, 'end', { wall: _sel.i, end: 0 }));
    append(_makeHandle(b.x, b.y, 'end', { wall: _sel.i, end: 1 }));
  } else if (_sel.kind === 'furn') {
    const f = _doc.furniture[_sel.i];
    if (!f) return;
    const def = (typeof FURN !== 'undefined') ? FURN[f.type] : null;
    if (!def) return;
    const w = def.w || 0.5, d = def.d || 0.5;
    const c = worldToSvg(f.x, f.z);
    const hx = (w / 2) / (_view.maxX - _view.minX) * (_view.w - PAD * 2);
    const hy = (d / 2) / (_view.maxZ - _view.minZ) * (_view.h - PAD * 2);
    // 4 角点 handle
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
      append(_makeHandle(c.x + sx * hx, c.y + sy * hy, 'furn-corner',
        { furn: _sel.i, corner: `${sx > 0 ? 'r' : 'l'}${sy > 0 ? 'b' : 't'}` }));
    });
    // 旋转 handle(顶部上方 18px)
    append(_makeHandle(c.x, c.y - hy - 18, 'furn-rotate', { furn: _sel.i, rotate: 1 }));
  } else if (_sel.kind === 'floor') {
    const f = _doc.floors[_sel.i];
    if (!f) return;
    const x1 = worldToSvg(f.x1, 0).x;
    const z1 = worldToSvg(0, f.z1).y;
    const x2 = worldToSvg(f.x2, 0).x;
    const z2 = worldToSvg(0, f.z2).y;
    [[x1, z1], [x2, z1], [x1, z2], [x2, z2]].forEach(([x, y], idx) => {
      append(_makeHandle(x, y, 'floor-corner', { floor: _sel.i, corner: idx }));
    });
  }
}

function _makeHandle(x, y, kind, data) {
  const size = 8;
  return _createSvg('rect', {
    x: x - size / 2, y: y - size / 2,
    width: size, height: size,
    rx: 1.5,
    class: `handle handle-${kind}`,
    fill: _palette.bgHandle,
    stroke: '#fff', 'stroke-width': 1,
    'data-handle': kind,
    ...Object.fromEntries(Object.entries(data).map(([k, v]) => [`data-${k}`, v])),
  });
}

// ============================================================
// 命中测试(从 e.target 反查 data-* 属性)
// ============================================================
function _pickTarget(e) {
  let el = e.target;
  while (el && el !== _svg) {
    if (el.dataset) {
      if (el.dataset.wallId !== undefined && el.dataset.openingId !== undefined) {
        return { kind: 'opening', wi: +el.dataset.wallId, oi: +el.dataset.openingId };
      }
      if (el.dataset.wallId !== undefined) {
        // 进一步判断是 line 还是 handle(端点)
        if (el.classList && el.classList.contains('handle-end')) {
          return { kind: 'end', wi: +el.dataset.wallId, end: +el.dataset.end };
        }
        return { kind: 'wall', wi: +el.dataset.wallId };
      }
      if (el.dataset.furnId !== undefined) {
        if (el.classList && el.classList.contains('handle-furn-corner')) {
          return { kind: 'furn-handle', fi: +el.dataset.furnId, corner: el.dataset.corner };
        }
        if (el.classList && el.classList.contains('handle-furn-rotate')) {
          return { kind: 'furn-rotate', fi: +el.dataset.furnId };
        }
        return { kind: 'furn', fi: +el.dataset.furnId };
      }
      if (el.dataset.floorId !== undefined) {
        if (el.classList && el.classList.contains('handle-floor-corner')) {
          return { kind: 'floor-handle', fi: +el.dataset.floorId, corner: +el.dataset.corner };
        }
        return { kind: 'floor', fi: +el.dataset.floorId };
      }
      if (el.dataset.stairsId !== undefined) return { kind: 'stairs', si: +el.dataset.stairsId };
    }
    el = el.parentNode;
  }
  return null;
}

// ============================================================
// 事件路由
// ============================================================
function _onPointerDown(e) {
  if (e.button === 2) return; // 右键走 contextmenu
  const pt = svgPointFromEvent(e);
  const world = svgToWorld(pt.x, pt.y);
  const target = _pickTarget(e);
  _fire('pointerdown', { world, screen: pt, target }, e);
  if (target) _fire('pick', target, e);
}

function _onPointerMove(e) {
  const pt = svgPointFromEvent(e);
  const world = svgToWorld(pt.x, pt.y);
  const target = _pickTarget(e);
  _fire('pointermove', { world, screen: pt, target }, e);
  // hover 高亮同步
  const nextHover = target ? _toSel(target) : null;
  if (!_sameSel(_hover, nextHover)) {
    _hover = nextHover;
    scheduleRender();
  }
}

function _onPointerUp(e) {
  const pt = svgPointFromEvent(e);
  const world = svgToWorld(pt.x, pt.y);
  const target = _pickTarget(e);
  _fire('pointerup', { world, screen: pt, target }, e);
}

function _onWheel(e) {
  e.preventDefault();
  const pt = svgPointFromEvent(e);
  const zoom = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoomAt(pt.x, pt.y, zoom);
  _fire('wheel', { world: svgToWorld(pt.x, pt.y), screen: pt, deltaY: e.deltaY }, e);
}

function _onContextMenu(e) {
  e.preventDefault();
  const pt = svgPointFromEvent(e);
  const world = svgToWorld(pt.x, pt.y);
  const target = _pickTarget(e);
  _fire('contextmenu', { target, world, screen: pt }, e);
}

// ============================================================
// 辅助
// ============================================================
function _createSvg(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function _isHidden(kind, i) {
  const h = _doc.hidden || {};
  return !!h[`${kind}:${i}`];
}

function _isSel(kind, i, sub) {
  if (!_sel) return false;
  if (sub !== undefined) return _sel.kind === kind && _sel.i === i && _sel.sub === sub;
  return _sel.kind === kind && _sel.i === i;
}

function _isHover(kind, i, sub) {
  if (!_hover) return false;
  if (sub !== undefined) return _hover.kind === kind && _hover.i === i && _hover.sub === sub;
  return _hover.kind === kind && _hover.i === i;
}

function _toSel(t) {
  if (!t) return null;
  if (t.kind === 'wall') return { kind: 'wall', i: t.wi };
  if (t.kind === 'opening') return { kind: 'opening', i: t.wi, sub: t.oi };
  if (t.kind === 'furn') return { kind: 'furn', i: t.fi };
  if (t.kind === 'floor') return { kind: 'floor', i: t.fi };
  if (t.kind === 'stairs') return { kind: 'stairs', i: t.si };
  return null;
}

function _sameSel(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.i !== b.i) return false;
  if (a.sub !== b.sub) return false;
  return true;
}

// 注册事件回调(同一事件支持多个监听者;首次注册保持单函数形态以兼容旧调用)
export function on(event, fn) {
  const cur = handlers[event];
  if (!cur) handlers[event] = fn;
  else if (Array.isArray(cur)) { if (!cur.includes(fn)) cur.push(fn); }
  else handlers[event] = [cur, fn];
}
function _fire(event, ...args) {
  const h = handlers[event];
  if (!h) return;
  if (Array.isArray(h)) h.forEach(fn => { try { fn(...args); } catch (e) { console.error('[render2d] handler error', e); } });
  else h(...args);
}