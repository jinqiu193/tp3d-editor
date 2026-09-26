import * as THREE from 'three';
import { OrbitControls } from './libs/OrbitControls.js';
import { RoomEnvironment } from './libs/RoomEnvironment.js';
import { RoundedBoxGeometry } from './libs/RoundedBoxGeometry.js';
import { mergeGeometries } from './libs/BufferGeometryUtils.js';
import { GLTFExporter } from './libs/GLTFExporter.js';
import { GLTFLoader } from './libs/GLTFLoader.js';
import { DRACOLoader } from './libs/DRACOLoader.js';

// DRACO 压缩 GLB 解码器：参考程序中的家具多为 DRACO 压缩
const _draco = new DRACOLoader();
_draco.setDecoderPath('./libs/draco/');
_draco.setDecoderConfig({ type: 'wasm' });
const _gltfLoader = new GLTFLoader();
_gltfLoader.setDRACOLoader(_draco);
// GLB 缓存：file → THREE.Group（已归零到 min.y=0、共享几何/材质）
const _glbCache = new Map();
const _glbLoading = new Map();
async function loadGLB(file) {
  if (_glbCache.has(file)) return _glbCache.get(file);
  if (_glbLoading.has(file)) return _glbLoading.get(file);
  const p = new Promise((resolve, reject) => {
    _gltfLoader.load(`./libs/items/${file}/model.glb`, gltf => {
      const g = gltf.scene;
      g.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(g);
      g.position.y = -box.min.y;                  // 归零到地面
      g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      _glbCache.set(file, g);
      resolve(g);
    }, undefined, err => reject(err));
  });
  _glbLoading.set(file, p);
  return p;
}
function glbBuild(file) {
  // 同步 build：从缓存克隆。要求 GLB 已通过 preloadGLBs() 预加载。
  return () => {
    const cached = _glbCache.get(file);
    if (!cached) {
      // 兜底：返回空组，并在后台异步补上
      const root = new THREE.Group();
      loadGLB(file).then(src => {
        const c = src.clone(true);
        c.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        while (root.children.length) root.remove(root.children[0]);
        c.children.forEach(child => { c.remove(child); root.add(child); });
        if (!root.children.length) root.add(c);
        root.updateMatrixWorld(true);
      });
      return root;
    }
    const c = cached.clone(true);
    c.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return c;
  };
}

// ── 自定义模型（用户导入的 GLB / glTF）────────────────────────
// 字节存 IndexedDB（tp3d_db / assets），doc.assets 只放元数据。
// 类型键统一加 user: 前缀，避免和内置 FURN 键冲突。
const CUSTOM_PREFIX = 'user:';
const _missingAssetWarned = new Set();

let _placeholderMat = null;
function _placeholderMaterial() {
  if (!_placeholderMat) {
    _placeholderMat = new THREE.MeshStandardMaterial({
      color: 0xc9a227, roughness: 0.7, metalness: 0.05,
      transparent: true, opacity: 0.5,
    });
  }
  return _placeholderMat;
}
// 字节缺失时（例如把 .tp3d.json 发给别人）显示可见、可点选的占位盒，
// 而不是像内置 glbBuild 那样返回空组（空组不可见也不可选中）。
function _customPlaceholder(meta) {
  const w = Math.max(0.05, +meta.w || 0.5);
  const d = Math.max(0.05, +meta.d || 0.5);
  const h = Math.max(0.05, +meta.h || 0.5);
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, _placeholderMaterial());
  mesh.position.y = h / 2;
  g.add(mesh);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0xc9a227 }));
  edges.position.y = h / 2;
  g.add(edges);
  g.userData.placeholder = true;
  return g;
}
async function loadGLBFromBytes(key, arrayBuffer) {
  if (_glbCache.has(key)) return _glbCache.get(key);
  const gltf = await _gltfLoader.parseAsync(arrayBuffer, '');
  const g = gltf.scene;
  g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g);
  g.position.y = -box.min.y;                  // 归零到地面，与 loadGLB 一致
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  _glbCache.set(key, g);
  return g;
}
async function _loadCustomAssetBytes(id) {
  const key = CUSTOM_PREFIX + id;
  if (_glbCache.has(key)) return _glbCache.get(key);
  if (_glbLoading.has(key)) return _glbLoading.get(key);
  const p = (async () => {
    // 1) 优先从 IndexedDB(快,本地缓存)
    const rec = await assetGet(id);
    if (rec && rec.bytes) {
      try { return await loadGLBFromBytes(key, rec.bytes); }
      catch (e) { /* 字节损坏,fallthrough 到磁盘 */ }
    }
    // 2) 回落到磁盘目录(用户设置的保存目录)
    if (DIR_PICKER_SUPPORT) {
      try {
        const buf = await _readAssetFromDisk(id);
        if (buf) {
          // 回填 IDB,自愈(用户清了 IDB 也能恢复)
          const meta = (doc.assets || []).find(a => a.id === id);
          await assetPut(id, {
            id, name: meta?.name || rec?.name || id, fileName: meta?.fileName || rec?.fileName || `${id}.glb`,
            bytes: buf, addedAt: Date.now(),
          });
          return await loadGLBFromBytes(key, buf);
        }
      } catch (e) { /* 磁盘也没有或权限失效 */ }
    }
    // 3) 都拿不到 → 占位盒
    if (!_missingAssetWarned.has(id)) {
      _missingAssetWarned.add(id);
      toast(`自定义模型「${rec?.name || id}」在本机和磁盘都找不到,已显示占位盒`, 'warn', 5000);
    }
    return null;
  })();
  _glbLoading.set(key, p);
  try { return await p; } finally { _glbLoading.delete(key); }
}
function _customBuild(id, meta) {
  const key = CUSTOM_PREFIX + id;
  return () => {
    const cached = _glbCache.get(key);
    if (cached) {
      const c = cached.clone(true);
      c.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      return c;
    }
    // 字节未就绪：先给占位盒，异步补上（与 glbBuild 的空组兜底同思路，但可见）
    const ph = _customPlaceholder(meta);
    _loadCustomAssetBytes(id).then(src => {
      if (!src) return;
      const c = src.clone(true);
      c.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      while (ph.children.length) ph.remove(ph.children[0]);
      c.children.forEach(child => { c.remove(child); ph.add(child); });
      if (!ph.children.length) ph.add(c);
      ph.userData.placeholder = false;
      ph.updateMatrixWorld(true);
    }).catch(() => {});
    return ph;
  };
}
// 从 doc.assets 同步注册 FURN 条目。必须在 normDoc 的 FURN 过滤之前调用，
// 否则自定义家具会被当成"已废弃类型"删掉。
function _registerCustomAssetsFromDoc() {
  const list = (doc && doc.assets) || [];
  for (const meta of list) {
    if (!meta || !meta.id) continue;
    const key = CUSTOM_PREFIX + meta.id;
    FURN[key] = {
      cat: meta.cat || 'custom',
      name: meta.name || meta.fileName || '自定义模型',
      icon: meta.icon || '📦',
      w: +meta.w || 0.5,
      d: +meta.d || 0.5,
      h: +meta.h || 0.5,
      scale: meta.scale != null ? +meta.scale : 1,
      yOff: +meta.yOff || 0,
      file: null,
      custom: meta.id,
      build: _customBuild(meta.id, meta),
    };
  }
}
// 启动 / 切换文档后异步把字节从 IndexedDB 灌进 _glbCache，然后重建一次
async function _hydrateCustomAssets() {
  const list = (doc && doc.assets) || [];
  if (!list.length) return;
  for (const meta of list) {
    if (!meta || !meta.id) continue;
    try { await _loadCustomAssetBytes(meta.id); } catch (e) { /* 占位盒兜底 */ }
  }
  rebuild();
}

// CSG 布尔运算（动态加载，加载失败自动退化为分段拼接）
let CSG = null;
import('./libs/three-bvh-csg.js').then(m => {
  CSG = m;
  // 首渲染时 CSG 尚未就绪,墙体走的是退化拼接路径;几何 hash 未变,直接 rebuild()
  // 会被增量缓存跳过。这里丢弃全部墙组强制按 CSG 重建(家具组 'furn:*' 不动)。
  for (const [key, entry] of [..._wallNodeByWi]) {
    if (typeof key !== 'number') continue;
    _disposeGroupChildren(entry.group);
    planGroup.remove(entry.group);
    _wallNodeByWi.delete(key);
  }
  rebuild();
  toast('CSG 真开洞引擎已就绪', 'success');
}).catch(() => toast('CSG 库加载失败，已退化为拼接模式', 'warn', 6000));

// ============================================================
// 渲染器 / 双相机（透视环视 + 正交俯视）
// ============================================================
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;   // 关闭每帧自动阴影更新;rebuild 时手动触发一次
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// 0.95 而非 1.0:ACES 把白点往上顶,1.0 时墙面实测亮度高糊成一片;
// 0.95 把中间调压回来,白墙才留得住层次。参考 spec_room3d_single.html 的注释。
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('canvasWrap').appendChild(renderer.domElement);
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

// 画布尺寸跟随容器（右侧属性面板占位后剩余区域）；首次调用在文件末尾执行
const canvasWrap = document.getElementById('canvasWrap');
// 提前到 fitCanvas() 上方:resize 后必须强制下一帧重画,否则 renderer.setSize()
// 清空 drawing buffer 后,RAF 因 _needsRender 已被消费 + 键盘删除没指针交互
// → 画面定格黑屏,直到鼠标动。详见 main.js:6855 animate() 的 idle skip 逻辑。
let _needsRender = true;
// 静止帧跳过 render:交互时间戳必须最先声明 —— 画布指针监听器(6225 行等)在模块
// 求值早期就已注册,若声明晚于监听器,启动阶段的第一次鼠标移动就会 TDZ 抛错,
// 中断后续初始化(页面显示不正常)。_pokeInteract 同理提前。
let _lastInteractAt = performance.now();
function _pokeInteract() { _lastInteractAt = performance.now(); _needsRender = true; }
function fitCanvas() {
  const w = canvasWrap.clientWidth, h = canvasWrap.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  updateOrthoFrustum();
  _needsRender = true;   // 强制下一帧重画 —— 修删除/折叠面板后的闪黑
}

// 全屏预览：只把 3D 区域 (#stage) 撑满视口；退出回到原布局
const stage = document.getElementById('stage');
const fsBtn = document.getElementById('btnFs');
function isFs() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function fsTarget() {
  // 各浏览器前缀 + 标准
  return (stage.requestFullscreen
    || stage.webkitRequestFullscreen
    || stage.mozRequestFullScreen
    || stage.msRequestFullscreen).bind(stage);
}
function fsExit() {
  const exit = document.exitFullscreen
    || document.webkitExitFullscreen
    || document.mozCancelFullScreen
    || document.msExitFullscreen;
  return exit.call(document);
}
function syncFsBtn() {
  if (!fsBtn) return;
  const on = isFs();
  fsBtn.classList.toggle('on', on);
  fsBtn.textContent = on ? '⤡' : '⤢';   // ⤢ 进入全屏 / ⤡ 退出全屏
  fsBtn.title = on ? '退出全屏' : '全屏预览此 3D 区域';
}
if (fsBtn) {
  fsBtn.addEventListener('click', async () => {
    try {
      if (isFs()) {
        await fsExit();
      } else {
        await fsTarget()();
      }
    } catch (e) {
      flash('该浏览器不支持全屏 API', 'warn', 1600);
    }
  });
}
['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(ev =>
  document.addEventListener(ev, () => { syncFsBtn(); requestAnimationFrame(fitCanvas); })
);
syncFsBtn();

const scene = new THREE.Scene();
// 浅冷灰底,贴合 spec_room3d_single 的整体调性 (0xeef1f5)
scene.background = new THREE.Color(0xeef1f5);

const pmrem = new THREE.PMREMGenerator(renderer);
// 环境光:RoomEnvironment addon 提供中性室内 IBL;roughness 0.04
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 100);
camera.position.set(6.5, 7.2, 8.5);

const ORTHO_VS = 10.5;
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 80);
orthoCam.up.set(0, 0, -1);   // 俯视时屏幕上方 = 北（-z），避免 lookAt 退化产生滚转
function updateOrthoFrustum() {
  // 2D 俯视时 canvas 被 display:none,clientWidth/Height 为 0 → 0/0=NaN
  // 会把视锥写坏(投影矩阵奇异,之后一切依赖相机的交互全部失灵),必须跳过
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  if (!w || !h) return;
  const a = w / h;
  orthoCam.left = -ORTHO_VS * a / 2; orthoCam.right = ORTHO_VS * a / 2;
  orthoCam.top = ORTHO_VS / 2; orthoCam.bottom = -ORTHO_VS / 2;
  orthoCam.updateProjectionMatrix();
}
updateOrthoFrustum();
let activeCam = camera;

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.4, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.5;
controls.maxDistance = 40;
controls.maxPolarAngle = 1.52;
controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: -1 }; // 左右键都由自定义代码接管,避免双发

// ============================================================
// 平滑 WASD 相机控制器 (借鉴 blueprint3d-babylon Hotkeys.js createSmoothCameraKeyboardController)
// 每帧累积速度,带加/减速;独立于 OS 键重复,避免抽筋式移动
// 3D 模式下驱动 camera + controls.target 沿前/右方向滑动;2D 模式下按 5% 视域步进平移
// ============================================================
const _camKeys = new Set(['w', 'a', 's', 'd']);
const CAM_MAX_SPEED = 5;
const CAM_ACCEL = 4.5;
const CAM_DECEL = 12;
const _camPressed = new Set();
const _camVel = { x: 0, z: 0 };
let _camFrameId = null;
let _camLastTs = null;
let _camHasMoved = false;

function _isTextInput(el) {
  return !!el && (
    el.tagName === 'INPUT' || el.tagName === 'SELECT' ||
    el.tagName === 'TEXTAREA' || el.isContentEditable
  );
}
function _camFrame(ts) {
  _camFrameId = null;
  // 只在 3D 视角驱动持续平滑移动
  if (activeCam !== camera) {
    _camPressed.clear(); _camVel.x = 0; _camVel.z = 0; _camLastTs = null; return;
  }
  const dt = _camLastTs == null ? 1 / 60 : Math.min(Math.max((ts - _camLastTs) / 1000, 0), 0.05);
  _camLastTs = ts;
  // 计算水平前向 (camera 看向 controls.target 的水平分量) 与右向量
  const fwd = new THREE.Vector3().subVectors(controls.target, camera.position);
  fwd.y = 0;
  if (fwd.lengthSq() > 1e-6) fwd.normalize();
  const rightX = -fwd.z, rightZ = fwd.x;
  let dx = 0, dz = 0;
  if (_camPressed.has('w')) { dx += fwd.x; dz += fwd.z; }
  if (_camPressed.has('s')) { dx -= fwd.x; dz -= fwd.z; }
  if (_camPressed.has('a')) { dx += rightX; dz += rightZ; }
  if (_camPressed.has('d')) { dx -= rightX; dz -= rightZ; }
  const dLen = Math.hypot(dx, dz);
  if (dLen > 1) { dx /= dLen; dz /= dLen; }
  dx *= CAM_MAX_SPEED; dz *= CAM_MAX_SPEED;
  // 加速 / 减速
  const dotV = _camVel.x * dx + _camVel.z * dz;
  const changingDir = dLen > 0 && dotV < 0;
  const acc = _camPressed.size > 0 && !changingDir ? CAM_ACCEL : CAM_DECEL;
  const chgX = dx - _camVel.x, chgZ = dz - _camVel.z;
  const chgL = Math.hypot(chgX, chgZ);
  const maxChg = acc * dt;
  if (chgL <= maxChg) { _camVel.x = dx; _camVel.z = dz; }
  else if (chgL > 0) { _camVel.x += (chgX / chgL) * maxChg; _camVel.z += (chgZ / chgL) * maxChg; }
  // 实际位移
  const moveX = _camVel.x * dt, moveZ = _camVel.z * dt;
  if (Math.abs(moveX) + Math.abs(moveZ) > 1e-6) {
    controls.target.x += moveX; controls.target.z += moveZ;
    camera.position.x += moveX; camera.position.z += moveZ;
    _camHasMoved = true;
  }
  const stillMoving = _camPressed.size > 0 || Math.hypot(_camVel.x, _camVel.z) > 0.01;
  if (stillMoving) _camFrameId = requestAnimationFrame(_camFrame);
  else { _camVel.x = 0; _camVel.z = 0; _camLastTs = null; }
}
function _camStart() { if (_camFrameId == null) _camFrameId = requestAnimationFrame(_camFrame); }
// 2D 模式: 步进式平移(每按一下 5% 视域);不做平滑插值
function _camPan2D(key) {
  // 计算当前可见的 X/Z 范围(从 orthoCam 推)
  const halfW = (orthoCam.right - orthoCam.left) / 2;
  const halfH = (orthoCam.top - orthoCam.bottom) / 2;
  const stepX = halfW * 0.1;
  const stepZ = halfH * 0.1;
  // SVG 2D 视图同步平移(viewBounds + svg 视口 px 步长)
  const svgStepX = (renderer.domElement.clientWidth  || 0) * 0.1;
  const svgStepY = (renderer.domElement.clientHeight || 0) * 0.1;
  if (key === 'w') {
    orthoCam.position.z -= stepZ; controls.target.z -= stepZ;
    if (topView && globalThis.render2dExports) render2dExports.panBy(0,  svgStepY);
  }
  if (key === 's') {
    orthoCam.position.z += stepZ; controls.target.z += stepZ;
    if (topView && globalThis.render2dExports) render2dExports.panBy(0, -svgStepY);
  }
  if (key === 'a') {
    orthoCam.position.x -= stepX; controls.target.x -= stepX;
    if (topView && globalThis.render2dExports) render2dExports.panBy( svgStepX, 0);
  }
  if (key === 'd') {
    orthoCam.position.x += stepX; controls.target.x += stepX;
    if (topView && globalThis.render2dExports) render2dExports.panBy(-svgStepX, 0);
  }
  orthoCam.updateMatrixWorld();
  _camHasMoved = true;
}

// ============================================================
// 灯光 / 地面 / 网格
// 参考 spec_room3d_single.html 的"室内建筑可视化"光照组合:
//   - 半球光 (天蓝 + 冷地) 强度低,只补暗部,不抢主光
//   - 主光:暖色 DirectionalLight (0xfff6ea) 模拟阳光从窗外斜照进来
//   - 副光:冷色 DirectionalLight 强度低,模拟另一侧的散射
// ============================================================
scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa4b0, 0.10));
const keyLight = new THREE.DirectionalLight(0xfff6ea, 2.35);
keyLight.position.set(4, 9, 5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
Object.assign(keyLight.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 30 });
keyLight.shadow.bias = -0.0004; keyLight.shadow.normalBias = 0.02;
keyLight.shadow.camera.updateProjectionMatrix();
scene.add(keyLight);
scene.add(new THREE.DirectionalLight(0xdce8f6, 0.30).translateX(-5).translateY(6).translateZ(-4));

const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0xe2e7eb, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.002;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(24, 48, 0x9fb0be, 0xcdd6dd);
grid.position.y = 0.001;
grid.material.transparent = true; grid.material.opacity = 0.4;
grid.material.depthWrite = false;        // 关闭深度写入:网格永远在物体之下
scene.add(grid);

// ============================================================
// 材质
// ============================================================
const M = {
  // 暖灰墙(spec_room3d_single 同款 0xe6e1d8):压住 envMapIntensity,
  // 让 IBL 只做补光不填平阴影,墙面就有"灰泥质感"而不是苍白塑料感
  wall: new THREE.MeshStandardMaterial({ color: 0xe6e1d8, roughness: 0.92, metalness: 0, envMapIntensity: 0.50 }),
  wallSel: new THREE.MeshStandardMaterial({ color: 0xffd54a, roughness: 0.7, emissive: 0x553300, emissiveIntensity: 0.4 }),
  wallHover: new THREE.MeshStandardMaterial({ color: 0xc3d9f2, roughness: 0.85 }),
  wallTarget: new THREE.MeshStandardMaterial({ color: 0xd8ecd8, roughness: 0.85 }),
  doorLeaf: new THREE.MeshStandardMaterial({ color: 0xcbb494, roughness: 0.55 }),
  frame: new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.5, metalness: 0.5 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0xcfe6f2, transparent: true, opacity: 0.22, roughness: 0.05, side: THREE.DoubleSide }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.55 }),
  metal: new THREE.MeshStandardMaterial({ color: 0xd9dbde, metalness: 0.85, roughness: 0.28 }),
  arc: new THREE.MeshBasicMaterial({ color: 0x5a7fb0, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
  preview: new THREE.MeshBasicMaterial({ color: 0x2b50d8, transparent: true, opacity: 0.45 }),
  ghost: new THREE.MeshBasicMaterial({ color: 0x2b8a50, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false }),
  fabric: new THREE.MeshStandardMaterial({ color: 0x8fa8bf, roughness: 0.85 }),
  wood: new THREE.MeshStandardMaterial({ color: 0xd8c7a8, roughness: 0.7 }),
  bedFrame: new THREE.MeshStandardMaterial({ color: 0xd9d2c5, roughness: 0.6 }),
  mattress: new THREE.MeshStandardMaterial({ color: 0xf7f9fa, roughness: 0.8 }),
  headboard: new THREE.MeshStandardMaterial({ color: 0xb9a98e, roughness: 0.65 }),
  wardrobe: new THREE.MeshStandardMaterial({ color: 0xd6cbb8, roughness: 0.6 }),
  counter: new THREE.MeshStandardMaterial({ color: 0xe9e5de, roughness: 0.4 }),
  sheet: new THREE.MeshStandardMaterial({ color: 0x9fc3d8, roughness: 0.85 }),
  floorSlab: new THREE.MeshStandardMaterial({ color: 0xdcd6cc, roughness: 0.75 }),
  white: new THREE.MeshStandardMaterial({ color: 0xf7f9fa, roughness: 0.6 }),
  gray: new THREE.MeshStandardMaterial({ color: 0x9aa1ab, roughness: 0.55 }),
  handle: new THREE.MeshBasicMaterial({ color: 0xff8800 }),
  stairTread: new THREE.MeshStandardMaterial({ color: 0xd6c8a8, roughness: 0.6 }),
  stairRiser: new THREE.MeshStandardMaterial({ color: 0xb8a888, roughness: 0.7 }),
  stairRail: new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.45, metalness: 0.6 }),
  // 医疗场景专用材质
  medBlue: new THREE.MeshStandardMaterial({ color: 0x3a7bd5, roughness: 0.45 }),
  medGreen: new THREE.MeshStandardMaterial({ color: 0x58a55c, roughness: 0.5 }),
  medRed: new THREE.MeshStandardMaterial({ color: 0xd64541, roughness: 0.5 }),
  medYellow: new THREE.MeshStandardMaterial({ color: 0xf5c542, roughness: 0.45 }),
};
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const rbox = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, 3, r);
const $ = id => document.getElementById(id);

// 13 种材质预设（名称 / 颜色 / 粗糙度）
const PRESETS = [
  { n: '白乳胶漆', c: '#f5f5f0', r: 0.9 },
  { n: '象牙白',   c: '#f0ead6', r: 0.85 },
  { n: '暖米色',   c: '#e8dcc0', r: 0.9 },
  { n: '浅灰水泥', c: '#c8c8c4', r: 0.95 },
  { n: '深灰水泥', c: '#8a8a88', r: 0.95 },
  { n: '原木色',   c: '#c8a06a', r: 0.7 },
  { n: '胡桃木',   c: '#7a5230', r: 0.65 },
  { n: '红砖',     c: '#a0522d', r: 0.9 },
  { n: '青砖',     c: '#6d8a96', r: 0.9 },
  { n: '白大理石', c: '#eeeeea', r: 0.25 },
  { n: '花岗岩灰', c: '#9a9a9a', r: 0.35 },
  { n: '蓝灰瓷砖', c: '#9fb6c9', r: 0.3 },
  { n: '墨绿墙裙', c: '#3d5a4c', r: 0.6 },
];

// 门样式枚举（op.kind）
const DOOR_STYLES = [
  { k: 'single',  n: '单开门',   icon: '🚪' },
  { k: 'double',  n: '双开门',   icon: '🚪' },
  { k: 'sliding', n: '推拉门',   icon: '▭' },
  { k: 'folding', n: '折叠门',   icon: '⇆' },
  { k: 'elevator', n: '电梯门',  icon: '⊟' },
  // 拱形门/玻璃门已下线;旧数据在 normDoc 里迁移为单开门
];

// 窗样式枚举
const WIN_STYLES = [
  { k: 'single',   n: '单扇窗',   icon: '◻' },
  { k: 'double',   n: '双扇窗',   icon: '◫' },
  { k: 'sliding',  n: '推拉窗',   icon: '◧' },
  { k: 'casement', n: '平开窗',   icon: '◰' },
  { k: 'fixed',    n: '固定窗',   icon: '■' },
  // 拱形窗已下线;旧数据在 normDoc 里迁移为单扇窗
];

// 拱形门窗已下线:ARCH_SHAPES / _archArc / _archUnitVerts / _addShapeFrame 已随功能一并移除

// 门扇/窗框颜色预设（5 色）
const LEAF_PRESETS = [
  { n: '原木',     c: '#c8a06a' },
  { n: '胡桃木',   c: '#7a5230' },
  { n: '白',       c: '#f0ead6' },
  { n: '深灰',     c: '#5a5a58' },
  { n: '黑色',     c: '#2c2c2c' },
];

// 玻璃颜色预设
const GLASS_PRESETS = [
  { n: '透明',     c: '#cfe6f2' },
  { n: '蓝灰',     c: '#9fb6c9' },
  { n: '茶色',     c: '#b89876' },
  { n: '墨绿',     c: '#5d7a6e' },
  { n: '灰',       c: '#9a9a9a' },
];
const texCache = new Map();

// ── 程序化纹理：木纹 / 格子 ──
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function mixRgb(a, b, t) {
  return { r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) };
}
function rgbCss(c, a = 1) { return a < 1 ? `rgba(${c.r},${c.g},${c.b},${a})` : `rgb(${c.r},${c.g},${c.b})`; }

// 木纹：稀疏竖纹 + 偶发色斑（不要节疤黑点，节奏更舒展）
function drawWood(ctx, w, h, base, dark) {
  const bg = hexToRgb(base), dk = hexToRgb(dark);
  // 底色
  ctx.fillStyle = rgbCss(bg);
  ctx.fillRect(0, 0, w, h);
  // 主纹理竖纹（稀疏：每 3px 一根，幅度更低）
  for (let x = 0; x < w; x += 3) {
    const t = (Math.sin(x * 0.45) + Math.sin(x * 0.18 + 1.7)) * 0.5;
    const a = 0.04 + Math.abs(t) * 0.08;
    ctx.fillStyle = rgbCss(dk, a);
    ctx.fillRect(x, 0, 1, h);
  }
  // 大尺度色斑（数量更少、幅度更弱）
  for (let i = 0; i < 3; i++) {
    const cx = (i * 137 + 23) % w;
    const cw = 50 + (i * 41) % 60;
    const grad = ctx.createLinearGradient(cx, 0, cx + cw, 0);
    grad.addColorStop(0, rgbCss(dk, 0));
    grad.addColorStop(0.5, rgbCss(dk, 0.10));
    grad.addColorStop(1, rgbCss(dk, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(cx, 0, cw, h);
  }
  // 浅色宽带（亮木纹年轮方向）
  for (let i = 0; i < 2; i++) {
    const cx = (i * 197 + 71) % w;
    const cw = 80 + (i * 53) % 70;
    const grad = ctx.createLinearGradient(cx, 0, cx + cw, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx, 0, cw, h);
  }
}

// 格子：大格 + 浅灰线 + 角点（线条是独立浅灰，不依赖底色）
function drawGrid(ctx, w, h, base, line, accent) {
  const bg = hexToRgb(base), ln = hexToRgb(line), ac = hexToRgb(accent || line);
  ctx.fillStyle = rgbCss(bg);
  ctx.fillRect(0, 0, w, h);
  // 大格：2×2，每格 w/2 × h/2
  const cw = w / 2, ch = h / 2;
  // 描边：浅灰固定色 + 中等 alpha（白底上能看到、彩色底也保持中性）
  ctx.strokeStyle = rgbCss(ln, 0.85);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cw, 4); ctx.lineTo(cw, h - 4);
  ctx.moveTo(4, ch); ctx.lineTo(w - 4, ch);
  ctx.stroke();
  // 外框
  ctx.strokeStyle = rgbCss(ln, 0.55);
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, w - 4, h - 4);
  // 角点小色
  ctx.fillStyle = rgbCss(ac, 0.50);
  for (const [x, y] of [[8, 8], [w - 8, 8], [8, h - 8], [w - 8, h - 8]]) {
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
  }
}

// 地面格子（瓦片/瓷砖）：大方格 + 浅缝
function drawTile(ctx, w, h, base, grout) {
  const bg = hexToRgb(base), gr = hexToRgb(grout);
  ctx.fillStyle = rgbCss(gr);
  ctx.fillRect(0, 0, w, h);
  // 2×2 瓷砖（中间留浅缝）
  const cellW = w / 2, cellH = h / 2, gap = 5;
  ctx.fillStyle = rgbCss(bg);
  ctx.fillRect(gap, gap, cellW - gap * 1.5, cellH - gap * 1.5);
  ctx.fillRect(cellW + gap * 0.5, gap, cellW - gap * 1.5, cellH - gap * 1.5);
  ctx.fillRect(gap, cellH + gap * 0.5, cellW - gap * 1.5, cellH - gap * 1.5);
  ctx.fillRect(cellW + gap * 0.5, cellH + gap * 0.5, cellW - gap * 1.5, cellH - gap * 1.5);
  // 每片瓷砖加微高光（左上到右下，幅度更低）
  for (const [x, y] of [[gap, gap], [cellW + gap * 0.5, gap], [gap, cellH + gap * 0.5], [cellW + gap * 0.5, cellH + gap * 0.5]]) {
    const grad = ctx.createLinearGradient(x, y, x + cellW, y + cellH);
    grad.addColorStop(0, 'rgba(255,255,255,0.10)');
    grad.addColorStop(1, 'rgba(0,0,0,0.04)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, cellW - gap * 1.5, cellH - gap * 1.5);
  }
}

function getTex(kind, baseHex) {
  const key = kind + '|' + (baseHex || '#cccccc');
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const b = baseHex || '#c8a06a';
  if (kind === 'wood') {
    // 默认木纹：浅底 + 棕色纹（无节疤黑点、节奏更舒展）
    drawWood(ctx, 256, 256, b, darken(b, 0.22));
  } else if (kind === 'grid') {
    // 默认格子：底色 + 浅灰线（不与底色耦合）
    drawGrid(ctx, 256, 256, b, '#b8bcc2', lighten(b, 0.10));
  } else if (kind === 'tile') {
    // 瓷砖缝：浅灰，独立于底色
    drawTile(ctx, 256, 256, b, '#c2c5cb');
  } else {
    ctx.fillStyle = b; ctx.fillRect(0, 0, 256, 256);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, tex);
  return tex;
}
function darken(hex, t) { const c = hexToRgb(hex); return rgbCss(mixRgb(c, { r: 0, g: 0, b: 0 }, t)); }
function lighten(hex, t) { const c = hexToRgb(hex); return rgbCss(mixRgb(c, { r: 255, g: 255, b: 255 }, t)); }

// 纹理选项（用于面板按钮组）
// 统一纹理选项（墙/地面/门窗门扇共用同一套生成器 & 同一组样式）
const TEX_OPTIONS = [
  { k: '',      n: '无',     icon: '·' },
  { k: 'wood',  n: '木纹',   icon: '▥' },
  { k: 'grid',  n: '格子',   icon: '▦' },
  { k: 'tile',  n: '瓷砖',   icon: '◫' },
];

// 三个内置主题(出厂模板,用户可编辑生成「我的版本」,支持恢复出厂):
// 每个主题 = 4 类对象(墙/地/门/窗)的默认色 + 纹理组合
// 简洁 = 白墙米地无纹理;木纹 = 原木色墙 + 胡桃木地 + 木纹纹理;格子 = 浅灰水泥墙 + 青砖地 + 格子纹理
const THEMES_BUILTIN = {
  simple: {
    n: '简洁', icon: '◯', builtIn: true,
    desc: '暖灰墙 + 米色地 + 无纹理,清爽百搭(spec 同款)',
    wall:   { base: '#e6e1d8', tex: '' },
    floor:  { color: '#e8dcc0', tex: '' },
    door:   { leafColor: '#e6e1d8', leafTex: '', glassColor: 'default' },
    window: { leafColor: '#e6e1d8', leafTex: '', glassColor: 'default' },
  },
  wood: {
    n: '木纹', icon: '▥', builtIn: true,
    desc: '原木色墙 + 胡桃木地 + 木纹,自然温暖',
    wall:   { base: '#c8a06a', tex: 'wood' },
    floor:  { color: '#7a5230', tex: 'wood' },
    door:   { leafColor: '#7a5230', leafTex: 'wood', glassColor: 'default' },
    window: { leafColor: '#7a5230', leafTex: 'wood', glassColor: 'default' },
  },
  grid: {
    n: '格子', icon: '▦', builtIn: true,
    desc: '浅灰水泥墙 + 青砖地 + 格子,工业复古',
    wall:   { base: '#c8c8c4', tex: 'grid' },
    floor:  { color: '#6d8a96', tex: 'grid' },
    door:   { leafColor: '#5a5a58', leafTex: '', glassColor: 'default' },
    window: { leafColor: '#5a5a58', leafTex: '', glassColor: 'default' },
  },
};

// 运行时主题字典: 内置 3 个 + localStorage 里的自定义主题 + 内置主题的「我的版本」覆盖
// 修改入口: themeSave / themeDelete / themeImport / themeReset
const THEMES = {};
function _loadCustomThemes() {
  let raw = null;
  try { raw = localStorage.getItem('tp3d_custom_themes'); } catch (e) {}
  if (!raw) return;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [k, t] of Object.entries(obj)) {
        if (t && typeof t === 'object' && t.n) {
          t.builtIn = false;
          THEMES[k] = t;
        }
      }
    }
  } catch (e) { /* 损坏数据静默忽略 */ }
}
// 加载内置主题的「我的版本」覆盖(用户在 simple/wood/grid 上改色后保存)
// 在 _ensureThemseBoot 中于内置模板塞入之后再调用,实现「用户版本覆盖出厂」
function _loadBuiltinOverrides() {
  let raw = null;
  try { raw = localStorage.getItem('tp3d_theme_overrides'); } catch (e) {}
  if (!raw) return;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [k, t] of Object.entries(obj)) {
        // 只对内置 key 生效;其它 key 一律忽略(防止旧版本污染)
        if (!THEMES_BUILTIN[k]) continue;
        if (!t || typeof t !== 'object' || !t.n) continue;
        // 保留 builtIn: true,只覆盖字段
        THEMES[k] = { ...THEMES[k], ...t, builtIn: true, override: true };
      }
    }
  } catch (e) { /* 损坏数据静默忽略 */ }
}
function _saveCustomThemes() {
  const out = {};
  for (const [k, t] of Object.entries(THEMES)) {
    if (!t.builtIn) out[k] = t;
  }
  try { localStorage.setItem('tp3d_custom_themes', JSON.stringify(out)); } catch (e) { /* 容量满静默 */ }
}
function _saveBuiltinOverrides() {
  const out = {};
  for (const [k, t] of Object.entries(THEMES)) {
    if (t.builtIn && t.override) out[k] = t;
  }
  try { localStorage.setItem('tp3d_theme_overrides', JSON.stringify(out)); } catch (e) { /* 容量满静默 */ }
}
function _ensureThemseBoot() {
  // 合并内置(每次启动刷新一次,内置对象不能被外部改)
  for (const [k, t] of Object.entries(THEMES_BUILTIN)) {
    THEMES[k] = JSON.parse(JSON.stringify(t));
  }
  _loadCustomThemes();
  _loadBuiltinOverrides();
}
_ensureThemseBoot();
// 暴露 boot 完成标志,便于 E2E 测试等待主题加载完成
if (typeof window !== 'undefined') window.__themeBootDone = true;

// 当前主题(默认 'simple',与历史 doc 的 baseline 视觉最接近)。
// 主题是用户偏好,不进 doc JSON;只走 localStorage。
let THEME = (() => {
  try { return localStorage.getItem('tp3d_theme') || 'simple'; } catch (e) { return 'simple'; }
})();
function themeCur() { return THEMES[THEME] || THEMES_BUILTIN.simple; }
function themeApply(key, opts) {
  // 兜底: key 不存在或当前 THEME 已不在字典里 → 切到 simple
  if (!THEMES[key]) key = 'simple';
  if (!THEMES[key]) return; // 极端情况: simple 也没了
  if (key === THEME) return; // 已经是这个主题,无变化
  THEME = key;
  try { localStorage.setItem('tp3d_theme', THEME); } catch (e) {}
  // 把新主题默认值回填到所有现有对象(墙/门/窗/地面),让画布立即变主题
  // 「主题切换」= 用新主题的整套色+纹理覆盖现有对象;
  // 用户在 inspector 改色/纹理属于「自定义」(切回主题时也会被新主题覆盖,这正是主题语义)
  const t = THEMES[THEME];
  for (const w of (doc.walls || [])) {
    // 玻璃墙:主题切换不改变其玻璃外观(始终是同一块磨砂半透面板)
    if (w.glass) { continue; }
    w.wallBase = t.wall.base;
    w.wallTex = t.wall.tex || undefined;
    for (const op of (w.openings || [])) {
      if (op.type === 'door') {
        op.leafColor = t.door.leafColor;
        op.leafTex = t.door.leafTex || undefined;
      } else if (op.type === 'window') {
        op.leafColor = t.window.leafColor;
        op.leafTex = t.window.leafTex || undefined;
      }
    }
  }
  for (const f of (doc.floors || [])) {
    f.color = t.floor.color;
    f.tex = t.floor.tex || undefined;
  }
  rebuild(); refreshProps();
  if (typeof renderThemePanel === 'function') renderThemePanel();
  flash(`已切换主题: ${THEMES[THEME].n}`);
}

// 把 baseMat 派生一份带 map 的新材质；tex 空时直接返回 baseMat 自身（共享）。
// repeat = [u, v]，用于设置纹理的 repeat。
// baseHex 缺省取 baseMat.color；显式传则覆盖。
function applyMatVariant(baseMat, tex, baseHex, repeat) {
  // 无纹理时:显式传了基色且与母材质不同 → 派生纯色材质(同样走缓存);
  // 否则共享母材质(墙基色 = 默认色时不浪费克隆)
  if (!tex) {
    if (!baseHex) return baseMat;
    const defHex = '#' + baseMat.color.getHexString();
    if (String(baseHex).toLowerCase() === defHex.toLowerCase()) return baseMat;
    const plainKey = `plain|${baseHex}|${baseMat.uuid}`;
    const plainCached = _wallMatCache.get(plainKey);
    if (plainCached && !plainCached.__disposed) return plainCached;
    const pm = baseMat.clone();
    pm.color.set(baseHex);
    pm.needsUpdate = true;
    pm.__matCacheKey = plainKey;
    _wallMatCache.set(plainKey, pm);
    return pm;
  }
  const hex = baseHex || '#' + baseMat.color.getHexString();
  // 借鉴 blueprint3d 的 descriptor-keyed material cache:
  // 同样 tex+hex+repeat 复用同一个 MeshStandardMaterial,避免 30 墙×N 重建 = 30N 个 GC-able 克隆
  const repU = repeat ? (repeat[0] || 1) : 1;
  const repV = repeat ? (repeat[1] || 1) : 1;
  const cacheKey = `${tex}|${hex}|${repU}|${repV}|${baseMat.uuid}`;
  const cached = _wallMatCache.get(cacheKey);
  if (cached && !cached.__disposed) return cached;
  const m = baseMat.clone();
  // 克隆后基色强制用 hex（保证 texture 与底色一致）
  m.color.set(hex);
  const t = getTex(tex, hex);
  if (repeat) { t.repeat.set(repU, repV); t.needsUpdate = true; }
  m.map = t;
  // map 启用后材质需要重新计算：roughness 略微降低让纹理可见
  if (m.roughness != null && m.roughness > 0.85) m.roughness = 0.75;
  m.needsUpdate = true;
  m.__matCacheKey = cacheKey;
  _wallMatCache.set(cacheKey, m);
  return m;
}

// 生成统一纹理选择条 HTML（data-attr 由 fieldName 决定）
function renderTexPickerHTML(fieldName, current) {
  const attr = 'data-' + fieldName.toLowerCase();
  return TEX_OPTIONS.map(t => {
    const on = (current || '') === t.k ? ' on' : '';
    return `<button class="styleBtn${on}" ${attr}="${t.k}">${t.icon} ${t.n}</button>`;
  }).join('');
}

// 绑定统一纹理选择条点击事件：把 data-attr 值写到 obj[fieldName]
function bindTexPickers(parentEl, obj, fieldName, onChange) {
  parentEl.querySelectorAll(`[data-${fieldName.toLowerCase()}]`).forEach(b => {
    b.onclick = () => {
      const v = b.dataset[fieldName.toLowerCase()];
      if (v) obj[fieldName] = v; else delete obj[fieldName];
      if (onChange) onChange();
    };
  });
}

// ============================================================
// 文档模型
// ============================================================
let doc = null;
Object.defineProperty(globalThis, 'doc', { get() { return doc; }, configurable: true });
let sel = null;                       // {kind:'wall'|'door'|'window', wi, oi}
let _isHidden = () => false;          // 大纲树隐藏标记：rebuild3D 中每帧重写
let _furnSearch = '';                 // 家具库搜索词（不丢光标）
let _furnSearchComposing = false;     // IME 组合输入中（中文输入法打字时）
// 暴露到全局方便调试 / 自动化测试（无副作用）
let _selMirror = null;
Object.defineProperty(globalThis, 'sel', {
  get() { return _selMirror; },
  set(v) { _selMirror = v; sel = v; },
  configurable: true,
});

// ── 多选选择模型 ─────────────────────────────────────────────
// sel 是唯一真源，不引入第二个数组：0 项 = null，1 项 = 原有单对象形状，
// ≥2 项 = {kind:'multi', items:[...]}。这样现有约 40 处 `sel = {kind:'wall', wi}`
// 写入点全部不用改，单选的既有行为零回归。
function _selList() {
  if (!sel) return [];
  return sel.kind === 'multi' ? sel.items : [sel];
}
// 用于去重的稳定键；门窗归一到同一个键空间
function _selKey(s) {
  if (!s) return '';
  if (s.kind === 'wall') return 'wall:' + s.wi;
  if (s.kind === 'floor') return 'floor:' + s.fi;
  if (s.kind === 'furniture') return 'furniture:' + s.fi;
  if (s.kind === 'door' || s.kind === 'window' || s.kind === 'opening') return 'open:' + s.wi + ':' + s.oi;
  return '';
}
function _setSelItems(items) {
  const uniq = [], seen = new Set();
  for (const it of items || []) {
    const k = _selKey(it);
    if (!k || seen.has(k)) continue;
    seen.add(k); uniq.push(it);
  }
  sel = uniq.length === 0 ? null : (uniq.length === 1 ? uniq[0] : { kind: 'multi', items: uniq });
  _selMirror = sel;
}
// Shift 点击：在集合里则移出，不在则加入
function _selToggle(item) {
  const k = _selKey(item);
  const list = _selList();
  const has = list.some(s => _selKey(s) === k);
  _setSelItems(has ? list.filter(s => _selKey(s) !== k) : [...list, item]);
}
// 高亮 / 大纲用。kind ∈ 'wall'|'floor'|'furniture'|'opening'，idx = wi 或 fi
function _selHas(kind, idx) {
  return _selList().some(s => {
    if (kind === 'wall') return s.kind === 'wall' && s.wi === idx;
    if (kind === 'floor') return s.kind === 'floor' && s.fi === idx;
    if (kind === 'furniture') return s.kind === 'furniture' && s.fi === idx;
    if (kind === 'stairs') return s.kind === 'stairs' && s.si === idx;
    if (kind === 'opening') return (s.kind === 'door' || s.kind === 'window' || s.kind === 'opening') && s.wi === idx;
    return false;
  });
}
// 点中已分组对象 → 展开成同组全部成员（标准行为：单击选中整组）
function _expandGroupSel(item) {
  const kind = item.kind;
  const arr = kind === 'wall' ? doc.walls : kind === 'floor' ? doc.floors
            : kind === 'furniture' ? doc.furniture : null;
  const idx = kind === 'wall' ? item.wi : item.fi;
  const o = arr && arr[idx];
  if (!o || !o.gid) return [item];
  const out = [];
  doc.walls.forEach((w, i) => { if (w.gid === o.gid) out.push({ kind: 'wall', wi: i }); });
  doc.floors.forEach((f, i) => { if (f.gid === o.gid) out.push({ kind: 'floor', fi: i }); });
  doc.furniture.forEach((f, i) => { if (f.gid === o.gid) out.push({ kind: 'furniture', fi: i }); });
  return out.length ? out : [item];
}
function _exposeE2E() {
  globalThis.refreshProps = refreshProps;
  globalThis.rebuild = rebuild;
  globalThis.__sel = (v) => { sel = v; _selMirror = v; refreshProps(); };
  globalThis._selList = _selList;               // 多选集合（测试用）
  globalThis._setSelItems = _setSelItems;       // 直接设置多选（测试用）
  globalThis._selHas = _selHas;
  globalThis.ctxDelete = ctxDelete;             // 测试用:模拟右键菜单 / 选中删除
  globalThis.deleteSelection = deleteSelection; // 测试用:多选删除
  globalThis.FURN = FURN;
  globalThis.furnRot = () => furnRot;
  globalThis.activeLv = () => activeLv;
  globalThis.stairGroups = stairGroups;
  Object.defineProperty(globalThis, 'wallGroups', { get() { return wallGroups; }, configurable: true });
  Object.defineProperty(globalThis, 'furnitureGroups', { get() { return furnitureGroups; }, configurable: true });
globalThis.snapFurn = snapFurn;       // 暴露吸附函数给 e2e
  globalThis.nearestWall = nearestWall; // 暴露最近墙查询给 e2e
  globalThis.tool_get = () => tool;   // 测试用:获取当前 tool
  globalThis.tool_set = (t) => tool = t; // 测试用:设置 tool
  globalThis.buildHandles = buildHandles; // 暴露 handle 重建给 e2e
  globalThis.handlesGroup = handlesGroup;
  globalThis.scene = scene;             // 暴露 scene 给 e2e
  globalThis.renderer = renderer;       // 暴露 renderer 给 e2e / perf 监控
  globalThis.THREE = THREE;             // 测试用：让 page.evaluate 能 new THREE.*
  globalThis.drag = () => drag;         // 暴露 drag 状态 getter
  globalThis.drag_set = (v) => { drag = v; };  // 仅供测试/内部调用
  // 注意:globalThis.sel 已在 845 行通过 defineProperty 暴露(getter 返回 _selMirror,
  // setter 同步给 sel)。这里不能再赋一次,否则会触发 setter 把 ()=>sel 写入 sel 自身
  globalThis._camPressed = _camPressed; // 暴露 WASD 控制器内部状态
  globalThis._camVel = _camVel;
  globalThis._camFrameId_get = () => _camFrameId;
  globalThis._camPan2D = _camPan2D;     // 暴露 2D 步进平移给 e2e
  globalThis.orthoCam = orthoCam;       // 暴露 2D 相机给 e2e
  globalThis.camera = camera;           // 暴露 3D 相机给 e2e
  globalThis.controls = controls;       // 暴露 OrbitControls 给 e2e
  globalThis.ctxDuplicate = ctxDuplicate; // 暴露复制函数给 e2e
  globalThis._ensureDragPreviewGroup = _ensureDragPreviewGroup;
  globalThis._pickAt = pickAt;          // 暴露拾取给 e2e（传 {clientX, clientY} 即可）
  globalThis._idbPut = idbPut;          // 测试用:直接写 IndexedDB(种文件快照)
  Object.defineProperty(globalThis, 'filesIndex', { get() { return filesIndex; }, configurable: true }); // 测试用
  globalThis._snapGet = snapGet;        // 测试用:读文件快照
  globalThis._pickMeshCount = () => pickMeshes.length;
  globalThis._glbCacheHas = (k) => _glbCache.has(k);          // 测试用：模型字节是否已就绪
  globalThis._furnGroupChildren = (fi) => furnitureGroups[fi] ? furnitureGroups[fi].children.length : -1;
  globalThis.furnProto = furnProto;                            // 测试用：原生家具 InstancedMesh parts 缓存
  globalThis.furnInstanced = furnInstanced;                    // 测试用：[type] → [InstancedMesh, ...]
  globalThis.furnBBox = furnBBox;                              // 测试用：type → {center, size}
  Object.defineProperty(globalThis, 'pickMeshes', { get() { return pickMeshes; }, configurable: true }); // 测试用：pick 候选 mesh 数组(随 rebuild 重新指向)
  globalThis.planGroup = planGroup;                            // 测试用：场景根 group
  globalThis._furnDummy = _furnDummy;                          // 测试用：scratch Object3D
  globalThis._furnMat = _furnMat;                              // 测试用：scratch Matrix4
  globalThis._furnZero = _furnZero;                            // 测试用：scratch zero-scale Matrix4
  globalThis.importModelFile = importModelFile;               // 测试用：跳过文件选择器直接导入
  globalThis.importPlanFromAI = importPlanFromAI;             // 测试用：直接喂 AI JSON
  globalThis._aiCallClaude = _aiCallClaude;                   // 测试用：流式调 API(SSE 解析)
  globalThis._extractDemoData = _extractDemoData;             // 测试用：无 PLAN 的 demo 扫描
  globalThis._demoDataToPlan = _demoDataToPlan;               // 测试用：demo 数据 → plan
  globalThis._extractJsCode = _extractJsCode;                 // 测试用：AI 兜底前的 JS 抽取
  globalThis.assetDel = assetDel;                             // 测试用：删除模型字节
  globalThis.assetGet = assetGet;
  globalThis.setAssetDirHandle = setAssetDirHandle;           // 测试用：注入目录句柄
  globalThis.getAssetDirHandle = getAssetDirHandle;
  globalThis.clearAssetDirHandle = clearAssetDirHandle;
  globalThis._writeAssetToDisk = _writeAssetToDisk;
  globalThis._readAssetFromDisk = _readAssetFromDisk;
  globalThis._deleteAssetFromDisk = _deleteAssetFromDisk;
  globalThis._loadCustomAssetBytes = _loadCustomAssetBytes;
  globalThis._glbCacheClearKey = (k) => _glbCache.delete(k);  // 测试用:让 _loadCustomAssetBytes 重新走路径
  globalThis.DIR_PICKER_SUPPORT = DIR_PICKER_SUPPORT;
  globalThis.saveDocAs = saveDocAs;             // 测试用:触发另存为
  globalThis.saveDoc = saveDoc;                 // 测试用
  globalThis.currentHandle = () => currentHandle;
  globalThis._writeCurrentToHandle = _writeCurrentToHandle;
  globalThis.chainNextPoint = chainNextPoint;   // 暴露墙链下一步纯函数给 e2e
  globalThis.snapToEndpoints = snapToEndpoints; // 暴露端点吸附给 e2e
  globalThis.orthoLock = () => orthoLock;       // 读取当前正交开关
  globalThis.setOrthoLock = (v) => { orthoLock = !!v; };  // 直接设置正交开关(测试用)
  globalThis.shiftDown = () => shiftDown;       // 读取 Shift 状态

  // ── render2d.js (SVG 2D 渲染) 桥接 ───────────────────────────────
  // render2d.js 用 ES module 加载,导出 initRender2D/on/renderPlan 等
  // 这里把 init 函数挂到 globalThis,setView('2d') 时调用
  function _syncSelToSvg() {
    if (typeof render2dExports === 'undefined') return;
    let s = null;
    if (sel && sel.kind === 'wall') s = { kind: 'wall', i: sel.wi };
    else if (sel && sel.kind === 'floor') s = { kind: 'floor', i: sel.fi };
    else if (sel && sel.kind === 'furn') s = { kind: 'furn', i: sel.fi };
    else if (sel && (sel.kind === 'opening' || sel.kind === 'door' || sel.kind === 'window'))
      s = { kind: 'opening', i: sel.wi, sub: sel.oi };
    render2dExports.setSelection(s);
  }

  globalThis.render2dInit = () => {
    const svg = document.getElementById('svg2d');
    if (!svg || typeof initRender2D === 'undefined') return;
    initRender2D({ svg, doc, palette: null });
    // 把视图尺寸同步给 SVG。注意 canvasWrap 在 2D 下 display:none,
    // getBoundingClientRect 会给 0×0 → 用 stage 或者 window 兜底
    const stage = document.getElementById('stage');
    let vw = 0, vh = 0;
    if (stage) {
      const r = stage.getBoundingClientRect();
      vw = r.width; vh = r.height;
    }
    if (!vw || !vh) { vw = window.innerWidth; vh = window.innerHeight; }
    render2dExports.setViewport(vw, vh);
    // 鼠标移动: 显示坐标
    render2dExports.on('pointermove', ({ world, screen, target }) => {
      coordsEl.textContent = `x ${world.x.toFixed(2)}  z ${world.z.toFixed(2)} m`;
    });
    // 拾取: 走 main.js 的 sel 路径(选墙/地/家具/门窗都走同一条)
    render2dExports.on('pick', (target, e) => {
      if (!target) return;
      if (tool === 'pan') return;   // 移动画布模式:不选中任何对象
      const item =
        target.kind === 'wall'     ? { kind: 'wall',     wi: target.wi }
      : target.kind === 'floor'    ? { kind: 'floor',    fi: target.fi }
      : target.kind === 'furn'     ? { kind: 'furniture',fi: target.fi }
      : target.kind === 'opening'  ? { kind: 'opening',  wi: target.wi, oi: target.oi }
      : target.kind === 'stairs'   ? { kind: 'stairs',   si: target.si }
      : null;
      if (!item) return;
      // Shift 点击 = 多选切换
      if (e.shiftKey && typeof _selToggle === 'function') {
        _selToggle(item);
      } else {
        sel = item;
        _selMirror = item;
      }
      rebuild(); refreshProps();
    });
    // ── 移动画布模式(2D 俯视):SVG 层接管左键拖动平移 ──
    // 2D 模式下 canvas 被 display:none,事件全部落在 #svg2d 上,
    // 所以 pan 工具要在这里接(3D 的 pan 走 canvas pointerdown 的 lPan 分支)
    let _svgPan = null;   // {x, y} 屏幕像素
    render2dExports.on('pointerdown', ({ screen }, e) => {
      if (tool !== 'pan' || e.button !== 0) return;
      _svgPan = { x: screen.x, y: screen.y };
      render2dExports.beginPan();
      const el = document.getElementById('svg2d');
      if (el) el.style.cursor = 'grabbing';
    });
    render2dExports.on('pointermove', ({ screen }) => {
      if (!_svgPan) return;
      const dx = screen.x - _svgPan.x, dy = screen.y - _svgPan.y;
      _svgPan.x = screen.x; _svgPan.y = screen.y;
      render2dExports.panByFast(dx, dy);
      // orthoCam 同步平移(俯视下 groundPoint/工具定位依赖相机),方向与 panBy 一致(抓纸式)
      // 注意:canvas 在 2D 下隐藏(clientWidth=0),必须用 svg2d 的可见尺寸换算
      const el = document.getElementById('svg2d');
      const w = (el && el.clientWidth) || window.innerWidth || 1;
      const h = (el && el.clientHeight) || window.innerHeight || 1;
      // 俯视相机 up=(0,0,-1),render2dFit 有意设 top=cz-halfH < bottom → z 用 bottom-top 取正
      const pxX = (orthoCam.right - orthoCam.left) / w;
      const pxZ = (orthoCam.bottom - orthoCam.top) / h;
      if (!isFinite(pxX) || !isFinite(pxZ) || pxX <= 0 || pxZ <= 0) return; // 视锥异常时不写相机
      orthoCam.position.x -= dx * pxX; orthoCam.position.z -= dy * pxZ;
      controls.target.x -= dx * pxX;   controls.target.z -= dy * pxZ;
      orthoCam.updateMatrixWorld();
    });
    const _svgPanEnd = () => {
      if (!_svgPan) return;
      _svgPan = null;
      render2dExports.endPan();
      const el = document.getElementById('svg2d');
      if (el) el.style.cursor = tool === 'pan' ? 'grab' : '';
    };
    render2dExports.on('pointerup', _svgPanEnd);
    window.addEventListener('pointerup', _svgPanEnd);   // 拖出 SVG 也能结束
    _syncSelToSvg();
  };
  globalThis.render2dFit = () => {
    if (typeof render2dExports === 'undefined') return;
    const stage = document.getElementById('stage');
    let vw = 0, vh = 0;
    if (stage) { const r = stage.getBoundingClientRect(); vw = r.width; vh = r.height; }
    if (!vw || !vh) { vw = window.innerWidth; vh = window.innerHeight; }
    const aspect = vw / Math.max(1, vh);
    render2dExports.fitToContent(doc, aspect);
    render2dExports.setViewport(vw, vh);
    // 同步到 orthoCam (供 _smoke_view_switch 验证)
    const v = render2dExports.getViewBounds();
    const cx = (v.minX + v.maxX) / 2, cz = (v.minZ + v.maxZ) / 2;
    orthoCam.position.set(cx, 20, cz);
    orthoCam.lookAt(cx, 0, cz);
    controls.target.set(cx, 0, cz);
    const halfW = (v.maxX - v.minX) / 2, halfH = (v.maxZ - v.minZ) / 2;
    orthoCam.left = cx - halfW; orthoCam.right = cx + halfW;
    orthoCam.top = cz - halfH; orthoCam.bottom = cz + halfH;
    orthoCam.updateProjectionMatrix();
  };
  globalThis._chain = () => chain;              // 读取当前链起点
  globalThis._setChain = (v) => { chain = v; }; // 写入当前链起点(测试用)
  globalThis._typedLen = () => typedLen;        // 读取数字输入状态
  globalThis._setTypedLen = (v) => { typedLen = v; };  // 写入数字输入状态(测试用)
  globalThis._autosaveNow = _autosaveNow;             // 立即同步写入(测试用,跳过 debounce)
  globalThis._lastAutosaveAt = () => _lastAutosaveAt; // 上次自动存档的 epoch ms
  globalThis._clearAutosaveDraft = _clearAutosaveDraft; // 清掉 tp3d_plan 草稿
  globalThis.mkWall = mkWall;                       // 暴露给 e2e
  globalThis.importPlanFromText = importPlanFromText;       // 外部 HTML 导入(纯文本接口,e2e 用)
  globalThis.importPlanHtmlFile = importPlanHtmlFile;       // 外部 HTML 导入(File 接口)
  globalThis.pushUndo = pushUndo;                   // 测试用:触发 markUnsaved(true)
  globalThis.undo = undo;                           // 测试用:走完整 undo 流程
  globalThis.redo = redo;                           // 测试用:走完整 redo 流程
  globalThis.newDoc = newDoc;                       // 测试用:验证栈清空
  globalThis.loadSample = loadSample;               // 测试用:载入示例户型
  globalThis.normDoc = normDoc;                     // 测试用:触发字段迁移
  globalThis._undoLen = () => undoStack.length;     // 测试用:读 undo 栈长度
  globalThis._redoLen = () => redoStack.length;     // 测试用:读 redo 栈长度
  globalThis.markUnsaved = markUnsaved;             // 测试用:手动控制 dirty 标志
  globalThis._rebuildCount = () => _rebuildCount || 0;   // 测试用:总 rebuild 调用次数
  globalThis._resetRebuildCount = () => { _rebuildCount = 0; };
  globalThis._rendererInfo = () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, frame: renderer.info.render.frame });
  globalThis._dragPreviewActive = () => !!(dragPreviewGroup && dragPreviewGroup.children.length);
  globalThis._panBy = _panBy;                                 // 测试用:左键平移函数
  globalThis._orbitBy = _orbitBy;                             // 测试用:右键旋转函数
  globalThis._lPan = () => lPan;                              // 测试用:读左键 pan 状态
  globalThis._rOrbit = () => rOrbit;                          // 测试用:读右键 rot 状态
  globalThis._controlsTarget = () => controls.target.clone(); // 测试用:读 OrbitControls target
  globalThis._activeCamPos = () => activeCam.position.clone();// 测试用:读相机位置
  globalThis._updateDragPreview = _updateDragPreview;     // 测试用:直接喂 preview payload
  globalThis._clearDragPreview = _clearDragPreview;
  globalThis._batchApply = _batchApply;
  // 测试用:合成一次拖拽 (mode, 参数),返回 drag 对象(可手动修改它)
  globalThis._startDrag = (mode, opts) => {
    pushUndo();
    if (mode === 'end') drag = { mode: 'end', wi: opts.wi, end: opts.end, ax: doc.walls[opts.wi].ax, az: doc.walls[opts.wi].az, bx: doc.walls[opts.wi].bx, bz: doc.walls[opts.wi].bz };
    else if (mode === 'open') drag = { mode: 'open', wi: opts.wi, oi: opts.oi, ot: doc.walls[opts.wi].openings[opts.oi].t };
    else if (mode === 'multi') drag = { mode: 'multi', ox: opts.ox, oz: opts.oz, items: opts.items };
    return drag;
  };
  globalThis._endDrag = () => { drag = null; };
  globalThis.placeFurnAt = (x, z, type) => {   // 直接在指定世界坐标放一件家具（绕过鼠标）
    furnType = type; furnRot = 0;
    const def = FURN[type];
    let nx = x, nz = z, nr = furnRot;

    pushUndo();
    doc.furniture.push({ type, x: nx, z: nz, rot: nr, lv: activeLv });
    // 与点击放置行为一致:不自动选中(用户可继续放置,左侧家具库面板保持可见)
    rebuild(); refreshProps();
    return { x: nx, z: nz, rot: nr };
  };
  globalThis.setViewPreset = setViewPreset;
  globalThis.setView = setView;
  globalThis.toggleView = toggleView;
  globalThis.fitViewToContent = fitViewToContent;
  globalThis.resetView = resetView;
  globalThis._topView = () => topView;
  globalThis._activeCam = () => activeCam;
  globalThis._rendererEl = () => renderer.domElement;
  globalThis._THREE = THREE;       // 测试用:把 THREE 命名空间也导出
  globalThis.__loadGLB = loadGLB;       // 暴露给扫描脚本
  globalThis.__measureGLB = async (file) => {
    const src = await loadGLB(file);
    const g = src.clone(true);
    g.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(g);
    return {
      w: +(b.max.x - b.min.x).toFixed(3),
      d: +(b.max.z - b.min.z).toFixed(3),
      h: +(b.max.y - b.min.y).toFixed(3),
      ymin: +b.min.y.toFixed(3),
    };
  };
}
globalThis.__exposeE2E = _exposeE2E;
let undoStack = [], redoStack = [];
let clipboard = null;                 // 复制粘贴用的源对象引用
let gridSnap = true;
const SNAP = 0.05;
const CX = 2.95, CZ = 3.3;            // 文档中心（用于居中摆放）

// ── 多文件工作区(File System Access API + IndexedDB) ──
const FS_SUPPORT = !!(window.showSaveFilePicker && window.showOpenFilePicker);
const TP3D_VERSION = 1;
const FILES_INDEX_KEY = 'tp3d_files_index';
const FILES_DB = 'tp3d_db';
const FILES_STORE = 'handles';
// filesIndex: [{ id, name, fileName, updatedAt }]
let filesIndex = [];
let currentFileId = null;             // 当前打开的 FileEntry.id
let currentHandle = null;             // 当前 FileSystemFileHandle(可空)
let unsaved = false;                  // 文档有未保存修改(注意:与下面的 rebuild dirty 是两个独立的脏标记)

function loadFilesIndex() {
  try { const s = localStorage.getItem(FILES_INDEX_KEY); filesIndex = s ? JSON.parse(s) : []; }
  catch (e) { filesIndex = []; }
}
function saveFilesIndex() {
  try { localStorage.setItem(FILES_INDEX_KEY, JSON.stringify(filesIndex)); }
  catch (e) { toast('索引保存失败：' + e.message, 'error', 6000); }
}

// IndexedDB 帮助器:store 'handles' 存 FileSystemFileHandle，store 'assets' 存自定义模型字节
const ASSETS_STORE = 'assets';
function _idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FILES_DB, 2);   // v2: 新增 assets store
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) db.createObjectStore(FILES_STORE);
      if (!db.objectStoreNames.contains(ASSETS_STORE)) db.createObjectStore(ASSETS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // 旧版本标签页仍持有连接时会卡住升级，明确报错而不是静默挂起
    req.onblocked = () => reject(new Error('数据库被其它标签页占用，请关闭其它标签页后重试'));
  });
}
async function idbGet(id) {
  try {
    const db = await _idbOpen();
    return await new Promise((res, rej) => {
      const tx = db.transaction(FILES_STORE, 'readonly').objectStore(FILES_STORE).get(id);
      tx.onsuccess = () => res(tx.result || null);
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { return null; }
}
async function idbPut(id, handle) {
  const db = await _idbOpen();
  return await new Promise((res, rej) => {
    const tx = db.transaction(FILES_STORE, 'readwrite').objectStore(FILES_STORE).put(handle, id);
    tx.onsuccess = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbDel(id) {
  try {
    const db = await _idbOpen();
    return await new Promise((res, rej) => {
      const tx = db.transaction(FILES_STORE, 'readwrite').objectStore(FILES_STORE).delete(id);
      tx.onsuccess = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { /* 静默 */ }
}

// ── 文件内容快照(IndexedDB,key = 'snap:' + entry.id)──────────────
// 每个 entry 存一份 { json, ts } 快照,解决两类"文件切换不了":
//  · 句柄权限丢失 / 浏览器不支持 FSA → 没有可读来源
//  · 切走时未保存的编辑切回后消失(快照比磁盘新则恢复快照)
async function snapPut(entryId) {
  try {
    if (!entryId || !doc) return;
    await idbPut('snap:' + entryId, { json: _buildFileJSON(), ts: Date.now() });
    const ent = filesIndex.find(f => f.id === entryId);
    if (ent) ent._hasSnap = true;
  } catch (e) { /* 容量满/隐私模式:静默,不影响主流程 */ }
}
async function snapGet(entryId) {
  try { return await idbGet('snap:' + entryId); } catch (e) { return null; }
}
function snapDel(entryId) { if (entryId) idbDel('snap:' + entryId); }

// ── 本地服务器文件适配器(存取 editor 目录,全程无弹窗)────────────
// 浏览器沙箱不允许直接写任意路径(FSA 必须弹授权),本地服务器代写:
//   GET  /api/files/list      列目录
//   GET  /api/files/get?name  读文件
//   POST /api/files/put?name  写文件(服务器端原子替换)
//   POST /api/files/del?name  删文件
// 服务器不可达(双击 html 打开等场景)时自动回落 FSA/快照,行为不变。
const _SRV = '/api/files';
let _srvOk = null;                  // null=未探测
async function srvProbe() {
  if (_srvOk !== null) return _srvOk;
  try {
    const r = await fetch(_SRV + '/list', { cache: 'no-store' });
    _srvOk = r.ok;
  } catch (e) { _srvOk = false; }
  return _srvOk;
}
async function srvList() {
  const r = await fetch(_SRV + '/list', { cache: 'no-store' });
  if (!r.ok) throw new Error('list ' + r.status);
  return (await r.json()).files || [];
}
async function srvGet(name) {
  const r = await fetch(_SRV + '/get?name=' + encodeURIComponent(name), { cache: 'no-store' });
  if (!r.ok) throw new Error('get ' + r.status);
  return await r.text();
}
async function srvPut(name, text) {
  const r = await fetch(_SRV + '/put?name=' + encodeURIComponent(name),
    { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (!r.ok) throw new Error('put ' + r.status);
  return await r.json();
}
async function srvDel(name) {
  const r = await fetch(_SRV + '/del?name=' + encodeURIComponent(name), { method: 'POST' });
  if (!r.ok) throw new Error('del ' + r.status);
  return await r.json();
}
// entry 的磁盘文件名(无则按显示名推导)
function _srvFileName(entry) {
  return entry.fileName && /\.json$/i.test(entry.fileName)
    ? entry.fileName
    : safeFileName(entry.name || '未命名') + '.tp3d.json';
}

// ── 自定义模型字节存取（IndexedDB）──────────────────────────
async function assetPut(id, rec) {
  const db = await _idbOpen();
  return await new Promise((res, rej) => {
    const tx = db.transaction(ASSETS_STORE, 'readwrite').objectStore(ASSETS_STORE).put(rec, id);
    tx.onsuccess = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function assetGet(id) {
  try {
    const db = await _idbOpen();
    return await new Promise((res, rej) => {
      const tx = db.transaction(ASSETS_STORE, 'readonly').objectStore(ASSETS_STORE).get(id);
      tx.onsuccess = () => res(tx.result || null);
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { return null; }
}
async function assetDel(id) {
  try {
    const db = await _idbOpen();
    return await new Promise((res, rej) => {
      const tx = db.transaction(ASSETS_STORE, 'readwrite').objectStore(ASSETS_STORE).delete(id);
      tx.onsuccess = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { /* 静默 */ }
}

// ── 模型保存目录(FileSystemDirectoryHandle)───────────────
//   key = 'dir-handle' 存在 ASSETS_STORE 里,与模型记录同名但语义不同
const ASSET_DIR_KEY = 'dir-handle';
const DIR_NAME_KEY = 'tp3d_asset_dir_name';
const DIR_PICKER_SUPPORT = !!window.showDirectoryPicker;
let _assetDirHandle = null;        // 当前内存缓存
let _assetDirChecked = false;      // 是否已尝试 queryPermission

async function setAssetDirHandle(handle) {
  _assetDirHandle = handle;
  _assetDirChecked = true;
  try {
    const db = await _idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction(ASSETS_STORE, 'readwrite').objectStore(ASSETS_STORE).put(handle, ASSET_DIR_KEY);
      tx.onsuccess = () => res();
      tx.onerror = () => rej(tx.error);
    });
    try { localStorage.setItem(DIR_NAME_KEY, handle.name || ''); } catch (e) { /* 静默 */ }
  } catch (e) {
    console.warn('[assetDir] persist handle failed', e);
  }
}
async function getAssetDirHandle() {
  if (_assetDirHandle) return _assetDirHandle;
  try {
    const db = await _idbOpen();
    const h = await new Promise((res, rej) => {
      const tx = db.transaction(ASSETS_STORE, 'readonly').objectStore(ASSETS_STORE).get(ASSET_DIR_KEY);
      tx.onsuccess = () => res(tx.result || null);
      tx.onerror = () => rej(tx.error);
    });
    _assetDirHandle = h || null;
    _assetDirChecked = true;
    return _assetDirHandle;
  } catch (e) { return null; }
}
async function clearAssetDirHandle() {
  _assetDirHandle = null;
  _assetDirChecked = true;
  try {
    const db = await _idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction(ASSETS_STORE, 'readwrite').objectStore(ASSETS_STORE).delete(ASSET_DIR_KEY);
      tx.onsuccess = () => res();
      tx.onerror = () => rej(tx.error);
    });
    try { localStorage.removeItem(DIR_NAME_KEY); } catch (e) { /* 静默 */ }
  } catch (e) { /* 静默 */ }
}
// 确保目录句柄就绪并有读写权限;UI 层用
async function _ensureAssetDir({ promptIfMissing = false } = {}) {
  if (!DIR_PICKER_SUPPORT) return null;
  let h = await getAssetDirHandle();
  if (h && !_assetDirChecked) {
    try {
      const q = await h.queryPermission({ mode: 'readwrite' });
      if (q !== 'granted') {
        const r = await h.requestPermission({ mode: 'readwrite' });
        if (r !== 'granted') h = null;
      }
    } catch (e) { h = null; }
    _assetDirChecked = true;
  }
  if (!h && promptIfMissing) {
    try {
      h = await window.showDirectoryPicker({ mode: 'readwrite' });
      await setAssetDirHandle(h);
      return h;
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      throw e;
    }
  }
  return h;
}
function _assetDirDisplayName() {
  try { return localStorage.getItem(DIR_NAME_KEY) || ''; } catch (e) { return ''; }
}
// 把 ArrayBuffer 写到目录;<id>.glb。返回文件名,失败返回 null。
async function _writeAssetToDisk(id, buf) {
  const dir = await _ensureAssetDir();
  if (!dir) return null;
  const fname = `${id}.glb`;
  const fh = await dir.getFileHandle(fname, { create: true });
  const w = await fh.createWritable();
  await w.write(buf);
  await w.close();
  return fname;
}
// 从目录读取 <id>.glb 的字节。返回 ArrayBuffer 或 null。
async function _readAssetFromDisk(id) {
  const dir = await getAssetDirHandle();
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(`${id}.glb`);
    const f = await fh.getFile();
    return await f.arrayBuffer();
  } catch (e) { return null; }
}
// 从目录删除 <id>.glb。失败静默(可能本来就没有)。
async function _deleteAssetFromDisk(id) {
  const dir = await getAssetDirHandle();
  if (!dir) return;
  try { await dir.removeEntry(`${id}.glb`); } catch (e) { /* 文件不在或权限失效 */ }
}

function markUnsaved(v) {
  unsaved = !!v;
  const dot = document.getElementById('unsavedDot');
  if (dot) dot.classList.toggle('on', unsaved);
  document.title = (unsaved ? '• ' : '') + 'TP3D · 户型编辑器' + (currentFileId ? ' — ' + (currentEntry()?.name || '') : '');
  renderFilesPanel();
  if (unsaved) _scheduleAutosave();
  else _cancelAutosave();
}
// ── 自动存档(草稿)────────────────────────────────────────────
// 所有 doc 修改最终都触发 markUnsaved(true)(经由 pushUndo wrapper)。
// 在这里 debounce 800ms 把当前 doc 写到 localStorage.tp3d_plan,刷新即可恢复。
// 用户成功另存到文件(saveDoc/saveDocAs)后 _clearAutosaveDraft() 清掉这个 key,
// 防 boot 时旧草稿盖住刚保存的文件版本。
let _autosaveTimer = null;
let _lastAutosaveAt = 0;          // 测试用:上一次实际写入的 epoch ms
const AUTOSAVE_DEBOUNCE_MS = 800;
const AUTOSAVE_KEY = 'tp3d_plan';
function _scheduleAutosave() {
  _cancelAutosave();
  _autosaveTimer = setTimeout(_doAutosave, AUTOSAVE_DEBOUNCE_MS);
}
function _cancelAutosave() {
  if (_autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
}
function _doAutosave() {
  _autosaveTimer = null;
  if (!doc) return;             // boot 前/出错时
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(doc));
    _lastAutosaveAt = Date.now();
    // 同步每文件快照(异步,不阻塞):句柄丢失/不支持 FSA 时切换仍有来源
    if (currentFileId) snapPut(currentFileId);
    // 服务器模式:自动保存直接落盘 editor 目录(用户要求全程静默保存)
    const ent = currentEntry();
    if (ent && ent._srv && ent.fileName && _srvOk) {
      srvPut(ent.fileName, _buildFileJSON())
        .then(r => { ent.updatedAt = r.mtime; })
        .catch(() => { /* 断网/只读盘:草稿仍在 localStorage */ });
    }
    // 写入成功后,既然 draft 与 doc 一致,顺手把红点灭掉(给用户"已自动保存"的反馈)
    if (unsaved) {
      unsaved = false;
      const dot = document.getElementById('unsavedDot');
      if (dot) dot.classList.toggle('on', false);
      document.title = 'TP3D · 户型编辑器' + (currentFileId ? ' — ' + (currentEntry()?.name || '') : '');
    }
  } catch (e) {
    // 容量满 / 隐私模式:静默;红点保留,提示用户手动 F2 保存
  }
}
function _clearAutosaveDraft() {
  _cancelAutosave();
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) { /* 静默 */ }
}
// 测试用:立刻同步执行一次(跳过 debounce),返回写入的字节数
function _autosaveNow() {
  if (!doc) return 0;
  try {
    const s = JSON.stringify(doc);
    localStorage.setItem(AUTOSAVE_KEY, s);
    _lastAutosaveAt = Date.now();
    return s.length;
  } catch (e) { return -1; }
}
function currentEntry() { return filesIndex.find(f => f.id === currentFileId) || null; }
function newId() { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function safeFileName(name) {
  return (name || '未命名').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}
function fmtTimeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const planGroup = new THREE.Group();
planGroup.position.set(-CX, 0, -CZ);
scene.add(planGroup);
const handlesGroup = new THREE.Group();
scene.add(handlesGroup);
const selHelper = new THREE.Group();
scene.add(selHelper);
const areaLabelsGroup = new THREE.Group();
scene.add(areaLabelsGroup);
let wallGroups = [];
let floorMeshes = [];
let furnitureGroups = [];
let stairGroups = [];
let dirty = false;
// ── 增量重建索引(借鉴 blueprint3d-babylon 的 node-map 模式) ──
// 每个实体类型一张 Map,key 是 doc 数组索引,value 是对应的 THREE.Group + 几何哈希
// rebuild3D 通过比对哈希决定复用/重建/销毁,避免每帧 tear-down 全部 mesh
const _wallNodeByWi   = new Map();   // wi → { group, hash, mitersL, mitersR }
const _floorNodeByFi  = new Map();   // fi → { mesh, hash }
const _stairNodeBySi  = new Map();   // si → { group, hash }
// 墙材质描述符缓存:key="tex|hex|repeatU|repeatV" → MeshStandardMaterial
// 30 墙 × 1 重建 = 0 次克隆(以前 30 次),GC 压力大幅下降
const _wallMatCache   = new Map();
let   _geomDirty = true;             // 本次 rebuild 是否真的改了 mesh(影响 shadow-map 重 bake)
function _wallGeomHash(w, miters) {
  const ml = miters ? miters.left : 0;
  const mr = miters ? miters.right : 0;
  // 包含所有影响渲染的门窗可变视觉字段:t/width/height/kind/shape/isOpen/leafColor/leafTex/
  // glassColor/sill(窗台高,影响窗框位置与墙洞)/hinge(铰链侧)/flip(开向)/swing
  return [w.ax, w.az, w.bx, w.bz, w.th, w.h, w.lv || 0,
    (w.openings || []).map(o => `${o.t}|${o.width}|${o.height}|${o.kind || ''}|${o.shape || 'square'}|${o.isOpen ? 1 : 0}|${o.leafColor || ''}|${o.leafTex || ''}|${o.glassColor || ''}|${o.sill || 0}|${o.hinge || 0}|${o.flip ? 1 : 0}|${o.swing || ''}`).join(','),
    ml, mr,
    w.halfWall ? 1 : 0,
    w.halfHeight || 0,
    w.wallTex || '', w.wallBase || '',
    w.glass ? 1 : 0,
    w.matIn || '', w.matOut || '',
    w.colorIn || '', w.colorOut || ''
  ].join('#');
}
function _floorGeomHash(f) {
  // color/tex 影响地面材质,必须进 hash,否则改色/改纹理时复用旧 mesh 导致不生效
  if (f.strips && f.strips.length) {
    return ['S', f.th || 0.05, f.lv || 0, f.color || '', f.tex || '',
      f.strips.map(s => `${s[0]}|${s[1]}|${s[2]}|${s[3]}`).join(';')].join('#');
  }
  return ['R', f.th || 0.05, f.lv || 0, f.x1, f.z1, f.x2, f.z2, f.color || '', f.tex || ''].join('#');
}
function _stairGeomHash(s) {
  // 注意字段名是 width/depth/height/steps(与属性面板、buildStairs 一致),不是 w/h;
  // 位置/旋转/楼层由缓存命中分支直接同步 group 变换,不进 hash(拖动免重建)
  return [s.type || 'straight',
    s.width || 0.9, s.depth || 3, s.height || 2.8, s.steps || 0].join('#');
}
let _rebuildCount = 0;          // e2e 测试用:统计整个会话累计 rebuild() 调用次数
const rebuild = () => { dirty = true; _rebuildCount++;
  // 2D 模式下同步触发 SVG 重绘(浏览器原生 Skia,几乎免费)
  if (topView && globalThis.render2dExports) {
    globalThis.render2dExports.markDirty();
    // 同步选中态到 SVG (sel 是闭包变量,通过闭包 setter 同步)
    if (typeof _syncSelToSvg === 'function') _syncSelToSvg();
  }
};

const snapV = v => gridSnap ? Math.round(v / SNAP) * SNAP : v;
// 「半墙」全局默认开关 —— 控制新建墙是否默认启用半墙
// 持久化到 localStorage('tp3d_halfwall_default'),与主题、楼层锁一致模式
let halfWallDefault = (() => {
  try { return localStorage.getItem('tp3d_halfwall_default') === '1'; }
  catch (e) { return false; }
})();

function mkWall(ax, az, bx, bz, openings = [], th = 0.12, lv = 0, extra = {}) {
  // 当前主题的墙面默认值(不影响现有对象,只决定新建墙的默认色)
  const wt = themeCur().wall;
  const out = { ax, az, bx, bz, th, openings, lv,
    wallBase: wt.base, wallTex: wt.tex || undefined, ...extra };
  if (halfWallDefault) {
    out.halfWall = true;
    out.halfHeight = 1.2;
  }
  return out;
}
function mkDoor(t, width, extra = {}) {
  const dt = themeCur().door;
  return { type: 'door', t, width, height: 2.05, kind: 'single', hinge: -1, flip: false,
    leafColor: dt.leafColor, leafTex: dt.leafTex || undefined,
    glassColor: dt.glassColor === 'default' ? undefined : dt.glassColor,
    ...extra };
}
function mkWin(t, width, extra = {}) {
  const wt = themeCur().window;
  return { type: 'window', t, width, height: 1.65, sill: 0.9,
    leafColor: wt.leafColor, leafTex: wt.leafTex || undefined,
    glassColor: wt.glassColor === 'default' ? undefined : wt.glassColor,
    ...extra };
}

function sampleDoc() {
  return {
    wallH: 2.75,
    walls: [
      mkWall(0, 0, 5.9, 0), mkWall(0, 6.6, 5.9, 6.6),
      mkWall(0, 0, 0, 6.6, [mkWin(5.0 / 6.6, 0.8)]),
      mkWall(5.9, 0, 5.9, 6.6, [mkDoor(0.75 / 6.6, 0.88), mkWin(5.1 / 6.6, 0.8)]),
      mkWall(0, 2.4, 2.55, 2.4), mkWall(3.6, 2.4, 5.9, 2.4),
      mkWall(2.55, 2.4, 2.55, 3.5), mkWall(0, 3.5, 2.55, 3.5),
      mkWall(2.55, 3.5, 3.2, 3.5, [mkDoor(0.5, 0.63)]),
      mkWall(3.2, 3.5, 3.7, 3.5),
      mkWall(3.7, 2.4, 3.7, 4.4, [mkDoor(0.7 / 2.0, 0.7)]),
      mkWall(3.7, 4.4, 5.9, 4.4), mkWall(3.0, 3.5, 3.0, 6.6),
    ],
    levels: [{ name: '1F', elev: 0 }],
    floors: [{ x1: 0, z1: 0, x2: 5.9, z2: 6.6, th: 0.15, color: '#dcd6cc', lv: 0 }],
    furniture: [
      { type: 'bed', x: 0.92, z: 1.22, rot: 0 },
      { type: 'nightstand', x: 1.95, z: 0.42, rot: 0 },
      { type: 'wardrobe', x: 1.28, z: 3.17, rot: 0 },
      { type: 'desk', x: 1.7, z: 5.6, rot: 0 },
      { type: 'fridge', x: 3.6, z: 6.15, rot: 0 },
    ],
  };
}
function normDoc() {
  doc.wallH = doc.wallH || 2.75;
  doc.walls = doc.walls || [];            // 旧草稿/损坏档案可能缺 walls —— 缺了会在下面 concat 崩
  doc.furniture = doc.furniture || [];
  doc.floors = doc.floors || [];
  doc.stairs = doc.stairs || [];
  doc.levels = doc.levels && doc.levels.length ? doc.levels : [{ name: '1F', elev: 0 }];
  doc.groups = doc.groups || [];          // 编组注册表：[{id, name}]，成员关系存在对象的 gid 上
  doc.assets = doc.assets || [];          // 自定义模型元数据（字节双写：IndexedDB + 可选磁盘目录）
  doc.assets.forEach(a => { if (a.dirStored == null) a.dirStored = false; });
  _registerCustomAssetsFromDoc();         // 必须早于下面的 FURN 过滤，否则自定义家具会被删掉
  (doc.walls || []).concat(doc.floors || [], doc.furniture || []).forEach(o => { if (o.lv == null) o.lv = 0; });
  // 拱形门/玻璃门/拱形窗已下线:旧档里的这些 kind 迁移为普通门窗(顺带清掉已无意义的 shape 字段)
  let _retiredOpenings = 0;
  (doc.walls || []).forEach(w => (w.openings || []).forEach(op => {
    const retired = (op.type === 'door' && (op.kind === 'arched' || op.kind === 'glass'))
                 || (op.type === 'window' && op.kind === 'arched');
    if (retired) { op.kind = 'single'; delete op.shape; _retiredOpenings++; }
  }));
  if (_retiredOpenings) console.info('[normDoc] 已将', _retiredOpenings, '个拱形门/玻璃门/拱形窗迁移为普通门窗');
  // 门/窗高度钳制到墙高以内(留 0.15m 门楣),修复旧档"门高≥墙高"造成的门上方缺口
  let _clampedOpenings = 0;
  (doc.walls || []).forEach(w => (w.openings || []).forEach(op => {
    const wh = (w.h != null ? w.h : doc.wallH) || 2.75;
    const h0 = op.height;
    if (op.type === 'door') {
      op.height = Math.min(h0 || 2.05, Math.max(0.5, wh - 0.15));
    } else {
      op.sill = Math.min(op.sill || 0, Math.max(0, wh - 0.35));
      op.height = Math.min(h0 || 0.9, Math.max(0.3, wh - op.sill - 0.05));
    }
    if (Math.abs((h0 || 0) - op.height) > 1e-6) _clampedOpenings++;
  }));
  if (_clampedOpenings) console.info('[normDoc] 已将', _clampedOpenings, '个门/窗高度钳制到墙高以内');
  // 清理已废弃的家具类型（如门/窗类 GLB，已从 FURN 中删除）
  const before = doc.furniture.length;
  doc.furniture = doc.furniture.filter(f => FURN[f.type]);
  const removed = before - doc.furniture.length;
  if (removed) console.info('[normDoc] 已移除', removed, '件已废弃家具');
  if (!doc.floors.length && doc.floor) {   // 旧档迁移：文档级地面 → 可绘制地面
    doc.floors.push({
      x1: doc.floor.cx - doc.floor.w / 2, z1: doc.floor.cz - doc.floor.d / 2,
      x2: doc.floor.cx + doc.floor.w / 2, z2: doc.floor.cz + doc.floor.d / 2,
      th: doc.floor.th || 0.15, color: doc.floor.color || '#dcd6cc', lv: 0,
    });
  }
}
// 把历史数据中"双开门宽度=单扇"的旧语义迁移为"门洞总宽"（×2）。
// 仅对未打过迁移标记的旧档执行，避免重复翻倍。
function migrateDoubleDoorWidth() {
  let touched = false;
  (doc.walls || []).forEach(w => (w.openings || []).forEach(op => {
    if (op.type !== 'door') return;
    if (op.kind === 'double' && !op._dblMigrated) {
      op.width = +(op.width * 2).toFixed(2);
      op._dblMigrated = true;
      touched = true;
    }
  }));
  if (touched) saveDoc();
}
// 楼层标高（含分解视图的垂直展开偏移）
let lvMode = 'stacked';            // stacked | explode | solo
let activeLv = 0;
// 地面层锁定：禁止鼠标拖动 + 方向键微移；状态持久化到 localStorage
let floorLocked = (() => { try { return localStorage.getItem('tp3d_floorLocked') === '1'; } catch (e) { return false; } })();
function levelY(lv) {
  const L = doc.levels[lv] || doc.levels[doc.levels.length - 1] || { elev: 0 };
  return (L.elev || 0) + (lvMode === 'explode' ? lv * 2.5 : 0);
}
// 闭环房间识别：栅格化墙线 → 外部洪水填充 → 内部连通域 = 房间
// ── 闭环房间识别核心：栅格化墙线 → 外部洪水填充 → 内部连通域 = 围合房间 ──
// 返回 [{ x1, z1, x2, z2, strips, area }](文档坐标,strips 为 5cm 栅格条带,贴合轮廓)。
// detectRooms(识别房间)与 createFloorFromWalls(按墙围合生成地面)共用此核心。
function _detectEnclosedRooms(lv) {
  const walls = doc.walls.filter(w => (w.lv || 0) === lv);
  if (walls.length < 3) return [];
  const res = 0.05;
  let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
  walls.forEach(w => {
    x0 = Math.min(x0, w.ax, w.bx); x1 = Math.max(x1, w.ax, w.bx);
    z0 = Math.min(z0, w.az, w.bz); z1 = Math.max(z1, w.az, w.bz);
  });
  x0 -= 0.4; z0 -= 0.4; x1 += 0.4; z1 += 0.4;
  const nx = Math.max(4, Math.ceil((x1 - x0) / res));
  const nz = Math.max(4, Math.ceil((z1 - z0) / res));
  const N = nx * nz;
  const blocked = new Uint8Array(N);
  walls.forEach(w => {
    const steps = Math.max(1, Math.ceil(Math.hypot(w.bx - w.ax, w.bz - w.az) / (res / 2)));
    for (let i = 0; i <= steps; i++) {
      const gx = Math.floor(((w.ax + (w.bx - w.ax) * i / steps) - x0) / res);
      const gz = Math.floor(((w.az + (w.bz - w.az) * i / steps) - z0) / res);
      for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
        const cx = gx + ox, cz = gz + oz;
        if (cx >= 0 && cz >= 0 && cx < nx && cz < nz) blocked[cz * nx + cx] = 1;
      }
    }
  });
  const outside = new Uint8Array(N);
  const st = [];
  for (let i = 0; i < nx; i++) { st.push(i, (nz - 1) * nx + i); }
  for (let j = 0; j < nz; j++) { st.push(j * nx, j * nx + nx - 1); }
  while (st.length) {
    const c = st.pop();
    if (c < 0 || c >= N || blocked[c] || outside[c]) continue;
    outside[c] = 1;
    const gx = c % nx;
    if (gx > 0) st.push(c - 1);
    if (gx < nx - 1) st.push(c + 1);
    if (c >= nx) st.push(c - nx);
    if (c < N - nx) st.push(c + nx);
  }
  const seen = new Uint8Array(N);
  const rooms = [];
  for (let c0 = 0; c0 < N; c0++) {
    if (blocked[c0] || outside[c0] || seen[c0]) continue;
    const cells = [c0]; seen[c0] = 1;
    let k = 0;
    while (k < cells.length) {
      const c = cells[k++];
      const gx = c % nx;
      if (gx > 0 && !seen[c - 1] && !blocked[c - 1] && !outside[c - 1]) { seen[c - 1] = 1; cells.push(c - 1); }
      if (gx < nx - 1 && !seen[c + 1] && !blocked[c + 1] && !outside[c + 1]) { seen[c + 1] = 1; cells.push(c + 1); }
      if (c >= nx && !seen[c - nx] && !blocked[c - nx] && !outside[c - nx]) { seen[c - nx] = 1; cells.push(c - nx); }
      if (c < N - nx && !seen[c + nx] && !blocked[c + nx] && !outside[c + nx]) { seen[c + nx] = 1; cells.push(c + nx); }
    }
    let bx0 = 1e9, bz0 = 1e9, bx1 = -1e9, bz1 = -1e9;
    cells.forEach(c => {
      const gx = c % nx, gz = (c / nx) | 0;
      bx0 = Math.min(bx0, gx); bx1 = Math.max(bx1, gx);
      bz0 = Math.min(bz0, gz); bz1 = Math.max(bz1, gz);
    });
    const area = cells.length * res * res;
    if (area < 1.0) continue;
    // 连通域 → 行连续段 → 纵向合并为条带(L 形/T 形房间保持精确轮廓)
    // 行扫描合并的算法与 _polygonToStrips 共用,见 _rowMapToStrips
    const rowSet = new Map();
    cells.forEach(c => {
      const gz = (c / nx) | 0;
      if (!rowSet.has(gz)) rowSet.set(gz, new Set());
      rowSet.get(gz).add(c % nx);
    });
    const strips = _rowMapToStrips(rowSet, x0, z0, res);
    rooms.push({
      x1: x0 + bx0 * res, z1: z0 + bz0 * res,
      x2: x0 + (bx1 + 1) * res, z2: z0 + (bz1 + 1) * res,
      strips,
      area,
    });
  }
  return rooms;
}

// 命令面板「识别房间（按墙生成地面）」:识别围合区域 → 分块地面(配色轮换) + 面积标签
function detectRooms() {
  const walls = doc.walls.filter(w => (w.lv || 0) === activeLv);
  if (walls.length < 3) return flash('墙太少，无法识别房间');
  const rooms = _detectEnclosedRooms(activeLv);
  if (!rooms.length) return flash('未发现闭合墙环围出的房间');
  pushUndo();
  doc.floors = doc.floors.filter(f => (f.lv || 0) !== activeLv || f.locked);   // 识别结果替换本层原地面，保留锁定
  const palette = ['#dcd6cc', '#cfe0d8', '#d8d2e2', '#e8dcc0', '#d6e2e8'];
  rooms.forEach((r, i) => {
    doc.floors.push({
      x1: r.x1, z1: r.z1, x2: r.x2, z2: r.z2,
      th: 0.05, color: palette[i % palette.length], lv: activeLv,
      strips: r.strips,
    });
  });
  sel = null; rebuild(); refreshProps();
  showAreaLabels(rooms);
  toast(`识别到 ${rooms.length} 个房间，已生成分块地面（Ctrl+Z 可退回）`, 'success', 3000);
}

// 房间面积标签：用 CanvasTexture 生成圆角白底 + 文字的 Sprite，挂在 areaLabelsGroup
let areaLabelsVisible = true;
function makeAreaSprite(text) {
  const c = document.createElement('canvas');
  c.width = 220; c.height = 64;
  const g = c.getContext('2d');
  // 圆角矩形背景
  g.fillStyle = 'rgba(255,255,255,0.94)';
  const r = 14;
  g.beginPath(); g.moveTo(r, 0); g.lineTo(c.width - r, 0); g.quadraticCurveTo(c.width, 0, c.width, r);
  g.lineTo(c.width, c.height - r); g.quadraticCurveTo(c.width, c.height, c.width - r, c.height);
  g.lineTo(r, c.height); g.quadraticCurveTo(0, c.height, 0, c.height - r);
  g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0); g.closePath(); g.fill();
  // 文字
  g.font = 'bold 28px "Segoe UI","Microsoft YaHei",sans-serif';
  g.fillStyle = '#1f2937';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(1.1, 0.32, 1);
  sp.renderOrder = 50;
  return sp;
}
function clearAreaLabels() {
  while (areaLabelsGroup.children.length) {
    const s = areaLabelsGroup.children.pop();
    s.material.map?.dispose(); s.material.dispose();
  }
  areaLabelsGroup.visible = areaLabelsVisible;
}
function showAreaLabels(rooms) {
  clearAreaLabels();
  rooms.forEach((r, i) => {
    const cx = (r.x1 + r.x2) / 2 - CX;
    const cz = (r.z1 + r.z2) / 2 - CZ;
    const area = Math.abs(r.x2 - r.x1) * Math.abs(r.z2 - r.z1);
    const sp = makeAreaSprite(area.toFixed(1) + ' ㎡');
    sp.position.set(cx, 0.15, cz);
    sp.userData.kind = 'label';
    areaLabelsGroup.add(sp);
  });
  areaLabelsGroup.visible = areaLabelsVisible;
}
function toggleAreaLabels() {
  areaLabelsVisible = !areaLabelsVisible;
  areaLabelsGroup.visible = areaLabelsVisible;
  flash(`房间面积标签 ${areaLabelsVisible ? '显示' : '隐藏'}`, 'info');
}
// 地面工具面板「按墙围合区域生成地面」:
// 每个闭合墙环围出的多边形区域生成一块贴合轮廓的地面(strips 条带,与识别房间/围房同构),
// 不再退化成包围盒矩形。替换本层未锁定的地面(与"识别房间"语义一致,重复点击不叠块)。
function createFloorFromWalls() {
  const walls = doc.walls.filter(w => (w.lv || 0) === activeLv);
  if (walls.length < 3) return flash('本层墙太少,至少 3 面墙才可能围出地面');
  const rooms = _detectEnclosedRooms(activeLv);
  if (!rooms.length) return flash('未发现闭合墙环围出的区域,请检查墙是否合拢');
  pushUndo();
  doc.floors = doc.floors.filter(f => (f.lv || 0) !== activeLv || f.locked);
  rooms.forEach(r => {
    doc.floors.push({
      x1: r.x1, z1: r.z1, x2: r.x2, z2: r.z2,
      th: 0.05, color: themeCur().floor.color,
      tex: themeCur().floor.tex || undefined, lv: activeLv,
      strips: r.strips,
    });
  });
  sel = null; rebuild(); refreshProps();
  toast(`已按 ${rooms.length} 个围合区域生成地面（Ctrl+Z 可退回）`, 'success', 3000);
}

// 由围房模式闭合时调用：把多边形顶点转成 floor。
// 不再退化成 AABB 矩形 —— 栅格化多边形 + 行扫描生成 strips,
// 跟 detectRooms 同样的数据结构,贴合用户实际画的形状。
function floorFromPolygon(pts, lv) {
  let x0 = +Infinity, z0 = +Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  const out = { x1: x0, z1: z0, x2: x1, z2: z1, th: 0.05,
                color: themeCur().floor.color,
                tex: themeCur().floor.tex || undefined, lv };
  const strips = _polygonToStrips(pts, 0.05);
  if (strips && strips.length) out.strips = strips;
  return out;
}
// 标准 even-odd 射线法,判断 (px,pz) 是否在 pts 围成的多边形内
function _pointInPolygon(px, pz, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, zi = pts[i].z, xj = pts[j].x, zj = pts[j].z;
    if (((zi > pz) !== (zj > pz)) &&
        (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}
// 把多边形栅格化为 strips(每行扫描 + 纵向合并),用于 floor.strips。
// 返回 [[za, zb, xa, xb], ...],与 detectRooms 的 strips 格式一致。
function _polygonToStrips(pts, res = 0.05) {
  if (!pts || pts.length < 3) return null;
  let x0 = +Infinity, z0 = +Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  // 栅格向 bbox 外扩半格,避免边界被截
  x0 -= res / 2; z0 -= res / 2; x1 += res / 2; z1 += res / 2;
  const nx = Math.max(1, Math.ceil((x1 - x0) / res));
  const nz = Math.max(1, Math.ceil((z1 - z0) / res));
  const rowMap = new Map();   // gz -> Set<gx>
  for (let gz = 0; gz < nz; gz++) {
    const rowCells = new Set();
    const pz = z0 + (gz + 0.5) * res;
    for (let gx = 0; gx < nx; gx++) {
      const px = x0 + (gx + 0.5) * res;
      if (_pointInPolygon(px, pz, pts)) rowCells.add(gx);
    }
    if (rowCells.size) rowMap.set(gz, rowCells);
  }
  return _rowMapToStrips(rowMap, x0, z0, res);
}
// 把 rowMap<gz, Set<gx>> 合并成 strips,转到世界坐标。
// 跟 detectRooms 内部那段(963-985)等价,抽出来共用。
function _rowMapToStrips(rowMap, x0, z0, res) {
  const rowStrips = [];
  for (const [gz, gxs] of rowMap) {
    const sorted = [...gxs].sort((a, b) => a - b);
    let sa = sorted[0], sb = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i] === sb + 1) { sb = sorted[i]; continue; }
      rowStrips.push({ za: gz, zb: gz + 1, xa: sa, xb: sb + 1 });
      if (i < sorted.length) { sa = sorted[i]; sb = sorted[i]; }
    }
  }
  rowStrips.sort((a, b) => a.za - b.za || a.xa - b.xa);
  const merged = [];
  rowStrips.forEach(rs => {
    const m = merged.find(mm => mm.xa === rs.xa && mm.xb === rs.xb && mm.zb === rs.za);
    if (m) m.zb = rs.zb; else merged.push({ ...rs });
  });
  return merged.map(mm => [z0 + mm.za * res, z0 + mm.zb * res, x0 + mm.xa * res, x0 + mm.xb * res]);
}

// 45° 量子步进旋转：先把当前角归到最近的 45° 网格，再走一步。
// 任意角度按一次即回正到网格（如 12° → 45°），随后每步恰好 45°。
const ROT_QUANTUM = Math.PI / 4;
function stepRot45(cur, dir) {
  const a = (Math.round(cur / ROT_QUANTUM) + dir) * ROT_QUANTUM;
  return ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

// 15° 精确旋转(Q/E),不量化到 45° 网格
function stepRot15(cur, dir) {
  const a = (cur || 0) + dir * (Math.PI / 12);
  return ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

// 撤销 / 重做
function pushUndo() {
  undoStack.push(JSON.stringify(doc));
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  refreshUndoTip();
}
// 键盘微移（方向键）：选中家具 / 墙端点 / 门窗 / 地面都生效
// Shift ×10。每按一次都 pushUndo（按一下回退一下，符合直觉）。
function nudgeSelected(dx, dz, withAlt) {
  if (!sel) return false;
  // 多选：所有成员一起微移（跳过锁定项）
  if (sel.kind === 'multi') {
    const snap = _batchSnapshot();
    if (!snap.length) { flash('所选对象均已锁定，无法微移', 'warn', 1400); return false; }
    pushUndo();
    _batchApply(snap, dx, dz);
    rebuild(); refreshProps();
    return true;
  }
  if (sel.kind === 'door' || sel.kind === 'window' || sel.kind === 'opening') {
    // 门窗是墙上的 t 参数（0~1），左右方向键 ±0.01（Shift ±0.05）；上下方向键 = 翻转铰链
    const w = doc.walls[sel.wi], op = w.openings[sel.oi];
    if (Math.abs(dz) > 0) {                                  // 上/下 = 翻铰链 / 开向
      pushUndo();
      if (sel.kind === 'door') op.hinge = (op.hinge || -1) * -1;
      else op.flip = !op.flip;
      rebuild(); refreshProps();
      return true;
    }
    const step = shiftDown ? 0.05 : 0.01;
    pushUndo();
    op.t = Math.max(0, Math.min(0.98, op.t + step * Math.sign(dx)));
    rebuild(); refreshProps();
    return true;
  }
  pushUndo();
  if (sel.kind === 'furniture') {
    const f = doc.furniture[sel.fi];
    f.x += dx; f.z += dz;
  } else if (sel.kind === 'wall') {
    const w = doc.walls[sel.wi];
    if (withAlt) { w.ax += dx; w.az += dz; }                // Alt = 只动 A 端点
    else { w.ax += dx; w.az += dz; w.bx += dx; w.bz += dz; }
  } else if (sel.kind === 'floor') {
    const f = doc.floors[sel.fi];
    if (floorLocked) { redoStack.push(undoStack.pop()); flash('地面层已锁定，无法微移', 'warn', 1400); return false; }
    if (f.strips) { redoStack.push(undoStack.pop()); return false; } // 退回 undo 步
    f.x1 += dx; f.z1 += dz; f.x2 += dx; f.z2 += dz;
  } else return false;
  rebuild(); refreshProps();
  return true;
}

// ── 多选批量操作 ─────────────────────────────────────────────
function _objOfSel(s) {
  if (!s) return null;
  if (s.kind === 'wall') return doc.walls[s.wi] || null;
  if (s.kind === 'floor') return doc.floors[s.fi] || null;
  if (s.kind === 'furniture') return doc.furniture[s.fi] || null;
  return null;
}
function _gidOf(s) { const o = _objOfSel(s); return (o && o.gid) || null; }

// 删除：按类型分组、索引降序 splice，避免前一个删除导致后面索引错位
function deleteSelection() {
  const list = _selList();
  if (!list.length) return;
  pushUndo();

  const walls = new Set(), floors = new Set(), furns = new Set(), stairs = new Set(), opensByWall = {};
  for (const s of list) {
    if (s.kind === 'wall') walls.add(s.wi);
    else if (s.kind === 'floor') floors.add(s.fi);
    else if (s.kind === 'furniture') furns.add(s.fi);
    else if (s.kind === 'stairs') stairs.add(s.si);
    else if (s.kind === 'door' || s.kind === 'window' || s.kind === 'opening') {
      (opensByWall[s.wi] = opensByWall[s.wi] || []).push(s.oi);
    }
  }
  for (const wi in opensByWall) {
    const w = doc.walls[wi]; if (!w) continue;
    opensByWall[wi].sort((a, b) => b - a).forEach(oi => w.openings.splice(oi, 1));
  }
  [...walls].sort((a, b) => b - a).forEach(i => doc.walls.splice(i, 1));
  [...floors].sort((a, b) => b - a).forEach(i => doc.floors.splice(i, 1));
  [...furns].sort((a, b) => b - a).forEach(i => doc.furniture.splice(i, 1));
  [...stairs].sort((a, b) => b - a).forEach(i => doc.stairs.splice(i, 1));
  sel = null; _selMirror = null;
  rebuild(); refreshProps();
  flash(`已删除 ${list.length} 项`, 'success', 1200);
}

// 复制一份并偏移 0.3m（多选整体复制）
function duplicateSelection() {
  const list = _selList();
  if (!list.length) return;
  pushUndo();
  const OFF = 0.3, newSel = [];
  for (const s of list) {
    if (s.kind === 'wall') {
      const w0 = doc.walls[s.wi]; if (!w0) continue;
      const nw = JSON.parse(JSON.stringify(w0));
      nw.ax += OFF; nw.az += OFF; nw.bx += OFF; nw.bz += OFF;
      doc.walls.push(nw); newSel.push({ kind: 'wall', wi: doc.walls.length - 1 });
    } else if (s.kind === 'floor') {
      const f0 = doc.floors[s.fi]; if (!f0) continue;
      const nf = JSON.parse(JSON.stringify(f0));
      nf.x1 += OFF; nf.x2 += OFF; nf.z1 += OFF; nf.z2 += OFF;
      if (nf.strips) nf.strips = nf.strips.map(([za, zb, xa, xb]) => [za + OFF, zb + OFF, xa + OFF, xb + OFF]);
      doc.floors.push(nf); newSel.push({ kind: 'floor', fi: doc.floors.length - 1 });
    } else if (s.kind === 'furniture') {
      const f0 = doc.furniture[s.fi]; if (!f0) continue;
      doc.furniture.push({ ...f0, x: f0.x + OFF, z: f0.z + OFF });
      newSel.push({ kind: 'furniture', fi: doc.furniture.length - 1 });
    }
  }
  _setSelItems(newSel);
  rebuild(); refreshProps();
  flash(`已复制 ${newSel.length} 项`, 'success', 1200);
}

// 编组：给选中对象打同一个 gid（门窗是墙的子级，自动跟随）
function groupSelection() {
  const objs = _selList().map(_objOfSel).filter(Boolean);
  if (objs.length < 2) return flash('至少选中 2 项才能成组', 'warn', 1600);
  pushUndo();
  const gid = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  objs.forEach(o => { o.gid = gid; });
  doc.groups.push({ id: gid, name: `组 ${doc.groups.length + 1}` });
  rebuild(); refreshProps();
  flash(`已成组（${objs.length} 项）`, 'success');
}
function ungroupSelection() {
  const objs = _selList().map(_objOfSel).filter(Boolean);
  const gids = new Set(objs.map(o => o.gid).filter(Boolean));
  if (!gids.size) return flash('所选对象没有编组', 'warn', 1600);
  pushUndo();
  objs.forEach(o => { delete o.gid; });
  // 清掉不再被任何成员引用的组
  const alive = new Set();
  doc.walls.concat(doc.floors, doc.furniture).forEach(o => { if (o.gid) alive.add(o.gid); });
  doc.groups = doc.groups.filter(g => alive.has(g.id));
  rebuild(); refreshProps();
  flash('已解组', 'success');
}
function setSelectionLock(v) {
  const list = _selList();
  if (!list.length) return;
  pushUndo();
  list.forEach(s => { const o = _objOfSel(s); if (o) o.locked = !!v; });
  rebuild(); refreshProps();
  flash(v ? '已锁定所选' : '已解锁所选', 'success', 1200);
}
function setSelectionHidden(v) {
  const list = _selList();
  if (!list.length) return;
  pushUndo();
  list.forEach(s => {
    const k = s.kind === 'wall' ? `wall:${s.wi}` : s.kind === 'floor' ? `floor:${s.fi}`
            : s.kind === 'furniture' ? `furniture:${s.fi}` : null;
    if (!k) return;
    if (v) doc.hidden[k] = true; else delete doc.hidden[k];
  });
  rebuild(); refreshProps();
  flash(v ? '已隐藏所选' : '已显示所选', 'success', 1200);
}

function syncUndoButtons() {
  // 顶栏上的撤销/重做按钮已移除；快捷键 Ctrl+Z / Ctrl+Y 仍然有效，这里保留同步函数避免调用点抛错
}
function undo() {
  if (!undoStack.length) return flash('没有可撤销的操作', 'warn');
  redoStack.push(JSON.stringify(doc));
  doc = JSON.parse(undoStack.pop()); normDoc();
  sel = null; rebuild(); refreshProps(); flash('已撤销', 'success'); syncUndoButtons();
}
function redo() {
  if (!redoStack.length) return flash('没有可重做的操作', 'warn');
  undoStack.push(JSON.stringify(doc));
  doc = JSON.parse(redoStack.pop()); normDoc();
  sel = null; rebuild(); refreshProps(); flash('已重做', 'success'); syncUndoButtons();
}

// 存取
function _buildFileJSON() {
  return JSON.stringify({
    tp3dVersion: TP3D_VERSION,
    name: doc.name || currentEntry()?.name || '未命名',
    updatedAt: Date.now(),
    doc,
  }, null, 2);
}
function _parseFileJSON(text) {
  const obj = JSON.parse(text);
  if (obj && typeof obj === 'object' && 'doc' in obj && 'tp3dVersion' in obj) return obj;
  // 旧版裸 doc:整段就是 doc
  return { tp3dVersion: TP3D_VERSION, name: doc?.name || '未命名', updatedAt: Date.now(), doc: obj };
}
async function _writeCurrentToHandle(handle) {
  if (!handle) throw new Error('没有文件句柄');
  const w = await handle.createWritable();
  await w.write(_buildFileJSON());
  await w.close();
}
async function _readFromHandle(handle) {
  const f = await handle.getFile();
  const text = await f.text();
  return { parsed: _parseFileJSON(text), lastModified: f.lastModified, fileName: f.name };
}

// 把当前 doc 写入 currentHandle;若无 handle 则退化为另存为
async function saveDoc() {
  // ── 服务器模式:直接写 editor 目录,无选择器/无确认 ──
  if (await srvProbe()) {
    try {
      let ent = currentEntry();
      const fname = _srvFileName(ent || { name: doc.name || '未命名' });
      const r = await srvPut(fname, _buildFileJSON());
      if (!ent) {
        // 未建档(草稿/未命名):静默建档并挂上当前文件
        const id = newId();
        ent = { id, name: doc.name || '未命名', fileName: fname, updatedAt: r.mtime, _srv: true };
        filesIndex.unshift(ent);
        currentFileId = id;
      } else {
        ent.fileName = fname; ent.updatedAt = r.mtime; ent._srv = true;
      }
      saveFilesIndex();
      _clearAutosaveDraft();
      if (currentFileId) await snapPut(currentFileId);
      markUnsaved(false);
      toast('已保存到 editor 目录：' + fname, 'success', 1500);
      renderFilesPanel();
    } catch (e) {
      toast('保存失败：' + (e?.message || e), 'error', 6000);
    }
    return;
  }
  if (!FS_SUPPORT) return saveDocAs();
  if (!currentHandle) return saveDocAs();
  try {
    await _writeCurrentToHandle(currentHandle);
    const ent = currentEntry();
    if (ent) { ent.updatedAt = Date.now(); saveFilesIndex(); }
    _clearAutosaveDraft();       // 用户已成功保存到文件,清除本地草稿防 boot 覆盖
    if (currentFileId) await snapPut(currentFileId);  // 同步快照(切回时版本对比用)
    markUnsaved(false);
    toast('已保存：' + (ent?.name || currentHandle.name), 'success', 1500);
    renderFilesPanel();
  } catch (e) {
    if (e && e.name === 'NotAllowedError') { toast('保存被拒绝：请重新选位置', 'warn', 2400); return; }
    toast('保存失败：' + (e?.message || e), 'error', 6000);
  }
}
async function saveDocAs() {
  // 服务器模式:按当前名直接写盘(不弹另存选择器);改名用右键「重命名」
  if (await srvProbe()) return saveDoc();
  if (!FS_SUPPORT) {
    // 降级:浏览器下载
    return exportJSON();
  }
  // 走同目录:无 currentHandle + 已设模型目录 → 直接写 <模型目录>/<safeName>.tp3d.json,不弹 picker
  let handle = null;
  let usedDirShortcut = false;
  if (!currentHandle && DIR_PICKER_SUPPORT) {
    try {
      const dir = await _ensureAssetDir();
      if (dir) {
        const suggested = safeFileName(doc.name || '新建户型') + '.tp3d.json';
        const fh = await dir.getFileHandle(suggested, { create: true });
        // FSA 不会告诉你哪个文件是 picker 选的,这里 getFileHandle 直接拿到
        // 为了让 filesIndex 列表能复用,包装一个 handle-like(仅供本函数后续用)
        handle = fh;
        usedDirShortcut = true;
      }
    } catch (e) {
      if (e && e.name !== 'AbortError') {
        // 写磁盘失败:回落到 picker
        console.warn('[saveDocAs] 写模型目录失败,回落 picker', e);
      }
      handle = null;
    }
  }
  if (!handle) {
    try {
      const suggested = safeFileName(doc.name || currentEntry()?.name || '新建户型');
      handle = await window.showSaveFilePicker({
        suggestedName: suggested + '.tp3d.json',
        types: [{ description: 'TP3D 文件', accept: { 'application/json': ['.tp3d.json'] } }],
      });
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return;
      toast('另存为失败：' + (e?.message || e), 'error', 6000);
      return;
    }
  }
  try {
    await _writeCurrentToHandle(handle);
    // 列表中查找是否已有这个 handle(同文件句柄复用 id)
    let entry = filesIndex.find(e => e._handle === handle);
    if (!entry) {
      entry = { id: newId(), name: handle.name.replace(/\.tp3d\.json$/i, ''), fileName: handle.name, updatedAt: Date.now() };
      filesIndex.unshift(entry);
    } else {
      entry.name = handle.name.replace(/\.tp3d\.json$/i, '');
      entry.fileName = handle.name;
      entry.updatedAt = Date.now();
    }
    entry._handle = handle;
    currentFileId = entry.id;
    currentHandle = handle;
    await idbPut(entry.id, handle);
    saveFilesIndex();
    _clearAutosaveDraft();       // 同上:成功另存到文件后清本地草稿
    markUnsaved(false);
    doc.name = entry.name;
    rebuild(); refreshProps();
    renderFilesPanel();
    const loc = usedDirShortcut ? ` (保存到模型目录「${_assetDirDisplayName()}」)` : '';
    toast(`已另存为：${entry.name}${loc}`, 'success', 2000);
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return;
    toast('另存为失败：' + (e?.message || e), 'error', 6000);
  }
}
async function loadDoc() {
  // 顶栏"打开":走多选 picker
  await openPicker();
}
async function openPicker() {
  if (!FS_SUPPORT) {
    // 降级:文件输入
    return _openViaInput();
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: 'TP3D 文件', accept: { 'application/json': ['.tp3d.json', '.json'] } }],
    });
    if (!handle) return;
    const entry = await _adoptHandle(handle);
    await switchToEntry(entry.id);
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return;
    toast('打开失败：' + (e?.message || e), 'error', 6000);
  }
}
function _openViaInput() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,.tp3d.json,application/json';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const text = await f.text();
      const parsed = _parseFileJSON(text);
      const id = newId();
      const entry = { id, name: parsed.name || f.name.replace(/\.(tp3d\.)?json$/i, ''), fileName: f.name, updatedAt: f.lastModified || Date.now() };
      filesIndex.unshift(entry);
      saveFilesIndex();
      await switchToEntry(id, parsed);
    } catch (e) { toast('读取失败：' + (e?.message || e), 'error', 6000); }
  };
  inp.click();
}
async function _adoptHandle(handle) {
  let entry = filesIndex.find(e => e._handle === handle);
  if (!entry) {
    entry = { id: newId(), name: handle.name.replace(/\.(tp3d\.)?json$/i, ''), fileName: handle.name, updatedAt: Date.now() };
    filesIndex.unshift(entry);
    saveFilesIndex();
  }
  entry._handle = handle;
  await idbPut(entry.id, handle);
  return entry;
}
async function switchToEntry(id, preParsed) {
  if (id === currentFileId && !preParsed) return;
  const entry = filesIndex.find(f => f.id === id);
  if (!entry) return;
  // 切走前把当前文档(含未保存编辑)快照进 IndexedDB —— 任何情况下不丢工作,
  // 因此不再弹"放弃未保存的修改?"对话框(它本身就会把切换卡死)
  if (currentFileId) await snapPut(currentFileId);
  let parsed = preParsed || null;
  if (!parsed) {
    // 来源优先级:服务器文件(editor 目录,最新) → 磁盘句柄 → IndexedDB 快照 → 报错
    let readErr = null;
    const srvAvail = await srvProbe();
    if (entry._srv && srvAvail) {
      try {
        const text = await srvGet(_srvFileName(entry));
        parsed = _parseFileJSON(text);
        entry.updatedAt = parsed.updatedAt || entry.updatedAt;
      } catch (e) {
        readErr = e;
      }
    }
    if (!parsed && !entry._srv && entry._handle) {
      try {
        if (entry._handle.queryPermission) {
          const p = await entry._handle.queryPermission({ mode: 'readwrite' });
          if (p !== 'granted') {
            const r = await entry._handle.requestPermission({ mode: 'readwrite' });
            if (r !== 'granted') readErr = new Error('权限被拒绝');
          }
        }
        if (!readErr) {
          const res = await _readFromHandle(entry._handle);
          parsed = res.parsed;
          entry.fileName = res.fileName;
          entry.updatedAt = res.lastModified || Date.now();
          saveFilesIndex();
        }
      } catch (e) {
        readErr = e;
      }
    } else {
      readErr = new Error('no-handle');
    }
    if (!parsed) {
      const snap = await snapGet(id);
      if (snap && snap.json) {
        try { parsed = _parseFileJSON(snap.json); } catch (e) { parsed = null; }
        if (parsed) toast('无法访问原文件,已从浏览器本地缓存打开', 'info', 3200);
      }
    }
    if (!parsed) {
      toast('读取失败:' + ((readErr && readErr.message) || '未知原因') + '。请用右键"重新选位置"', 'error', 5000);
      return;
    }
    // 快照比刚读到的内容新 → 上次切走时有未保存的编辑,优先恢复快照
    const snap2 = await snapGet(id);
    if (snap2 && snap2.json) {
      try {
        const sp = JSON.parse(snap2.json);
        if (sp && sp.updatedAt && parsed.updatedAt && sp.updatedAt > parsed.updatedAt + 1000) {
          parsed = sp;
          toast('已恢复上次未保存的编辑(磁盘版本更旧)', 'info', 3600);
        }
      } catch (e) { /* 快照损坏则忽略,用磁盘版本 */ }
    }
  } else {
    // preParsed(非 FSA 导入 / 测试注入):入列后立刻落快照,之后可随时切回
    await snapPut(id);
  }
  // 关键:跨文件切换,清空 undo/redo 栈(否则 Ctrl+Z 会跨文件)
  undoStack.length = 0; redoStack.length = 0;
  doc = parsed.doc;
  if (!doc.name) doc.name = entry.name;
  try { normDoc(); } catch (e) {
    toast('文件数据不完整,打开失败:' + (e?.message || e), 'error', 5000);
    return;
  }
  _hydrateCustomAssets();     // 切换文档后重新灌自定义模型字节
  sel = null;
  currentFileId = entry.id;
  currentHandle = entry._handle || null;
  rebuild(); refreshProps();
  _syncTopbarKb();
  _clearAutosaveDraft();         // 切到新文档,清旧草稿
  markUnsaved(false);
  renderFilesPanel();
  toast('已打开:' + entry.name, 'success', 1400);
}
async function _confirmDiscardUnsaved() {
  if (!unsaved) return true;
  return await new Promise(resolve => {
    tpDialog('放弃未保存的修改?', '<div class="note">当前文档有未保存的改动,继续切换会丢失。是否先保存?</div>', [
      { t: '保存并切换', fn: async () => { await saveDoc(); resolve(true); } },
      { t: '放弃改动', fn() { resolve(true); } },
      { t: '取消', fn() { resolve(false); } },
    ]);
  });
}
function exportJSON() {
  // 走下载,作为无 FSA 浏览器 / "分享给他人" 用途
  try {
    const blob = new Blob([_buildFileJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    const fname = safeFileName(doc.name || '未命名') + '.tp3d.json';
    a.href = URL.createObjectURL(blob); a.download = fname; a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 ' + fname, 'success', 1600);
    _warnCustomAssetsOnExport();
  } catch (e) { toast('导出失败:' + (e?.message || e), 'error'); }
}
function importUnderlay() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      const maxW = 1600;
      const sc = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * sc));
      c.height = Math.max(1, Math.round(img.height * sc));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      pushUndo();
      doc.underlay = {
        src: c.toDataURL('image/jpeg', 0.82),
        aspect: c.height / c.width,
        w: 8, cx: 2.95, cz: 3.3, opacity: 0.5, visible: true,
      };
      rebuild(); refreshProps();
      markUnsaved(true);
      flash('底图已导入:调好比例与位置后照着描墙（F6）');
    };
    img.src = URL.createObjectURL(f);
  };
  inp.click();
}
function removeUnderlay() {
  if (!doc.underlay) return flash('当前没有底图');
  pushUndo();
  doc.underlay = null;
  texCache.clear();
  rebuild(); refreshProps(); markUnsaved(true); flash('底图已移除');
}

// ── 导入外部 3D HTML(从单文件 Three.js demo 提取 window.PLAN) ─────
function _extractPlanJson(html) {
  // 平衡花括号扫描:抓 window.PLAN = {...}; 块,避免误吞后续代码
  const re = /window\.PLAN\s*=\s*/;
  const i = html.search(re);
  if (i < 0) throw new Error('未找到 window.PLAN = {...}');
  let j = i + html.slice(i).match(re)[0].length;
  if (html[j] !== '{') throw new Error('window.PLAN 后面不是 {');
  let depth = 0, inStr = false, esc = false, q = '"', start = j;
  for (; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) inStr = false;
    } else {
      if (c === '"' || c === "'") { inStr = true; q = c; }
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
    }
  }
  throw new Error('window.PLAN 的对象未闭合');
}

// ── Demo 结构化数据解析(无 window.PLAN 的 fallback) ─────────────────
// 扫描常见命名:`const WALLS = [...]`、`const ROOMS = [...]`、
// `const DOORS = [...]`、`const ICONS = [...]`、`const S = 1/N`(像素→米缩放)
// 多名字 fallback:每个槽位按候选名顺序试,谁先扫到非空就用谁
// 返回 { walls:[[x1,y1,x2,y2]像素], rooms:[{x1,y1,x2,y2,name,c}], doors:[{axis,x,y}], icons:[{x,y,t}], unit: 像素→米, colorMap? }
function _extractDemoData(html) {
  const out = { walls: [], rooms: [], doors: [], icons: [], unit: null, cx: 0, cy: 0 };

  // 0) 多名字候选(按顺序扫,谁先有结果用谁)
  const CANDIDATES = {
    walls: ['WALLS', 'wallList', 'WALL_LIST', 'wallData', 'walls', 'wallSegs'],
    rooms: ['ROOMS', 'roomList', 'ROOM_LIST', 'rooms', 'roomData', 'roomRects'],
    doors: ['DOORS', 'doorList', 'DOOR_LIST', 'doors', 'doorData'],
    icons: ['ICONS', 'iconList', 'ICON_LIST', 'icons', 'iconData', 'furnList', 'FURN'],
    furn:  ['FURN', 'furnList', 'FURNITURE', 'furniture', 'FURN_LIST'],
    colors: ['FLOOR_COLOR', 'COLOR', 'colorMap', 'ROOM_COLOR'],
  };

  // 1) 缩放 + 中心: `const S  = 1/30;` / `const CX = 427, CY = 316;`
  //    也支持 `const SCALE = ...` / `const CENTER = ...`
  const mS = html.match(/(?:const|let|var)\s+(?:S|SCALE)\s*=\s*1\s*\/\s*(\d+(?:\.\d+)?)/);
  if (mS) out.unit = +mS[1] ? 1 / +mS[1] : null;
  if (!out.unit) {
    const mScale = html.match(/(?:const|let|var)\s+(?:S|SCALE|unit|UNIT)\s*=\s*([\d.]+)/);
    if (mScale) out.unit = +mScale[1];
  }
  const mC = html.match(/(?:const|let|var)\s+(?:CX|CENTER_X)\s*=\s*(-?\d+(?:\.\d+)?)\s*,\s*(?:CY|CENTER_Y)\s*=\s*(-?\d+(?:\.\d+)?)/);
  if (mC) { out.cx = +mC[1]; out.cy = +mC[2]; }

  // 2) 找第一个有内容的数组(每个槽位独立扫,谁先非空用谁)
  const firstBlock = (names) => {
    for (const n of names) {
      const b = _extractArrayBlock(html, n);
      if (b && b.length > 20) return b;
    }
    return null;
  };

  // 3) WALLS: `[x1,y1,x2,y2]` 数组
  const wallBlock = firstBlock(CANDIDATES.walls);
  if (wallBlock) {
    const re = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
    let m; while ((m = re.exec(wallBlock))) out.walls.push([+m[1], +m[2], +m[3], +m[4]]);
  }
  // 4) ROOMS: 对象字段顺序不固定({id, name, x1, y1, x2, y2, c})
  const roomBlock = firstBlock(CANDIDATES.rooms);
  if (roomBlock) {
    const objRe = /\{[^{}]+\}/g;
    let om;
    while ((om = objRe.exec(roomBlock))) {
      const obj = om[0];
      const grab = (key) => {
        const m = obj.match(new RegExp(`(?:^|[,\\s])${key}\\s*:\\s*['"]?([^'",\\s]+)['"]?`));
        return m ? m[1] : '';
      };
      const x1 = +grab('x1'), y1 = +grab('y1'), x2 = +grab('x2'), y2 = +grab('y2');
      if (!Number.isFinite(x1) || !Number.isFinite(x2)) continue;
      out.rooms.push({ x1, y1, x2, y2, name: grab('name') || grab('title'), c: grab('c') || grab('color') });
    }
  }
  // 5) DOORS: `{axis:'h'|'v', x, y}`
  const doorBlock = firstBlock(CANDIDATES.doors);
  if (doorBlock) {
    const re = /\{\s*axis\s*:\s*['"]([hv])['"]\s*,\s*(?:x\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*y\s*:\s*(-?\d+(?:\.\d+)?)|y\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*x\s*:\s*(-?\d+(?:\.\d+)?))\s*\}/g;
    let m;
    while ((m = re.exec(doorBlock))) {
      const axis = m[1];
      const x = m[2] != null ? +m[2] : +m[5];
      const y = m[3] != null ? +m[3] : +m[4];
      out.doors.push({ axis, x, y });
    }
  }
  // 6) ICONS: `{x:.., y:.., t:'..'}`  或  `{x, y, type:'..'}`
  const iconBlock = firstBlock(CANDIDATES.icons);
  if (iconBlock) {
    const re = /\{\s*x\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*y\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(?:t|type|kind)\s*:\s*['"]([^'"]+)['"]\s*\}/g;
    let m;
    while ((m = re.exec(iconBlock))) out.icons.push({ x: +m[1], y: +m[2], t: m[3] });
  }
  // 7) FLOOR_COLOR: 颜色键值表
  const colorBlock = (() => {
    for (const n of CANDIDATES.colors) {
      const b = _extractObjectBlock(html, n);
      if (b && b.length > 20) return b;
    }
    return null;
  })();
  if (colorBlock) {
    const colorMap = {};
    const re = /(\w+)\s*:\s*(?:0x|#)([0-9a-fA-F]{6})/g;
    let m;
    while ((m = re.exec(colorBlock))) colorMap[m[1]] = '#' + m[2];
    out.colorMap = colorMap;
  }
  return out;
}

// 辅助:从 html 中提取 `const NAME = [ ... ];` 或 `const NAME = [ ... ]` 的数组块内容
function _extractArrayBlock(html, name) {
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\[`);
  const i = html.search(re);
  if (i < 0) return null;
  let j = i + html.slice(i).match(re)[0].length;
  // 找到匹配的 ]  —— 跟踪字符串和嵌套;depth 从 1 起算(已在外层 [ 内)
  let depth = 1, inStr = false, esc = false, q = '"';
  for (; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) inStr = false;
    } else {
      if (c === '"' || c === "'") { inStr = true; q = c; }
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) return html.slice(i, j + 1); }
    }
  }
  return null;
}

// 辅助:提取 `const NAME = { ... };` 的对象块
function _extractObjectBlock(html, name) {
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{`);
  const i = html.search(re);
  if (i < 0) return null;
  let j = i + html.slice(i).match(re)[0].length;
  let depth = 1, inStr = false, esc = false, q = '"';
  for (; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) inStr = false;
    } else {
      if (c === '"' || c === "'") { inStr = true; q = c; }
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return html.slice(i, j + 1); }
    }
  }
  return null;
}

// ── AI 兜底:从 HTML 中提取"业务 JS 代码"(剔 three.js 库内联) ─────
// 思路:找到最大 <script> 段,剔除明显是库定义的代码(class extends ... = function,
// 大块常量定义,典型 three.js 关键字如 MeshStandardMaterial 等)
// 返回字符串:截断到 maxLen,优先保留含 WALLS/ROOMS/ICONS 的段落
function _extractJsCode(html, maxLen = 30000) {
  // 1) 抓所有 <script>...</script>
  const scripts = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const code = m[1];
    // 跳过 import / src 引用型
    if (/^\s*import\s/.test(code)) continue;
    scripts.push(code);
  }
  if (!scripts.length) return '';
  // 2) 选最大的(业务代码通常远大于库代码?—— 实际上常相反,选第二大的更稳)
  scripts.sort((a, b) => b.length - a.length);
  // 3) 简化:取最大的,直接裁短
  let code = scripts[0];
  // 4) 截断到 maxLen,优先保留含关键字段的行(前后各 200 字符)
  if (code.length > maxLen) {
    // 找关键字段位置
    const keys = ['WALLS', 'ROOMS', 'DOORS', 'ICONS', 'FURN', 'FLOOR_COLOR', 'toZ', 'toX'];
    const positions = [];
    for (const k of keys) {
      const i = code.indexOf(k);
      if (i >= 0) positions.push(i);
    }
    if (positions.length) {
      // 取 positions 中位数为中心,前后各 maxLen/2
      positions.sort((a, b) => a - b);
      const center = positions[Math.floor(positions.length / 2)];
      const half = Math.floor(maxLen / 2);
      const start = Math.max(0, center - half);
      const end = Math.min(code.length, start + maxLen);
      code = '/* ... [前段省略] ... */\n' + code.slice(start, end) + '\n/* ... [后段省略] ... */';
    } else {
      code = code.slice(0, maxLen) + '\n/* ... [后段省略] ... */';
    }
  }
  return code;
}

// ── demo 数据 → 编辑器 .tp3d.json(等价于 AI 输出的 schema) ──────────
// 已知 demo 类型 → 编辑器家具 type 映射
const DEMO_ICON_MAP = {
  person:   'diningChair',
  printer:  'desk',
  coffee:   'tea',
  wc:     'toilet',
  baby:   'cabinetWhite',
};
function _demoDataToPlan(data) {
  const cx = data.cx || 0, cy = data.cy || 0;
  const unit = data.unit || 0.0256;  // 默认与 importPlanFromText 一致
  const p2 = (p) => +(p * unit).toFixed(3);  // 注意:demo 像素单位已是世界单位(unit=1/30=0.033m),
  // 我们需要 (px-cx)*unit 转成世界米。重新实现:
  const tx = (px) => +((px - cx) * unit).toFixed(3);
  const tz = (py) => +((py - cy) * unit).toFixed(3);
  // 1) 墙
  const walls = data.walls.map(([x1, y1, x2, y2]) => {
    return mkWall(tx(x1), tz(y1), tx(x2), tz(y2));
  });
  // 2) 地面(每个房间一块)
  const colorMap = data.colorMap || {};
  const floors = data.rooms.map(r => {
    const color = colorMap[r.c] || themeCur().floor.color;
    return {
      x1: tx(r.x1), z1: tz(r.y1),
      x2: tx(r.x2), z2: tz(r.y2),
      th: 0.05, name: r.name || r.id || '', lv: 0,
      color, tex: undefined,
    };
  });
  // 3) 门:在最近墙上插入 door opening
  for (const d of data.doors) {
    // 找最近的墙(d 在墙的某个端点附近 / 或在墙中段)
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      // 简化:像素坐标已经丢弃了,这里直接用 d.x, d.y → 世界
      const dwx = tx(d.x), dwz = tz(d.y);
      // 点到线段距离
      const ax = w.ax, az = w.az, bx = w.bx, bz = w.bz;
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((dwx - ax) * dx + (dwz - az) * dz) / len2));
      const px = ax + t * dx, pz = az + t * dz;
      const dist = Math.hypot(dwx - px, dwz - pz);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    if (bestIdx < 0) continue;
    // 距离过远:跳过(门可能在房间内某处,找不到墙)
    if (bestDist > 0.5) continue;
    const w = walls[bestIdx];
    // 计算 door 的 t 比例(d 在墙上的归一化位置)
    const dx = w.bx - w.ax, dz = w.bz - w.az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) continue;
    const t = Math.max(0.05, Math.min(0.95, ((tx(d.x) - w.ax) * dx + (tz(d.y) - w.az) * dz) / len2));
    w.openings.push(mkDoor(t, 0.9, { kind: 'single', flip: false }));
  }
  // 4) 家具(从 icons 映射)
  const furniture = [];
  const skipped = {};
  for (const ic of data.icons) {
    const type = DEMO_ICON_MAP[ic.t];
    if (!type) { skipped[ic.t] = (skipped[ic.t] || 0) + 1; continue; }
    if (!FURN[type]) { skipped[ic.t] = (skipped[ic.t] || 0) + 1; continue; }
    furniture.push({ type, x: tx(ic.x), z: tz(ic.y), rot: 0, lv: 0 });
  }
  return {
    wallH: 2.6,
    levels: [{ name: '1F', elev: 0 }],
    walls, floors, furniture,
  };
}

// 暴露给 e2e + 被 importPlanHtml 调用
function importPlanFromText(text, sourceName = '外部 3D HTML') {
  const json = _extractPlanJson(text);
  const plan = JSON.parse(json);
  const M = plan.unit || 0.0256;
  const p2 = p => +(p * M).toFixed(3);
  // 1) 墙
  const walls = (plan.walls || []).map(w => {
    const [t, a, b, c] = w;
    if (t === 'h') return mkWall(p2(a), p2(b), p2(a), p2(c));
    if (t === 'v') return mkWall(p2(b), p2(a), p2(c), p2(a));
    return null;
  }).filter(Boolean);
  // 2) 地面:每个 room + open 各一块矩形地面
  const roomRects = [
    ...(plan.rooms || []).map(r => ({ rect: r.rect, name: r.name || r.id })),
    ...(plan.open ? [{ rect: plan.open.rect, name: plan.open.name || '开放区' }] : []),
  ];
  const floors = roomRects.map(({ rect, name }) => ({
    x1: p2(rect[0]), z1: p2(rect[1]),
    x2: p2(rect[2]), z2: p2(rect[3]),
    th: 0.15, name, lv: 0,
    color: themeCur().floor.color, tex: themeCur().floor.tex || undefined,
  }));
  // 3) 家具:7 种类型映射
  const KIND_MAP = {
    desk: 'desk', chair: 'diningChair', monitor: 'computer',
    sofa: 'sofa', shelf: 'shelf', roundtable: 'tea',
  };
  const furniture = [];
  const skipped = {};
  for (const t of plan.furn || []) {
    const [kind, x, y, ...rest] = t;
    const type = KIND_MAP[kind];
    if (!type) { skipped[kind] = (skipped[kind] || 0) + 1; continue; }
    // 推断 rot:多数 tuple rot 在末尾;特殊:roundtable 没有 rot
    const rot = (kind === 'roundtable') ? 0
              : (typeof rest[rest.length - 1] === 'number' ? rest[rest.length - 1] : 0);
    furniture.push({ type, x: p2(x), z: p2(y), rot });
  }
  const skippedMsg = Object.keys(skipped).length
    ? `(跳过 ${Object.entries(skipped).map(([k, v]) => `${k}×${v}`).join(', ')})`
    : '';
  // 4) 装载(走 newDoc 流程,不污染文件工作区)
  undoStack.length = 0; redoStack.length = 0;
  doc = {
    name: sourceName.replace(/\.html?$/i, ''),
    wallH: 2.6,
    levels: [{ name: '1F', elev: 0 }],
    walls, floors, furniture,
    hidden: {},
  };
  normDoc();
  sel = null;
  rebuild(); refreshProps();
  _syncTopbarKb();
  markUnsaved(true);
  toast(
    `已从 ${sourceName} 导入: ${walls.length} 墙 / ${floors.length} 地面 / ${furniture.length} 家具 ${skippedMsg}`,
    'success', 2800
  );
}

// ── AI 转换:接收 AI 已经"翻译"好的标准化 JSON,直接装载 ──────────────
// AI 输出的标准格式(由 prompt 引导):
// {
//   "wallH": 2.6,
//   "levels": [{ "name": "1F", "elev": 0 }],
//   "walls":     [{ "ax":0,"az":0,"bx":3,"bz":0,"th":0.12,
//                   "openings":[{"type":"door","t":0.5,"width":0.9,"height":2.1,"kind":"single","flip":false},
//                               {"type":"window","t":0.5,"width":1.2,"height":1.4,"sill":0.9}] }],
//   "floors":    [{ "x1":-5,"z1":-5,"x2":5,"z2":5,"th":0.05,"color":"#dcd6cc","name":"客厅","lv":0 }],
//   "furniture": [{ "type":"desk","x":1.5,"z":2,"rot":0,"scale":1,"lv":0,"name":"" }]
// }
function importPlanFromAI(json, sourceName = 'AI 转换') {
  // 容错:AI 有时会包 ```json fence 或首尾夹了多余字符,自动剥
  let _raw = json;
  if (typeof _raw === 'string') {
    let s = _raw.trim();
    const m = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
    if (m) s = m[1];
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    _raw = JSON.parse(s);
  }
  const raw = _raw;
  const plan = (raw && typeof raw === 'object') ? raw : {};
  // 1) 墙:openings 用 mkDoor/mkWin 构造,不是裸对象
  const walls = (plan.walls || []).map(w => {
    if (!Number.isFinite(+w.ax) || !Number.isFinite(+w.bx)) return null;
    const m = mkWall(+w.ax || 0, +w.az || 0, +w.bx || 0, +w.bz || 0);
    if (w.th != null) m.th = +w.th;
    if (w.h != null)  m.h = +w.h;
    if (Array.isArray(w.openings)) {
      for (const op of w.openings) {
        if (op.type === 'door') {
          m.openings.push(mkDoor(op.t ?? 0.5, op.width ?? 0.9, {
            kind: op.kind || 'single',
            flip: !!op.flip,
            height: op.height,
          }));
        } else if (op.type === 'window') {
          m.openings.push(mkWin(op.t ?? 0.5, op.width ?? 1.2, {
            height: op.height, sill: op.sill,
          }));
        }
      }
    }
    return m;
  }).filter(Boolean);
  // 2) 地面:color 缺失用 themeCur().floor.color 兜底
  const floors = (plan.floors || []).map(f => ({
    x1: +f.x1, z1: +f.z1, x2: +f.x2, z2: +f.z2,
    th: f.th ?? 0.05,
    color: f.color || themeCur().floor.color,
    tex: f.tex || undefined,
    name: f.name, lv: f.lv ?? 0,
  })).filter(f => Number.isFinite(f.x1) && f.x2 > f.x1 && f.z2 > f.z1);
  // 3) 家具:FURN[type] 二次校验,白名单跳过+记 skipped
  const furniture = [];
  const skipped = {};
  for (const f of (plan.furniture || [])) {
    if (!FURN[f.type]) { skipped[f.type] = (skipped[f.type] || 0) + 1; continue; }
    furniture.push({
      type: f.type, x: +f.x, z: +f.z,
      rot: +(f.rot || 0), lv: f.lv ?? 0,
      scale: f.scale, name: f.name,
    });
  }
  const skippedMsg = Object.keys(skipped).length
    ? `(跳过 ${Object.entries(skipped).map(([k, v]) => `${k}×${v}`).join(', ')})`
    : '';
  // 4) 装载(同 importPlanFromText)
  undoStack.length = 0; redoStack.length = 0;
  doc = {
    name: sourceName.replace(/\.html?$/i, ''),
    wallH: plan.wallH ?? 2.6,
    levels: (plan.levels && plan.levels.length) ? plan.levels : [{ name: '1F', elev: 0 }],
    walls, floors, furniture, hidden: {},
  };
  normDoc();
  sel = null;
  rebuild(); refreshProps();
  _syncTopbarKb();
  markUnsaved(true);
  toast(
    `AI 转换完成: ${walls.length} 墙 / ${floors.length} 地面 / ${furniture.length} 家具 ${skippedMsg}`,
    'success', 3200
  );
  return { walls: walls.length, floors: floors.length, furniture: furniture.length, skipped };
}

async function importPlanHtmlFile(file) {
  const text = await file.text();
  return importPlanFromText(text, file.name);
}

function importPlanHtml() {
  // 若当前文档有未保存修改,先确认
  if (typeof _hasUnsaved === 'function' && _hasUnsaved()) {
    if (!confirm('当前文档有未保存修改,导入外部 HTML 将覆盖它。继续?')) return;
  }
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.html,.htm,text/html';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (f) {
      try { await importPlanHtmlFile(f); }
      catch (e) { flash('导入失败:' + (e?.message || e), 'error', 4000); }
    }
  };
  inp.click();
}

// ── AI 转换外部 3D HTML ───────────────────────────────────────
// 浏览器端直接调 minimaxi 的 Anthropic Messages API 兼容反代
// (TODO 上线前: key 移到后端代理或用户本地设置)
async function _aiCallClaude({ system, user, max_tokens = 8192 }) {
  const url = 'https://api.minimaxi.com/anthropic/v1/messages';
  const headers = {
    'content-type': 'application/json',
    'x-api-key': 'sk-cp-PUYHH6AHVJ97o5GLyBAHOo9zYxVboopS3y6bHm41zyTIsZNvjAb1tFafBq0WgYIoImszU_8ICoZZNuuGG5hf4xaQWnoIvbaM0ljbcDCSpf7_b3_sgqrR2mw',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const resp = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({
      model: 'MiniMax-M2.7',
      max_tokens,
      stream: true,
      system: [{ type: 'text', text: system }],
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} ${t.slice(0, 160)}`);
  }
  // SSE 解析: 按 \n\n 切事件, 提取 data: 行 → JSON.parse
  const reader = resp.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '', text = '', thinking = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let dataStr = '';
      for (const ln of block.split('\n')) {
        if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
      }
      if (!dataStr || dataStr === '[DONE]') continue;
      let evt; try { evt = JSON.parse(dataStr); } catch { continue; }
      if (evt.type === 'content_block_delta' && evt.delta) {
        if (evt.delta.type === 'text_delta')      text += evt.delta.text;
        else if (evt.delta.type === 'thinking_delta') thinking += evt.delta.thinking;
      }
    }
  }
  return { text, thinking };
}

async function importPlanHtmlFromAI() {
  if (typeof _hasUnsaved === 'function' && _hasUnsaved()) {
    if (!confirm('当前文档有未保存修改,AI 转换将覆盖它。继续?')) return;
  }
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.html,.htm,text/html';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const html = await f.text();

    // ── 三级 fallback:PLAN → demo 解析 → AI 兜底 ─────────────
    // 1a) PLAN(快路径)
    let planText;
    let planErr;
    try { planText = _extractPlanJson(html); }
    catch (e) { planErr = e; }

    if (planText) {
      // PLAN 找到了 → 走 AI 转换(快路径走 AI,已有逻辑)
    } else {
      // 1b) demo 解析(本地, 不依赖 AI)
      const demo = _extractDemoData(html);
      const hasData = demo.walls.length || demo.rooms.length || demo.icons.length;
      if (hasData) {
        const aiJson = _demoDataToPlan(demo);
        try {
          importPlanFromAI(aiJson, f.name);
          flash(`已从 ${f.name} 提取结构化数据: ${aiJson.walls.length} 墙 / ${aiJson.floors.length} 地面 / ${aiJson.furniture.length} 家具`, 'info', 3000);
          return;
        } catch (e) {
          return flash('Demo 数据导入失败: ' + e.message, 'error', 6000);
        }
      }
      // 1c) 都没找到 → 走 AI 兜底(把 JS 代码段发 AI,让 AI 逆向分析)
      // 设置一个 flag 让下面 2) 走兜底 prompt
      planText = '__AI_FALLBACK__';
      globalThis.__aiFallbackFileName = f.name;
      globalThis.__aiFallbackHtml = html;
      // 不 return —— 继续往下走
    }

    // 2) 拼 prompt
    let user;
    if (planText === '__AI_FALLBACK__') {
      // ── AI 兜底:发整段业务 JS 给 AI,让它逆向分析出 墙/地/家具 ──
      const jsCode = _extractJsCode(globalThis.__aiFallbackHtml || '');
      user =
`以下是用户上传的 Three.js HTML demo 的核心业务 JS 代码(已剔 three.js 库内联)。

任务:逆向分析这段代码,提取房间布局和家具位置,转成"内部 3D 编辑器"的标准 JSON。

分析步骤:
1. 找形如 \`const WALLS = [...]\` 的硬编码数组(墙段 [x1,y1,x2,y2])
   或 \`new THREE.BoxGeometry(...)\` 这种手搭的几何对象(推算位置/尺寸)
2. 找 \`const ROOMS = [...]\` 房间矩形,或从墙体反推房间
3. 找 \`const ICONS = [...]\` 家具位置数组,或 \`new THREE.Mesh(...)\` 中看似家具的 mesh
4. 单位换算:代码里若有 \`const S = 1/N\` 或 \`SCALE = ...\`,把像素坐标乘 S 转米;
   若无缩放系数但用了图块坐标,默认 1 单位 = 0.3 米。

输出严格的 JSON(不要 markdown fence、不要说明)。结构:
{
  "wallH": 2.6,
  "levels": [{ "name": "1F", "elev": 0 }],
  "walls":     [{ "ax":0,"az":0,"bx":3,"bz":0,"th":0.12 }],
  "floors":    [{ "x1":-5,"z1":-5,"x2":5,"z2":5,"th":0.05,"color":"#dcd6cc","name":"客厅","lv":0 }],
  "furniture": [{ "type":"desk","x":1.5,"z":2,"rot":0 }]
}

家具 type 白名单(没有把握的家具类型请直接省略):
desk,shelf,sofa,tea,table,diningChair,officeChair,couchMed,bed,wardrobe,
nightstand,toilet,basin,fridge,computer,tvFlat,tvStand,meetingTable,coffeeTable,
closet,dresser,stool,coatRack,waitingChair,cabinetWhite,woodCabinet,woodPcDesk,
books,bookshelf,picture,indoorPlant,pottedWhite,tree,ceilFan,ceilingLight,
floorLamp,tableLamp,stove,microwave,washer,kitchen,kCounter,kFridge,
kShelf,medFridge,glbFridge,hood,iron,kettle,kitchenCabinet,acBlock,
airConditioner,thermostat,sprinkler,smokeDetector,fireExtinguisher

JS 代码:
\`\`\`
${jsCode}
\`\`\``;
    } else {
      user = `以下是 window.PLAN JSON(已剥离外层 HTML),请按 schema 输出对应 .tp3d.json:\n\n${planText}`;
    }
    const system =
`你是室内平面图分析助手。输入是一段 window.PLAN JSON(已经是从 Three.js demo 里抽出来的)。
你的任务:把这段结构化数据转成"内部 3D 编辑器"的标准 JSON 格式。

输出严格的 JSON(不要任何 markdown fence、不要任何说明文字、不要任何思考过程前缀)。结构:

{
  "wallH": 2.6,
  "levels": [{ "name": "1F", "elev": 0 }],
  "walls":     [{ "ax":0,"az":0,"bx":3,"bz":0,"th":0.12,
                  "openings":[{"type":"door","t":0.5,"width":0.9,"height":2.1,"kind":"single","flip":false},
                              {"type":"window","t":0.5,"width":1.2,"height":1.4,"sill":0.9}] }],
  "floors":    [{ "x1":-5,"z1":-5,"x2":5,"z2":5,"th":0.05,"color":"#dcd6cc","name":"客厅","lv":0 }],
  "furniture": [{ "type":"desk","x":1.5,"z":2,"rot":0,"scale":1,"lv":0,"name":"" }]
}

规则:
- 单位:米(m)。坐标:X 横轴,Z 纵轴。
- 墙 th 默认 0.12,h 默认等于 wallH。
- 门 openings.type="door"(width 0.6-1.5),窗 openings.type="window"(width 1.0-2.4,sill 0.9)。
- door.kind ∈ {"single","double","sliding","garage"},默认 "single"。
- 家具 type 必须从以下白名单选(没有把握的家具类型请直接省略,不要瞎猜):
  bed,bed1,wardrobe,nightstand,desk,shelf,sofa,tea,dining,toilet,basin,fridge,diningChair,officeChair,
  officeTable,glbDesk,couchMed,couchSm,lounge,meetingTable,coffeeTable,table,closet,dresser,tvFlat,
  tvStand,computer,glbSofa,sofaBlack,sofaRow3,stool,coatRack,waitingChair,cabinetWhite,woodCabinet,
  woodPcDesk,woodBedside,bedHeadScreen,bedsideScreen,glbShelf,books,bookshelf,picture,rectangularCarpet,
  rectangularMirror,roundCarpet,roundMirror,wallArt06,wineBottle,laundryBag,firTree,bush,cactus,column,
  fence,hedge,highFence,hydrant,indoorPlant,lowFence,mediumFence,palm,parkingSpot,pillar,pottedWhite,
  smallIndoorPlant,tree,ceilFan,ceilLamp,ceilingLight,floorLamp,tableLamp,stove,microwave,washer,kitchen,
  kCounter,kFridge,kShelf,medFridge,glbFridge,freezer,coffeeMachine,hood,iron,kettle,kitchenCabinet,
  toaster,acBlock,airConditioner,thermostat,sprinkler,smokeDetector,fireExtinguisher,exerciseBike,barbell,
  piano,guitar,stereoSpeaker,television,pcBlack
- rot 用弧度,默认 0。
- 只输出 JSON,严格符合上述 schema。`;

    // 3) 流式调用(长 toast, duration=0, 需 toast 返回 close 句柄)
    const tip = toast(planText === '__AI_FALLBACK__' ? 'AI 逆向分析 HTML 代码…(可能 30-90 秒)' : 'AI 分析中…(通常 10-30 秒)', 'info', 0);
    let res;
    try { res = await _aiCallClaude({ system, user, max_tokens: planText === '__AI_FALLBACK__' ? 16384 : 8192 }); }
    catch (e) {
      tip.close?.();
      const msg = /Failed to fetch|NetworkError|CORS/i.test(e.message)
        ? 'AI 接口跨域被拒或网络中断。可能原因:① minimaxi 未开放浏览器跨域;② 网络问题。请联系作者或自备本地反代服务。'
        : 'AI 调用失败: ' + e.message;
      return flash(msg, 'error', 7000);
    }

    // 4) 解析 JSON(1 次重试)
    const tryParse = (txt) => {
      let s = (txt || '').trim();
      const m = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
      if (m) s = m[1];
      // 兜底:取第一个 { 到最后一个 } 的子串
      const a = s.indexOf('{'), b = s.lastIndexOf('}');
      if (a >= 0 && b > a) s = s.slice(a, b + 1);
      return JSON.parse(s);
    };
    let aiJson;
    try { aiJson = tryParse(res.text); }
    catch (e1) {
      // 重试一次: 强调"只返 JSON"
      try {
        res = await _aiCallClaude({
          system: '只返回 JSON,不要任何其他字符(不要 markdown fence、不要说明、不要思考过程)。',
          user: user + '\n\n上一轮你返回了非纯 JSON,这次请严格只输出 JSON 对象。',
          max_tokens: 8192,
        });
        aiJson = tryParse(res.text);
      } catch (e2) {
        tip.close?.();
        return flash('AI 输出无法解析(已重试 1 次): ' + e2.message, 'error', 7000);
      }
    }
    tip.close?.();

    // 5) 装载
    try {
      importPlanFromAI(aiJson, f.name);
    } catch (e) {
      flash('AI 结果导入失败: ' + e.message, 'error', 6000);
    }
    // 清理兜底临时变量
    globalThis.__aiFallbackFileName = null;
    globalThis.__aiFallbackHtml = null;
  };
  inp.click();
}

// ── 导入自定义 GLB / glTF 模型为家具 ─────────────────────────
// 字节存 IndexedDB，doc.assets 只放元数据（尺寸/分类/文件名）。
function importModel() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.glb,.gltf,model/gltf-binary,model/gltf+json';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (f) importModelFile(f);
  };
  inp.click();
}
// 只量包围盒，不写缓存（避免用临时 key 污染 _glbCache）
async function _measureModelBytes(buf) {
  const gltf = await _gltfLoader.parseAsync(buf.slice(0), '');
  const g = gltf.scene;
  g.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(g);
  return {
    w: +(b.max.x - b.min.x).toFixed(4),
    d: +(b.max.z - b.min.z).toFixed(4),
    h: +(b.max.y - b.min.y).toFixed(4),
  };
}
async function importModelFile(file) {
  let buf;
  try { buf = await file.arrayBuffer(); }
  catch (e) { return toast('读取文件失败：' + (e?.message || e), 'error', 5000); }

  let measured;
  try { measured = await _measureModelBytes(buf); }
  catch (e) { return toast('解析模型失败，请确认是有效的 GLB / glTF 文件', 'error', 6000); }

  // 尺寸单位：GLB 里的单位没有强制约定，>10m 才可能是厘米/毫米。
  // 家具本身可以合法地很大（楼梯、长柜），所以只给「建议值」，让用户在对话框里确认。
  const maxDim = Math.max(measured.w, measured.d, measured.h) || 1;
  const autoScale = maxDim > 100 ? 0.001 : (maxDim > 10 ? 0.01 : 1);

  const baseName = (file.name || '自定义模型').replace(/\.(glb|gltf)$/i, '');
  const catOpts = ['custom', ...FURN_CAT_ORDER.filter(c => c !== 'custom')]
    .map(c => `<option value="${c}">${FURN_CAT_NAMES[c] || c}</option>`).join('');
  const scaleOpts = [[1, '米（模型已是米制）'], [0.01, '厘米 → 米'], [0.001, '毫米 → 米']]
    .map(([v, label]) => `<option value="${v}"${v === autoScale ? ' selected' : ''}>${label}</option>`).join('');
  // 若还没设置保存目录,在对话框里露一行提示,并让导入按钮可选触发选择
  const dirConfigured = !!(await getAssetDirHandle().catch(() => null));
  const dirHint = DIR_PICKER_SUPPORT
    ? (dirConfigured
        ? `<div class="note" style="color:var(--accent)">✓ 模型将保存到磁盘目录「${_assetDirDisplayName()}」,并同时保存在本机数据库(快速加载)</div>`
        : `<div class="note" style="color:#c2410c">⚠️ 尚未设置模型保存目录 —— 导入的模型只会保存到本机浏览器数据库,不能跟项目文件夹一起拷贝走</div>`)
    : `<div class="note">当前浏览器不支持将模型保存到磁盘,只会保存在本机数据库</div>`;
  tpDialog('导入 3D 模型', `
    <div class="frow"><label>名称</label><input id="imName" type="text" value="${baseName.replace(/"/g, '&quot;')}" style="flex:1"></div>
    <div class="frow"><label>分类</label><select id="imCat" style="flex:1">${catOpts}</select></div>
    <div class="frow"><label>模型单位</label><select id="imScale" style="flex:1">${scaleOpts}</select></div>
    <div class="note">换算后尺寸：<b id="imSize">—</b><br>导入后可在家具库找到，并可改尺寸。</div>
    ${dirHint}`,
    [
      { t: '取消' },
      {
        t: '导入',
        fn: async () => {
          const name = (document.getElementById('imName')?.value || baseName).trim() || baseName;
          const cat = document.getElementById('imCat')?.value || 'custom';
          const scale = parseFloat(document.getElementById('imScale')?.value) || 1;
          const w = +(measured.w * scale).toFixed(3);
          const d = +(measured.d * scale).toFixed(3);
          const h = +(measured.h * scale).toFixed(3);
          const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          try {
            await assetPut(id, { id, name, fileName: file.name || '', bytes: buf, addedAt: Date.now() });
          } catch (e) {
            return toast('写入本地数据库失败：' + (e?.message || e), 'error', 6000);
          }
          // 尝试写到磁盘(失败不阻断 —— IDB 已经有了,降级无感)
          let dirStored = false;
          let diskFileName = '';
          if (DIR_PICKER_SUPPORT) {
            try {
              const fname = await _writeAssetToDisk(id, buf);
              if (fname) { dirStored = true; diskFileName = fname; }
            } catch (e) {
              if (e && e.name !== 'AbortError') {
                toast('磁盘写入失败,模型仍保存在本机数据库: ' + (e?.message || e), 'warn', 4000);
              }
            }
          }
          const meta = { id, name, cat, icon: '📦', w, d, h, scale, yOff: 0, fileName: dirStored ? diskFileName : (file.name || ''), dirStored };
          pushUndo();
          doc.assets.push(meta);
          _registerCustomAssetsFromDoc();
          await loadGLBFromBytes(CUSTOM_PREFIX + id, buf).catch(() => {});
          furnType = CUSTOM_PREFIX + id; furnRot = 0; clearGhost();
          rebuild(); refreshProps(); markUnsaved(true);
          _syncAssetDirKb();
          const where = DIR_PICKER_SUPPORT && dirStored ? ' 已同步到磁盘目录' : (DIR_PICKER_SUPPORT ? ' 仅保存在本机数据库' : '');
          toast(`已导入「${name}」（${w.toFixed(2)} × ${d.toFixed(2)} × ${h.toFixed(2)} m）${where}`, 'success', 3600);
        },
      },
    ]);
  // 实时预览换算后的尺寸
  const updSize = () => {
    const sc = parseFloat(document.getElementById('imScale')?.value) || 1;
    const el = document.getElementById('imSize');
    if (el) el.textContent = `${(measured.w * sc).toFixed(2)} × ${(measured.d * sc).toFixed(2)} × ${(measured.h * sc).toFixed(2)} m`;
  };
  const scaleSel = document.getElementById('imScale');
  if (scaleSel) { scaleSel.onchange = updSize; updSize(); }
}
// 删除自定义模型：元数据 + IndexedDB 字节 + 磁盘文件 + 已放置的实例
function deleteCustomAsset(id) {
  const meta = (doc.assets || []).find(a => a.id === id);
  if (!meta) return;
  const used = (doc.furniture || []).filter(f => f.type === CUSTOM_PREFIX + id).length;
  const diskNote = meta.dirStored ? '<br>磁盘上的对应 <code>.glb</code> 文件也会一并删除。' : '';
  tpDialog('删除自定义模型', `
    <div class="note">将删除「${meta.name}」及其模型文件${used ? `，并移除已放置的 ${used} 件` : ''}。${diskNote}<br>此操作可撤销（模型文件本身不会恢复，需要重新导入）。</div>`,
    [
      { t: '取消' },
      { t: '删除', fn: async () => {
        pushUndo();
        doc.assets = (doc.assets || []).filter(a => a.id !== id);
        doc.furniture = (doc.furniture || []).filter(f => f.type !== CUSTOM_PREFIX + id);
        delete FURN[CUSTOM_PREFIX + id];
        _glbCache.delete(CUSTOM_PREFIX + id);
        if (furnType === CUSTOM_PREFIX + id) furnType = null;
        assetDel(id).catch(() => {});
        if (meta.dirStored) _deleteAssetFromDisk(id).catch(() => {});
        _setSelItems(_selList().filter(s => {
          if (s.kind !== 'furniture') return true;
          const f = doc.furniture[s.fi];
          return !!f;
        }));
        rebuild(); refreshProps(); markUnsaved(true);
        toast(`已删除「${meta.name}」`, 'success');
      } },
    ]);
}
// 导出前提醒：自定义模型不会打包进文件
function _warnCustomAssetsOnExport() {
  const n = (doc.assets || []).length;
  if (n) toast(`此文档含 ${n} 个自定义模型，未打包进文件；在别的电脑打开会显示占位盒`, 'warn', 5200);
}
function exportGLB() {
  const hasContent = doc.walls.length || (doc.furniture || []).length;
  if (!hasContent) return flash('画面为空,先画点东西再导出');
  // 暂存并移除需要排除的节点（仅排除底图,地面保留）,导出完恢复
  const excluded = [];
  planGroup.traverse(o => {
    const byUser = o.userData && o.userData.excludeFromExport;
    const byName = o.name && /^(_underlay|grid|ground|helper)/i.test(o.name);
    const byKind = o.userData && o.userData.kind === 'underlay';
    if (byUser || byName || byKind) excluded.push(o);
  });
  excluded.forEach(o => o.parent && o.parent.remove(o));
  const restore = () => excluded.forEach(o => planGroup.add(o));
  const onDone = res => {
    restore();
    const blob = new Blob([res], { type: 'model/gltf-binary' });
    const a = document.createElement('a');
    const fname = safeFileName(doc.name || '未命名') + '.glb';
    a.href = URL.createObjectURL(blob); a.download = fname; a.click();
    URL.revokeObjectURL(a.href);
    flash(`已导出 ${fname}（含地面层,共排除 ${excluded.length} 个底图节点）`);
    _warnCustomAssetsOnExport();
  };
  const onErr = err => {
    restore();
    console.error('GLB export error', err);
    toast('GLB 导出失败:' + (err?.message || err), 'error', 6000);
  };
  new GLTFExporter().parse(planGroup, onDone, onErr, { binary: true });
}

// ============================================================
// DXF 导出 — 借鉴 blueprint3d-babylon dxfExporter.js
// 输出 AutoCAD R12 兼容 2D DXF,含层/线型/标注/门窗符号
// ============================================================
function exportDXF() {
  if (!doc.walls.length && !(doc.furniture || []).length) {
    return flash('画面为空,先画点东西再导出');
  }
  const W = (doc.walls || []);
  const F = (doc.furniture || []);
  const FL = (doc.floors || []);
  const ST = (doc.stairs || []);

  // ── DXF primitives (DXF R12 ASCII) ──────────────────
  const PREC = 5;
  const num = v => { const r = +Number(v || 0).toFixed(PREC); return Object.is(r, -0) ? 0 : r; };
  const esc = s => String(s || '').replace(/[<>]/g, ch => ch === '<' ? '(' : ')');
  const P = (c, v) => `${c}\n${v}\n`;
  const L = (x1, z1, x2, z2, layer) =>
    P(0, 'LINE') + P(8, layer)
    + P(10, num(x1)) + P(20, num(z1)) + P(30, 0)
    + P(11, num(x2)) + P(21, num(z2)) + P(31, 0);
  const C = (x, z, r, layer) =>
    P(0, 'CIRCLE') + P(8, layer)
    + P(10, num(x)) + P(20, num(z)) + P(30, 0) + P(40, num(r));
  const A = (x, z, r, a1, a2, layer) =>
    P(0, 'ARC') + P(8, layer)
    + P(10, num(x)) + P(20, num(z)) + P(30, 0)
    + P(40, num(r)) + P(50, num(a1)) + P(51, num(a2));
  const T = (x, z, v, layer, opt = {}) =>
    P(0, 'TEXT') + P(8, layer)
    + P(10, num(x)) + P(20, num(z)) + P(30, 0)
    + P(40, num(opt.h ?? 0.2)) + P(1, esc(v))
    + P(50, num(opt.rot || 0)) + P(7, 'STANDARD');

  // ── 图层定义 ──────────────────────────────────────
  const LAYERS = [
    { name: 'A-WALL', color: 7 },
    { name: 'A-WALL-CNTR', color: 8, lineType: 'DASHED' },
    { name: 'A-DOOR', color: 30 },
    { name: 'A-WIND', color: 4 },
    { name: 'A-ROOM', color: 3 },
    { name: 'A-FURN', color: 9 },
    { name: 'A-FLOR-PLNT', color: 3 },
    { name: 'A-LITE', color: 50 },
    { name: 'A-ANNO', color: 7 },
    { name: 'A-ROOM-ANNO', color: 7 },
    { name: 'A-FURN-ANNO', color: 8 },
    { name: 'A-DIMS', color: 6 },
    { name: 'A-STAIR', color: 30 },
  ];

  // ── 重心理算(用于标注偏向外侧) ────────────────────────
  let cgx = 0, cgz = 0, nW = 0;
  for (const w of W) {
    cgx += (+w.ax + +w.bx) / 2;
    cgz += (+w.az + +w.bz) / 2;
    nW++;
  }
  const centerX = nW ? cgx / nW : 0;
  const centerZ = nW ? cgz / nW : 0;

  // ── 墙体绘制(含门窗符号) ──────────────────────────
  let body = '';
  for (const w of W) {
    const basis = _wallBasis(w);
    if (!basis) continue;
    const th = Math.max(0.02, +w.th || 0.12);
    const half = th / 2;
    const spans = _openingSpans(w);

    // 两条平行边线
    for (const off of [-half, half]) {
      let cur = 0;
      for (const s of spans) {
        if (s.start > cur) {
          const a = _pointAlongWall(basis, cur, off);
          const b = _pointAlongWall(basis, s.start, off);
          body += L(a.x, a.z, b.x, b.z, 'A-WALL');
        }
        cur = Math.max(cur, s.end);
      }
      if (cur < basis.length) {
        const a = _pointAlongWall(basis, cur, off);
        const b = _pointAlongWall(basis, basis.length, off);
        body += L(a.x, a.z, b.x, b.z, 'A-WALL');
      }
    }
    // 两端封口
    const sA = _pointAlongWall(basis, 0, -half), sB = _pointAlongWall(basis, 0, half);
    const eA = _pointAlongWall(basis, basis.length, -half), eB = _pointAlongWall(basis, basis.length, half);
    body += L(sA.x, sA.z, sB.x, sB.z, 'A-WALL');
    body += L(eA.x, eA.z, eB.x, eB.z, 'A-WALL');
    // 中线
    body += L(basis.ax, basis.az, basis.bx, basis.bz, 'A-WALL-CNTR');

    // 计算 dirSign(向室外侧)
    const mid = _pointAlongWall(basis, basis.length / 2);
    const testOff = th / 2 + 1;
    const p1 = _pointAlongWall(basis, basis.length / 2, testOff);
    const p2 = _pointAlongWall(basis, basis.length / 2, -testOff);
    const d1 = (p1.x - centerX) ** 2 + (p1.z - centerZ) ** 2;
    const d2 = (p2.x - centerX) ** 2 + (p2.z - centerZ) ** 2;
    const dirSign = d1 >= d2 ? 1 : -1;

    // 门窗符号
    for (const s of spans) {
      const j1A = _pointAlongWall(basis, s.start, -half);
      const j1B = _pointAlongWall(basis, s.start, half);
      const j2A = _pointAlongWall(basis, s.end, -half);
      const j2B = _pointAlongWall(basis, s.end, half);
      const symLayer = s.op.type === 'door' ? 'A-DOOR' : 'A-WIND';
      body += L(j1A.x, j1A.z, j1B.x, j1B.z, symLayer);
      body += L(j2A.x, j2A.z, j2B.x, j2B.z, symLayer);
      const width = s.end - s.start;
      if (s.op.type === 'window') {
        // 窗:三横线(双线+中线)
        for (const off of [-th / 4, 0, th / 4]) {
          const a = _pointAlongWall(basis, s.start, off);
          const b = _pointAlongWall(basis, s.end, off);
          body += L(a.x, a.z, b.x, b.z, 'A-WIND');
        }
        const mm = _pointAlongWall(basis, (s.start + s.end) / 2, -th / 2);
        const mp = _pointAlongWall(basis, (s.start + s.end) / 2, th / 2);
        body += L(mm.x, mm.z, mp.x, mp.z, 'A-WIND');
      } else {
        // 门:铰链点 + 弧 + 门扇线
        const hinge = _pointAlongWall(basis, s.start);
        const openSign = s.op.flip ? -1 : 1;
        const leafEnd = _pointAlongWall(basis, s.start, width * openSign * dirSign);
        body += L(hinge.x, hinge.z, leafEnd.x, leafEnd.z, 'A-DOOR');
        body += C(hinge.x, hinge.z, Math.min(0.035, th / 5), 'A-DOOR');
        // 弧: 从闭合方向(沿墙) 到 开启方向(法向)
        const closedAngle = Math.atan2(basis.uz, basis.ux) * 180 / Math.PI;
        const openAngle = Math.atan2(basis.nz * dirSign * openSign, basis.nx * dirSign * openSign) * 180 / Math.PI;
        const norm = a => ((a % 360) + 360) % 360;
        const ca = norm(closedAngle), oa = norm(openAngle);
        const [arcStart, arcEnd] = ((ca - oa + 360) % 360) <= 180 ? [oa, ca] : [ca, oa];
        body += A(hinge.x, hinge.z, width, arcStart, arcEnd, 'A-DOOR');
      }

      // 门窗代号: M0921 / C1214
      const code = (s.op.type === 'door' ? 'M' : 'C')
        + String(Math.round((+s.op.width || 0) * 1000)).padStart(4, '0')
        + 'x' + String(Math.round((+s.op.height || 0) * 1000)).padStart(4, '0');
      const textOff = (th / 2 + 0.15) * dirSign;
      const textCenter = _pointAlongWall(basis, (s.start + s.end) / 2, textOff);
      let ang = Math.atan2(basis.uz, basis.ux) * 180 / Math.PI;
      if (ang > 90 || ang < -90) ang += 180;
      body += T(textCenter.x, textCenter.z, code, 'A-ANNO', { h: 0.10, rot: ang });
    }

    // 总尺寸标注
    const dimOff = (th / 2 + 0.6) * dirSign;
    const dimA = _pointAlongWall(basis, 0, dimOff);
    const dimB = _pointAlongWall(basis, basis.length, dimOff);
    const tick = 0.08;
    const dimMid = _pointAlongWall(basis, 0, (th / 2) * dirSign);
    const dimMidE = _pointAlongWall(basis, basis.length, (th / 2) * dirSign);
    body += L(dimMid.x, dimMid.z, dimA.x, dimA.z, 'A-DIMS');
    body += L(dimMidE.x, dimMidE.z, dimB.x, dimB.z, 'A-DIMS');
    body += L(dimA.x, dimA.z, dimB.x, dimB.z, 'A-DIMS');
    // tick
    const tickA = { x: dimA.x - basis.ux * tick + basis.nx * tick * dirSign, z: dimA.z - basis.uz * tick + basis.nz * tick * dirSign };
    const tickA2 = { x: dimA.x + basis.ux * tick - basis.nx * tick * dirSign, z: dimA.z + basis.uz * tick - basis.nz * tick * dirSign };
    body += L(tickA.x, tickA.z, tickA2.x, tickA2.z, 'A-DIMS');
    const tickB = { x: dimB.x - basis.ux * tick + basis.nx * tick * dirSign, z: dimB.z - basis.uz * tick + basis.nz * tick * dirSign };
    const tickB2 = { x: dimB.x + basis.ux * tick - basis.nx * tick * dirSign, z: dimB.z + basis.uz * tick - basis.nz * tick * dirSign };
    body += L(tickB.x, tickB.z, tickB2.x, tickB2.z, 'A-DIMS');
    const mmLen = Math.round(basis.length * 1000);
    let ang = Math.atan2(basis.uz, basis.ux) * 180 / Math.PI;
    if (ang > 90 || ang < -90) ang += 180;
    const txtMid = _pointAlongWall(basis, basis.length / 2, dimOff + 0.07 * dirSign);
    body += T(txtMid.x, txtMid.z, mmLen + ' mm', 'A-DIMS', { h: 0.14, rot: ang });
  }

  // ── 家具/物品 ──────────────────────────────────────
  for (const it of F) {
    const corners = _itemCorners(it);
    const t = (it.type || '').toLowerCase();
    const n = (it.name || '').toLowerCase();
    const layer = /^(tree|palm|bush|indoorplant|pottedwhite|smallindoorplant|cactus|firtree|hydrant|column|roundcarpet|roundmirror)$/.test(t) || n.includes('植') || n.includes('绿化') || n.includes('树')
      ? 'A-FLOR-PLNT'
      : t.includes('light') || /^(ceilinglight|floorlamp|tablelamp|ceillamp|ceilfan)$/.test(t) || n.includes('灯')
      ? 'A-LITE'
      : 'A-FURN';
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      body += L(a.x, a.z, b.x, b.z, layer);
    }
    // 圆形家具 → CIRCLE
    if (/^(tree|palm|bush|indoorplant|pottedwhite|smallindoorplant|cactus|firtree|hydrant|column|roundcarpet|roundmirror|ceilinglight|floorlamp|tablelamp|ceillamp|ceilfan)$/i.test(it.type || '')) {
      const r = Math.max(+it.width || 0, +it.depth || 0) / 2;
      body += C(+it.x || 0, +it.z || 0, r, layer);
    }
    // 名称标注
    if (it.name) {
      body += T(+it.x || 0, +it.z || 0, it.name, 'A-FURN-ANNO', { h: 0.12, rot: 0 });
    }
  }

  // ── 楼梯 ─────────────────────────────────────────
  for (const st of ST) {
    const w = +st.width || 0.9, d = +st.depth || 3;
    const cx = +st.x || 0, cz = +st.z || 0, rot = +st.rot || 0;
    const xf = (x, z) => {
      const c = Math.cos(rot), s = Math.sin(rot);
      return { x: cx + x * c - z * s, z: cz + x * s + z * c };
    };
    if (st.type === 'spiral') {
      const r = Math.min(w, d) / 2;
      body += C(cx, cz, r, 'A-STAIR');
      body += C(cx, cz, r * 0.15, 'A-STAIR');
      for (let i = 0; i < 12; i++) {
        const a = rot + (i / 12) * Math.PI * 2;
        body += L(cx + Math.cos(a) * r * 0.15, cz + Math.sin(a) * r * 0.15, cx + Math.cos(a) * r, cz + Math.sin(a) * r, 'A-STAIR');
      }
    } else {
      const cs = [xf(-w / 2, -d / 2), xf(w / 2, -d / 2), xf(w / 2, d / 2), xf(-w / 2, d / 2)];
      for (let i = 0; i < 4; i++) body += L(cs[i].x, cs[i].z, cs[(i + 1) % 4].x, cs[(i + 1) % 4].z, 'A-STAIR');
      const steps = Math.max(3, Math.round((+st.height || 2.8) / 0.18));
      for (let i = 1; i < steps; i++) {
        const zv = -d / 2 + d * i / steps;
        const a = xf(-w / 2, zv), b = xf(w / 2, zv);
        body += L(a.x, a.z, b.x, b.z, 'A-STAIR');
      }
    }
    const upA = xf(0, -d * 0.3), upB = xf(0, d * 0.3);
    body += L(upA.x, upA.z, upB.x, upB.z, 'A-STAIR');
    body += T(cx, cz, '楼梯', 'A-ANNO', { h: 0.16, rot: rot * 180 / Math.PI });
  }

  // ── DXF 文件头 + 表 + 实体 ─────────────────────────
  let dxf = '';
  // HEADER section
  dxf += P(0, 'SECTION') + P(2, 'HEADER');
  dxf += P(9, '$ACADVER') + P(1, 'AC1009');
  dxf += P(9, '$INSUNITS') + P(70, 6);  // 6 = meters
  dxf += P(0, 'ENDSEC');
  // TABLES
  dxf += P(0, 'SECTION') + P(2, 'TABLES');
  dxf += P(0, 'TABLE') + P(2, 'LTYPE') + P(70, 2);
  dxf += P(0, 'LTYPE') + P(2, 'CONTINUOUS') + P(70, 0) + P(3, 'Solid line') + P(72, 65) + P(73, 0) + P(40, 0);
  dxf += P(0, 'LTYPE') + P(2, 'DASHED') + P(70, 0) + P(3, 'Dashed line') + P(72, 65) + P(73, 2) + P(40, 0.3) + P(49, 0.2) + P(49, -0.1);
  dxf += P(0, 'ENDTAB');
  dxf += P(0, 'TABLE') + P(2, 'LAYER') + P(70, LAYERS.length);
  for (const ly of LAYERS) {
    dxf += P(0, 'LAYER') + P(2, ly.name) + P(70, 0) + P(62, ly.color) + P(6, ly.lineType || 'CONTINUOUS');
  }
  dxf += P(0, 'ENDTAB');
  dxf += P(0, 'ENDSEC');
  // ENTITIES
  dxf += P(0, 'SECTION') + P(2, 'ENTITIES');
  dxf += body;
  dxf += P(0, 'ENDSEC');
  dxf += P(0, 'EOF');

  // 下载
  const blob = new Blob([dxf], { type: 'application/dxf' });
  const a = document.createElement('a');
  const fname = safeFileName(doc.name || '未命名') + '.dxf';
  a.href = URL.createObjectURL(blob); a.download = fname; a.click();
  URL.revokeObjectURL(a.href);

}
async function newDoc() {
  // 新建文档是不可逆的"新基线":丢弃旧 undo/redo 栈(否则 Ctrl+Z 会回到旧文档,语义混乱),
  // 也不 pushUndo(否则栈里会多一条"空 → 空"无意义项)
  // ── 服务器模式:editor 目录里静默建档,无任何弹窗 ──
  if (await srvProbe()) {
    undoStack.length = 0; redoStack.length = 0;
    try {
      const names = new Set((await srvList()).map(f => f.name));
      let base = '新建户型', fname = base + '.tp3d.json', n = 2;
      while (names.has(fname)) fname = `${base}-${n++}.tp3d.json`;
      doc = { name: fname.replace(/\.tp3d\.json$/i, ''), wallH: 2.75, levels: [{ name: '1F', elev: 0 }], walls: [], furniture: [], floors: [], stairs: [], hidden: {} };
      const id = newId();
      filesIndex.unshift({ id, name: doc.name, fileName: fname, updatedAt: Date.now(), _srv: true });
      saveFilesIndex();
      sel = null; currentFileId = id; currentHandle = null;
      rebuild(); refreshProps(); _syncTopbarKb(); markUnsaved(true);
      renderFilesPanel();
      await srvPut(fname, _buildFileJSON());
      await snapPut(id);
      flash('已创建 ' + fname + '（editor 目录）', 'success');
    } catch (e) {
      toast('新建失败：' + (e?.message || e), 'error', 5000);
    }
    return;
  }
  if (!FS_SUPPORT) {
    // 无 FSA 也能多文件:内容存 IndexedDB 快照,面板内即可切换/删除
    undoStack.length = 0; redoStack.length = 0;
    doc = { name: '新建户型', wallH: doc.wallH || 2.75, levels: doc.levels || [{ name: '1F', elev: 0 }], walls: [], furniture: [], floors: [], stairs: [], hidden: {} };
    const id = newId();
    filesIndex.unshift({ id, name: '新建户型', updatedAt: Date.now() });
    saveFilesIndex();
    sel = null; currentFileId = id; currentHandle = null;
    rebuild(); refreshProps(); _syncTopbarKb(); markUnsaved(true);
    renderFilesPanel();
    await snapPut(id);
    flash('已创建「新建户型」(保存在浏览器本地,可在文件面板切换)');
    return;
  }
  // 默认空文档,然后让用户立即另存为(选位置)
  undoStack.length = 0; redoStack.length = 0;
  doc = { name: '新建户型', wallH: 2.75, levels: [{ name: '1F', elev: 0 }], walls: [], furniture: [], floors: [], hidden: {} };
  sel = null;
  rebuild(); refreshProps();
  _syncTopbarKb();
  markUnsaved(true);
  // 直接走另存为:用户选好位置后写入并加入列表
  await saveDocAs();
}
function loadSample() { pushUndo(); doc = sampleDoc(); doc.name = '示例户型'; sel = null; rebuild(); refreshProps(); _syncTopbarKb(); markUnsaved(true); flash('已载入示例户型'); }

// ============================================================
// 家具库（参数化构件，均以地面中心为原点，可放置/旋转/删除）
// ============================================================
function fBed(w, d, single) {
  const g = new THREE.Group();
  addLocal(g, rbox(w + 0.04, 0.5, 0.08, 0.02), M.headboard, 0, 0.38, -d / 2 + 0.04);
  addLocal(g, box(w, 0.22, d - 0.08), M.bedFrame, 0, 0.24, 0);
  addLocal(g, rbox(w - 0.06, 0.18, d - 0.14, 0.03), M.mattress, 0, 0.44, 0);
  const pw = single ? w - 0.24 : w / 2 - 0.12;
  addLocal(g, rbox(pw, 0.1, 0.34, 0.04), M.white, single ? 0 : -w / 4 + 0.02, 0.56, -d / 2 + 0.32);
  if (!single) addLocal(g, rbox(pw, 0.1, 0.34, 0.04), M.white, w / 4 - 0.02, 0.56, -d / 2 + 0.32);
  addLocal(g, box(w - 0.04, 0.06, d * 0.55), M.sheet, 0, 0.495, d * 0.2, false);
  return g;
}
function fWardrobe() {
  const g = new THREE.Group();
  addLocal(g, box(1.8, 2.2, 0.55), M.wardrobe, 0, 1.1, 0);
  for (let d = 0; d < 2; d++)
    for (let s = 0; s < 5; s++)
      addLocal(g, box(0.05, 1.9, 0.02), M.counter, -0.66 + d * 0.46 + s * 0.09, 1.1, -0.285, false);
  for (let d = 0; d < 2; d++)
    addLocal(g, box(0.025, 0.26, 0.025), M.metal, -0.07 + d * 0.14, 1.15, -0.3, false);
  return g;
}
function fNightstand() {
  const g = new THREE.Group();
  addLocal(g, rbox(0.45, 0.48, 0.42, 0.015), M.wardrobe, 0, 0.28, 0);
  addLocal(g, box(0.47, 0.02, 0.44), M.counter, 0, 0.53, 0);
  addLocal(g, new THREE.CylinderGeometry(0.035, 0.03, 0.1, 12), M.sheet, 0.08, 0.6, 0.03);
  return g;
}
function fDesk() {
  const g = new THREE.Group();
  addLocal(g, box(1.3, 0.04, 0.6), M.wood, 0, 0.74, 0);
  for (const sx of [-1, 1]) addLocal(g, box(0.05, 0.72, 0.55), M.wood, sx * 0.6, 0.37, 0);
  addLocal(g, box(0.42, 0.05, 0.42), M.gray, 0.15, 0.45, 0.42);
  addLocal(g, box(0.42, 0.5, 0.05), M.gray, 0.15, 0.72, 0.64);
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    addLocal(g, new THREE.CylinderGeometry(0.015, 0.015, 0.44, 8), M.dark, 0.15 + sx * 0.17, 0.22, 0.42 + sz * 0.17);
  addLocal(g, new THREE.CylinderGeometry(0.05, 0.07, 0.03, 12), M.dark, -0.4, 0.78, -0.15);
  addLocal(g, new THREE.CylinderGeometry(0.008, 0.008, 0.3, 8), M.dark, -0.4, 0.92, -0.1);
  return g;
}
function fShelf() {
  const g = new THREE.Group();
  addLocal(g, box(1.2, 1.8, 0.3), M.wardrobe, 0, 0.9, 0);
  const cols = [M.sheet, M.gray, M.dark];
  for (let lvl = 0; lvl < 4; lvl++) {
    addLocal(g, box(1.1, 0.03, 0.26), M.counter, 0, 0.32 + lvl * 0.44, 0, false);
    let bx = -0.52;
    while (bx < 0.42) {
      const bw = 0.04 + Math.random() * 0.03, bh = 0.2 + Math.random() * 0.08;
      addLocal(g, box(bw, bh, 0.2), cols[Math.floor(Math.random() * 3)], bx + bw / 2, 0.335 + lvl * 0.44 + bh / 2, 0, false);
      bx += bw + 0.015;
      if (Math.random() < 0.25) bx += 0.12;
    }
  }
  return g;
}
function fSofa() {
  const g = new THREE.Group();
  addLocal(g, box(2.0, 0.4, 0.85), M.fabric, 0, 0.2, 0);
  addLocal(g, box(2.0, 0.4, 0.2), M.fabric, 0, 0.5, -0.33);
  for (const sx of [-1, 1]) addLocal(g, box(0.2, 0.3, 0.85), M.fabric, sx * 0.9, 0.35, 0);
  addLocal(g, rbox(0.6, 0.12, 0.45, 0.05), M.sheet, -0.4, 0.46, -0.05);
  addLocal(g, rbox(0.6, 0.12, 0.45, 0.05), M.sheet, 0.4, 0.46, -0.05);
  return g;
}
function fTea() {
  const g = new THREE.Group();
  addLocal(g, box(1.0, 0.04, 0.5), M.wood, 0, 0.4, 0);
  for (const sx of [-1, 1]) addLocal(g, box(0.06, 0.38, 0.4), M.wood, sx * 0.42, 0.19, 0);
  return g;
}
function fDining() {
  const g = new THREE.Group();
  addLocal(g, box(1.4, 0.05, 0.85), M.wood, 0, 0.74, 0);
  for (const sx of [-1, 1]) addLocal(g, box(0.08, 0.72, 0.7), M.wood, sx * 0.58, 0.36, 0);
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
    addLocal(g, box(0.4, 0.05, 0.4), M.gray, sx * 0.5, 0.46, sz * 0.75);
    addLocal(g, box(0.4, 0.45, 0.05), M.gray, sx * 0.5, 0.7, sz * 0.75 + (sz > 0 ? 0.18 : -0.18));
  }
  return g;
}
function fToilet() {
  const g = new THREE.Group();
  addLocal(g, rbox(0.4, 0.42, 0.2, 0.03), M.white, 0, 0.52, -0.22);
  addLocal(g, rbox(0.36, 0.15, 0.5, 0.06), M.white, 0, 0.2, 0.05);
  addLocal(g, new THREE.CylinderGeometry(0.19, 0.17, 0.06, 18), M.white, 0, 0.33, 0.08);
  return g;
}
function fBasin() {
  const g = new THREE.Group();
  addLocal(g, new THREE.CylinderGeometry(0.05, 0.07, 0.7, 12), M.white, 0, 0.35, 0);
  addLocal(g, new THREE.CylinderGeometry(0.23, 0.19, 0.13, 20), M.white, 0, 0.77, 0);
  addLocal(g, new THREE.CylinderGeometry(0.011, 0.011, 0.18, 8), M.metal, 0, 0.92, -0.12);
  return g;
}
function fFridge() {
  const g = new THREE.Group();
  addLocal(g, rbox(0.65, 1.9, 0.65, 0.02), M.gray, 0, 0.95, 0);
  addLocal(g, box(0.58, 0.015, 0.02), M.metal, 0, 1.28, 0.335, false);
  addLocal(g, box(0.04, 0.5, 0.03), M.metal, -0.2, 1.05, 0.35, false);
  addLocal(g, box(0.04, 0.5, 0.03), M.metal, -0.2, 1.65, 0.35, false);
  return g;
}
function fShoeCabinet() {
  const g = new THREE.Group();
  addLocal(g, rbox(1.0, 1.2, 0.35, 0.02), M.wardrobe, 0, 0.6, 0);
  for (let i = 0; i < 3; i++) {
    addLocal(g, box(0.96, 0.02, 0.31), M.counter, 0, 0.2 + i * 0.4, 0, false);
    addLocal(g, box(0.04, 0.36, 0.02), M.metal, -0.1, 0.2 + i * 0.4 + 0.18, 0.18, false);
    addLocal(g, box(0.04, 0.36, 0.02), M.metal, 0.1, 0.2 + i * 0.4 + 0.18, 0.18, false);
  }
  return g;
}
function fVanityStool() {
  const g = new THREE.Group();
  addLocal(g, new THREE.CylinderGeometry(0.22, 0.2, 0.04, 20), M.fabric, 0, 0.45, 0);
  addLocal(g, new THREE.CylinderGeometry(0.21, 0.19, 0.36, 16), M.fabric, 0, 0.25, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.22, 8), M.dark, sx * 0.14, 0.11, sz * 0.14);
  return g;
}
function fKidsBed() {
  const g = new THREE.Group();
  addLocal(g, rbox(1.04, 0.35, 0.06, 0.02), M.headboard, 0, 0.28, -1.37);
  addLocal(g, box(1.0, 0.18, 1.34), M.bedFrame, 0, 0.16, 0);
  addLocal(g, rbox(0.94, 0.14, 1.28, 0.03), M.mattress, 0, 0.3, 0);
  addLocal(g, rbox(0.9, 0.08, 0.3, 0.04), M.white, 0, 0.4, -1.15);
  addLocal(g, box(0.96, 0.05, 0.7), M.sheet, 0, 0.335, 0.28, false);
  addLocal(g, box(1.0, 0.25, 0.02), M.dark, 0, 0.5, 0.5, false);
  for (const sx of [-0.4, 0, 0.4])
    addLocal(g, box(0.02, 0.25, 0.02), M.dark, sx, 0.5, 0.5, false);
  return g;
}
function fFoldTable() {
  const g = new THREE.Group();
  addLocal(g, box(1.2, 0.04, 0.6), M.wood, 0, 0.74, 0);
  for (const sx of [-1, 1]) addLocal(g, box(0.04, 0.72, 0.04), M.dark, sx * 0.55, 0.37, 0.25);
  for (const sx of [-1, 1]) addLocal(g, box(0.04, 0.72, 0.04), M.dark, sx * 0.55, 0.37, -0.25);
  addLocal(g, box(0.1, 0.02, 0.02), M.metal, 0, 0.74, 0.3, false);
  return g;
}
function fBayWindowCushion() {
  const g = new THREE.Group();
  addLocal(g, rbox(1.5, 0.1, 0.5, 0.04), M.fabric, 0, 0.05, 0);
  addLocal(g, rbox(1.5, 0.3, 0.1, 0.04), M.fabric, 0, 0.2, -0.2);
  for (const sx of [-0.5, 0, 0.5])
    addLocal(g, rbox(0.4, 0.08, 0.4, 0.03), M.sheet, sx, 0.12, 0.05, false);
  return g;
}
function fLShapedSofa() {
  const g = new THREE.Group();
  addLocal(g, box(2.0, 0.4, 0.85), M.fabric, 0, 0.2, 0);
  addLocal(g, box(2.0, 0.4, 0.2), M.fabric, 0, 0.5, -0.33);
  for (const sx of [-1, 1]) addLocal(g, box(0.2, 0.3, 0.85), M.fabric, sx * 0.9, 0.35, 0);
  addLocal(g, box(0.85, 0.4, 1.4), M.fabric, 1.225, 0.2, 0.275);
  addLocal(g, box(0.2, 0.3, 1.4), M.fabric, 1.625, 0.35, 0.275);
  addLocal(g, rbox(0.6, 0.12, 0.45, 0.05), M.sheet, -0.4, 0.46, -0.05, false);
  addLocal(g, rbox(0.6, 0.12, 0.45, 0.05), M.sheet, 0.4, 0.46, -0.05, false);
  return g;
}
function fCornerCabinet() {
  const g = new THREE.Group();
  addLocal(g, rbox(0.8, 1.8, 0.8, 0.02), M.wardrobe, 0, 0.9, 0);
  addLocal(g, box(0.02, 1.8, 0.6), M.counter, -0.39, 0.9, 0, false);
  addLocal(g, box(0.6, 1.8, 0.02), M.counter, 0, 0.9, -0.39, false);
  for (let lvl = 0; lvl < 3; lvl++)
    addLocal(g, box(0.7, 0.02, 0.7), M.counter, 0, 0.3 + lvl * 0.6, 0, false);
  addLocal(g, box(0.04, 0.3, 0.02), M.metal, 0.2, 1.0, 0.39, false);
  return g;
}
function fBarCounter() {
  const g = new THREE.Group();
  addLocal(g, rbox(1.8, 1.05, 0.55, 0.02), M.counter, 0, 0.525, 0);
  addLocal(g, box(1.75, 0.04, 0.5), M.wood, 0, 1.05, 0);
  for (const sx of [-0.6, 0, 0.6]) {
    addLocal(g, new THREE.CylinderGeometry(0.14, 0.12, 0.04, 16), M.dark, sx, 0.65, -0.55);
    addLocal(g, new THREE.CylinderGeometry(0.03, 0.03, 0.6, 8), M.metal, sx, 0.35, -0.55);
    addLocal(g, new THREE.CylinderGeometry(0.16, 0.14, 0.02, 16), M.dark, sx, 0.06, -0.55);
  }
  return g;
}
function fBookcaseWide() {
  const g = new THREE.Group();
  addLocal(g, box(2.0, 2.0, 0.35), M.wardrobe, 0, 1.0, 0);
  for (let lvl = 0; lvl < 5; lvl++)
    addLocal(g, box(1.9, 0.03, 0.3), M.counter, 0, 0.2 + lvl * 0.4, 0, false);
  addLocal(g, box(1.96, 1.96, 0.02), M.counter, 0, 1.0, -0.165, false);
  return g;
}
function fArmchair() {
  const g = new THREE.Group();
  addLocal(g, rbox(0.8, 0.4, 0.8, 0.04), M.fabric, 0, 0.2, 0);
  addLocal(g, box(0.8, 0.5, 0.15), M.fabric, 0, 0.45, -0.33);
  for (const sx of [-1, 1]) addLocal(g, rbox(0.15, 0.35, 0.8, 0.04), M.fabric, sx * 0.33, 0.3, 0);
  addLocal(g, rbox(0.5, 0.1, 0.5, 0.03), M.sheet, 0, 0.46, 0, false);
  return g;
}
function fCoffeeTableLow() {
  const g = new THREE.Group();
  addLocal(g, rbox(1.2, 0.04, 0.6, 0.02), M.wood, 0, 0.35, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    addLocal(g, box(0.06, 0.33, 0.06), M.dark, sx * 0.54, 0.165, sz * 0.24);
  addLocal(g, box(1.1, 0.02, 0.5), M.wood, 0, 0.12, 0, false);
  return g;
}
function fShoeRack() {
  const g = new THREE.Group();
  for (let lvl = 0; lvl < 3; lvl++) {
    addLocal(g, box(0.8, 0.02, 0.3), M.wood, 0, 0.1 + lvl * 0.2, 0);
    for (const sx of [-1, 1])
      addLocal(g, box(0.04, 0.18, 0.04), M.dark, sx * 0.36, 0.1 + lvl * 0.2 + 0.09, 0.12);
    for (const sx of [-1, 1])
      addLocal(g, box(0.04, 0.18, 0.04), M.dark, sx * 0.36, 0.1 + lvl * 0.2 + 0.09, -0.12);
  }
  return g;
}
function fPlantStand() {
  const g = new THREE.Group();
  addLocal(g, new THREE.CylinderGeometry(0.2, 0.18, 0.06, 16), M.wood, 0, 0.03, 0);
  addLocal(g, new THREE.CylinderGeometry(0.16, 0.14, 0.06, 16), M.wood, 0, 0.3, 0);
  addLocal(g, new THREE.CylinderGeometry(0.12, 0.1, 0.06, 16), M.wood, 0, 0.55, 0);
  addLocal(g, new THREE.CylinderGeometry(0.03, 0.03, 0.6, 8), M.dark, 0, 0.3, 0, false);
  return g;
}
function fTVCabinet() {
  const g = new THREE.Group();
  addLocal(g, rbox(2.0, 0.45, 0.4, 0.02), M.wardrobe, 0, 0.225, 0);
  for (let i = 0; i < 3; i++) {
    addLocal(g, box(0.6, 0.4, 0.36), M.counter, -0.65 + i * 0.65, 0.225, 0, false);
    addLocal(g, box(0.04, 0.2, 0.02), M.metal, -0.35 + i * 0.65, 0.225, 0.2, false);
  }
  return g;
}
function fKitchenIsland() {
  const g = new THREE.Group();
  addLocal(g, rbox(2.0, 0.9, 1.0, 0.02), M.counter, 0, 0.45, 0);
  addLocal(g, box(1.96, 0.04, 0.96), M.wood, 0, 0.9, 0);
  addLocal(g, rbox(0.5, 0.04, 0.35, 0.02), M.metal, -0.5, 0.92, 0, false);
  return g;
}
function fWardrobeOpen() {
  const g = new THREE.Group();
  addLocal(g, box(1.5, 2.2, 0.55), M.wardrobe, 0, 1.1, 0);
  addLocal(g, box(1.4, 0.04, 0.45), M.counter, 0, 1.8, 0, false);
  addLocal(g, box(0.04, 1.0, 0.45), M.counter, 0, 1.3, 0, false);
  addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 1.3, 8), M.metal, 0, 1.75, 0, false);
  for (let i = 0; i < 2; i++) {
    addLocal(g, box(1.4, 0.02, 0.45), M.counter, 0, 0.3 + i * 0.25, 0, false);
    addLocal(g, box(0.1, 0.02, 0.02), M.metal, 0, 0.3 + i * 0.25, 0.23, false);
  }
  return g;
}
function fDresserMirror() {
  const g = new THREE.Group();
  addLocal(g, rbox(1.0, 0.75, 0.5, 0.02), M.wardrobe, 0, 0.375, 0);
  addLocal(g, box(0.9, 0.02, 0.4), M.counter, 0, 0.75, 0, false);
  addLocal(g, box(0.6, 0.8, 0.03), M.glass, 0, 1.2, -0.2, false);
  addLocal(g, box(0.64, 0.84, 0.02), M.frame, 0, 1.2, -0.22, false);
  return g;
}
function fWorkstation() {
  const g = new THREE.Group();
  addLocal(g, box(1.6, 0.04, 0.8), M.counter, 0, 0.74, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    addLocal(g, box(0.05, 0.72, 0.05), M.dark, sx * 0.75, 0.37, sz * 0.37);
  addLocal(g, box(1.6, 0.4, 0.02), M.fabric, 0, 1.0, -0.4, false);
  addLocal(g, box(0.02, 0.4, 0.8), M.fabric, 0.8, 1.0, 0, false);
  addLocal(g, box(0.5, 0.3, 0.02), M.dark, 0, 0.95, -0.3, false);
  addLocal(g, box(0.5, 0.04, 0.2), M.dark, 0, 0.8, -0.25, false);
  return g;
}
function fReceptionDesk() {
  const g = new THREE.Group();
  addLocal(g, rbox(2.4, 1.05, 0.6, 0.02), M.counter, 0, 0.525, 0);
  addLocal(g, box(2.35, 0.04, 0.55), M.wood, 0, 1.05, 0);
  addLocal(g, box(0.8, 0.3, 0.02), M.dark, 0, 1.2, -0.3, false);
  addLocal(g, box(0.4, 0.25, 0.02), M.dark, -0.5, 1.1, -0.25, false);
  return g;
}
function fDisplayCabinet() {
  const g = new THREE.Group();
  addLocal(g, box(1.2, 2.0, 0.4), M.counter, 0, 1.0, 0);
  for (let lvl = 0; lvl < 4; lvl++) {
    addLocal(g, box(1.1, 0.02, 0.35), M.counter, 0, 0.25 + lvl * 0.45, 0, false);
    addLocal(g, box(1.08, 0.4, 0.02), M.glass, 0, 0.45 + lvl * 0.45, 0.18, false);
  }
  addLocal(g, box(1.0, 0.02, 0.02), M.white, 0, 1.95, 0.18, false);
  return g;
}
function fMeetingSet() {
  const g = new THREE.Group();
  addLocal(g, box(3.0, 0.05, 1.2), M.wood, 0, 0.74, 0);
  for (const sx of [-1, 1]) addLocal(g, box(0.08, 0.72, 1.0), M.wood, sx * 1.4, 0.37, 0);
  for (const sx of [-1, 0, 1]) {
    for (const sz of [-1, 1]) {
      const cz = sz * 0.9;
      addLocal(g, box(0.45, 0.04, 0.45), M.gray, sx * 0.8, 0.46, cz);
      addLocal(g, box(0.45, 0.4, 0.05), M.gray, sx * 0.8, 0.7, cz + (sz > 0 ? -0.2 : 0.2));
      addLocal(g, box(0.04, 0.42, 0.04), M.dark, sx * 0.8 - 0.2, 0.23, cz - 0.2);
      addLocal(g, box(0.04, 0.42, 0.04), M.dark, sx * 0.8 + 0.2, 0.23, cz - 0.2);
    }
  }
  return g;
}
function fOfficePartition() {
  const g = new THREE.Group();
  addLocal(g, box(1.5, 1.6, 0.04), M.fabric, 0, 0.8, 0);
  addLocal(g, box(1.5, 0.04, 0.04), M.dark, 0, 1.6, 0, false);
  addLocal(g, box(1.5, 0.04, 0.04), M.dark, 0, 0.0, 0, false);
  for (const sx of [-1, 1])
    addLocal(g, box(0.04, 0.8, 0.04), M.dark, sx * 0.7, 0.4, 0, false);
  return g;
}
function fFilingCabinet() {
  const g = new THREE.Group();
  addLocal(g, rbox(0.9, 1.6, 0.5, 0.02), M.gray, 0, 0.8, 0);
  for (let i = 0; i < 4; i++) {
    addLocal(g, box(0.8, 0.3, 0.02), M.counter, 0, 0.2 + i * 0.4, 0.26, false);
    addLocal(g, box(0.1, 0.04, 0.02), M.metal, 0, 0.2 + i * 0.4, 0.28, false);
  }
  return g;
}
function fWhiteboard() {
  const g = new THREE.Group();
  addLocal(g, box(1.8, 1.2, 0.03), M.white, 0, 1.2, 0);
  addLocal(g, box(1.84, 1.24, 0.02), M.dark, 0, 1.2, -0.01, false);
  for (const sx of [-1, 1]) {
    addLocal(g, box(0.04, 1.2, 0.04), M.dark, sx * 0.8, 0.6, 0.15);
    addLocal(g, box(0.2, 0.04, 0.4), M.dark, sx * 0.8, 0.02, 0);
  }
  return g;
}
function fPrinterStand() {
  const g = new THREE.Group();
  addLocal(g, rbox(0.8, 0.7, 0.5, 0.02), M.gray, 0, 0.35, 0);
  addLocal(g, rbox(0.55, 0.3, 0.4, 0.02), M.dark, 0, 0.85, 0);
  addLocal(g, box(0.3, 0.02, 0.35), M.counter, 0, 0.95, 0, false);
  return g;
}
function fSignBoard() {
  const g = new THREE.Group();
  addLocal(g, new THREE.CylinderGeometry(0.04, 0.04, 1.8, 8), M.dark, 0, 0.9, 0);
  addLocal(g, box(0.6, 0.4, 0.03), M.white, 0, 1.6, 0);
  addLocal(g, box(0.5, 0.3, 0.01), M.counter, 0, 1.6, 0.02, false);
  addLocal(g, new THREE.CylinderGeometry(0.25, 0.25, 0.04, 16), M.dark, 0, 0.02, 0);
  return g;
}
function fTriageDesk() {
  const g = new THREE.Group();
  addLocal(g, rbox(2.0, 1.0, 0.6, 0.02), M.counter, 0, 0.5, 0);
  addLocal(g, box(1.96, 0.04, 0.56), M.counter, 0, 1.0, 0);
  addLocal(g, box(0.4, 0.25, 0.02), M.dark, -0.4, 1.15, -0.25, false);
  addLocal(g, box(0.8, 0.25, 0.02), M.white, 0.4, 1.15, -0.25, false);
  return g;
}
function fMedicineCabinet() {
  const g = new THREE.Group();
  addLocal(g, box(1.5, 2.0, 0.4), M.counter, 0, 1.0, 0);
  for (const sx of [-1, 1]) {
    addLocal(g, box(0.7, 1.9, 0.02), M.glass, sx * 0.38, 1.0, 0.2, false);
    addLocal(g, box(0.04, 0.3, 0.02), M.metal, sx * 0.35, 1.0, 0.22, false);
  }
  for (let lvl = 0; lvl < 5; lvl++)
    addLocal(g, box(1.4, 0.02, 0.35), M.counter, 0, 0.2 + lvl * 0.4, 0, false);
  return g;
}
function fWheelchair() {
  const g = new THREE.Group();
  addLocal(g, rbox(0.5, 0.08, 0.45, 0.02), M.fabric, 0, 0.5, 0);
  addLocal(g, box(0.5, 0.6, 0.04), M.fabric, 0, 0.8, -0.22);
  for (const sx of [-1, 1]) {
    addLocal(g, new THREE.TorusGeometry(0.3, 0.03, 8, 24), M.dark, sx * 0.28, 0.3, 0);
    addLocal(g, new THREE.CylinderGeometry(0.04, 0.04, 0.1, 8), M.metal, sx * 0.28, 0.3, 0);
  }
  for (const sx of [-1, 1])
    addLocal(g, new THREE.TorusGeometry(0.1, 0.02, 6, 16), M.dark, sx * 0.2, 0.1, 0.3);
  for (const sx of [-1, 1])
    addLocal(g, box(0.04, 0.3, 0.4), M.dark, sx * 0.25, 0.65, 0, false);
  return g;
}
function fIVStand() {
  const g = new THREE.Group();
  addLocal(g, new THREE.CylinderGeometry(0.25, 0.25, 0.04, 16), M.dark, 0, 0.02, 0);
  addLocal(g, new THREE.CylinderGeometry(0.03, 0.03, 1.8, 8), M.metal, 0, 0.92, 0);
  addLocal(g, new THREE.CylinderGeometry(0.15, 0.15, 0.02, 12), M.metal, 0, 1.85, 0, false);
  for (const sx of [-1, 1])
    addLocal(g, box(0.02, 0.1, 0.02), M.metal, sx * 0.1, 1.9, 0, false);
  addLocal(g, rbox(0.12, 0.25, 0.06, 0.01), M.white, 0, 1.7, 0, false);
  return g;
}
function fHospitalBed() {
  const g = new THREE.Group();
  addLocal(g, rbox(1.0, 0.3, 2.1, 0.02), M.gray, 0, 0.45, 0);
  addLocal(g, rbox(0.95, 0.15, 2.05, 0.03), M.white, 0, 0.6, 0);
  addLocal(g, rbox(0.95, 0.4, 0.2, 0.03), M.white, 0, 0.8, -0.95);
  for (const sx of [-1, 1])
    addLocal(g, box(0.02, 0.2, 1.8), M.dark, sx * 0.48, 0.7, 0, false);
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    addLocal(g, new THREE.CylinderGeometry(0.06, 0.06, 0.03, 12), M.dark, sx * 0.4, 0.03, sz * 0.9);
  return g;
}
function fStretcher() {
  const g = new THREE.Group();
  addLocal(g, rbox(0.7, 0.1, 1.9, 0.02), M.white, 0, 0.8, 0);
  addLocal(g, box(0.7, 0.04, 1.9), M.gray, 0, 0.74, 0, false);
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    addLocal(g, box(0.04, 0.7, 0.04), M.dark, sx * 0.3, 0.37, sz * 0.85);
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    addLocal(g, new THREE.CylinderGeometry(0.06, 0.06, 0.03, 12), M.dark, sx * 0.3, 0.03, sz * 0.85);
  return g;
}
function fMedCart() {
  const g = new THREE.Group();
  addLocal(g, rbox(0.6, 0.85, 0.4, 0.02), M.gray, 0, 0.45, 0);
  for (let i = 0; i < 3; i++) {
    addLocal(g, box(0.55, 0.02, 0.35), M.counter, 0, 0.25 + i * 0.25, 0.2, false);
    addLocal(g, box(0.1, 0.02, 0.02), M.metal, 0, 0.25 + i * 0.25, 0.22, false);
  }
  addLocal(g, box(0.6, 0.04, 0.4), M.counter, 0, 0.87, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    addLocal(g, new THREE.CylinderGeometry(0.05, 0.05, 0.03, 12), M.dark, sx * 0.25, 0.02, sz * 0.15);
  return g;
}
function fExamBed() {
  const g = new THREE.Group();
  // 可升降靠背（倾斜段）+ 平躺段两段床板
  addLocal(g, rbox(0.62, 0.04, 0.6, 0.015), M.medBlue, 0, 0.62, -0.6);
  addLocal(g, rbox(0.62, 0.04, 1.2, 0.015), M.medBlue, 0, 0.62, 0.3);
  // 床垫：上段（头侧）加枕头
  addLocal(g, rbox(0.56, 0.1, 0.6, 0.02), M.white, 0, 0.7, -0.6);
  addLocal(g, rbox(0.56, 0.1, 1.18, 0.02), M.white, 0, 0.7, 0.3);
  addLocal(g, rbox(0.4, 0.08, 0.28, 0.02), M.sheet, 0, 0.78, -0.78);
  // 输液架（床侧立柱 + 挂钩）
  addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.9, 8), M.metal, 0.35, 0.45, -0.4);
  for (const sx of [0.28, 0.42])
    addLocal(g, box(0.02, 0.02, 0.08), M.metal, sx, 0.9, -0.4, false);
  // 脚踏板
  addLocal(g, box(0.56, 0.22, 0.03), M.medBlue, 0, 0.5, 0.92);
  // 床架 + 脚轮
  for (const sx of [-0.3, 0.3]) for (const sz of [-0.88, 0.88])
    addLocal(g, new THREE.CylinderGeometry(0.03, 0.04, 0.62, 10), M.dark, sx, 0.31, sz);
  for (const sx of [-0.3, 0.3]) for (const sz of [-0.88, 0.88])
    addLocal(g, new THREE.CylinderGeometry(0.04, 0.04, 0.035, 10), M.metal, sx, 0.02, sz);
  return g;
}
function fInfantCrib() {
  const g = new THREE.Group();
  // 床体基座
  addLocal(g, rbox(0.72, 0.16, 1.2, 0.02), M.sheet, 0, 0.28, 0);
  // 床板
  addLocal(g, rbox(0.64, 0.06, 1.1, 0.02), M.white, 0, 0.5, 0);
  // 四根床柱
  for (const sx of [-0.34, 0.34]) for (const sz of [-0.58, 0.58])
    addLocal(g, box(0.04, 0.85, 0.04), M.white, sx, 0.62, sz);
  // 前后长护栏（竖杆）
  for (const sz of [-0.58, 0.58]) {
    addLocal(g, box(0.68, 0.05, 0.025), M.white, 0, 0.98, sz);
    addLocal(g, box(0.68, 0.05, 0.025), M.white, 0, 0.6, sz);
    for (let i = 0; i < 6; i++) {
      const x = -0.29 + i * 0.116;
      addLocal(g, box(0.02, 0.46, 0.02), M.white, x, 0.82, sz, false);
    }
  }
  // 左右短护栏
  for (const sx of [-0.34, 0.34]) {
    addLocal(g, box(0.03, 0.05, 1.12), M.white, sx, 0.98, 0);
    addLocal(g, box(0.03, 0.05, 1.12), M.white, sx, 0.6, 0);
  }
  // 卡通装饰 + 床头铃
  addLocal(g, rbox(0.18, 0.18, 0.03, 0.02), M.medYellow, 0, 0.72, -0.3, false);
  addLocal(g, new THREE.CylinderGeometry(0.015, 0.015, 0.2, 8), M.metal, 0.24, 1.05, -0.2);
  for (const sx of [-0.34, 0.34]) for (const sz of [-0.58, 0.58])
    addLocal(g, new THREE.CylinderGeometry(0.035, 0.035, 0.03, 10), M.dark, sx, 0.03, sz);
  return g;
}
function fDeliveryBed() {
  const g = new THREE.Group();
  // 分段可调床板（靠背 + 座 + 腿板）
  addLocal(g, rbox(0.9, 0.05, 0.6, 0.02), M.medBlue, 0, 0.62, -0.65);
  addLocal(g, rbox(0.9, 0.05, 0.7, 0.02), M.medBlue, 0, 0.62, 0);
  addLocal(g, rbox(0.9, 0.05, 0.6, 0.02), M.medBlue, 0, 0.62, 0.65);
  // 床垫
  addLocal(g, rbox(0.84, 0.1, 1.9, 0.02), M.white, 0, 0.7, 0);
  // 头枕可升降靠背（倾斜示意）
  addLocal(g, rbox(0.84, 0.18, 0.5, 0.03), M.sheet, 0, 0.82, -0.7);
  // 腿托（两个可调节式腿架）
  for (const sx of [-0.3, 0.3]) {
    addLocal(g, box(0.1, 0.06, 0.3), M.medBlue, sx, 0.68, 0.98);
    addLocal(g, rbox(0.1, 0.05, 0.22, 0.02), M.white, sx, 0.73, 1.12);
    addLocal(g, new THREE.CylinderGeometry(0.025, 0.025, 0.5, 8), M.metal, sx, 0.42, 1.05);
  }
  // 拉手 + 调节摇杆
  addLocal(g, box(0.04, 0.04, 0.5), M.metal, 0.48, 0.64, -0.4);
  addLocal(g, new THREE.CylinderGeometry(0.03, 0.03, 0.15, 8), M.dark, 0.45, 0.3, 0.7);
  // 床架 + 脚轮
  for (const sx of [-0.42, 0.42]) for (const sz of [-0.85, 0.85])
    addLocal(g, new THREE.CylinderGeometry(0.035, 0.045, 0.58, 10), M.dark, sx, 0.3, sz);
  for (const sx of [-0.42, 0.42]) for (const sz of [-0.85, 0.85])
    addLocal(g, new THREE.CylinderGeometry(0.05, 0.05, 0.04, 12), M.metal, sx, 0.02, sz);
  return g;
}
function fIcuBed() {
  const g = new THREE.Group();
  // 床架 + 厚床垫
  addLocal(g, rbox(1.05, 0.14, 2.2, 0.02), M.gray, 0, 0.55, 0);
  addLocal(g, rbox(0.98, 0.16, 2.12, 0.03), M.white, 0, 0.68, 0);
  // 三段护栏（可放倒式，竖杆+横杆）
  const rail = (sx) => {
    addLocal(g, box(0.03, 0.42, 1.0), M.metal, sx, 0.78, 0.5);
    addLocal(g, box(0.03, 0.05, 1.0), M.metal, sx, 0.98, 0.5);
    for (let i = 0; i < 7; i++) {
      const z = -0.4 + i * 0.133;
      addLocal(g, new THREE.CylinderGeometry(0.01, 0.01, 0.42, 6), M.metal, sx, 0.8, z, false);
    }
  };
  rail(-0.48); rail(0.48);
  // 床头板 + 床尾板（可拆卸式）
  for (const sz of [-1.08, 1.08]) {
    addLocal(g, rbox(1.0, 0.5, 0.05, 0.02), M.medBlue, 0, 0.92, sz);
    addLocal(g, box(0.8, 0.04, 0.04), M.dark, 0, 0.82, sz, false);
  }
  // 床头升高摇杆 + 输液架孔
  addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), M.metal, 0.4, 0.35, -1.05);
  addLocal(g, box(0.04, 0.04, 0.04), M.dark, 0.4, 0.5, -1.05);
  // 床侧监护仪支架 + 输液架
  addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 1.1, 8), M.metal, -0.42, 0.55, -0.3);
  addLocal(g, box(0.18, 0.14, 0.03), M.dark, -0.42, 1.25, -0.3);
  for (const sx of [-0.48, 0.48]) for (const sz of [-1.05, 1.05])
    addLocal(g, new THREE.CylinderGeometry(0.065, 0.065, 0.05, 12), M.dark, sx, 0.03, sz);
  return g;
}
function fCompanionBed() {
  const g = new THREE.Group();
  // 折叠床体（平放状态）+ 床垫
  addLocal(g, rbox(0.82, 0.08, 1.82, 0.02), M.fabric, 0, 0.5, 0);
  addLocal(g, rbox(0.76, 0.1, 1.76, 0.02), M.sheet, 0, 0.6, 0);
  addLocal(g, rbox(0.5, 0.06, 0.3, 0.02), M.white, 0, 0.68, -0.72);
  // X 型可折叠支腿（交叉支撑）
  for (const sz of [-0.55, 0.55]) {
    addLocal(g, box(0.04, 0.45, 0.75), M.dark, -0.2, 0.26, sz);
    addLocal(g, box(0.04, 0.45, 0.75), M.dark, 0.2, 0.26, sz);
  }
  // 床头床尾横向连杆
  for (const sz of [-0.85, 0.85])
    addLocal(g, box(0.78, 0.04, 0.04), M.dark, 0, 0.5, sz);
  // 折叠铰链 + 脚垫
  addLocal(g, box(0.08, 0.02, 0.02), M.metal, 0, 0.48, 0, false);
  for (const sx of [-0.36, 0.36]) for (const sz of [-0.8, 0.8])
    addLocal(g, new THREE.CylinderGeometry(0.03, 0.03, 0.03, 8), M.dark, sx, 0.03, sz);
  return g;
}
function fCtScanner() {
  const g = new THREE.Group();
  // 主机外壳（大型）
  addLocal(g, rbox(0.55, 1.15, 0.55, 0.02), M.white, 0, 0.85, 0);
  // 环形机架（圆环 + 内圈开口 + 外圈装饰环）
  addLocal(g, new THREE.TorusGeometry(0.42, 0.19, 16, 32), M.white, 0, 1.5, 0);
  addLocal(g, new THREE.TorusGeometry(0.42, 0.2, 16, 32), M.counter, 0, 1.5, 0.01, false);
  addLocal(g, new THREE.CylinderGeometry(0.36, 0.36, 0.06, 24), M.dark, 0, 1.5, 0, false);
  addLocal(g, new THREE.TorusGeometry(0.5, 0.03, 8, 32), M.medBlue, 0, 1.5, 0);
  // 激光定位灯
  addLocal(g, new THREE.CylinderGeometry(0.015, 0.015, 0.08, 8), M.medRed, 0, 1.96, 0);
  // 诊断床（可伸缩，伸进机架）
  addLocal(g, box(0.55, 0.04, 1.9), M.medBlue, 0, 0.72, 0);
  addLocal(g, rbox(0.5, 0.03, 1.85, 0.01), M.white, 0, 0.76, 0);
  addLocal(g, new THREE.CylinderGeometry(0.04, 0.05, 0.5, 10), M.metal, 0, 0.25, 0.6);
  addLocal(g, new THREE.CylinderGeometry(0.04, 0.05, 0.5, 10), M.metal, 0, 0.25, -0.6);
  addLocal(g, box(0.6, 0.03, 0.5), M.dark, 0, 0.06, 0.5);
  // 控制台
  addLocal(g, box(0.45, 0.5, 0.45), M.counter, 0.65, 0.6, 0.5);
  addLocal(g, box(0.4, 0.22, 0.06), M.dark, 0.65, 0.85, 0.5);
  addLocal(g, box(0.4, 0.04, 0.3), M.gray, 0.65, 0.75, 0.5, false);
  return g;
}
function fXrayMachine() {
  const g = new THREE.Group();
  // 地面轨道底座
  addLocal(g, box(1.1, 0.05, 0.16), M.dark, 0, 0.03, 0);
  // 立柱
  addLocal(g, box(0.3, 2.2, 0.3), M.white, 0, 1.15, 0);
  // 水平伸缩臂 + 球管（X射线管）
  addLocal(g, box(0.75, 0.08, 0.16), M.white, 0, 2.35, 0.2);
  addLocal(g, box(0.16, 0.28, 0.12), M.gray, 0.62, 2.28, 0.2);
  addLocal(g, new THREE.SphereGeometry(0.11, 16, 12), M.dark, 0.32, 2.18, 0.2, false);
  addLocal(g, new THREE.CylinderGeometry(0.06, 0.08, 0.14, 12), M.metal, 0.32, 2.12, 0.2);
  // 拍片床/胸片架（立式面板）
  addLocal(g, box(0.9, 0.03, 0.6), M.counter, -0.4, 0.9, -0.5);
  addLocal(g, box(0.75, 1.5, 0.1), M.white, -0.4, 1.65, -0.5);
  addLocal(g, box(0.75, 1.5, 0.02), M.dark, -0.4, 1.65, -0.56, false);
  // 操作面板
  addLocal(g, box(0.25, 0.35, 0.05), M.dark, 0.25, 1.5, 0.18);
  // 高压电源箱
  addLocal(g, box(0.5, 0.5, 0.5), M.gray, 1.1, 0.3, 0.3);
  return g;
}
function fUltrasound() {
  const g = new THREE.Group();
  // 移动推车底座 + 脚轮
  addLocal(g, rbox(0.55, 0.6, 0.55, 0.02), M.white, 0, 0.35, 0);
  for (const sx of [-0.22, 0.22]) for (const sz of [-0.22, 0.22])
    addLocal(g, new THREE.CylinderGeometry(0.045, 0.045, 0.04, 10), M.dark, sx, 0.02, sz);
  // 手推把手
  addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), M.metal, -0.3, 1.2, -0.3);
  addLocal(g, box(0.05, 0.02, 0.4), M.metal, -0.3, 1.35, -0.28, false);
  // 主显示屏（可旋转）
  addLocal(g, box(0.36, 0.26, 0.05), M.dark, 0, 0.68, 0.3);
  addLocal(g, box(0.3, 0.2, 0.03), M.medBlue, 0, 0.7, 0.32, false);
  // 触控操作面板
  addLocal(g, box(0.3, 0.18, 0.04), M.dark, 0, 0.52, 0.31, false);
  addLocal(g, box(0.24, 0.12, 0.02), M.white, 0, 0.5, 0.33, false);
  // 探头挂架 + 多支探头
  for (const sx of [-0.35, -0.15, 0.05]) {
    addLocal(g, box(0.14, 0.04, 0.06), M.gray, sx, 0.94, 0.18);
    addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.4, 8), M.metal, sx, 0.72, 0.18);
    addLocal(g, rbox(0.05, 0.08, 0.05, 0.015), M.dark, sx, 0.5, 0.18);
  }
  // 电缆
  addLocal(g, new THREE.CylinderGeometry(0.008, 0.008, 0.5, 6), M.dark, 0.15, 0.7, 0.2);
  return g;
}
function fDefibrillator() {
  const g = new THREE.Group();
  // 带提手的便携主机
  addLocal(g, rbox(0.5, 0.36, 0.32, 0.02), M.medRed, 0, 0.3, 0);
  addLocal(g, box(0.42, 0.26, 0.05), M.white, 0, 0.24, 0.17);
  addLocal(g, box(0.1, 0.08, 0.9), M.dark, 0, 0.5, 0);
  // 提手
  addLocal(g, box(0.06, 0.04, 0.2), M.dark, 0, 0.5, 0);
  // 心电屏幕 + 指示灯
  addLocal(g, box(0.24, 0.1, 0.03), M.medBlue, 0, 0.34, 0.17);
  addLocal(g, box(0.06, 0.06, 0.02), M.medYellow, -0.12, 0.28, 0.19, false);
  addLocal(g, rbox(0.18, 0.06, 0.02, 0.01), M.white, -0.08, 0.18, 0.19, false);
  // 两个电极板（手柄式）
  for (const sx of [-0.25, 0.25]) {
    addLocal(g, rbox(0.1, 0.04, 0.12, 0.01), M.gray, sx, 0.62, 0.08);
    addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.2, 8), M.dark, sx, 0.72, 0.06);
    addLocal(g, rbox(0.06, 0.03, 0.06, 0.01), M.medYellow, sx, 0.82, 0.05);
  }
  // 缠绕的连接线
  addLocal(g, new THREE.CylinderGeometry(0.008, 0.008, 0.4, 6), M.dark, -0.2, 0.45, 0.05);
  addLocal(g, new THREE.CylinderGeometry(0.008, 0.008, 0.4, 6), M.dark, 0.2, 0.45, 0.05);
  return g;
}
function fAnesthesiaMachine() {
  const g = new THREE.Group();
  // 主机箱
  addLocal(g, rbox(0.55, 1.0, 0.5, 0.02), M.white, 0, 0.5, 0);
  // 顶部监控屏
  addLocal(g, box(0.3, 0.25, 0.05), M.dark, 0, 1.15, 0.28);
  addLocal(g, box(0.24, 0.18, 0.03), M.medBlue, 0, 1.16, 0.3, false);
  // 流量计（玻璃管，带刻度）
  for (const sx of [-0.1, 0.1]) {
    addLocal(g, new THREE.CylinderGeometry(0.03, 0.03, 0.35, 10), M.glass, sx, 0.95, 0.1);
    addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.05, 8), M.metal, sx, 1.18, 0.1);
  }
  // 两个气瓶（氧气 + 笑气）
  for (const sz of [-0.15, 0.15]) {
    addLocal(g, new THREE.CylinderGeometry(0.12, 0.12, 0.6, 14), M.medGreen, 0.05, 0.32, sz);
    addLocal(g, new THREE.SphereGeometry(0.06, 12, 10), M.dark, 0.05, 0.62, sz);
    addLocal(g, new THREE.CylinderGeometry(0.13, 0.13, 0.02, 14), M.counter, 0.05, 0.05, sz);
  }
  // 蒸发罐（麻醉剂）
  addLocal(g, new THREE.CylinderGeometry(0.09, 0.1, 0.16, 14), M.medYellow, 0.22, 1.0, 0.12);
  addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.04, 8), M.metal, 0.22, 1.12, 0.12);
  // 呼吸回路管（螺纹示意）
  addLocal(g, new THREE.CylinderGeometry(0.015, 0.015, 0.3, 6), M.gray, 0.15, 0.75, 0.28);
  // 底部脚轮
  for (const sx of [-0.24, 0.24]) for (const sz of [-0.2, 0.2])
    addLocal(g, new THREE.CylinderGeometry(0.04, 0.04, 0.03, 10), M.dark, sx, 0.03, sz);
  return g;
}
function fInfusionPump() {
  const g = new THREE.Group();
  // 泵体
  addLocal(g, rbox(0.32, 0.42, 0.34, 0.02), M.white, 0, 0.35, 0);
  // 显示屏
  addLocal(g, box(0.22, 0.14, 0.03), M.dark, 0, 0.4, 0.18);
  addLocal(g, box(0.16, 0.08, 0.02), M.medGreen, 0, 0.4, 0.19, false);
  // 门锁扣
  addLocal(g, box(0.04, 0.3, 0.04), M.gray, 0.12, 0.42, 0.18);
  // 输液管 + 输液瓶
  addLocal(g, new THREE.CylinderGeometry(0.012, 0.012, 0.5, 6), M.dark, 0, 0.75, 0.1);
  addLocal(g, new THREE.CylinderGeometry(0.06, 0.05, 0.18, 12), M.glass, 0, 0.9, 0.1);
  addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.08, 8), M.gray, 0, 1.0, 0.1);
  // 顶部挂钩
  addLocal(g, new THREE.TorusGeometry(0.05, 0.015, 6, 12), M.metal, 0, 1.05, 0.1);
  // 底脚
  for (const sx of [-0.12, 0.12]) addLocal(g, new THREE.CylinderGeometry(0.03, 0.03, 0.03, 8), M.dark, sx, 0.02, 0.12);
  return g;
}
function fFirstAidKit() {
  const g = new THREE.Group();
  // 带提手的急救箱箱体
  addLocal(g, rbox(0.45, 0.22, 0.3, 0.02), M.white, 0, 0.15, 0);
  // 箱盖 + 合页
  addLocal(g, rbox(0.45, 0.06, 0.3, 0.02), M.counter, 0, 0.29, 0);
  addLocal(g, box(0.04, 0.02, 0.06), M.metal, -0.15, 0.27, 0.15);
  addLocal(g, box(0.04, 0.02, 0.06), M.metal, 0.15, 0.27, 0.15);
  // 提手
  addLocal(g, box(0.1, 0.05, 0.04), M.dark, 0, 0.34, 0);
  addLocal(g, box(0.03, 0.1, 0.03), M.dark, -0.2, 0.35, 0);
  addLocal(g, box(0.03, 0.1, 0.03), M.dark, 0.2, 0.35, 0);
  // 红十字标志（箱体正面）
  addLocal(g, box(0.14, 0.05, 0.01), M.medRed, -0.05, 0.16, 0.16);
  addLocal(g, box(0.05, 0.14, 0.01), M.medRed, -0.05, 0.16, 0.16);
  // 锁扣
  addLocal(g, box(0.04, 0.03, 0.02), M.metal, 0, 0.14, 0.16);
  return g;
}
function fOxygenTankCart() {
  const g = new THREE.Group();
  // 两个氧气瓶并排
  for (const sx of [-0.15, 0.15]) {
    addLocal(g, new THREE.CylinderGeometry(0.13, 0.13, 1.3, 14), M.medGreen, sx, 0.65, 0);
    addLocal(g, new THREE.SphereGeometry(0.07, 12, 10), M.dark, sx, 1.34, 0);
    addLocal(g, new THREE.CylinderGeometry(0.14, 0.14, 0.03, 14), M.counter, sx, 0.04, 0);
  }
  // 氧气表 + 流量计
  addLocal(g, new THREE.CylinderGeometry(0.05, 0.05, 0.06, 10), M.white, 0, 1.3, 0.12);
  addLocal(g, new THREE.CylinderGeometry(0.03, 0.03, 0.18, 8), M.glass, 0, 1.1, 0.15);
  // 推车架（背靠框架 + 把手）
  addLocal(g, box(0.44, 0.9, 0.05), M.gray, 0, 0.5, -0.3);
  addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), M.metal, -0.18, 1.1, -0.35);
  addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), M.metal, 0.18, 1.1, -0.35);
  addLocal(g, box(0.04, 0.02, 0.3), M.metal, 0, 1.25, -0.35);
  // 底部底座 + 脚轮
  addLocal(g, box(0.46, 0.04, 0.4), M.dark, 0, 0.06, -0.1);
  for (const sx of [-0.2, 0.2]) for (const sz of [-0.28, 0.08])
    addLocal(g, new THREE.CylinderGeometry(0.04, 0.04, 0.04, 10), M.dark, sx, 0.03, sz);
  return g;
}
function fMicroscope() {
  const g = new THREE.Group();
  // 马蹄形底座
  addLocal(g, rbox(0.3, 0.04, 0.28, 0.01), M.dark, 0, 0.02, 0);
  // 镜臂（弧形立柱）
  addLocal(g, box(0.06, 0.35, 0.06), M.metal, -0.1, 0.22, 0.03);
  // 载物台 + 样品夹
  addLocal(g, box(0.12, 0.015, 0.12), M.metal, 0, 0.4, 0);
  addLocal(g, box(0.02, 0.02, 0.1), M.dark, 0, 0.43, 0);
  // 物镜转盘（4个物镜）
  addLocal(g, new THREE.CylinderGeometry(0.05, 0.05, 0.03, 12), M.metal, -0.1, 0.47, 0.03);
  for (let i = 0; i < 4; i++) {
    const ang = i * Math.PI / 2;
    addLocal(g, new THREE.CylinderGeometry(0.015, 0.015, 0.06, 8), M.dark, -0.1 + Math.cos(ang) * 0.07, 0.5, 0.03 + Math.sin(ang) * 0.07);
  }
  // 镜筒（倾斜）+ 目镜（双筒）
  addLocal(g, box(0.04, 0.16, 0.04), M.metal, -0.1, 0.6, 0.03);
  for (const sx of [-0.03, 0.03]) {
    addLocal(g, box(0.02, 0.05, 0.02), M.metal, -0.1 + sx, 0.72, 0.03);
    addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.02, 10), M.dark, -0.1 + sx, 0.76, 0.03);
  }
  // 粗调节旋钮
  addLocal(g, new THREE.CylinderGeometry(0.04, 0.04, 0.02, 12), M.dark, -0.1, 0.3, 0.08);
  addLocal(g, new THREE.CylinderGeometry(0.04, 0.04, 0.02, 12), M.dark, -0.1, 0.3, -0.02);
  // 反光镜
  addLocal(g, new THREE.CylinderGeometry(0.06, 0.06, 0.01, 12), M.glass, 0, 0.08, 0);
  return g;
}
function fCentrifuge() {
  const g = new THREE.Group();
  // 圆筒机身
  addLocal(g, new THREE.CylinderGeometry(0.2, 0.22, 0.3, 20), M.white, 0, 0.18, 0);
  addLocal(g, new THREE.CylinderGeometry(0.21, 0.23, 0.02, 20), M.counter, 0, 0.33, 0);
  // 顶盖（可开启式，半透明）
  addLocal(g, new THREE.SphereGeometry(0.19, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.counter, 0, 0.33, 0, false);
  addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.03, 8), M.dark, 0, 0.52, 0);
  // 转子（内腔示意）
  addLocal(g, new THREE.CylinderGeometry(0.12, 0.12, 0.06, 16), M.gray, 0, 0.3, 0);
  for (let i = 0; i < 8; i++) {
    const ang = i * Math.PI / 4;
    addLocal(g, new THREE.CylinderGeometry(0.02, 0.02, 0.05, 8), M.metal, Math.cos(ang) * 0.08, 0.33, Math.sin(ang) * 0.08);
  }
  // 控制面板
  addLocal(g, box(0.26, 0.06, 0.03), M.dark, 0, 0.08, 0.23);
  addLocal(g, box(0.04, 0.03, 0.02), M.medGreen, -0.14, 0.16, 0.24, false);
  addLocal(g, box(0.04, 0.03, 0.02), M.medRed, -0.08, 0.16, 0.24, false);
  // 底脚
  for (const sx of [-0.16, 0.16]) for (const sz of [-0.16, 0.16])
    addLocal(g, new THREE.CylinderGeometry(0.03, 0.03, 0.02, 8), M.dark, sx, 0.01, sz);
  return g;
}
function fVitalsCart() {
  const g = new THREE.Group();
  // 推车底座 + 脚轮
  addLocal(g, rbox(0.55, 0.55, 0.45, 0.02), M.white, 0, 0.3, 0);
  for (const sx of [-0.22, 0.22]) for (const sz of [-0.18, 0.18])
    addLocal(g, new THREE.CylinderGeometry(0.04, 0.04, 0.03, 10), M.dark, sx, 0.02, sz);
  // 立柱
  addLocal(g, new THREE.CylinderGeometry(0.025, 0.025, 0.9, 8), M.metal, 0, 0.75, 0);
  // 监护屏幕（大屏）
  addLocal(g, box(0.32, 0.26, 0.05), M.dark, 0, 1.15, 0.28);
  addLocal(g, box(0.26, 0.2, 0.03), M.medBlue, 0, 1.16, 0.3, false);
  addLocal(g, box(0.26, 0.03, 0.03), M.gray, 0, 1.3, 0.3, false);
  // 心电波形示意（绿色线条用薄片替代）
  addLocal(g, box(0.2, 0.008, 0.008), M.medGreen, 0, 1.12, 0.32, false);
  // 血压计 + 袖带挂架
  addLocal(g, box(0.18, 0.12, 0.08), M.gray, 0, 0.62, 0.28);
  addLocal(g, box(0.14, 0.05, 0.04), M.medYellow, 0, 0.68, 0.32, false);
  addLocal(g, new THREE.TorusGeometry(0.08, 0.03, 8, 16), M.sheet, -0.2, 0.5, 0.2);
  // 主电缆收纳
  addLocal(g, box(0.12, 0.12, 0.12), M.gray, 0, 0.85, -0.15);
  addLocal(g, new THREE.CylinderGeometry(0.01, 0.01, 0.3, 6), M.dark, 0, 1.4, -0.1);
  return g;
}
function fWalker() {
  const g = new THREE.Group();
  // U型框架（左右两侧 + 前横梁）
  for (const sx of [-0.22, 0.22]) {
    addLocal(g, new THREE.CylinderGeometry(0.018, 0.018, 0.82, 8), M.metal, sx, 0.61, 0.1);
    addLocal(g, new THREE.CylinderGeometry(0.018, 0.018, 0.82, 8), M.metal, sx, 0.61, -0.1);
    addLocal(g, new THREE.CylinderGeometry(0.018, 0.018, 0.2, 8), M.metal, sx, 0.61, 0);
    addLocal(g, box(0.04, 0.025, 0.18), M.dark, sx, 0.82, 0);
  }
  // 前横梁（两层，可折叠式）
  addLocal(g, box(0.44, 0.03, 0.03), M.metal, 0, 0.82, 0.1);
  addLocal(g, box(0.44, 0.03, 0.03), M.metal, 0, 0.82, -0.1);
  // 握把（软胶套）
  addLocal(g, box(0.44, 0.03, 0.025), M.dark, 0, 0.9, -0.1);
  // 底部横撑
  addLocal(g, box(0.44, 0.03, 0.03), M.metal, 0, 0.1, 0);
  // 脚垫
  for (const sx of [-0.22, 0.22]) for (const sz of [-0.1, 0.1])
    addLocal(g, new THREE.CylinderGeometry(0.025, 0.025, 0.03, 8), M.dark, sx, 0.02, sz);
  return g;
}
function fMobileSurgLight() {
  const g = new THREE.Group();
  // 五脚底座 + 脚轮
  for (let i = 0; i < 5; i++) {
    const ang = i * Math.PI * 2 / 5;
    addLocal(g, box(0.05, 0.03, 0.4), M.dark, Math.cos(ang) * 0.2, 0.05, Math.sin(ang) * 0.2);
    addLocal(g, new THREE.CylinderGeometry(0.04, 0.04, 0.03, 10), M.dark, Math.cos(ang) * 0.37, 0.02, Math.sin(ang) * 0.37);
  }
  // 立柱
  addLocal(g, new THREE.CylinderGeometry(0.03, 0.04, 1.7, 10), M.metal, 0, 0.9, -0.1);
  // 平衡臂
  addLocal(g, box(0.65, 0.04, 0.04), M.metal, 0.3, 1.75, -0.05);
  // 灯头（无影灯：多层多灯珠）
  addLocal(g, new THREE.CylinderGeometry(0.28, 0.22, 0.05, 24), M.white, 0.6, 1.72, 0.1);
  addLocal(g, new THREE.CylinderGeometry(0.16, 0.12, 0.04, 18), M.counter, 0.6, 1.68, 0.1);
  addLocal(g, new THREE.CylinderGeometry(0.04, 0.04, 0.08, 12), M.metal, 0.45, 1.68, 0.1);
  // 把手（消毒把手）
  addLocal(g, new THREE.CylinderGeometry(0.04, 0.04, 0.2, 8), M.medGreen, 0.6, 1.85, 0.35);
  return g;
}
function fChartCabinet() {
  const g = new THREE.Group();
  // 柜体
  addLocal(g, rbox(1.2, 1.5, 0.56, 0.02), M.white, 0, 0.75, 0);
  // 顶部台面
  addLocal(g, box(1.22, 0.03, 0.58), M.counter, 0, 1.51, 0);
  // 四层抽屉（带标签条 + 拉手）
  for (let i = 0; i < 4; i++) {
    const y = 0.2 + i * 0.34;
    addLocal(g, box(1.1, 0.3, 0.5), M.counter, 0, y, 0.03);
    addLocal(g, box(0.8, 0.04, 0.02), M.medBlue, 0, y + 0.05, 0.29, false);
    addLocal(g, box(0.16, 0.035, 0.02), M.metal, 0, y - 0.05, 0.29);
  }
  // 底部脚
  for (const sx of [-0.5, 0.5]) for (const sz of [-0.24, 0.24])
    addLocal(g, new THREE.CylinderGeometry(0.03, 0.03, 0.05, 8), M.dark, sx, 0.03, sz);
  return g;
}
function fHandSanitizerStand() {
  const g = new THREE.Group();
  // 落地底座
  addLocal(g, new THREE.CylinderGeometry(0.22, 0.28, 0.04, 20), M.dark, 0, 0.02, 0);
  // 立柱
  addLocal(g, new THREE.CylinderGeometry(0.03, 0.04, 1.1, 10), M.metal, 0, 0.6, 0);
  // 消毒液瓶（半透明白瓶）
  addLocal(g, rbox(0.16, 0.34, 0.16, 0.02), M.white, 0, 1.05, 0);
  // 液面（蓝色液体）
  addLocal(g, rbox(0.12, 0.16, 0.12, 0.015), M.medBlue, 0, 0.98, 0, false);
  // 按压泵头 + 喷嘴
  addLocal(g, new THREE.CylinderGeometry(0.025, 0.025, 0.1, 10), M.metal, 0, 1.26, 0);
  addLocal(g, box(0.1, 0.03, 0.03), M.metal, 0, 1.32, 0.06);
  addLocal(g, rbox(0.05, 0.04, 0.02, 0.005), M.dark, 0.06, 1.31, 0.07);
  // 提示标识
  addLocal(g, box(0.06, 0.04, 0.005), M.medGreen, 0, 0.8, 0.09, false);
  return g;
}
// 家具库分类顺序与显示名（custom 排最前，导入的模型最容易找到）
const FURN_CAT_ORDER = ['custom','bed','bath','kitchen','hvac','furn','light','media','misc','outdoor','safety','medical','sport','other'];
const FURN_CAT_NAMES = { custom:'我的模型', bed:'床与卧室', bath:'卫浴', kitchen:'厨电', hvac:'空调暖通', furn:'桌椅柜', light:'灯具', media:'视听娱乐', misc:'装饰杂物', outdoor:'绿植户外', safety:'安防设备', medical:'医疗设备', sport:'健身玩具', stairs:'楼梯(工具)', other:'其他' };

const FURN = {
  bed:       { cat: 'bed',      name: '双人床 1.5×2.0', icon: '🛏', w: 1.5,  d: 2.0,  build: () => fBed(1.5, 2.0, false) },
  bed1:      { cat: 'bed',      name: '单人床 1.0×2.0', icon: '🛏', w: 1.0,  d: 2.0,  build: () => fBed(1.0, 2.0, true) },
  wardrobe:  { cat: 'furn',     name: '衣柜 1.8m',      icon: '🚪', w: 1.8,  d: 0.55, build: fWardrobe },
  nightstand:{ cat: 'bed',      name: '床头柜',         icon: '🪑', w: 0.45, d: 0.42, build: fNightstand },
  desk:      { cat: 'furn',     name: '书桌 + 椅',      icon: '🖥', w: 1.3,  d: 1.15, build: fDesk },
  shelf:     { cat: 'furn',     name: '书架 1.2m',      icon: '📚', w: 1.2,  d: 0.3,  build: fShelf },
  sofa:      { cat: 'furn',     name: '三人沙发',       icon: '🛋', w: 2.0,  d: 0.85, build: fSofa },
  tea:       { cat: 'furn',     name: '茶几',           icon: '☕', w: 1.0,  d: 0.5,  build: fTea },
  dining:    { cat: 'furn',     name: '餐桌 + 4椅',     icon: '🍽', w: 2.1,  d: 1.9,  build: fDining },
  toilet:    { cat: 'bath',     name: '马桶',           icon: '🚽', w: 0.45, d: 0.72, build: fToilet },
  basin:     { cat: 'bath',     name: '洗手台',         icon: '🚰', w: 0.5,  d: 0.4,  build: fBasin },
  fridge:    { cat: 'kitchen',  name: '冰箱',           icon: '🧊', w: 0.65, d: 0.65, build: fFridge },

  // ── 参考程序移植的 GLB 模型（Pascal Editor，MIT）──
  // w/d = 实际占地面积（米），h = 模型离地高度
  // scale = 模型内部单位→米的换算（>1 表示源模型偏小，需放大）
  bunkbed:        { cat: 'bed',     name: '双层床',         icon: '🛏', w: 1.0,  d: 2.0,  h: 1.55, file: 'bunkbed',        build: glbBuild('bunkbed') },
  bedside:        { cat: 'bed',     name: '床头柜(精致)',   icon: '🪑', w: 0.44, d: 0.46, h: 0.48, file: 'bedside-table',  build: glbBuild('bedside-table') },
  couchMed:       { cat: 'furn',    name: '中沙发',         icon: '🛋', w: 2.35, d: 1.10, h: 0.95, file: 'couch-medium',   build: glbBuild('couch-medium'),   scale: 0.5 },
  couchSm:        { cat: 'furn',    name: '双人沙发',       icon: '🛋', w: 1.45, d: 1.10, h: 0.95, file: 'couch-small',    build: glbBuild('couch-small'),    scale: 0.5 },
  lounge:         { cat: 'furn',    name: '躺椅',           icon: '🪑', w: 0.67, d: 1.25, h: 1.03, file: 'lounge-chair',   build: glbBuild('lounge-chair') },
  lrChair:        { cat: 'furn',    name: '扶手椅',         icon: '🪑', w: 1.10, d: 1.07, h: 0.74, file: 'livingroom-chair',build: glbBuild('livingroom-chair') },
  officeTable:    { cat: 'furn',    name: '办公桌',         icon: '🖥', w: 1.50, d: 0.61, h: 0.75, file: 'office-table',   build: glbBuild('office-table') },
  bathtub:        { cat: 'bath',    name: '浴缸',           icon: '🛁', w: 1.75, d: 0.83, h: 0.78, file: 'bathtub',        build: glbBuild('bathtub') },
  shower:         { cat: 'bath',    name: '淋浴',           icon: '🚿', w: 0.83, d: 0.83, h: 2.06, file: 'shower',         build: glbBuild('shower'),      yOff: -0.6 },
  bathSink:       { cat: 'bath',    name: '浴室柜',         icon: '🚰', w: 1.37, d: 0.47, h: 0.97, file: 'bathroom-sink',  build: glbBuild('bathroom-sink') },
  stove:          { cat: 'kitchen', name: '灶台',           icon: '🔥', w: 0.69, d: 0.56, h: 0.85, file: 'stove',          build: glbBuild('stove') },
  microwave:      { cat: 'kitchen', name: '微波炉',         icon: '🍲', w: 0.52, d: 0.41, h: 0.26, file: 'microwave',      build: glbBuild('microwave') },
  washer:         { cat: 'kitchen', name: '洗衣机',         icon: '🧺', w: 0.60, d: 0.53, h: 0.86, file: 'washing-machine',build: glbBuild('washing-machine') },
  kitchen:        { cat: 'kitchen', name: '整体厨房',       icon: '🍳', w: 2.38, d: 0.83, h: 1.03, file: 'kitchen',        build: glbBuild('kitchen') },
  kCounter:       { cat: 'kitchen', name: '厨房台面',       icon: '🍽', w: 1.47, d: 0.63, h: 0.73, file: 'kitchen-counter',build: glbBuild('kitchen-counter') },
  kFridge:        { cat: 'kitchen', name: '厨房冰箱',       icon: '🧊', w: 1.30, d: 1.30, h: 3.31, file: 'kitchen-fridge', build: glbBuild('kitchen-fridge') },
  kShelf:         { cat: 'kitchen', name: '厨房搁架',       icon: '🗄', w: 2.20, d: 0.52, h: 0.89, file: 'kitchen-shelf',  build: glbBuild('kitchen-shelf') },
  tvFlat:         { cat: 'media',   name: '平板电视',       icon: '📺', w: 1.22, d: 0.12, h: 0.71, file: 'flat-screen-tv', build: glbBuild('flat-screen-tv'), scale: 0.3, yOff: 1.0 },
  tvStand:        { cat: 'furn',    name: '电视柜',         icon: '📺', w: 1.85, d: 0.32, h: 0.35, file: 'tv-stand',       build: glbBuild('tv-stand') },
  computer:       { cat: 'media',   name: '台式电脑',       icon: '💻', w: 0.67, d: 0.19, h: 0.47, file: 'computer',       build: glbBuild('computer') },
  ceilFan:        { cat: 'light',   name: '吊扇',           icon: '🌀', w: 0.92, d: 1.03, h: 0.35, file: 'ceiling-fan',    build: glbBuild('ceiling-fan'),  yOff: 2.4 },
  ceilLamp:       { cat: 'light',   name: '吊灯',           icon: '💡', w: 0.55, d: 0.55, h: 0.85, file: 'ceiling-lamp',   build: glbBuild('ceiling-lamp'), yOff: 2.4 },
  floorLamp:      { cat: 'light',   name: '落地灯',         icon: '🪔', w: 0.70, d: 0.68, h: 1.85, file: 'floor-lamp',     build: glbBuild('floor-lamp') },
  tableLamp:      { cat: 'light',   name: '台灯',           icon: '🪔', w: 0.29, d: 0.66, h: 0.73, file: 'table-lamp',     build: glbBuild('table-lamp') },
  acBlock             : { name: '空调外机块', icon: '❄', cat: 'hvac', w: 1.33, d: 1.33, h: 1.20, file: 'ac-block', build: glbBuild('ac-block') },
  airConditioner      : { name: '挂壁空调', icon: '❄', cat: 'hvac', w: 1000.00, d: 139.14, h: 243.19, file: 'air-conditioner', scale: 0.01, build: glbBuild('air-conditioner') },  // ⚠size>5m
  airConditionerBlock : { name: '空调方块', icon: '❄', cat: 'hvac', w: 1.04, d: 0.77, h: 0.69, file: 'air-conditioner-block', build: glbBuild('air-conditioner-block') },
  airConditioning     : { name: '中央空调', icon: '❄', cat: 'hvac', w: 1.55, d: 0.40, h: 0.60, file: 'air-conditioning', build: glbBuild('air-conditioning') },
  alarmKeypad         : { name: '报警键盘', icon: '🔐', cat: 'safety', w: 0.18, d: 0.12, h: 0.02, file: 'alarm-keypad', build: glbBuild('alarm-keypad') },
  ball                : { name: '球', icon: '⚽', cat: 'sport', w: 0.23, d: 0.23, h: 0.24, file: 'ball', build: glbBuild('ball') },
  barbell             : { name: '杠铃', icon: '🏋', cat: 'sport', w: 0.38, d: 1.72, h: 0.38, file: 'barbell', build: glbBuild('barbell') },
  barbellStand        : { name: '杠铃架', icon: '🏋', cat: 'furn', w: 1.33, d: 1.72, h: 1.22, file: 'barbell-stand', build: glbBuild('barbell-stand') },
  basketHoop          : { name: '篮球架', icon: '🏀', cat: 'sport', w: 0.67, d: 0.56, h: 1.77, file: 'basket-hoop', build: glbBuild('basket-hoop') },
  beanBag             : { name: '懒人沙发', icon: '🛋', cat: 'misc', w: 1.04, d: 1.13, h: 1.07, file: 'bean-bag', build: glbBuild('bean-bag') },
  books               : { name: '书堆', icon: '📚', cat: 'misc', w: 0.21, d: 0.18, h: 0.21, file: 'books', build: glbBuild('books') },
  bookshelf           : { name: '书架', icon: '📚', cat: 'furn', w: 0.92, d: 0.32, h: 1.99, file: 'bookshelf', build: glbBuild('bookshelf') },
  bush                : { name: '灌木丛', icon: '🌿', cat: 'outdoor', w: 3.12, d: 1.04, h: 1.08, file: 'bush', build: glbBuild('bush') },
  cactus              : { name: '仙人掌', icon: '🌵', cat: 'outdoor', w: 0.33, d: 0.27, h: 0.39, file: 'cactus', build: glbBuild('cactus') },
  carToy              : { name: '玩具车', icon: '🚗', cat: 'sport', w: 0.30, d: 0.59, h: 0.38, file: 'car-toy', build: glbBuild('car-toy') },
  ceilingLight        : { name: '吸顶灯', icon: '💡', cat: 'light', w: 0.36, d: 0.36, h: 1.01, file: 'ceiling-light', yOff: 2.4, build: glbBuild('ceiling-light') },
  circularCeilingLight: { name: '圆形吸顶灯', icon: '💡', cat: 'light', w: 0.21, d: 0.21, h: 0.09, file: 'circular-ceiling-light', yOff: 2.4, build: glbBuild('circular-ceiling-light') },
  closet              : { name: '衣柜', icon: '🚪', cat: 'furn', w: 1.95, d: 0.60, h: 2.26, file: 'closet', build: glbBuild('closet') },
  coatRack            : { name: '衣架', icon: '🧥', cat: 'furn', w: 0.33, d: 0.33, h: 1.75, file: 'coat-rack', build: glbBuild('coat-rack') },
  coffeeMachine       : { name: '咖啡机', icon: '☕', cat: 'kitchen', w: 0.15, d: 0.23, h: 0.23, file: 'coffee-machine', build: glbBuild('coffee-machine') },
  coffeeTable         : { name: '咖啡桌', icon: '☕', cat: 'furn', w: 1.72, d: 1.03, h: 0.29, file: 'coffee-table', build: glbBuild('coffee-table') },
  column              : { name: '圆柱', icon: '🏛', cat: 'outdoor', w: 0.50, d: 0.50, h: 2.50, file: 'column', build: glbBuild('column') },
  cuttingBoard        : { name: '砧板', icon: '🍞', cat: 'kitchen', w: 0.26, d: 0.41, h: 0.07, file: 'cutting-board', build: glbBuild('cutting-board') },
  glbDesk             : { name: '书桌(GLB)', icon: '🖥', cat: 'furn', w: 1.82, d: 0.85, h: 0.92, file: 'desk', build: glbBuild('desk') },
  diningChair         : { name: '餐椅', icon: '🪑', cat: 'furn', w: 0.46, d: 0.49, h: 0.86, file: 'dining-chair', build: glbBuild('dining-chair') },
  diningTable         : { name: '餐桌', icon: '🍽', cat: 'furn', w: 2.15, d: 0.94, h: 0.70, file: 'dining-table', build: glbBuild('dining-table') },
  doubleBed           : { name: '双人床', icon: '🛏', cat: 'bed', w: 1.51, d: 1.99, h: 0.70, file: 'double-bed', build: glbBuild('double-bed') },
  dresser             : { name: '梳妆台', icon: '🪞', cat: 'furn', w: 1.23, d: 0.60, h: 0.73, file: 'dresser', build: glbBuild('dresser') },
  dryingRack          : { name: '晾衣架', icon: '👕', cat: 'furn', w: 1.79, d: 0.58, h: 1.04, file: 'drying-rack', build: glbBuild('drying-rack') },
  easel               : { name: '画架', icon: '🎨', cat: 'furn', w: 0.98, d: 0.55, h: 2.32, file: 'easel', build: glbBuild('easel') },
  electricPanel       : { name: '电气面板', icon: '🔌', cat: 'safety', w: 0.65, d: 0.15, h: 1.31, file: 'electric-panel', build: glbBuild('electric-panel') },
  evWallCharger       : { name: '充电桩', icon: '🔌', cat: 'safety', w: 0.29, d: 0.16, h: 0.64, file: 'ev-wall-charger', build: glbBuild('ev-wall-charger') },
  exerciseBike        : { name: '动感单车', icon: '🚴', cat: 'sport', w: 0.94, d: 0.59, h: 1.41, file: 'exercise-bike', build: glbBuild('exercise-bike') },
  exitSign            : { name: '出口指示', icon: '🚪', cat: 'safety', w: 0.89, d: 0.14, h: 0.52, file: 'exit-sign', build: glbBuild('exit-sign') },
  fence               : { name: '栅栏', icon: '🚧', cat: 'outdoor', w: 2.00, d: 0.09, h: 0.76, file: 'fence', build: glbBuild('fence') },
  firTree             : { name: '冷杉', icon: '🌲', cat: 'outdoor', w: 1.31, d: 1.34, h: 2.98, file: 'fir-tree', build: glbBuild('fir-tree') },
  fireAlarm           : { name: '火警', icon: '🧯', cat: 'safety', w: 1.55, d: 0.83, h: 2.14, file: 'fire-alarm', build: glbBuild('fire-alarm') },
  fireDetector        : { name: '烟感', icon: '🧯', cat: 'safety', w: 0.13, d: 0.10, h: 0.13, file: 'fire-detector', build: glbBuild('fire-detector') },
  fireExtinguisher    : { name: '灭火器', icon: '🧯', cat: 'safety', w: 0.30, d: 0.70, h: 1.06, file: 'fire-extinguisher', build: glbBuild('fire-extinguisher') },
  freezer             : { name: '冷冻柜', icon: '🧊', cat: 'kitchen', w: 0.43, d: 0.29, h: 0.92, file: 'freezer', build: glbBuild('freezer') },
  glbFridge           : { name: '冰箱(单门)', icon: '🧊', cat: 'kitchen', w: 0.69, d: 0.71, h: 1.92, file: 'fridge', build: glbBuild('fridge') },
  fruits              : { name: '水果盘', icon: '🍎', cat: 'other', w: 0.39, d: 0.39, h: 0.27, file: 'fruits', build: glbBuild('fruits') },
  fryingPan           : { name: '煎锅', icon: '🍳', cat: 'kitchen', w: 0.35, d: 0.63, h: 0.09, file: 'frying-pan', build: glbBuild('frying-pan') },
  guitar              : { name: '吉他', icon: '🎸', cat: 'media', w: 0.39, d: 0.08, h: 1.17, file: 'guitar', build: glbBuild('guitar') },
  hedge               : { name: '绿篱', icon: '🌳', cat: 'outdoor', w: 2.00, d: 1.50, h: 1.50, file: 'hedge', build: glbBuild('hedge') },
  highFence           : { name: '高栅栏', icon: '🚧', cat: 'outdoor', w: 4.00, d: 0.09, h: 4.00, file: 'high-fence', build: glbBuild('high-fence') },
  hood                : { name: '油烟机', icon: '🌀', cat: 'kitchen', w: 1.21, d: 0.51, h: 0.52, file: 'hood', build: glbBuild('hood') },
  hydrant             : { name: '消防栓', icon: '🚒', cat: 'outdoor', w: 0.63, d: 0.63, h: 0.88, file: 'hydrant', build: glbBuild('hydrant') },
  indoorPlant         : { name: '室内盆栽', icon: '🪴', cat: 'outdoor', w: 0.69, d: 0.82, h: 1.63, file: 'indoor-plant', build: glbBuild('indoor-plant') },
  iron                : { name: '熨斗', icon: '🪨', cat: 'kitchen', w: 0.35, d: 0.21, h: 0.23, file: 'iron', build: glbBuild('iron') },
  ironingBoard        : { name: '熨衣板', icon: '👔', cat: 'kitchen', w: 1.31, d: 0.47, h: 0.95, file: 'ironing-board', build: glbBuild('ironing-board') },
  kettle              : { name: '水壶', icon: '🫖', cat: 'kitchen', w: 0.23, d: 0.18, h: 0.25, file: 'kettle', build: glbBuild('kettle') },
  kitchenCabinet      : { name: '厨房柜', icon: '🗄', cat: 'furn', w: 1.65, d: 0.76, h: 1.09, file: 'kitchen-cabinet', build: glbBuild('kitchen-cabinet') },
  kitchenUtensils     : { name: '厨具', icon: '🍴', cat: 'kitchen', w: 0.22, d: 0.20, h: 0.48, file: 'kitchen-utensils', build: glbBuild('kitchen-utensils') },
  laundryBag          : { name: '洗衣袋', icon: '🧺', cat: 'misc', w: 0.46, d: 0.47, h: 0.77, file: 'laundry-bag', build: glbBuild('laundry-bag') },
  lowFence            : { name: '矮栅栏', icon: '🚧', cat: 'outdoor', w: 2.00, d: 0.09, h: 0.76, file: 'low-fence', build: glbBuild('low-fence') },
  mediumFence         : { name: '中栅栏', icon: '🚧', cat: 'outdoor', w: 4.00, d: 0.09, h: 4.00, file: 'medium-fence', build: glbBuild('medium-fence') },
  officeChair         : { name: '办公椅', icon: '🪑', cat: 'furn', w: 0.66, d: 0.69, h: 1.16, file: 'office-chair', build: glbBuild('office-chair') },
  outdoorPlayhouse    : { name: '户外小屋', icon: '🏠', cat: 'outdoor', w: 0.29, d: 0.71, h: 0.46, file: 'outdoor-playhouse', build: glbBuild('outdoor-playhouse') },
  palm                : { name: '棕榈', icon: '🌴', cat: 'outdoor', w: 7.86, d: 7.62, h: 11.93, file: 'palm', build: glbBuild('palm') },  // ⚠size>5m
  parkingSpot         : { name: '停车位', icon: '🅿', cat: 'outdoor', w: 5.66, d: 2.65, h: 0.12, file: 'parking-spot', build: glbBuild('parking-spot') },
  patioUmbrella       : { name: '遮阳伞', icon: '⛱', cat: 'outdoor', w: 3.84, d: 3.84, h: 3.61, file: 'patio-umbrella', build: glbBuild('patio-umbrella') },
  piano               : { name: '钢琴', icon: '🎹', cat: 'media', w: 1.53, d: 0.68, h: 1.43, file: 'piano', build: glbBuild('piano') },
  picture             : { name: '相框', icon: '🖼', cat: 'misc', w: 1.47, d: 0.06, h: 0.82, file: 'picture', build: glbBuild('picture') },
  pillar              : { name: '方柱', icon: '🏛', cat: 'outdoor', w: 0.34, d: 0.29, h: 1.25, file: 'pillar', build: glbBuild('pillar') },
  poolTable           : { name: '台球桌', icon: '🎱', cat: 'furn', w: 2.10, d: 3.49, h: 0.97, file: 'pool-table', build: glbBuild('pool-table') },
  recessedLight       : { name: '嵌入灯', icon: '💡', cat: 'light', w: 0.22, d: 0.22, h: 0.06, file: 'recessed-light', yOff: 2.4, build: glbBuild('recessed-light') },
  rectangularCarpet   : { name: '矩形地毯', icon: '🟫', cat: 'misc', w: 2.77, d: 1.80, h: 0.03, file: 'rectangular-carpet', build: glbBuild('rectangular-carpet') },
  rectangularCeilingLight: { name: '矩形吸顶灯', icon: '💡', cat: 'light', w: 48.00, d: 14.00, h: 2.07, file: 'rectangular-ceiling-light', scale: 0.01, yOff: 2.4, build: glbBuild('rectangular-ceiling-light') },  // ⚠size>5m
  rectangularMirror   : { name: '矩形镜', icon: '🪞', cat: 'misc', w: 0.88, d: 0.25, h: 1.56, file: 'rectangular-mirror', build: glbBuild('rectangular-mirror') },
  roundCarpet         : { name: '圆形地毯', icon: '🟤', cat: 'misc', w: 1.99, d: 1.99, h: 0.04, file: 'round-carpet', build: glbBuild('round-carpet') },
  roundMirror         : { name: '圆形镜', icon: '🪞', cat: 'misc', w: 0.57, d: 0.04, h: 0.57, file: 'round-mirror', build: glbBuild('round-mirror') },
  scooter             : { name: '踏板车', icon: '🛴', cat: 'sport', w: 0.85, d: 0.45, h: 0.84, file: 'scooter', build: glbBuild('scooter') },
  sewingMachine       : { name: '缝纫机', icon: '🧵', cat: 'furn', w: 0.82, d: 0.31, h: 0.68, file: 'sewing-machine', build: glbBuild('sewing-machine') },
  glbShelf            : { name: '搁板', icon: '🗄', cat: 'furn', w: 0.74, d: 0.32, h: 0.04, file: 'shelf', build: glbBuild('shelf') },
  showerAngle         : { name: '角淋浴', icon: '🚿', cat: 'bath', w: 0.82, d: 0.82, h: 1.80, file: 'shower-angle', yOff: -0.6, build: glbBuild('shower-angle') },
  showerRug           : { name: '浴室垫', icon: '🟫', cat: 'bath', w: 0.77, d: 0.48, h: 0.03, file: 'shower-rug', build: glbBuild('shower-rug') },
  showerSquare        : { name: '方形淋浴', icon: '🚿', cat: 'bath', w: 0.80, d: 0.80, h: 1.80, file: 'shower-square', yOff: -0.6, build: glbBuild('shower-square') },
  singleBed           : { name: '单人床', icon: '🛏', cat: 'bed', w: 1.08, d: 2.13, h: 0.59, file: 'single-bed', build: glbBuild('single-bed') },
  sinkCabinet         : { name: '水池柜', icon: '🚰', cat: 'bath', w: 0.97, d: 0.64, h: 1.26, file: 'sink-cabinet', build: glbBuild('sink-cabinet') },
  skate               : { name: '滑板', icon: '🛹', cat: 'sport', w: 0.85, d: 0.19, h: 0.11, file: 'skate', build: glbBuild('skate') },
  smallIndoorPlant    : { name: '小盆栽', icon: '🪴', cat: 'outdoor', w: 0.39, d: 0.38, h: 0.67, file: 'small-indoor-plant', build: glbBuild('small-indoor-plant') },
  smallKitchenCabinet : { name: '小厨房柜', icon: '🗄', cat: 'furn', w: 1.11, d: 0.76, h: 1.09, file: 'small-kitchen-cabinet', build: glbBuild('small-kitchen-cabinet') },
  smokeDetector       : { name: '烟雾报警', icon: '🧯', cat: 'safety', w: 0.16, d: 0.16, h: 0.05, file: 'smoke-detector', build: glbBuild('smoke-detector') },
  glbSofa             : { name: '沙发', icon: '🛋', cat: 'furn', w: 2.05, d: 1.01, h: 0.73, file: 'sofa', build: glbBuild('sofa') },
  sprinkler           : { name: '喷淋头', icon: '💦', cat: 'safety', w: 0.09, d: 0.09, h: 0.04, file: 'sprinkler', build: glbBuild('sprinkler') },
  stairs              : { name: '楼梯', icon: '🪜', cat: 'stairs', w: 1.62, d: 5.08, h: 4.02, file: 'stairs', build: glbBuild('stairs') },
  stereoSpeaker       : { name: '立体声音响', icon: '🔊', cat: 'media', w: 0.23, d: 0.34, h: 1.00, file: 'stereo-speaker', build: glbBuild('stereo-speaker') },
  stool               : { name: '吧凳', icon: '🪑', cat: 'furn', w: 0.52, d: 0.55, h: 1.15, file: 'stool', build: glbBuild('stool') },
  sunbed              : { name: '日光浴床', icon: '🛏', cat: 'bed', w: 0.85, d: 1.01, h: 1.13, file: 'sunbed', build: glbBuild('sunbed') },
  suspendedFireplace  : { name: '吊壁炉', icon: '🔥', cat: 'hvac', w: 1.74, d: 0.79, h: 4.22, file: 'suspended-fireplace', build: glbBuild('suspended-fireplace') },
  table               : { name: '通用桌', icon: '🟫', cat: 'furn', w: 1.42, d: 2.78, h: 0.82, file: 'table', build: glbBuild('table') },
  television          : { name: '老电视', icon: '📺', cat: 'media', w: 1.61, d: 0.37, h: 1.07, file: 'television', build: glbBuild('television') },
  tesla               : { name: '特斯拉车', icon: '🚗', cat: 'other', w: 1.98, d: 4.75, h: 1.62, file: 'tesla', build: glbBuild('tesla') },
  thermostat          : { name: '温控器', icon: '🌡', cat: 'hvac', w: 0.05, d: 0.00, h: 0.05, file: 'thermostat', build: glbBuild('thermostat') },
  threadmill          : { name: '跑步机', icon: '🏃', cat: 'sport', w: 2.10, d: 0.90, h: 1.45, file: 'threadmill', build: glbBuild('threadmill') },
  toaster             : { name: '烤面包机', icon: '🍞', cat: 'kitchen', w: 0.27, d: 0.17, h: 0.23, file: 'toaster', build: glbBuild('toaster') },
  glbToilet           : { name: '座便器', icon: '🚽', cat: 'bath', w: 0.42, d: 0.71, h: 0.81, file: 'toilet', build: glbBuild('toilet') },
  toiletBrush         : { name: '马桶刷', icon: '🪠', cat: 'bath', w: 0.12, d: 0.12, h: 0.56, file: 'toilet-brush', build: glbBuild('toilet-brush') },
  toiletPaper         : { name: '卷纸', icon: '🧻', cat: 'bath', w: 0.25, d: 0.24, h: 0.26, file: 'toilet-paper', build: glbBuild('toilet-paper') },
  toy                 : { name: '玩具', icon: '🧸', cat: 'sport', w: 0.29, d: 0.33, h: 0.49, file: 'toy', build: glbBuild('toy') },
  trashBin            : { name: '垃圾桶', icon: '🗑', cat: 'other', w: 0.35, d: 0.41, h: 0.59, file: 'trash-bin', build: glbBuild('trash-bin') },
  tree                : { name: '树', icon: '🌳', cat: 'outdoor', w: 5.74, d: 6.14, h: 7.49, file: 'tree', build: glbBuild('tree') },
  tub                 : { name: '浴桶', icon: '🛁', cat: 'bath', w: 2.34, d: 1.11, h: 0.78, file: 'tub', build: glbBuild('tub') },
  wallArt06           : { name: '墙饰', icon: '🖼', cat: 'misc', w: 0.54, d: 0.03, h: 0.89, file: 'wall-art-06', build: glbBuild('wall-art-06') },
  wallSink            : { name: '墙挂洗手盆', icon: '🚰', cat: 'bath', w: 1.39, d: 0.81, h: 1.45, file: 'wall-sink', build: glbBuild('wall-sink') },
  wineBottle          : { name: '酒瓶', icon: '🍷', cat: 'misc', w: 0.38, d: 0.16, h: 0.34, file: 'wine-bottle', build: glbBuild('wine-bottle') },

  // ── fac/ 70 个医疗/办公/标识 专用模型（中文源 → ASCII slug）──
  medPda                : { name: '医疗 PDA', icon: '📱', cat: 'medical', w: 0.077, d: 0.02, h: 0.163, file: 'pda-handheld', build: glbBuild('pda-handheld') },
  medCallBtn            : { name: '一键呼叫按钮', icon: '🆘', cat: 'medical', w: 0.086, d: 0.2, h: 0.016, file: 'call-button', build: glbBuild('call-button') },
  glbIronStair          : { name: '铁扶手楼梯', icon: '🪜', cat: 'stairs', w: 7.945, d: 3.65, h: 3.753, file: 'iron-railing-stair', build: glbBuild('iron-railing-stair') },
  meetingTable          : { name: '会议桌', icon: '🗄', cat: 'furn', w: 5.152, d: 2.181, h: 0.986, file: 'meeting-table', build: glbBuild('meeting-table') },
  medTempTag            : { name: '体温标签', icon: '🌡', cat: 'medical', w: 0.037, d: 0.009, h: 0.037, file: 'temp-tag-qr', build: glbBuild('temp-tag-qr') },
  medFridge             : { name: '医用冰箱', icon: '🧊', cat: 'kitchen', w: 1.071, d: 1.342, h: 1.815, file: 'fridge-1', build: glbBuild('fridge-1') },
  medOutflowSens        : { name: '出液传感器', icon: '💧', cat: 'medical', w: 0.072, d: 0.025, h: 0.066, file: 'outflow-sensor', build: glbBuild('outflow-sensor') },
  officeChairBlk        : { name: '办公椅(黑)', icon: '🪑', cat: 'furn', w: 0.604, d: 0.63, h: 0.801, file: 'office-chair-black', build: glbBuild('office-chair-black') },
  medScreen             : { name: '医疗屏风', icon: '🟦', cat: 'medical', w: 2.094, d: 0.531, h: 1.655, file: 'medical-screen', build: glbBuild('medical-screen') },
  downStair             : { name: '向下楼梯', icon: '⬇', cat: 'stairs', w: 0.424, d: 0.019, h: 0.184, file: 'down-stair', build: glbBuild('down-stair') },
  navGoFwd              : { name: '向前直行标识', icon: '⬆', cat: 'other', w: 0.424, d: 0.019, h: 0.184, file: 'go-forward', build: glbBuild('go-forward') },
  navGoRight            : { name: '向右标识', icon: '➡', cat: 'other', w: 0.424, d: 0.019, h: 0.184, file: 'go-right', build: glbBuild('go-right') },
  navGoLeft             : { name: '向左标识', icon: '⬅', cat: 'other', w: 0.424, d: 0.019, h: 0.184, file: 'go-left', build: glbBuild('go-left') },
  medVentilator         : { name: '呼吸机', icon: '🫁', cat: 'medical', w: 0.63, d: 0.905, h: 0.368, file: 'ventilator', build: glbBuild('ventilator') },
  stoolGreen            : { name: '圆凳(绿)', icon: '🪑', cat: 'furn', w: 0.579, d: 0.556, h: 0.849, file: 'stool-green', build: glbBuild('stool-green') },
  wallStruct            : { name: '墙体结构', icon: '🧱', cat: 'other', w: 0.557, d: 0.203, h: 0.03, file: 'wall-structure', scale: 0.01, build: glbBuild('wall-structure') },
  marbleTeaTable        : { name: '大理石茶桌', icon: '☕', cat: 'furn', w: 0.835, d: 2.026, h: 0.355, file: 'marble-tea-table', build: glbBuild('marble-tea-table') },
  medBabyTag            : { name: '婴儿标签', icon: '👶', cat: 'medical', w: 0.027, d: 0.012, h: 0.033, file: 'baby-tag', build: glbBuild('baby-tag') },
  navSplitLR            : { name: '左右分流标识', icon: '↔', cat: 'other', w: 0.424, d: 0.019, h: 0.184, file: 'split-lr', build: glbBuild('split-lr') },
  bedHeadScreen         : { name: '床头屏', icon: '📺', cat: 'furn', w: 0.388, d: 0.046, h: 0.154, file: 'bed-head-screen', build: glbBuild('bed-head-screen') },
  bedsideScreen         : { name: '床旁屏', icon: '📺', cat: 'furn', w: 0.38, d: 0.03, h: 0.266, file: 'bedside-screen', build: glbBuild('bedside-screen') },
  greenPillow           : { name: '绿色枕头', icon: '🛏', cat: 'bed', w: 1.986, d: 0.764, h: 0.497, file: 'green-pillow', build: glbBuild('green-pillow') },
  medEcg                : { name: '心电监护仪', icon: '💓', cat: 'medical', w: 0.454, d: 0.256, h: 0.414, file: 'ecg-monitor', build: glbBuild('ecg-monitor') },
  medSurgTbl            : { name: '手术台', icon: '🛏', cat: 'medical', w: 2.099, d: 1.028, h: 1.034, file: 'surgery-table', build: glbBuild('surgery-table') },
  medSurgArm            : { name: '手术机械臂', icon: '🤖', cat: 'medical', w: 1.697, d: 1.338, h: 2.412, file: 'surgery-arm', build: glbBuild('surgery-arm') },
  medSurgArmLight       : { name: '手术机械臂灯', icon: '💡', cat: 'medical', w: 2.573, d: 3.16, h: 2.564, file: 'surgery-arm-light', build: glbBuild('surgery-arm-light') },
  medSurgLight          : { name: '手术灯', icon: '💡', cat: 'medical', w: 2.421, d: 2.7, h: 1.962, file: 'surgery-light', build: glbBuild('surgery-light') },
  nurseStation          : { name: '护士站', icon: '🏥', cat: 'furn', w: 1.856, d: 3.703, h: 1.127, file: 'nurse-station', build: glbBuild('nurse-station') },
  nurseStationPC        : { name: '护士站主机', icon: '🖥', cat: 'furn', w: 0.433, d: 0.231, h: 0.072, file: 'nurse-station-pc', build: glbBuild('nurse-station-pc') },
  medWashSens           : { name: '按压洗手传感器', icon: '🧼', cat: 'medical', w: 0.064, d: 0.08, h: 0.039, file: 'press-wash-sensor', build: glbBuild('press-wash-sensor') },
  medFallRadar          : { name: '摔倒监测雷达', icon: '📡', cat: 'medical', w: 0.102, d: 0.102, h: 0.043, file: 'fall-radar', build: glbBuild('fall-radar') },
  cabinetWhite          : { name: '文件柜(白)', icon: '🗄', cat: 'furn', w: 1.84, d: 0.4, h: 2, file: 'filing-cabinet-white', build: glbBuild('filing-cabinet-white') },
  screenOnco            : { name: '昂科门口屏', icon: '📺', cat: 'media', w: 0.226, d: 0.028, h: 0.424, file: 'onco-door-screen', build: glbBuild('onco-door-screen') },
  medPullTag            : { name: '易拉扣标签', icon: '🏷', cat: 'medical', w: 0.032, d: 0.024, h: 0.034, file: 'pull-tab-tag', build: glbBuild('pull-tab-tag') },
  medSmartMattress      : { name: '智能床垫', icon: '🛏', cat: 'bed', w: 0.29, d: 1.105, h: 0.024, file: 'smart-mattress', build: glbBuild('smart-mattress') },
  medWristTag           : { name: '智能腕式标签', icon: '⌚', cat: 'medical', w: 0.024, d: 0.104, h: 0.146, file: 'wristband-tag', build: glbBuild('wristband-tag') },
  woodCabinet1          : { name: '木纹单柜', icon: '🪑', cat: 'furn', w: 1.145, d: 0.4, h: 1.2, file: 'wood-single-cabinet', build: glbBuild('wood-single-cabinet') },
  woodBedside           : { name: '木纹床头柜', icon: '🪑', cat: 'bed', w: 0.328, d: 0.361, h: 0.376, file: 'wood-bedside', build: glbBuild('wood-bedside') },
  woodCabinet           : { name: '木纹柜', icon: '🪑', cat: 'furn', w: 0.705, d: 0.37, h: 1.146, file: 'wood-cabinet', build: glbBuild('wood-cabinet') },
  woodPcDesk            : { name: '木纹电脑桌', icon: '🖥', cat: 'furn', w: 1.915, d: 0.6, h: 1.099, file: 'wood-pc-desk', build: glbBuild('wood-pc-desk') },
  woodCabSet            : { name: '木纹组柜', icon: '🪑', cat: 'furn', w: 3, d: 0.45, h: 0.814, file: 'wood-cabinet-set', build: glbBuild('wood-cabinet-set') },
  glbStair              : { name: '楼梯', icon: '🪜', cat: 'stairs', w: 3.525, d: 7.048, h: 3.753, file: 'stair', build: glbBuild('stair') },
  medMomTag             : { name: '母亲标签', icon: '👩', cat: 'medical', w: 0.03, d: 0.013, h: 0.042, file: 'mom-tag', build: glbBuild('mom-tag') },
  medMomBabyTag         : { name: '母婴标签', icon: '👶', cat: 'medical', w: 0.03, d: 0.013, h: 0.042, file: 'mom-baby-tag', build: glbBuild('mom-baby-tag') },
  medTempHumid          : { name: '温湿度传感器', icon: '🌡', cat: 'medical', w: 0.065, d: 0.039, h: 0.117, file: 'temp-humid-sensor', build: glbBuild('temp-humid-sensor') },
  medEnvMon             : { name: '环境监测终端', icon: '🌡', cat: 'medical', w: 0.112, d: 0.112, h: 0.033, file: 'env-monitor', build: glbBuild('env-monitor') },
  pcBlack               : { name: '黑色电脑', icon: '💻', cat: 'media', w: 1.14, d: 0.651, h: 0.668, file: 'pc-black', build: glbBuild('pc-black') },
  tvOff                 : { name: '电视(关屏)', icon: '📺', cat: 'media', w: 1.44, d: 0.11, h: 0.836, file: 'tv-off', build: glbBuild('tv-off') },
  basinWhite            : { name: '白色洗手池', icon: '🚰', cat: 'bath', w: 0.554, d: 0.405, h: 0.96, file: 'basin-white', build: glbBuild('basin-white') },
  basinRowWhite         : { name: '联排洗手池(白)', icon: '🚰', cat: 'bath', w: 2.25, d: 0.6, h: 0.301, file: 'basin-row-white', build: glbBuild('basin-row-white') },
  pottedWhite           : { name: '白盆绿植', icon: '🪴', cat: 'outdoor', w: 0.952, d: 1.072, h: 1.451, file: 'potted-white', build: glbBuild('potted-white') },
  medGateway            : { name: '监护网关', icon: '📡', cat: 'medical', w: 0.065, d: 0.065, h: 0.021, file: 'monitor-gateway', build: glbBuild('monitor-gateway') },
  waitingChair          : { name: '等候区座椅', icon: '🪑', cat: 'furn', w: 1.501, d: 0.537, h: 0.581, file: 'waiting-chair', build: glbBuild('waiting-chair') },
  sofaRow3              : { name: '联排沙发(3人)', icon: '🛋', cat: 'furn', w: 0.837, d: 2.044, h: 0.714, file: 'sofa-row-3', build: glbBuild('sofa-row-3') },
  medChestTag           : { name: '胸卡标签', icon: '🏷', cat: 'medical', w: 0.055, d: 0.005, h: 0.086, file: 'chest-tag', build: glbBuild('chest-tag') },
  showerBath            : { name: '花洒浴室', icon: '🚿', cat: 'bath', w: 0.819, d: 0.464, h: 1.733, file: 'shower-bath', build: glbBuild('shower-bath') },
  medBleTag             : { name: '蓝牙定位标签', icon: '📡', cat: 'medical', w: 0.025, d: 0.012, h: 0.034, file: 'ble-tag', build: glbBuild('ble-tag') },
  medAssetTag           : { name: '资产定位标签', icon: '🏷', cat: 'medical', w: 0.04, d: 0.011, h: 0.04, file: 'asset-tag', build: glbBuild('asset-tag') },
  medAssetStateTag      : { name: '资产状态标签', icon: '🏷', cat: 'medical', w: 0.05, d: 0.05, h: 0.015, file: 'asset-state-tag', build: glbBuild('asset-state-tag') },
  screenCorridor        : { name: '走廊屏', icon: '📺', cat: 'media', w: 0.724, d: 0.181, h: 0.232, file: 'corridor-screen', build: glbBuild('corridor-screen') },
  medCryoTag            : { name: '超低温标签', icon: '🥶', cat: 'medical', w: 0.067, d: 0.039, h: 0.089, file: 'cryo-tag', build: glbBuild('cryo-tag') },
  squatToilet           : { name: '蹲便器', icon: '🚽', cat: 'bath', w: 0.375, d: 0.488, h: 0.028, file: 'squat-toilet', build: glbBuild('squat-toilet') },
  medIvPole             : { name: '输液杆', icon: '💉', cat: 'medical', w: 0.587, d: 0.583, h: 2.239, file: 'iv-pole', build: glbBuild('iv-pole') },
  medIvMonitor          : { name: '输液监视器', icon: '💉', cat: 'medical', w: 0.12, d: 0.036, h: 0.153, file: 'iv-monitor', build: glbBuild('iv-monitor') },
  medIvEmpty            : { name: '输液空管检测器', icon: '💉', cat: 'medical', w: 0.06, d: 0.077, h: 0.027, file: 'iv-empty-detector', build: glbBuild('iv-empty-detector') },
  screenDoor            : { name: '门口屏', icon: '📺', cat: 'media', w: 0.226, d: 0.028, h: 0.424, file: 'door-screen', build: glbBuild('door-screen') },
  medTamperBand         : { name: '防拆腕带', icon: '⌚', cat: 'medical', w: 0.036, d: 0.127, h: 0.202, file: 'tamper-wristband', build: glbBuild('tamper-wristband') },
  urinalCeramic         : { name: '陶瓷小便池', icon: '🚽', cat: 'bath', w: 0.265, d: 0.294, h: 0.916, file: 'urinal-ceramic', build: glbBuild('urinal-ceramic') },
  toiletLid             : { name: '马桶盖', icon: '🚽', cat: 'bath', w: 0.469, d: 0.924, h: 1.198, file: 'toilet-lid', build: glbBuild('toilet-lid') },
  sofaBlack             : { name: '黑色沙发椅', icon: '🛋', cat: 'furn', w: 0.698, d: 0.621, h: 0.564, file: 'sofa-black', build: glbBuild('sofa-black') },

  // ── 原生家具（代码构建，无外部模型）──
  shoeCabinet    : { cat: 'furn',    name: '鞋柜',           icon: '👞', w: 1.0,  d: 0.35, build: fShoeCabinet },
  vanityStool    : { cat: 'furn',    name: '梳妆凳',         icon: '🪑', w: 0.45, d: 0.45, build: fVanityStool },
  kidsBed        : { cat: 'bed',     name: '儿童床 1.0×1.4', icon: '🛏', w: 1.0,  d: 1.4,  build: fKidsBed },
  foldTable      : { cat: 'furn',    name: '折叠桌',         icon: '🟫', w: 1.2,  d: 0.6,  build: fFoldTable },
  bayWindowPad   : { cat: 'furn',    name: '飘窗垫',         icon: '🛋', w: 1.5,  d: 0.5,  build: fBayWindowCushion },
  lShapedSofa    : { cat: 'furn',    name: 'L型沙发',        icon: '🛋', w: 2.45, d: 1.65, build: fLShapedSofa },
  cornerCabinet  : { cat: 'furn',    name: '角柜',           icon: '🗄', w: 0.8,  d: 0.8,  build: fCornerCabinet },
  barCounter     : { cat: 'furn',    name: '吧台',           icon: '🍷', w: 1.8,  d: 0.55, build: fBarCounter },
  bookcaseWide   : { cat: 'furn',    name: '宽书架 2.0m',    icon: '📚', w: 2.0,  d: 0.35, build: fBookcaseWide },
  armchair       : { cat: 'furn',    name: '单人扶手椅',     icon: '🪑', w: 0.8,  d: 0.8,  build: fArmchair },
  coffeeTableLow : { cat: 'furn',    name: '矮茶几',         icon: '☕', w: 1.2,  d: 0.6,  build: fCoffeeTableLow },
  shoeRack       : { cat: 'furn',    name: '鞋架',           icon: '👞', w: 0.8,  d: 0.3,  build: fShoeRack },
  plantStand     : { cat: 'outdoor', name: '花架',           icon: '🪴', w: 0.4,  d: 0.4,  build: fPlantStand },
  tvCabinet      : { cat: 'furn',    name: '电视柜 2.0m',    icon: '📺', w: 2.0,  d: 0.4,  build: fTVCabinet },
  kitchenIsland  : { cat: 'kitchen', name: '厨房中岛',       icon: '🍳', w: 2.0,  d: 1.0,  build: fKitchenIsland },
  wardrobeOpen   : { cat: 'furn',    name: '开放式衣柜',     icon: '🚪', w: 1.5,  d: 0.55, build: fWardrobeOpen },
  dresserMirror  : { cat: 'furn',    name: '梳妆台带镜',     icon: '🪞', w: 1.0,  d: 0.5,  build: fDresserMirror },

  // ── 办公/商业家具 ──
  workstation    : { cat: 'furn',    name: '工位隔断',       icon: '🖥', w: 1.6,  d: 0.8,  build: fWorkstation },
  receptionDesk  : { cat: 'furn',    name: '前台',           icon: '🏢', w: 2.4,  d: 0.6,  build: fReceptionDesk },
  displayCabinet : { cat: 'furn',    name: '展示柜',         icon: '🗄', w: 1.2,  d: 0.4,  build: fDisplayCabinet },
  meetingSet     : { cat: 'furn',    name: '会议桌+6椅',     icon: '🍽', w: 3.0,  d: 2.4,  build: fMeetingSet },
  officePartition: { cat: 'furn',    name: '办公隔断屏风',   icon: '🟦', w: 1.5,  d: 0.04, build: fOfficePartition },
  filingCabinet  : { cat: 'furn',    name: '文件柜',         icon: '🗄', w: 0.9,  d: 0.5,  build: fFilingCabinet },
  whiteboard     : { cat: 'furn',    name: '白板',           icon: '📋', w: 1.8,  d: 0.4,  build: fWhiteboard },
  printerStand   : { cat: 'furn',    name: '打印机台',       icon: '🖨', w: 0.8,  d: 0.5,  build: fPrinterStand },

  // ── 医院场景物品 ──
  signBoard      : { cat: 'medical', name: '标识牌',         icon: '📋', w: 0.6,  d: 0.4,  build: fSignBoard },
  triageDesk     : { cat: 'medical', name: '分诊台',         icon: '🏥', w: 2.0,  d: 0.6,  build: fTriageDesk },
  medicineCabinet: { cat: 'medical', name: '药柜',           icon: '💊', w: 1.5,  d: 0.4,  build: fMedicineCabinet },
  wheelchair     : { cat: 'medical', name: '轮椅',           icon: '♿', w: 0.6,  d: 0.7,  build: fWheelchair },
  ivStand        : { cat: 'medical', name: '输液架',         icon: '💉', w: 0.5,  d: 0.5,  build: fIVStand },
  hospitalBed    : { cat: 'medical', name: '病床',           icon: '🛏', w: 1.0,  d: 2.1,  build: fHospitalBed },
  stretcher      : { cat: 'medical', name: '担架',           icon: '🛏', w: 0.7,  d: 1.9,  build: fStretcher },
  medCart        : { cat: 'medical', name: '医疗推车',       icon: '🚑', w: 0.6,  d: 0.4,  build: fMedCart },

  // ── 医疗床类 ──
  examBed        : { cat: 'medical', name: '诊查床',         icon: '🛏', w: 0.62, d: 1.85, build: fExamBed },
  infantCrib     : { cat: 'medical', name: '婴儿床',         icon: '👶', w: 0.7,  d: 1.2,  build: fInfantCrib },
  deliveryBed    : { cat: 'medical', name: '产床',           icon: '🛏', w: 0.95, d: 2.0,  build: fDeliveryBed },
  icuBed         : { cat: 'medical', name: 'ICU监护床',      icon: '🛏', w: 1.05, d: 2.2,  build: fIcuBed },
  companionBed   : { cat: 'medical', name: '陪护床',         icon: '🛏', w: 0.85, d: 1.85, build: fCompanionBed },

  // ── 大型影像设备 ──
  ctScanner      : { cat: 'medical', name: 'CT断层扫描仪',   icon: '🔬', w: 2.0,  d: 0.6,  build: fCtScanner },
  xrayMachine    : { cat: 'medical', name: 'X光机',          icon: '🩻', w: 1.2,  d: 0.4,  build: fXrayMachine },
  ultrasound     : { cat: 'medical', name: '超声诊断仪',     icon: '📡', w: 0.5,  d: 0.5,  build: fUltrasound },

  // ── 治疗 / 急救设备 ──
  defibrillator  : { cat: 'medical', name: '除颤仪',         icon: '⚡', w: 0.5,  d: 0.3,  build: fDefibrillator },
  anesthesiaMch  : { cat: 'medical', name: '麻醉机',         icon: '💨', w: 0.6,  d: 0.5,  build: fAnesthesiaMachine },
  infusionPump   : { cat: 'medical', name: '输液泵',         icon: '💉', w: 0.35, d: 0.35, build: fInfusionPump },
  firstAidKit    : { cat: 'medical', name: '急救箱',         icon: '🆘', w: 0.45, d: 0.3,  build: fFirstAidKit },
  oxygenCart     : { cat: 'medical', name: '氧气瓶车',       icon: '🎈', w: 0.6,  d: 0.4,  build: fOxygenTankCart },

  // ── 检验 / 诊断 ──
  microscope     : { cat: 'medical', name: '显微镜',         icon: '🔬', w: 0.3,  d: 0.25, build: fMicroscope },
  centrifuge     : { cat: 'medical', name: '离心机',         icon: '🌀', w: 0.45, d: 0.4,  build: fCentrifuge },
  vitalsCart     : { cat: 'medical', name: '生命体征推车',   icon: '📊', w: 0.55, d: 0.45, build: fVitalsCart },

  // ── 辅助康复 / 其他 ──
  walker         : { cat: 'medical', name: '助行器',         icon: '🚶', w: 0.5,  d: 0.45, build: fWalker },
  mobileSurgLamp : { cat: 'medical', name: '移动无影灯',     icon: '💡', w: 0.6,  d: 0.5,  build: fMobileSurgLight },
  chartCabinet   : { cat: 'medical', name: '病历柜',         icon: '🗄', w: 1.2,  d: 0.55, build: fChartCabinet },
  sanitizerStand : { cat: 'medical', name: '免洗消毒柱',     icon: '🧼', w: 0.3,  d: 0.3,  build: fHandSanitizerStand },

};

// ============================================================
// 原生家具 InstancedMesh 缓存(B.2a)
// 12 条原生家具中,11 条(去掉 fShelf 的 Math.random 书本)走 InstancedMesh 路径
// 第一次见到某个 type 时 capture:跑一次 def.build(),traverse 所有子 Mesh
// 记录 (geo, mat, basePos, localMatrix) 为 parts[]
// 每个 part 单独建一个 THREE.InstancedMesh;槽位按"同 type 的第几件"分配(不是全局 fi),
// instanceId → doc.fi 的映射存在 userData.instanceMap 里(pickAt 用它还原 fi)
// ============================================================
const NATIVE_INSTANCED_OK = new Set([
  'bed', 'bed1', 'wardrobe', 'nightstand', 'desk',
  'sofa', 'tea', 'dining', 'toilet', 'basin', 'fridge',
  'shoeCabinet', 'vanityStool', 'kidsBed', 'foldTable', 'bayWindowPad',
  'lShapedSofa', 'cornerCabinet', 'barCounter', 'bookcaseWide', 'armchair',
  'coffeeTableLow', 'shoeRack', 'plantStand', 'tvCabinet', 'kitchenIsland',
  'wardrobeOpen', 'dresserMirror',
  'workstation', 'receptionDesk', 'displayCabinet', 'meetingSet', 'officePartition',
  'filingCabinet', 'whiteboard', 'printerStand',
  'signBoard', 'triageDesk', 'medicineCabinet', 'wheelchair', 'ivStand',
  'hospitalBed', 'stretcher', 'medCart',
  'examBed', 'infantCrib', 'deliveryBed', 'icuBed', 'companionBed',
  'ctScanner', 'xrayMachine', 'ultrasound',
  'defibrillator', 'anesthesiaMch', 'infusionPump', 'firstAidKit', 'oxygenCart',
  'microscope', 'centrifuge', 'vitalsCart',
  'walker', 'mobileSurgLamp', 'chartCabinet', 'sanitizerStand'
  // 'shelf' excluded — fShelf 内部 Math.random() 书本数不固定,geometry 每帧都变
]);

// type -> parts[]
const furnProto = {};
// type -> [InstancedMesh, ...]  parallel to parts
const furnInstanced = {};
// 每个 InstancedMesh 预开的实例槽数(覆盖户型里的同款家具数量)
const FURN_INST_MAX = 128;

// scratch (避免每帧 new Matrix4 等)
const _furnDummy = new THREE.Object3D();
const _furnMat = new THREE.Matrix4();
const _furnZero = new THREE.Matrix4().makeScale(0, 0, 0);
// type -> { center: Vector3, size: Vector3 } 本地坐标下的 bbox,旋转后算 sel overlay 用
const furnBBox = {};

function _captureFurnProto(type, buildFn) {
  const proto = { parts: [], bbox: null };
  const g = buildFn();
  g.updateMatrixWorld(true);
  const bbox = new THREE.Box3();
  g.traverse(o => {
    if (o.isMesh && o.geometry) {
      // 局部变换:position 是 build 内 addLocal 给的
      // 我们用 matrix 而非 position,因为 CylinderGeometry/RoundedBox 中心可能不在原点
      o.updateMatrix();
      proto.parts.push({
        geo: o.geometry,
        mat: o.material,
        cast: o.castShadow !== false,
        localMatrix: o.matrix.clone(),
      });
      // 参与整体 bbox
      const wb = new THREE.Box3().setFromObject(o);
      bbox.union(wb);
    }
  });
  // 把 bbox 平移到原点 = bbox 中心,尺寸 = bbox 范围
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  bbox.getCenter(center);
  bbox.getSize(size);
  // 把每个 part 的 localMatrix 减去 center(让所有 part 以 bbox 中心为参考)
  for (const part of proto.parts) {
    const m = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
    part.localMatrix.premultiply(m);
  }
  proto.bbox = { center, size };
  return proto;
}

function _ensureFurnInstanced(type) {
  if (furnInstanced[type]) return furnInstanced[type];
  const proto = furnProto[type];
  if (!proto) return null;
  const arr = [];
  for (let pi = 0; pi < proto.parts.length; pi++) {
    const part = proto.parts[pi];
    // 预留 FURN_INST_MAX 个实例槽位(setMatrixAt 越界会静默丢弃,必须一次开够)
    const inst = new THREE.InstancedMesh(part.geo, part.mat, FURN_INST_MAX);
    inst.castShadow = part.cast;
    inst.receiveShadow = true;
    inst.count = 0;
    inst.userData = { kind: 'furniture', type, partIdx: pi, instanceMap: new Map() };
    planGroup.add(inst);
    pickMeshes.push(inst);
    arr.push(inst);
  }
  furnInstanced[type] = arr;
  return arr;
}

// ============================================================
// 3D 重建：墙 = 分段盒体 + 门洞/窗洞 + 门扇/窗框
// ============================================================
let pickMeshes = [];

function segMesh(parent, mat, s, e, y0, y1, th, wi) {
  if (e - s < 0.012 || y1 - y0 < 0.012) return null;
  const m = new THREE.Mesh(box(e - s, y1 - y0, th), mat);
  m.position.set((s + e) / 2, (y0 + y1) / 2, 0);
  m.castShadow = m.receiveShadow = true;
  m.userData = { kind: 'wall', wi };
  parent.add(m); pickMeshes.push(m);
  return m;
}

// 单段墙(支持 CSG 开洞);y0→y1 是垂直范围(半墙场景 y0>0 表示仅上半段)
// 半墙时上下两段都传 ops(全量);开洞 y 范围会被 clamp 到 [y0,y1],拼接 = 完整门窗洞口
function buildWallSegment(parent, mat, x0, x1, y0, y1, th, wi, ops, localC) {
  const segH = y1 - y0;
  if (segH < 0.05) return;
  // CSG 路径
  if (CSG && ops.length) {
    try {
      let acc = new CSG.Brush(box(x1 - x0, segH, th), mat);
      acc.position.set((x0 + x1) / 2, y0 + segH / 2, 0);
      acc.updateMatrixWorld();
      const ev = new CSG.Evaluator();
      for (const op of ops) {
        const c = localC(op);
        const hw = Math.min(op.width, (x1 - x0) - 0.08) / 2;
        const s = Math.max(x0, c - hw), e = Math.min(x1, c + hw);
        // 把 y0/y1 加进 cutter 范围:洞必须落在 [y0, y1] 之间
        const reqTop = op.type === 'door' ? op.height : Math.min(op.sill + op.height, y1);
        const reqBot = op.type === 'window' ? op.sill : y0;
        const top = Math.min(reqTop, y1);
        const bot = Math.max(reqBot, y0);
        if (top - bot < 0.05 || e - s < 0.05) continue;
        const cutter = new CSG.Brush(box(e - s + 0.002, top - bot + 0.002, th + 0.004));
        cutter.position.set((s + e) / 2, (bot + top) / 2, 0);
        cutter.updateMatrixWorld();
        acc = ev.evaluate(acc, cutter, CSG.SUBTRACTION);
        acc.updateMatrixWorld();
      }
      const m = new THREE.Mesh(acc.geometry, mat);
      m.castShadow = m.receiveShadow = true;
      m.userData = { kind: 'wall', wi };
      parent.add(m); pickMeshes.push(m);
      return;
    } catch (err) { /* 退化 */ }
  }
  // 分段拼接退化路径
  if (!ops.length) {
    segMesh(parent, mat, x0, x1, y0, y1, th, wi);
    return;
  }
  let cur = x0;
  for (const op of ops) {
    const c = localC(op);
    const hw = Math.min(op.width, (x1 - x0) - 0.08) / 2;
    const s = Math.max(x0, c - hw), e = Math.min(x1, c + hw);
    if (op.type === 'window') {
      segMesh(parent, mat, cur, s, y0, y1, th, wi);
      // 窗洞:下沿 sill,上沿 sill+height,落到 [y0,y1] 范围
      segMesh(parent, mat, s, e, y0, Math.max(y0, op.sill), th, wi);
      segMesh(parent, mat, s, e, Math.min(y1, op.sill + op.height), y1, th, wi);
    } else {
      segMesh(parent, mat, cur, s, y0, y1, th, wi);
      // 门洞:0→height 是门扇区域,不建墙;height→y1 补门楣墙
      // (CSG 不可用时的退化路径;此前这里写反了——门洞被砌死、门上方留缺口)
      segMesh(parent, mat, s, e, Math.min(y1, Math.max(y0, op.height)), y1, th, wi);
    }
    cur = e;
  }
  segMesh(parent, mat, cur, x1, y0, y1, th, wi);
}

function buildWall(w, wi, mit) {
  const dx = w.bx - w.ax, dz = w.bz - w.az;
  const L = Math.hypot(dx, dz);
  const g = new THREE.Group();
  g.position.set(w.ax, levelY(w.lv || 0), w.az);
  g.rotation.y = -Math.atan2(dz, dx);
  g.userData = { kind: 'wall', wi };
  const H = (w.h != null ? w.h : doc.wallH), th = w.th;
  const extS = (mit && mit.s) || 0, extE = (mit && mit.e) || 0;
  const x0 = -extS, x1 = L + extE;      // 本地 x 范围（含墙角延长）
  // 选中/悬停高亮已改为 selHelper 覆盖层(见 rebuild3D),墙体材质恒定 →
  // 复用判定只需几何 hash,材质缓存命中率也更高
  const halfWall = !!w.halfWall;
  const halfH = halfWall
    ? Math.max(0.2, Math.min((w.halfHeight != null ? w.halfHeight : 1.2), H - 0.05))
    : H;
  // 下半段材质:走 applyMatVariant(主题色 + 纹理)
  // 玻璃墙(w.glass === true):用磨砂半透 MeshPhysicalMaterial,无视主题色/纹理;
  // 上下两段同材质(玻璃不分上下),保留与普通墙相同的几何与开洞能力。
  const matLow = w.glass ? new THREE.MeshPhysicalMaterial({
    color: 0xc8e6f5, transparent: true, opacity: 0.35, roughness: 0.3,
    metalness: 0.0, side: THREE.DoubleSide, depthWrite: false,
  }) : applyMatVariant(M.wall, w.wallTex, w.wallBase,
        [Math.max(1, Math.round(L * 4)), Math.max(1, Math.round(halfH * 2))]);
  // 上半段材质:始终走 M.wall 默认浅灰白(无 wallBase / 无 wallTex)
  const matUp = w.glass ? matLow : M.wall;

  const ops = [...(w.openings || [])].map((op, oi) => ({ ...op, _oi: oi })).sort((a, b) => a.t - b.t);
  const localC = op => x0 + op.t * (x1 - x0);   // 开洞中心（本地 x）
  // 门/窗高度钳制到墙高以内(留 0.15m 门楣):否则 CSG 会把门洞一直切到墙顶,
  // 门上方出现缺口、门扇穿出墙顶。ops 是拷贝,不污染 doc 数据。
  const wallH = (w.h != null ? w.h : doc.wallH) || 2.75;
  for (const op of ops) {
    if (op.type === 'door') {
      op.height = Math.min(op.height || 2.05, Math.max(0.5, wallH - 0.15));
    } else {
      op.sill = Math.min(op.sill || 0, Math.max(0, wallH - 0.35));
      op.height = Math.min(op.height || 0.9, Math.max(0.3, wallH - op.sill - 0.05));
    }
  }

  // ── 墙体几何 ──
  // 半墙时:上下两段都按 [y0,y1] 各自独立开洞(ops 全量传入)
  //  buildWallSegment 内部对开洞 y 范围 clamp 到 [y0,y1],拼接 = 完整门窗洞口
  //  视觉:墙的下半段彩色/纹理,上半段浅灰白;门窗洞口从地面到顶完整,中间 1.2m 分界线穿门窗
  // 普通墙:单段(0→H)放 matLow + 全部 openings(原行为)
  if (halfWall) {
    buildWallSegment(g, matLow, x0, x1, 0, halfH, th, wi, ops, localC);
    buildWallSegment(g, matUp,  x0, x1, halfH, H, th, wi, ops, localC);
  } else {
    buildWallSegment(g, matLow, x0, x1, 0, H, th, wi, ops, localC);
  }

  // ── 多面材质：内/外面彩色蒙皮（同样参与开洞;无开口的墙也要生效,直接整面蒙皮）──
  if (CSG && (w.matIn || w.matOut)) {
    try {
      const sides = [[-(th / 2 + 0.0025), 'matIn'], [th / 2 + 0.0025, 'matOut']];
      for (const [zo, key] of sides) {
        const hex = w[key];
        if (!hex) continue;
        let acc = new CSG.Brush(box(x1 - x0, H - 0.02, 0.004),
          new THREE.MeshStandardMaterial({ color: hex, roughness: 0.8 }));
        acc.position.set((x0 + x1) / 2, (H - 0.02) / 2 + 0.01, zo);
        acc.updateMatrixWorld();
        const ev = new CSG.Evaluator();
        for (const op of ops) {
          const c = localC(op);
          const hw = Math.min(op.width, (x1 - x0) - 0.08) / 2 + 0.001;
          const s = Math.max(x0, c - hw), e = Math.min(x1, c + hw);
          const top = op.type === 'door' ? op.height : Math.min(op.sill + op.height, H);
          const bot = op.type === 'window' ? op.sill : 0;
          const cutter = new CSG.Brush(box(e - s + 0.002, top - bot + 0.002, th + 0.02));
          cutter.position.set((s + e) / 2, (bot + top) / 2, 0);
          cutter.updateMatrixWorld();
          acc = ev.evaluate(acc, cutter, CSG.SUBTRACTION);
          acc.updateMatrixWorld();
        }
        const sm = new THREE.Mesh(acc.geometry, acc.material);
        sm.receiveShadow = true;
        sm.userData = { kind: 'wall', wi };
        g.add(sm); pickMeshes.push(sm);
      }
    } catch (err) { /* 蒙皮失败不影响主体 */ }
  }

  // ── 门扇（平贴墙面）/ 窗框玻璃 ──
  for (const op of ops) {
    const c = localC(op);
    const hw = Math.min(op.width, (x1 - x0) - 0.08) / 2;
    const s = Math.max(x0, c - hw), e = Math.min(x1, c + hw);
    const ww = e - s;
    if (op.type === 'window') {
      const wg = new THREE.Group();
      wg.position.set((s + e) / 2, 0, 0);
      wg.userData = { kind: 'window', wi, oi: op._oi };
      // 颜色材质（按 op.leafColor / op.glassColor 派生，否则用默认 M.frame / M.glass）
      const fMat = (op.leafColor && op.leafColor !== 'default')
        ? new THREE.MeshStandardMaterial({ color: op.leafColor, roughness: 0.5, metalness: 0.4 })
        : M.frame;
      const gMat = (op.glassColor && op.glassColor !== 'default')
        ? new THREE.MeshPhysicalMaterial({ color: op.glassColor, transparent: true, opacity: 0.28, roughness: 0.05, side: THREE.DoubleSide })
        : M.glass;
      const style = op.kind || 'single';
      // 共用部件：窗台板（避免地面漏口边缘不齐）
      addLocal(wg, box(ww + 0.1, 0.04, w.th + 0.1), fMat, 0, op.sill - 0.02, 0);
      if (style === 'fixed') {
        // 固定窗：单块大玻璃 + 外框
        addLocal(wg, box(ww - 0.04, op.height, 0.03), gMat, 0, op.sill + op.height / 2, 0, false);
        addLocal(wg, box(ww, 0.06, 0.1), fMat, 0, op.sill + 0.03, 0);
        addLocal(wg, box(ww, 0.06, 0.1), fMat, 0, op.sill + op.height - 0.03, 0);
        addLocal(wg, box(0.06, op.height, 0.1), fMat, -ww / 2 + 0.03, op.sill + op.height / 2, 0);
        addLocal(wg, box(0.06, op.height, 0.1), fMat, ww / 2 - 0.03, op.sill + op.height / 2, 0);
      } else if (style === 'double') {
        // 双扇窗：中间竖框，左右各一块玻璃
        addLocal(wg, box(ww - 0.04, op.height, 0.03), gMat, 0, op.sill + op.height / 2, 0, false);
        addLocal(wg, box(ww, 0.06, 0.1), fMat, 0, op.sill + 0.03, 0);
        addLocal(wg, box(ww, 0.06, 0.1), fMat, 0, op.sill + op.height - 0.03, 0);
        addLocal(wg, box(0.06, op.height, 0.1), fMat, -ww / 2 + 0.03, op.sill + op.height / 2, 0);
        addLocal(wg, box(0.06, op.height, 0.1), fMat, ww / 2 - 0.03, op.sill + op.height / 2, 0);
        addLocal(wg, box(0.05, op.height, 0.06), fMat, 0, op.sill + op.height / 2, 0);   // 中竖框
      } else if (style === 'sliding') {
        // 推拉窗：左右两扇，每扇内嵌玻璃，两扇之间重叠 1/4
        const half = ww / 2;
        const leafW = half + 0.06;
        addLocal(wg, box(leafW - 0.05, op.height - 0.06, 0.04), gMat, -half / 2, op.sill + op.height / 2, 0, false);
        addLocal(wg, box(leafW - 0.05, op.height - 0.06, 0.04), gMat, half / 2, op.sill + op.height / 2, 0, false);
        addLocal(wg, box(leafW, op.height, 0.05), fMat, -half / 2, op.sill + op.height / 2, 0);
        addLocal(wg, box(leafW, op.height, 0.05), fMat, half / 2, op.sill + op.height / 2, 0);
        addLocal(wg, box(ww, 0.06, 0.1), fMat, 0, op.sill + op.height - 0.03, 0);
      } else if (style === 'casement') {
        // 平开窗：单侧铰链，整扇可绕一侧开启（与 op.hinge 一致）
        const side = op.hinge === -1 ? -1 : 1;
        const glassW = ww - 0.08;
        addLocal(wg, box(glassW, op.height - 0.06, 0.03), gMat, side * (-glassW / 2), op.sill + op.height / 2, 0, false);
        addLocal(wg, box(glassW + 0.04, op.height, 0.05), fMat, side * (-glassW / 2), op.sill + op.height / 2, 0);
        addLocal(wg, box(ww, 0.06, 0.1), fMat, 0, op.sill + op.height - 0.03, 0);
        addLocal(wg, box(0.06, op.height, 0.1), fMat, side * (-ww / 2 + 0.03), op.sill + op.height / 2, 0);
      } else {
        // single（默认）：原样
        addLocal(wg, box(ww - 0.1, op.height, 0.03), gMat, 0, op.sill + op.height / 2, 0, false);
        addLocal(wg, box(ww, 0.06, 0.1), fMat, 0, op.sill + 0.03, 0);
        addLocal(wg, box(ww, 0.06, 0.1), fMat, 0, op.sill + op.height - 0.03, 0);
        addLocal(wg, box(0.06, op.height, 0.1), fMat, -ww / 2 + 0.03, op.sill + op.height / 2, 0);
        addLocal(wg, box(0.06, op.height, 0.1), fMat, ww / 2 - 0.03, op.sill + op.height / 2, 0);
        addLocal(wg, box(0.05, op.height, 0.06), fMat, 0, op.sill + op.height / 2, 0);
      }
      g.add(wg); pickMeshes.push(wg);
    } else {
      const dg = new THREE.Group();
      dg.position.set((s + e) / 2, 0, 0);
      dg.userData = { kind: 'door', wi, oi: op._oi };
      // 门扇材质（按 op.leafColor 派生基色；按 op.leafTex 加纹理）
      const leafBase = (op.leafColor && op.leafColor !== 'default') ? op.leafColor : null;
      let leafMat = leafBase
        ? new THREE.MeshStandardMaterial({ color: leafBase, roughness: 0.55 })
        : M.doorLeaf;
      if (op.leafTex) {
        const baseHex = leafBase || ('#' + M.doorLeaf.color.getHexString());
        const variant = applyMatVariant(leafMat, op.leafTex, baseHex, [Math.max(1, Math.round(ww * 4)), Math.max(1, Math.round(op.height * 4))]);
        if (variant !== leafMat) leafMat = variant;
      }
      const style = op.kind || 'single';
      // ── isOpen 开关门状态:把可动门扇/把手放进 hinge 子组,绕 Y 轴旋转 ──
      const isOpen = !!op.isOpen;
      const hinge = new THREE.Group();
      // hingeSide: -1 = 铰链在门左边; +1 = 右边
      const hingeSide = op.hinge === 1 ? 1 : -1;
      // flip 决定开门方向(往墙哪一侧开)
      const flipSign = op.flip ? -1 : 1;
      const openDeg = isOpen ? 90 : 0;   // 开 90 度
      if (style === 'double') {
        // 双开门：两扇对开,共用中竖框;每扇有自己的 hinge
        const leftLeaf = new THREE.Group();
        // 左扇:铰链在门洞中线(整扇从中线开始)
        addLocal(leftLeaf, box(ww / 2, op.height, 0.05), leafMat, ww / 4, op.height / 2, 0);
        addLocal(leftLeaf, box(0.04, 0.5, 0.03), M.metal, ww / 2 - 0.08, 1.02, -flipSign * 0.035);
        if (isOpen) leftLeaf.rotation.y = -openDeg * Math.PI / 180 * flipSign;
        dg.add(leftLeaf);
        const rightLeaf = new THREE.Group();
        addLocal(rightLeaf, box(ww / 2, op.height, 0.05), leafMat, -ww / 4, op.height / 2, 0);
        addLocal(rightLeaf, box(0.04, 0.5, 0.03), M.metal, -ww / 2 + 0.08, 1.02, flipSign * 0.035);
        if (isOpen) rightLeaf.rotation.y = openDeg * Math.PI / 180 * flipSign;
        dg.add(rightLeaf);
        addLocal(dg, box(0.04, op.height, 0.08), M.frame, 0, op.height / 2, 0);   // 中竖框(固定)
      } else if (style === 'sliding') {
        // 推拉门：两扇重叠，可看见一扇在前面一扇在后面
        addLocal(dg, box(ww * 0.55, op.height, 0.05), leafMat, -ww * 0.2, op.height / 2, -0.06);
        addLocal(dg, box(ww * 0.55, op.height, 0.05), leafMat, ww * 0.2, op.height / 2, 0.06);
        addLocal(dg, box(ww, 0.06, 0.1), M.frame, 0, op.height - 0.03, 0);
      } else if (style === 'elevator') {
        // 电梯门(自动中分双扇)：两扇不锈钢面板在中间对开,无把手,顶部有横轨
        // 中分缝 ~10mm,顶部贯通金属横梁
        const panelW = ww / 2 - 0.005;
        const steelMat = new THREE.MeshStandardMaterial({
          color: 0xb8bcc0, metalness: 0.85, roughness: 0.32,
        });
        addLocal(dg, box(panelW, op.height, 0.04), steelMat, -ww / 4, op.height / 2, 0);
        addLocal(dg, box(panelW, op.height, 0.04), steelMat,  ww / 4, op.height / 2, 0);
        addLocal(dg, box(ww + 0.02, 0.06, 0.1), M.frame, 0, op.height - 0.03, 0);
        addLocal(dg, box(0.02, op.height, 0.06), M.metal, 0, op.height / 2, 0.025);
      } else if (style === 'folding') {
        // 折叠门：4 扇折痕（用 4 片斜板示意）
        const segs = 4, w = ww / segs;
        for (let i = 0; i < segs; i++) {
          const cx = -ww / 2 + w * (i + 0.5);
          const tilt = (i % 2 === 0 ? 1 : -1) * 0.06;
          const panel = new THREE.Mesh(box(w * 0.98, op.height - 0.02, 0.04), leafMat);
          panel.position.set(cx, op.height / 2, tilt);
          panel.castShadow = panel.receiveShadow = true;
          dg.add(panel);
        }
        addLocal(dg, box(ww, 0.06, 0.1), M.frame, 0, op.height - 0.03, 0);
      }
      // 拱形门/玻璃门已下线:旧 kind 直接落回 single 渲染(数据在 normDoc 里已迁移)
      else {
        // single（默认）—— 门扇 + 把手进 hinge 子组
        addLocal(hinge, box(ww, op.height, 0.05), leafMat, -hingeSide * ww / 2, op.height / 2, 0);
        addLocal(hinge, box(0.04, 0.5, 0.03), M.metal, hingeSide === -1 ? ww - 0.08 : -ww + 0.08, 1.02, flipSign * 0.035);
        hinge.position.set(hingeSide === -1 ? -ww / 2 : ww / 2, 0, 0);
        hinge.rotation.y = openDeg * Math.PI / 180 * hingeSide * flipSign;
        dg.add(hinge);
      }
      g.add(dg); pickMeshes.push(dg);
    }
  }
  g.visible = !_isHidden('wall', wi) && (lvMode !== 'solo' || (w.lv || 0) === activeLv);
  planGroup.add(g);
  wallGroups[wi] = g;
  return g;
}

// ── 墙角自动延长：共享端点恰好两面墙时，各自延出半厚填补墙角 ──
function computeMiters() {
  const map = {};
  doc.walls.forEach((w, wi) => {
    [[w.ax, w.az, 's'], [w.bx, w.bz, 'e']].forEach(([x, z, endk]) => {
      const k = x.toFixed(3) + ',' + z.toFixed(3);
      (map[k] = map[k] || []).push({ wi, endk, th: w.th });
    });
  });
  const mit = {};
  for (const k in map) {
    const uniq = [];
    map[k].forEach(en => { if (!uniq.some(u => u.wi === en.wi)) uniq.push(en); });
    if (uniq.length !== 2) continue;
    const [a, b] = uniq;
    const wa = doc.walls[a.wi], wb = doc.walls[b.wi];
    const da = a.endk === 'e'
      ? { x: wa.ax - wa.bx, z: wa.az - wa.bz }
      : { x: wa.bx - wa.ax, z: wa.bz - wa.az };
    const db = b.endk === 'e'
      ? { x: wb.ax - wb.bx, z: wb.az - wb.bz }
      : { x: wb.bx - wb.ax, z: wb.bz - wb.az };
    const la = Math.hypot(da.x, da.z) || 1, lb = Math.hypot(db.x, db.z) || 1;
    const alpha = Math.acos(THREE.MathUtils.clamp((da.x * db.x + da.z * db.z) / (la * lb), -1, 1));
    const extA = Math.min(Math.max((wb.th / 2) / Math.tan(Math.max(alpha / 2, 0.12)), 0), 0.5);
    const extB = Math.min(Math.max((wa.th / 2) / Math.tan(Math.max(alpha / 2, 0.12)), 0), 0.5);
    mit[a.wi] = mit[a.wi] || {};
    mit[a.wi][a.endk] = extA;
    mit[b.wi] = mit[b.wi] || {};
    mit[b.wi][b.endk] = extB;
  }
  return mit;
}
function addLocal(parent, geo, mat, x, y, z, cast = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = cast; m.receiveShadow = true;
  parent.add(m);
  return m;
}

// ============================================================
// 楼梯 — 借鉴 blueprint3d-babylon stairsGeometry 算法
// 数据: { type:'straight'|'lshape'|'spiral', x, z, rot, width, depth, height,
//        steps?, lv, color }
// ============================================================
function buildStairs(s, si) {
  const g = new THREE.Group();
  const w = Math.max(0.6, s.width || 0.9);     // 单段宽
  const D = Math.max(1.0, s.depth || 3.0);     // 水平投影深
  const H = Math.max(0.6, s.height || 2.8);    // 总高
  const steps = Math.max(3, Math.round(s.steps || H / 0.18));
  const sd = D / steps;                        // 踏深
  const sh = H / steps;                        // 踏高
  const tread = Math.min(0.04, sh * 0.5);

  const baseY = levelY(s.lv || 0);

  if (s.type === 'spiral') {
    // 螺旋楼梯: 沿 z 轴向 -z 走,每步转 12°
    const totalAngle = Math.PI;       // 半圈 / 全圈? 半圈够爬一层
    const radius = Math.max(w, D) / 2;
    for (let i = 0; i < steps; i++) {
      const a = i * (totalAngle / steps);
      const cx = Math.sin(a) * radius;
      const cz = -Math.cos(a) * radius + radius;   // 让底部在原点
      const cy = i * sh + tread / 2;
      const treadGeo = new THREE.BoxGeometry(w * 0.95, tread, sd * 0.95);
      const treadMesh = new THREE.Mesh(treadGeo, M.stairTread);
      treadMesh.position.set(cx, cy, cz);
      treadMesh.rotation.y = -a;
      treadMesh.castShadow = treadMesh.receiveShadow = true;
      g.add(treadMesh);
    }
    // 中央立柱
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, H + 0.2, 16), M.metal);
    post.position.set(0, baseY + H / 2, 0);
    post.castShadow = true;
    g.add(post);
    // 顶圈扶手
    const topRing = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 0.9, 0.015, 8, 32, Math.PI),
      M.stairRail
    );
    topRing.rotation.x = Math.PI / 2;
    topRing.rotation.z = Math.PI;
    topRing.position.set(0, baseY + H + 0.05, radius);
    topRing.castShadow = true;
    g.add(topRing);
  } else if (s.type === 'lshape') {
    // L 型: 先走 n1 步 (沿 +z), 平台, 再走 n2 步 (沿 +x)
    const n1 = Math.min(steps - 2, Math.floor(steps / 2));
    const n2 = steps - n1;
    const w1 = w, w2 = w;
    // 第 1 段
    for (let i = 0; i < n1; i++) {
      const z = -i * sd - sd / 2;
      const y = i * sh + tread / 2;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w1, tread, sd * 0.98), M.stairTread);
      m.position.set(0, y, z);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
    // 平台
    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(w2, tread, sd * 1.6),
      M.stairTread
    );
    platform.position.set(w2 / 2, (n1 - 1) * sh + sh / 2 + tread, -(n1 - 1) * sd / 2 - sd / 2);
    platform.castShadow = platform.receiveShadow = true;
    g.add(platform);
    // 第 2 段
    for (let i = 0; i < n2; i++) {
      const x = w2 / 2 + i * sd + sd / 2;
      const y = (n1 - 1) * sh + sh + i * sh + tread / 2;
      const m = new THREE.Mesh(new THREE.BoxGeometry(sd * 0.98, tread, w2 * 0.95), M.stairTread);
      m.position.set(x, y, 0);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
  } else {
    // straight 直跑
    for (let i = 0; i < steps; i++) {
      const z = -i * sd - sd / 2;
      const y = i * sh + tread / 2;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, tread, sd * 0.98), M.stairTread);
      m.position.set(0, y, z);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      // 立板
      if (i > 0) {
        const r = new THREE.Mesh(new THREE.BoxGeometry(w, sh - tread, 0.02), M.stairRiser);
        r.position.set(0, i * sh, z + sd / 2);
        r.castShadow = r.receiveShadow = true;
        g.add(r);
      }
    }
    // 顶层踏板 + 扶手
    const top = new THREE.Mesh(new THREE.BoxGeometry(w, tread, sd), M.stairTread);
    top.position.set(0, H + tread / 2, 0);
    top.castShadow = top.receiveShadow = true;
    g.add(top);
    const railL = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, H + 0.9, 8), M.stairRail);
    railL.position.set(-w / 2 + 0.04, baseY + (H + 0.9) / 2, -D + 0.04);
    railL.castShadow = true;
    g.add(railL);
    const railR = railL.clone();
    railR.position.x = w / 2 - 0.04;
    g.add(railR);
  }

  // 整体位置: 文档坐标直接作为 planGroup 局部坐标(planGroup 自带 -CX/-CZ 偏移,
  // 这里不能再减,否则楼梯会比放置点整体偏移 (CX,CZ),与 2D 俯视图/拖拽口径不一致)
  g.position.set(s.x, baseY, s.z);
  g.rotation.y = s.rot || 0;
  g.userData = { kind: 'stairs', si };
  g.visible = !_isHidden('stairs', si) && (lvMode !== 'solo' || (s.lv || 0) === activeLv);
  // 拾取 + 大纲
  g.traverse(o => { if (o.isMesh) { o.userData = { kind: 'stairs', si }; pickMeshes.push(o); } });
  planGroup.add(g);
  stairGroups[si] = g;
  return g;
}


function buildHandles() {
  handlesGroup.clear();
  if (sel && sel.kind === 'wall') {
    const w = doc.walls[sel.wi];
    if (w) [[w.ax, w.az, 0], [w.bx, w.bz, 1]].forEach(([x, z, end]) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), M.handle);
      m.position.set(x - CX, 0.09, z - CZ);
      m.userData = { kind: 'end', wi: sel.wi, end };
      handlesGroup.add(m);
    });
    // 3D 中点 handle: 拖动整体移动墙(竖向环,半透明)
    const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
    const ringGeo = new THREE.TorusGeometry(0.16, 0.02, 8, 24);
    const ring = new THREE.Mesh(ringGeo, M.handle);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(mx - CX, 0.05, mz - CZ);
    ring.userData = { kind: 'wallMove', wi: sel.wi };
    handlesGroup.add(ring);
  }
  if (sel && sel.kind === 'furniture') {
    // 3D 旋转环 (Viewer3DHandles 模式): 在家具顶部画一个环,拖动旋转 5°
    const f = doc.furniture[sel.fi]; if (f) {
      const def = FURN[f.type];
      const h = (def && def.h) || 0.5;
      const ringGeo = new THREE.TorusGeometry(0.3, 0.025, 8, 32);
      const ring = new THREE.Mesh(ringGeo, M.handle);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(f.x - CX, h + 0.05, f.z - CZ);
      ring.rotation.z = -(f.rot || 0);
      ring.userData = { kind: 'furnRot', fi: sel.fi };
      handlesGroup.add(ring);
      // 移动箭头 (XZ plane 上 4 个小锥): 提示可整体移动
      const arrowMat = M.handle;
      const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      const arrowGeo = new THREE.ConeGeometry(0.07, 0.15, 8);
      dirs.forEach(([dx, dz]) => {
        const c = new THREE.Mesh(arrowGeo, arrowMat);
        c.position.set(f.x + dx * 0.6 - CX, 0.05, f.z + dz * 0.6 - CZ);
        c.rotation.z = dx === 0 ? (dz > 0 ? -Math.PI / 2 : Math.PI / 2) : (dx > 0 ? 0 : Math.PI);
        c.rotation.x = dz === 0 ? (dx > 0 ? 0 : Math.PI) : 0;
        c.userData = { kind: 'furnMove', fi: sel.fi };
        handlesGroup.add(c);
      });
    }
  }
  if (sel && sel.kind === 'floor') {
    // 地面缩放: 4 角 + 旋转环
    const f = doc.floors[sel.fi]; if (f) {
      const cx = (f.x1 + f.x2) / 2, cz = (f.z1 + f.z2) / 2;
      const corners = [[f.x1, f.z1], [f.x2, f.z1], [f.x2, f.z2], [f.x1, f.z2]];
      corners.forEach(([x, z], i) => {
        const c = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), M.handle);
        c.position.set(x - CX, 0.05, z - CZ);
        c.userData = { kind: 'floorCorner', fi: sel.fi, corner: i };
        handlesGroup.add(c);
      });
      const ringGeo = new THREE.TorusGeometry(0.3, 0.025, 8, 32);
      const ring = new THREE.Mesh(ringGeo, M.handle);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(cx - CX, 0.05, cz - CZ);
      ring.userData = { kind: 'floorRot', fi: sel.fi };
      handlesGroup.add(ring);
    }
  }
  if (tool === 'wall') {
    doc.walls.forEach(w => {
      [[w.ax, w.az], [w.bx, w.bz]].forEach(([x, z]) => {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), M.frame);
        m.position.set(x - CX, 0.05, z - CZ);
        handlesGroup.add(m);
      });
    });
  }
}

// ============================================================
// exporterUtils — 借鉴 blueprint3d-babylon exporterUtils.js
// 适配我们的 schema: {ax, az, bx, bz, openings:[{t, type, width, height, sill, kind}]}
// ============================================================
function _wallBasis(w) {
  if (!w) return null;
  const ax = +w.ax || 0, az = +w.az || 0;
  const bx = +w.bx || 0, bz = +w.bz || 0;
  const length = Math.hypot(bx - ax, bz - az);
  if (length <= 0.00001) return null;
  const ux = (bx - ax) / length, uz = (bz - az) / length;
  // 法向 (nx,nz): 右手系逆时针,墙左侧
  return { ax, az, bx, bz, length, ux, uz, nx: -uz, nz: ux };
}
function _pointAlongWall(basis, distance, normalOffset = 0) {
  return {
    x: basis.ax + basis.ux * distance + basis.nx * normalOffset,
    z: basis.az + basis.uz * distance + basis.nz * normalOffset,
  };
}
function _openingSpans(w) {
  const basis = _wallBasis(w);
  if (!basis) return [];
  const out = [];
  for (const op of (w.openings || [])) {
    const center = Math.max(0, Math.min(basis.length, (+op.t || 0.5) * basis.length));
    const half = Math.max(0.05, +op.width || (op.type === 'door' ? 0.9 : 1.25)) / 2;
    const start = Math.max(0, center - half);
    const end = Math.min(basis.length, center + half);
    if (end - start > 0.001) out.push({ op, start, end });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
function _rotatePoint(x, z, angle) {
  const c = Math.cos(angle || 0), s = Math.sin(angle || 0);
  return { x: x * c - z * s, z: x * s + z * c };
}
function _itemCorners(it) {
  const scale = +it.scale || 1;
  const hw = ((+it.width || 0) * scale) / 2;
  const hd = ((+it.depth || 0) * scale) / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, z]) => {
    const r = _rotatePoint(x, z, it.rot || 0);
    return { x: (+it.x || 0) + r.x, z: (+it.z || 0) + r.z };
  });
}
function _floorElevation(lv) {
  // 多层累积: lv=0 → 0;lv=1 → wallH + floorTh;...
  const levels = (doc.levels || []).slice().sort((a, b) => (+a.elev || 0) - (+b.elev || 0));
  const targetIdx = Math.max(0, lv | 0);
  let elev = 0;
  for (let i = 0; i < targetIdx; i++) {
    elev += +doc.wallH || 2.6;
    elev += +(doc.floorTh || 0.05);
  }
  return elev;
}
// 暴露给 DXF / 其他工具
globalThis._wallBasis = _wallBasis;
globalThis._pointAlongWall = _pointAlongWall;
globalThis._openingSpans = _openingSpans;
globalThis._itemCorners = _itemCorners;
globalThis._floorElevation = _floorElevation;

// 增量重建工具:把单个 Group 的所有子 mesh 几何/材质回收,
// 但保留 Group 本身的 id/位置/旋转(借用 blueprint3d 的 disposeMaterials 模式)
// 共享材质 M.* 不动,避免污染 _wallMatCache 之类的共享缓存
function _disposeGroupChildren(group) {
  if (!group) return;
  const toDispose = [];
  group.traverse(o => {
    if (o.isMesh) {
      if (o.geometry) toDispose.push(o.geometry);
      // 标记自创建材质以便 caller 决定是否 dispose(_wallMatCache 里的我们不 dispose)
    }
    // 同时清掉 pickMeshes 里指向的引用
    const idx = pickMeshes.indexOf(o);
    if (idx >= 0) pickMeshes.splice(idx, 1);
  });
  toDispose.forEach(g => g.dispose && g.dispose());
  while (group.children.length) group.remove(group.children[0]);
}
// (旧的 _wallCanReuse / _currentWallSelState 已删:墙复用只看几何 hash,
//  选中/hover 高亮改走 selHelper 覆盖层,不再参与重建判定)

function rebuild3D() {
  _geomDirty = false;
  // ── 增量重建(借鉴 blueprint3d-babylon 的 _syncWallPreview 模式) ──
  // 旧行为:planGroup.traverse + 全 dispose + planGroup.clear + 全重建
  // 新行为:对每个实体比对 hash → 复用/重建
  // pickMeshes 必须保留引用,因为 sel helper / raycast 都依赖它;
  // 我们在 dispose 单个 group 时同步清理 pickMeshes 中的孤儿引用。
  // 不再 reset pickMeshes = []。
  const _hidden = doc.hidden || {};
  _isHidden = (kind, i) => _hidden[`${kind}:${i}`];

  // 先清掉被删除的实体(在 doc 里消失的 index)
  function _pruneMap(map, len) {
    for (const key of [...map.keys()]) {
      if (key >= len) {
        const entry = map.get(key);
        const g = entry.group || entry.mesh;
        _disposeGroupChildren(g);
        planGroup.remove(g);
        map.delete(key);
        _geomDirty = true;
      }
    }
  }
  _pruneMap(_stairNodeBySi, (doc.stairs || []).length);
  _pruneMap(_floorNodeByFi, (doc.floors || []).length);
  _pruneMap(_wallNodeByWi,  doc.walls.length);

  // ── 楼梯 ──
  (doc.stairs || []).forEach((s, si) => {
    const newHash = _stairGeomHash(s);
    const cached = _stairNodeBySi.get(si);
    if (cached && cached.hash === newHash) {
      stairGroups[si] = cached.group;
      const g = cached.group;
      // 同步位置/朝向/显隐(拖动、旋转、楼层切换不改几何 hash,免重建直接跟随;
      // 局部坐标 = 原始文档坐标,与 buildStairs/拖拽代码一致)
      g.position.set(s.x, levelY(s.lv || 0), s.z);
      g.rotation.y = s.rot || 0;
      g.visible = !_isHidden('stairs', si) && (lvMode !== 'solo' || (s.lv || 0) === activeLv);
      return; // 跳过 buildStairs,几何无变化
    }
    // 几何变化:销毁旧,创建新
    if (cached) {
      _disposeGroupChildren(cached.group);
      planGroup.remove(cached.group);
    }
    const newGroup = buildStairs(s, si);
    _stairNodeBySi.set(si, { hash: newHash, group: newGroup });
    _geomDirty = true;
  });

  // ── 地面(floor 直接走 inline,没用 buildFloor) ──
  (doc.floors || []).forEach((f, fi) => {
    const newHash = _floorGeomHash(f);
    const cached = _floorNodeByFi.get(fi);
    if (cached && cached.hash === newHash && cached.selState === (_selHas('floor', fi) ? 1 : 0)) {
      floorMeshes[fi] = cached.mesh;
      // 显隐变化:同步更新
      cached.mesh.visible = !_isHidden('floor', fi) && (lvMode !== 'solo' || (f.lv || 0) === activeLv);
      return;
    }
    // 重建
    if (cached) {
      _disposeGroupChildren(cached.mesh);
      planGroup.remove(cached.mesh);
    }
    const yOff = levelY(f.lv || 0);
    const th = f.th || 0.05;
    let mat = new THREE.MeshStandardMaterial({ color: f.color || '#dcd6cc', roughness: 0.75 });
    if (_selHas('floor', fi)) { mat.emissive.set(0x554400); mat.emissiveIntensity = 0.6; }
    let dimU = 1, dimV = 1;
    if (f.strips && f.strips.length) {
      let xMin =  Infinity, xMax = -Infinity, zMin =  Infinity, zMax = -Infinity;
      f.strips.forEach(([za, zb, xa, xb]) => {
        if (xa < xMin) xMin = xa; if (xb > xMax) xMax = xb;
        if (za < zMin) zMin = za; if (zb > zMax) zMax = zb;
      });
      dimU = Math.max(0.5, xMax - xMin); dimV = Math.max(0.5, zMax - zMin);
    } else {
      dimU = Math.max(0.5, Math.abs(f.x2 - f.x1));
      dimV = Math.max(0.5, Math.abs(f.z2 - f.z1));
    }
    if (f.tex) {
      const variant = applyMatVariant(mat, f.tex, f.color, [Math.max(1, Math.round(dimU / 0.5)), Math.max(1, Math.round(dimV / 0.5))]);
      if (variant !== mat) mat = variant;
    }
    let m;
    if (f.strips && f.strips.length) {
      const geos = f.strips.map(([za, zb, xa, xb]) => {
        const g = new THREE.BoxGeometry(xb - xa, th, zb - za);
        g.translate((xa + xb) / 2, -th / 2, (za + zb) / 2);
        return g;
      });
      m = new THREE.Mesh(mergeGeometries(geos, false), mat);
      geos.forEach(g2 => g2.dispose());
      m.position.y = yOff;
    } else {
      const x1 = Math.min(f.x1, f.x2), x2 = Math.max(f.x1, f.x2);
      const z1 = Math.min(f.z1, f.z2), z2 = Math.max(f.z1, f.z2);
      m = new THREE.Mesh(box(x2 - x1, th, z2 - z1), mat);
      m.position.set((x1 + x2) / 2, yOff - th / 2, (z1 + z2) / 2);
    }
    m.receiveShadow = true;
    m.visible = !_isHidden('floor', fi) && (lvMode !== 'solo' || (f.lv || 0) === activeLv);
    m.userData = { kind: 'floor', fi };
    planGroup.add(m); pickMeshes.push(m);
    floorMeshes[fi] = m;
    _floorNodeByFi.set(fi, { hash: newHash, mesh: m, selState: _selHas('floor', fi) ? 1 : 0 });
    // 只有几何真的变了才重 bake 阴影(仅选中态变化时几何/阴影都不变)
    if (!cached || cached.hash !== newHash) _geomDirty = true;
    // 锁定态视觉提示
    if (floorLocked && (lvMode !== 'solo' || (f.lv || 0) === activeLv) && !_isHidden('floor', fi)) {
      mat.transparent = true; mat.opacity = Math.min(mat.opacity ?? 1, 0.55);
      let outline;
      if (f.strips && f.strips.length) {
        outline = new THREE.Group();
        f.strips.forEach(([za, zb, xa, xb]) => {
          const ring = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(xb - xa, th, zb - za)),
            new THREE.LineBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.85 })
          );
          ring.position.set((xa + xb) / 2, -th / 2, (za + zb) / 2);
          outline.add(ring);
        });
      } else {
        const x1 = Math.min(f.x1, f.x2), x2 = Math.max(f.x1, f.x2);
        const z1 = Math.min(f.z1, f.z2), z2 = Math.max(f.z1, f.z2);
        outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(x2 - x1, th + 0.002, z2 - z1)),
          new THREE.LineBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.85 })
        );
        outline.position.set((x1 + x2) / 2, -th / 2, (z1 + z2) / 2);
      }
      outline.userData.floorLockOverlay = true;
      planGroup.add(outline);
    }
  });

  const miters = computeMiters();
  doc.walls.forEach((w, wi) => {
    const newHash = _wallGeomHash(w, miters[wi]);
    const cached = _wallNodeByWi.get(wi);
    // 复用只看几何 hash:选中/hover 高亮走 selHelper 覆盖层,
    // 不再销毁重建墙体(CSG + 阴影重烘焙是 hover 扫墙卡顿的根源)
    if (cached && cached.hash === newHash) {
      wallGroups[wi] = cached.group;
      // 同步显隐
      cached.group.visible = !_isHidden('wall', wi) && (lvMode !== 'solo' || (w.lv || 0) === activeLv);
      return;
    }
    // 几何变化:销毁旧,创建新
    if (cached) {
      _disposeGroupChildren(cached.group);
      planGroup.remove(cached.group);
    }
    const newGroup = buildWall(w, wi, miters[wi]);
    _wallNodeByWi.set(wi, { hash: newHash, group: newGroup });
    _geomDirty = true;
  });

  // ── 家具 ──
  // 原生类型走 InstancedMesh(已增量),非原生走 Group,增量方式同楼梯/墙
  // 先统计每个 type 出现次数,定 InstancedMesh.count
  // 截断 furnitureGroups 到当前家具数量，清理被删除家具的旧引用
  if (furnitureGroups.length > (doc.furniture || []).length) {
    furnitureGroups.length = (doc.furniture || []).length;
  }
  const typeCount = {};
  (doc.furniture || []).forEach((f, fi) => {
    if (FURN[f.type] && NATIVE_INSTANCED_OK.has(f.type)) {
      typeCount[f.type] = (typeCount[f.type] || 0) + 1;
    }
  });
  // 槽位按类型分配:同 type 的第 n 件 → 槽 n(instanceId),与全局 fi 解耦。
  // 旧实现直接 setMatrixAt(fi) 而 count 是每类计数 → 第一件之外的家具全部隐形且不可选。
  const slotByType = {};
  (doc.furniture || []).forEach((f, fi) => {
    const def = FURN[f.type];
    if (!def) return;
    const visible = !_isHidden('furniture', fi) && (lvMode !== 'solo' || (f.lv || 0) === activeLv);
    // _captureFurnProto 把每个 part 的 localMatrix 都减去了 bbox.center,
    // 所以"在 y 放 dummy"等价于"中心落在 y"。要底面贴地(y+bbox.min.y=0)
    // 就得把 y 抬到 levelY + yOff + bbox.min.y。
    // 旧版 def.yOff 是按未中心化坐标算的偏移,这里统一叠加 bbox.min.y。
    let yFloorOffset = 0;
    if (NATIVE_INSTANCED_OK.has(f.type) && !furnProto[f.type]) {
      furnProto[f.type] = _captureFurnProto(f.type, def.build);
      furnBBox[f.type] = furnProto[f.type].bbox;
    }
    if (NATIVE_INSTANCED_OK.has(f.type)) {
      const bb = furnBBox[f.type];
      yFloorOffset = bb ? bb.center.y : 0;
    }
    const y = levelY((f.lv || 0)) + (def.yOff || 0) + yFloorOffset;
    const baseSc = def.scale || 1;
    const userSc = f.scale != null ? f.scale : 1;
    const sc = baseSc * userSc;
    const rot = f.rot || 0;

    if (NATIVE_INSTANCED_OK.has(f.type)) {
      const instArr = _ensureFurnInstanced(f.type);
      if (!instArr) { furnitureGroups[fi] = null; return; }
      const proto = furnProto[f.type];
      const slot = slotByType[f.type] = (slotByType[f.type] ?? -1) + 1;
      const cap = typeCount[f.type] || 0;
      if (slot >= FURN_INST_MAX) return; // 超出预留槽位,放弃渲染(极罕见)
      for (const inst of instArr) inst.count = cap;  // 精确赋值(增减都同步,删家具不留幽灵实例)
      _furnDummy.position.set(f.x, y, f.z);
      _furnDummy.rotation.set(0, rot, 0);
      _furnDummy.scale.set(sc, sc, sc);
      _furnDummy.updateMatrix();
      for (let pi = 0; pi < proto.parts.length; pi++) {
        const inst = instArr[pi];
        _furnMat.multiplyMatrices(_furnDummy.matrix, proto.parts[pi].localMatrix);
        if (visible) inst.setMatrixAt(slot, _furnMat);
        else inst.setMatrixAt(slot, _furnZero);
        inst.userData.instanceMap.set(slot, fi);   // instanceId → doc.fi(拾取用)
        inst.instanceMatrix.needsUpdate = true;
      }
      // 实例矩阵已更新:丢弃缓存的包围球。否则新放/移动的实例在旧球外时,
      // 射线拾取的球测试失败 → 整个 InstancedMesh 不可选中,视锥裁剪也会误剔除。
      for (const inst of instArr) inst.boundingSphere = null;
      furnitureGroups[fi] = { __instanced: true, type: f.type, fi, slot, x: f.x, y, z: f.z, rot, sc, visible };
      return;
    }

    // 非原生:hash-based 增量重建(y = 楼层抬升,换楼层必须重建,否则复用旧 y)
    const furnHash = `${f.type}|${f.x}|${f.z}|${y}|${rot}|${sc}|${visible}`;
    const cached = _wallNodeByWi.get('furn:' + fi);
    if (cached && cached.hash === furnHash) {
      furnitureGroups[fi] = cached.group;
      return;
    }
    if (cached) {
      _disposeGroupChildren(cached.group);
      planGroup.remove(cached.group);
    }
    const g = def.build();
    g.position.set(f.x, y, f.z);
    g.rotation.y = rot;
    g.scale.set(sc, sc, sc);
    g.visible = visible;
    g.userData = { kind: 'furniture', fi };
    planGroup.add(g); pickMeshes.push(g);
    furnitureGroups[fi] = g;
    _wallNodeByWi.set('furn:' + fi, { hash: furnHash, group: g });
    _geomDirty = true;
  });
  // 清零 InstancedMesh 中超出 count 的旧 slot 矩阵，防止删除家具后幽灵实例残留
  for (const type in furnInstanced) {
    const instArr = furnInstanced[type];
    const usedSlots = typeCount[type] || 0;
    for (const inst of instArr) {
      if (inst.count < FURN_INST_MAX) {
        for (let s = inst.count; s < FURN_INST_MAX; s++) {
          inst.setMatrixAt(s, _furnZero);
        }
        inst.instanceMatrix.needsUpdate = true;
      }
      // 清理 instanceMap 中超出 count 的旧映射
      for (const key of [...inst.userData.instanceMap.keys()]) {
        if (key >= usedSlots) inst.userData.instanceMap.delete(key);
      }
    }
  }
  // 删除被移除的家具(以 furn: 开头的 key)
  const curFurnCount = (doc.furniture || []).length;
  for (const key of [..._wallNodeByWi.keys()]) {
    if (typeof key === 'string' && key.startsWith('furn:')) {
      const idx = +key.slice(5);
      if (idx >= curFurnCount) {
        const entry = _wallNodeByWi.get(key);
        _disposeGroupChildren(entry.group);
        planGroup.remove(entry.group);
        _wallNodeByWi.delete(key);
        _geomDirty = true;
      }
    }
  }

  buildHandles();
  // 平面图底图（描述参考，铺在地面上层）
  const U = doc.underlay;
  if (U && U.visible && U.src) {
    if (!texCache.has(U.src)) {
      const tex = new THREE.TextureLoader().load(U.src, t => { t.colorSpace = THREE.SRGBColorSpace; rebuild(); });
      tex.colorSpace = THREE.SRGBColorSpace;
      texCache.set(U.src, tex);
    }
    const uh = U.w * (U.aspect || 0.75);
    const um = new THREE.Mesh(
      new THREE.PlaneGeometry(U.w, uh),
      new THREE.MeshBasicMaterial({ map: texCache.get(U.src), transparent: true, opacity: U.opacity ?? 0.5, depthWrite: false })
    );
    um.rotation.x = -Math.PI / 2;
    um.position.set(U.cx, 0.004, U.cz);
    um.renderOrder = 2;
    um.name = '_underlay';
    um.userData.excludeFromExport = true;
    planGroup.add(um);
  }
  selHelper.clear();
  // 墙体高亮覆盖层:半透明壳 + 描边(替代旧的"重建墙体换高亮材质"方案,
  // 选中/悬停/放置目标都不再触碰墙几何,帧开销 ~0.1ms)
  const _wallShell = (wi, color, opacity) => {
    const g = wallGroups[wi];
    if (!g) return;
    g.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(g);
    if (b.isEmpty()) return;
    const size = new THREE.Vector3(), ctr = new THREE.Vector3();
    b.getSize(size); b.getCenter(ctr);
    size.x += 0.02; size.y += 0.02; size.z += 0.02;
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    shell.position.copy(ctr);
    shell.renderOrder = 5;
    selHelper.add(shell);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(shell.geometry),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity + 0.35) }));
    edges.position.copy(ctr);
    edges.renderOrder = 6;
    selHelper.add(edges);
  };
  for (const s of _selList()) {
    if (s.kind === 'furniture' && furnitureGroups[s.fi]) {
      const fg = furnitureGroups[s.fi];
      if (fg.__instanced) {
        // InstancedMesh 走 overlay wireframe (BoxHelper 不支持 per-instance)
        const bb = furnBBox[fg.type];
        if (bb) {
          const size = bb.size;
          const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
          const edges = new THREE.EdgesGeometry(boxGeo);
          boxGeo.dispose();
          const wire = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffaa00 }));
          // fg.y 现在是家具底面世界 y(dummy 已被抬到「底面贴地」),
          // BoxGeometry 默认中心在原点,所以高亮框中心 = 底面 + size.y/2。
          // selHelper 挂在 scene 上,需把 doc 坐标换算成世界坐标(减 CX/CZ)
          wire.position.set(fg.x - CX, fg.y + size.y / 2, fg.z - CZ);
          wire.rotation.y = fg.rot;
          wire.scale.setScalar(fg.sc);
          selHelper.add(wire);
        }
      } else {
        selHelper.add(new THREE.BoxHelper(fg, 0xffaa00));
      }
    } else if (s.kind === 'wall') {
      _wallShell(s.wi, 0xff8800, 0.28);
    } else if (s.kind === 'door' || s.kind === 'window' || s.kind === 'opening') {
      const w = doc.walls[s.wi];
      if (w && w.openings[s.oi]) {
        const op = w.openings[s.oi];
        const dx = w.bx - w.ax, dz = w.bz - w.az;
        const L = Math.hypot(dx, dz) || 1;
        const t = op.t ?? 0.5;
        const cx = w.ax + dx * t;
        const cz = w.az + dz * t;
        const sill = op.type === 'window' ? (op.sill || 0) : 0;
        const ring = new THREE.Mesh(
          new THREE.BoxGeometry(op.width || 0.9, op.height || 2, (w.th || 0.12) + 0.06),
          new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.3, depthWrite: false }));
        ring.position.set(cx - CX, sill + (op.height || 2) / 2, cz - CZ);
        ring.rotation.y = -Math.atan2(dz, dx);
        ring.renderOrder = 5;
        selHelper.add(ring);
      }
    }
  }
  // 悬停墙 / 门窗放置目标墙(轻量高亮,不重建几何)
  if (hoverWi != null && hoverWi !== placeWall && !_selHas('wall', hoverWi)) {
    _wallShell(hoverWi, 0xffcc66, 0.15);
  }
  if (placeWall != null) {
    _wallShell(placeWall, 0x44aaff, 0.22);
  }
  outlineTree && outlineTree.render();
  // 阴影 bake 状态机:
  //   拖拽中       → autoUpdate=false(每帧 bake 是拖墙卡顿的主因,冻结)
  //   从冻结恢复时 → autoUpdate=true + 补一次 needsUpdate
  //   非拖拽几何变化(_geomDirty)→ 重 bake
  //   sel/hover 这类 rebuild:_geomDirty=false 且状态不变 → 不重 bake
  if (renderer && renderer.shadowMap) {
    if (drag) {
      renderer.shadowMap.autoUpdate = false;
    } else if (!renderer.shadowMap.autoUpdate) {
      renderer.shadowMap.autoUpdate = true;
      renderer.shadowMap.needsUpdate = true;
    } else if (_geomDirty) {
      renderer.shadowMap.needsUpdate = true;
    }
  }
}


// ============================================================
// 工具状态与拾取
// ============================================================
let tool = 'select';
let chain = null;             // 画墙链当前起点（文档坐标）
let chainPts = [];            // 链式已走顶点(含起点);围房模式闭合时据此生成多边形地面
let typedLen = '';
let wallMode = 'chain';        // 画墙模式：single / chain / room（Tab 切换）
let polyPts = [];              // room 模式顶点累积；闭合后保留可继续围下一个
const WALL_MODE_NAMES = { single: '单段', chain: '链式', room: '围房' };
let drag = null;              // {mode, ...}
let ghost = null;             // 门/窗放置预览组（严格平行于目标墙）
let placeWall = null;         // 两步放门窗：已选中的目标墙索引
let hoverWi = null;           // 悬停高亮的墙（未选墙时）
let orbit = null;             // 空白处拖动 → 旋转视角（现在由右键拖动触发）
let rOrbit = null;            // 右键拖动 → 旋转视角
let lPan = null;              // 左键拖空白处 → 平移画布 {x,y}
let marquee = null;           // Shift+左键拖空白处 → 框选 {x0,y0,x1,y1,add}
let needProps = false;
let orthoLock = true;         // 正交锁定：开 = 画墙强制水平/垂直(默认);按 Shift 临时放开,可以斜着画
                              // 切换入口:顶部「正交」按钮。
let floorA = null;            // 画地面：第一个角点
let previewFloorMesh = null;
let furnType = null;          // 家具库：当前选中的家具类型
let furnRot = 0;              // 家具放置旋转角
let stairType = 'straight';   // 楼梯类型 straight / lshape / spiral
let stairFurn = '';           // 楼梯工具下选中的楼梯类家具(FURN key);''=参数化楼梯

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const V = new THREE.Vector3();

function groundPoint(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointerNdc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, activeCam);
  if (!raycaster.ray.intersectPlane(groundPlane, V)) return null;
  return { x: V.x + CX, z: V.z + CZ };   // 世界 → 文档坐标
}

function pickAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointerNdc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, activeCam);
  const hs = raycaster.intersectObjects(handlesGroup.children, false);
  if (hs.length) return { hit: hs[0].object.userData, kind: 'end' };
  const hits = raycaster.intersectObjects(pickMeshes, true);
  if (hits.length) {
    // 优先选择门/窗：遍历所有命中，找第一个属于 door/window 的祖先
    for (const h of hits) {
      let o = h.object;
      while (o && !(o.userData && o.userData.kind)) o = o.parent;
      if (o && (o.userData.kind === 'door' || o.userData.kind === 'window')) {
        const hit = { ...o.userData };
        if (h.instanceId != null && o.userData.instanceMap) {
          hit.fi = o.userData.instanceMap.get(h.instanceId);
        }
        return { hit, kind: o.userData.kind };
      }
    }
    // 没有命中门/窗，取最近的命中
    let o = hits[0].object;
    while (o && !(o.userData && o.userData.kind)) o = o.parent;
    if (o) {
      const hit = { ...o.userData };
      if (hits[0].instanceId != null && o.userData.instanceMap) {
        hit.fi = o.userData.instanceMap.get(hits[0].instanceId);
      }
      return { hit, kind: o.userData.kind };
    }
  }
  return null;
}

function nearestWall(p, maxDist = 0.4) {
  let best = null;
  doc.walls.forEach((w, wi) => {
    const dx = w.bx - w.ax, dz = w.bz - w.az;
    const L2 = dx * dx + dz * dz;
    if (L2 < 1e-6) return;
    let t = ((p.x - w.ax) * dx + (p.z - w.az) * dz) / L2;
    t = Math.max(0.06, Math.min(0.94, t));
    const px = w.ax + t * dx, pz = w.az + t * dz;
    const d = Math.hypot(p.x - px, p.z - pz);
    if (d < (best ? best.d : maxDist)) best = { wi, t, d, px, pz };
  });
  return best;
}

// 家具贴墙/贴边吸附：靠近墙 0.3m 内→把家具边贴到墙面上并旋转到靠墙姿态
// 优先贴最近的一面墙（额外推 wall.th/2 + 1mm 留缝，避免家具穿入墙厚），其次贴最近的其他家具边缘
// 返回值含 {x,z,rot,snapped,to}
function snapFurn(p, w, d, curRot, preferRot = true) {
  const SNAP_DIST = 0.30;
  const halfW = w / 2, halfD = d / 2;
  // 1) 贴墙
  const wall = nearestWall(p, SNAP_DIST);
  if (wall) {
    const wallData = doc.walls[wall.wi];
    const dx = wallData.bx - wallData.ax;
    const dz = wallData.bz - wallData.az;
    const wallAng = Math.atan2(dz, dx);                     // 墙方向
    // 额外推墙厚的一半 + 1mm 留缝:避免家具几何压进墙里
    const wallClearance = (wallData.th || 0.12) / 2 + 0.001;
    // 候选两个姿态：宽边靠墙（W 平行墙）或长边靠墙（D 平行墙）
    // 用 curRot 量化到最近 90°，再找与 wallAng 接近的那个
    const base = Math.round(curRot / (Math.PI / 2)) * (Math.PI / 2);
    const cands = [base, base + Math.PI / 2];
    let best = null;
    for (const r of cands) {
      // 家具局部 X 轴在水平面上投影 = cos(r), sin(r)
      // 取离墙最近的那个角朝墙推 + 整体朝墙推 SNAP_DIST
      // 简化：把家具中心推到离墙面 SNAP_DIST + 半边长度 的位置
      // 假设家具背面是 -X 局部方向（多数家具约定），那么把中心推到墙面 + 半宽
      const halfX = Math.abs(Math.cos(r)) * halfW + Math.abs(Math.sin(r)) * halfD;
      const halfZ = Math.abs(Math.sin(r)) * halfW + Math.abs(Math.cos(r)) * halfD;
      // 投影：把候选中心 (px, pz) 反推 = 墙面最近点 + 法线 * (halfX + 墙厚一半)
      // 墙法线 = (sin(ang), -cos(ang)) 或 (-sin, cos)，选离 p 更近的那个
      const n1x = Math.sin(wallAng), n1z = -Math.cos(wallAng);
      const off1 = halfX + wallClearance;
      const c1x = wall.px + n1x * off1, c1z = wall.pz + n1z * off1;
      const d1 = Math.hypot(c1x - p.x, c1z - p.z);
      const n2x = -n1x, n2z = -n1z;
      const c2x = wall.px + n2x * off1, c2z = wall.pz + n2z * off1;
      const d2 = Math.hypot(c2x - p.x, c2z - p.z);
      const pick = d1 < d2 ? { x: c1x, z: c1z, d: d1 } : { x: c2x, z: c2z, d: d2 };
      const aligned = Math.abs(((r - wallAng) % Math.PI)) < 0.01;
      if (!best || pick.d < best.d || (aligned && !best.aligned)) best = { x: pick.x, z: pick.z, rot: r, d: pick.d, aligned };
    }
    if (best) {
      const rot = preferRot ? best.rot : curRot;
      return { x: best.x, z: best.z, rot, snapped: 'wall', to: '墙 #' + (wall.wi + 1), d: best.d };
    }
  }
  // 2) 贴其他家具的边（最近的一条 AABB 边）
  let best = null;
  doc.furniture.forEach((f, fi) => {
    const fd = FURN[f.type]; if (!fd) return;
    const fx0 = f.x - fd.w / 2, fx1 = f.x + fd.w / 2;
    const fz0 = f.z - fd.d / 2, fz1 = f.z + fd.d / 2;
    // 四条边各取最近点
    const edges = [
      { x: fx0, dx: -1, dz: 0, axis: 'z' },                    // 左边（法线 -X）
      { x: fx1, dx: +1, dz: 0, axis: 'z' },
      { x: fz0, dx: 0, dz: -1, axis: 'x' },                    // 前边（法线 -Z）
      { x: fz1, dx: 0, dz: +1, axis: 'x' },
    ];
    for (const e of edges) {
      const close = e.axis === 'z'
        ? Math.abs(p.x - e.x) < SNAP_DIST && p.z >= fz0 - 0.3 && p.z <= fz1 + 0.3
        : Math.abs(p.z - e.x) < SNAP_DIST && p.x >= fx0 - 0.3 && p.x <= fx1 + 0.3;
      if (!close) continue;
      const dist = e.axis === 'z' ? Math.abs(p.x - e.x) : Math.abs(p.z - e.x);
      const halfX = e.axis === 'z' ? halfW : halfD;
      const nx = p.x < e.x ? -1 : +1;
      const nz = p.z < e.x ? -1 : +1;
      const cx = p.x + (e.axis === 'z' ? (e.x < p.x ? -halfX : +halfX) : 0);
      const cz = p.z + (e.axis === 'x' ? (e.x < p.z ? -halfX : +halfX) : 0);
      // 与现有朝向对齐（保持长边平行 = curRot 量化的 0/90/180/270）
      const rot = Math.round(curRot / (Math.PI / 2)) * (Math.PI / 2);
      if (!best || dist < best.d) best = { x: cx, z: cz, rot, d: dist, snapped: 'furn', to: FURN[f.type].name + ' #' + (fi + 1) };
    }
  });
  return best;
}

// 地面绘制预览
function updateFloorPreview(a, b) {
  if (!previewFloorMesh) {
    previewFloorMesh = new THREE.Mesh(box(1, 1, 1), M.preview);
    scene.add(previewFloorMesh);
  }
  const dx = Math.abs(b.x - a.x) || 0.01, dz = Math.abs(b.z - a.z) || 0.01;
  previewFloorMesh.scale.set(dx, 0.05, dz);
  previewFloorMesh.position.set((a.x + b.x) / 2 - CX, 0.026, (a.z + b.z) / 2 - CZ);
}
function clearFloorPreview() {
  if (previewFloorMesh) { previewFloorMesh.geometry.dispose(); scene.remove(previewFloorMesh); previewFloorMesh = null; }
  dimLabel.style.display = 'none';
}
// 家具放置虚影（穿透渲染）
function updateFurnGhost(p, typeOverride) {
  const def = FURN[typeOverride || furnType];
  if (!def) return;
  if (!ghost) {
    ghost = new THREE.Group();
    addLocal(ghost, box(def.w, 1.0, def.d), M.ghost, 0, 0.5, 0, false);
    ghost.traverse(o => { o.renderOrder = 999; });
    scene.add(ghost);
  }
  ghost.position.set(p.x - CX, levelY(activeLv), p.z - CZ);
  ghost.rotation.y = furnRot;
}
// 门/窗放置预览：仅在已选中的目标墙上滑动，严格平行于该墙
function updateGhostOnWall(p) {
  if (!p) return;
  const w = doc.walls[placeWall];
  if (!w) { placeWall = null; clearGhost(); return; }
  const defW = tool === 'door' ? 0.8 : 0.9;
  const dx = w.bx - w.ax, dz = w.bz - w.az;
  const L = Math.hypot(dx, dz);
  const hw = defW / 2;
  const tMin = (hw + 0.03) / L, tMax = 1 - (hw + 0.03) / L;
  if (tMin > tMax) { clearGhost(); return; }          // 墙太短放不下
  let t = ((p.x - w.ax) * dx + (p.z - w.az) * dz) / (L * L);
  t = Math.max(tMin, Math.min(tMax, t));
  if (!ghost) {
    ghost = new THREE.Group();
    if (tool === 'door') {
      addLocal(ghost, box(0.8, 2.05, 0.05), M.ghost, 0, 1.025, 0, false);
      ghost.userData.handle = addLocal(ghost, box(0.04, 0.5, 0.02), M.ghost, 0.32, 1.02, 0, false);
    } else {
      addLocal(ghost, box(0.9, 1.65, 0.03), M.ghost, 0, 0.9 + 0.825, 0, false);
    }
    ghost.traverse(o => { o.renderOrder = 999; });   // 穿透墙体渲染，不被墙面遮挡
    scene.add(ghost);
  }
  ghost.position.set(w.ax + t * dx - CX, 0, w.az + t * dz - CZ);
  ghost.rotation.y = -Math.atan2(dz, dx);             // 与墙同向 → 平行
  const ndx = dx / L, ndz = dz / L;
  // 相机在墙的哪一侧：正 = 本地 +Z 侧（flip=true 的开向面）
  ghost._side = ((camera.position.x + CX - (w.ax + t * dx)) * -ndz
               + (camera.position.z + CZ - (w.az + t * dz)) * ndx) >= 0 ? 1 : -1;
  if (ghost.userData.handle) ghost.userData.handle.position.z = ghost._side * 0.03;
  ghost._t = t;
}
function clearGhost() {
  if (ghost) {
    ghost.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    scene.remove(ghost); ghost = null;
  }
}
function projOnWall(w, p) {
  const dx = w.bx - w.ax, dz = w.bz - w.az, L2 = dx * dx + dz * dz;
  if (L2 < 1e-6) return null;
  let t = ((p.x - w.ax) * dx + (p.z - w.az) * dz) / L2;
  return Math.max(0.05, Math.min(0.95, t));
}

// ============================================================
// 拖拽预览（端点 / 开门窗洞 / 多选整体拖）
// 拖拽中不写回 doc / 不 rebuild，只把预览几何贴到鼠标；
// 松开在 pointerup 一次性写回 + 调一次 rebuild()。
// ============================================================
let dragPreviewGroup = null;      // 顶层 Group,跟 docGroup 平行
function _ensureDragPreviewGroup() {
  if (dragPreviewGroup && dragPreviewGroup.parent === scene) return dragPreviewGroup;
  dragPreviewGroup = new THREE.Group();
  dragPreviewGroup.renderOrder = 1000;     // 在所有 wall/furn 之上
  scene.add(dragPreviewGroup);
  return dragPreviewGroup;
}
function _disposeDragPreview() {
  if (!dragPreviewGroup) return;
  dragPreviewGroup.traverse(o => {
    if (o.isMesh) { o.geometry.dispose(); }
  });
  scene.remove(dragPreviewGroup);
  dragPreviewGroup = null;
}
function _clearDragPreview() { _disposeDragPreview(); }

// 端点拖拽：从另一端到鼠标位置的"延长墙"预览
// q = {x, z} 鼠标位置(已吸附)
function _previewEndExtend(wi, ax, az, bx, bz, end, q) {
  const g = _ensureDragPreviewGroup();
  const otherX = end === 0 ? bx : ax;
  const otherZ = end === 0 ? bz : az;
  const dx = q.x - otherX, dz = q.z - otherZ;
  const L = Math.max(Math.hypot(dx, dz), 0.01);
  // 用一个薄 box 表现"延长部分"
  const w = doc.walls[wi];
  const th = (w && w.th) || 0.12;
  const H = (w && w.h != null) ? w.h : doc.wallH;
  const boxGeo = box(0.12, H, th);     // 借用 box() 工厂(内部 new)
  const mesh = new THREE.Mesh(boxGeo, M.preview);
  mesh.position.set((otherX + q.x) / 2 - CX, H / 2, (otherZ + q.z) / 2 - CZ);
  mesh.rotation.y = -Math.atan2(dz, dx);
  mesh.scale.x = L / 0.12;     // 沿本地 x 拉长
  g.add(mesh);
  // 再画一条端点 → 鼠标的连线,蓝色粗线
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(otherX - CX, 0.05, otherZ - CZ),
    new THREE.Vector3(q.x - CX, 0.05, q.z - CZ),
  ]);
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x2b50d8 }));
  g.add(line);
}
// 开门窗洞拖拽：沿墙滑动的预览 box
function _previewOpeningMove(wi, oi, t, targetWi) {
  const g = _ensureDragPreviewGroup();
  const useWi = (targetWi != null) ? targetWi : wi;
  const w = doc.walls[useWi]; if (!w) return;
  const src = doc.walls[wi];
  const op = (useWi === wi) ? (src && src.openings[oi]) : (src && src.openings[oi]);  // 总是从源墙拿 op(尺寸/类型)
  if (!op) return;
  const dx = w.bx - w.ax, dz = w.bz - w.az, L = Math.hypot(dx, dz) || 1;
  const cx = w.ax + t * dx, cz = w.az + t * dz;
  const H = w.h != null ? w.h : doc.wallH;
  const Hh = op.type === 'door' ? op.height : (op.sill + op.height);
  const bot = op.type === 'door' ? 0 : op.sill;
  const h = Math.max(Hh - bot, 0.1);
  const th = (w.th || 0.12) + 0.02;
  const boxGeo = box(op.width, h, th);
  const mesh = new THREE.Mesh(boxGeo, M.ghost);
  mesh.position.set(cx - CX, bot + h / 2, cz - CZ);
  mesh.rotation.y = -Math.atan2(dz, dx);
  mesh.renderOrder = 999;
  g.add(mesh);
  // 跨墙提示: 在目标墙附近画一条高亮指示线
  if (useWi !== wi) {
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(w.ax - CX, 0.02, w.az - CZ),
      new THREE.Vector3(w.bx - CX, 0.02, w.bz - CZ),
    ]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xff8800 }));
    line.renderOrder = 999;
    g.add(line);
  }
}
// 多选整体拖：在每个选中件原位置画一个半透明 ghost(显示"将要搬去的位置")
function _previewMultiDrag(items, dx, dz) {
  const g = _ensureDragPreviewGroup();
  for (const s of items) {
    if (s.kind === 'wall') {
      const w = doc.walls[s.i]; if (!w) continue;
      const wdx = w.bx - w.ax, wdz = w.bz - w.az;
      const L = Math.max(Math.hypot(wdx, wdz), 0.01);
      const H = (w.h != null) ? w.h : doc.wallH;
      const boxGeo = box(L + 0.4, H, w.th + 0.04);
      const m = new THREE.Mesh(boxGeo, M.preview);
      const cx = (w.ax + w.bx) / 2 + dx, cz = (w.az + w.bz) / 2 + dz;
      m.position.set(cx - CX, H / 2, cz - CZ);
      m.rotation.y = -Math.atan2(wdz, wdx);   // 整体平移不改变墙朝向,用原 wdz/wdx
      g.add(m);
    } else if (s.kind === 'floor') {
      const f = doc.floors[s.i]; if (!f) continue;
      const w = Math.abs(f.x2 - f.x1), d = Math.abs(f.z2 - f.z1);
      const boxGeo = box(w + 0.4, 0.06, d + 0.4);
      const m = new THREE.Mesh(boxGeo, M.preview);
      m.position.set((f.x1 + f.x2) / 2 + dx - CX, 0.03, (f.z1 + f.z2) / 2 + dz - CZ);
      g.add(m);
    } else if (s.kind === 'furniture') {
      const f = doc.furniture[s.i]; if (!f) continue;
      const def = FURN[f.type]; if (!def) continue;
      const boxGeo = box((def.w || 0.5) + 0.2, (def.h || 0.5) + 0.2, (def.d || 0.5) + 0.2);
      const m = new THREE.Mesh(boxGeo, M.preview);
      m.position.set(f.x + dx - CX, 0.05, f.z + dz - CZ);
      g.add(m);
    }
  }
}

function _updateDragPreview(kind, drag, payload) {
  _disposeDragPreview();    // 每帧重建一次预览几何(只几个 mesh,可忽略 GC)
  // 缓存最新值,pointerup 时一次性写回 doc
  if (kind === 'end') {
    drag._previewQ = payload;
    _previewEndExtend(drag.wi, drag.ax, drag.az, drag.bx, drag.bz, drag.end, payload);
  } else if (kind === 'open') {
    drag._previewT = payload.t;
    drag._previewTargetWi = (payload.targetWi != null) ? payload.targetWi : drag.wi;
    _previewOpeningMove(drag.wi, drag.oi, payload.t, drag._previewTargetWi);
  } else if (kind === 'multi') {
    drag._previewDelta = payload;
    _previewMultiDrag(drag.items, payload.dx, payload.dz);
  }
}

// ============================================================
// 指针事件
// ============================================================
const dimLabel = document.getElementById('dimLabel');
const coordsEl = document.getElementById('coords');
let _coordsAt = 0;          // 坐标文字节流时间戳
const snapDot = document.getElementById('snapDot');
let downXY = null;

// 吸附高亮：kind ∈ 'end'|'mid'|'axis'|'45'|'grid'；world 为吸附点（用于映射到屏幕）
function showSnapDot(kind, screenX, screenY) {
  if (!snapDot) return;
  const r = renderer.domElement.getBoundingClientRect();
  snapDot.className = 'show k-' + kind;
  snapDot.style.left = (screenX - r.left) + 'px';
  snapDot.style.top = (screenY - r.top) + 'px';
}
function hideSnapDot() { if (snapDot) snapDot.className = ''; }

// ── 视角控制 ────────────────────────────────────────
// 右键拖拽 → 旋转视角(以 controls.target 为中心做球坐标旋转)
// 俯视正交时只转 phi 的限制保持不动。
function _orbitBy(dx, dy) {
  const off = activeCam.position.clone().sub(controls.target);
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.theta -= dx * 0.005;
  if (activeCam === camera) sph.phi = Math.max(0.08, Math.min(1.52, sph.phi - dy * 0.005));
  off.setFromSpherical(sph);
  activeCam.position.copy(controls.target).add(off);
  activeCam.lookAt(controls.target);
}

// 左键拖拽空白处 → 平移画布(camera + controls.target 沿屏幕 XY 一起移动)
// Shift+左键拖空白 → 框选(沿用 marquee 状态)
const _panSpeed = 0.0045; // 屏幕像素 → 世界单位的经验系数
const _panFwd = new THREE.Vector3();
const _panRight = new THREE.Vector3();
const _panOffset = new THREE.Vector3();
function _panBy(dx, dy) {
  activeCam.getWorldDirection(_panFwd);
  _panFwd.y = 0; if (_panFwd.lengthSq() < 1e-6) return; _panFwd.normalize();
  _panRight.crossVectors(_panFwd, activeCam.up).normalize();
  _panOffset.set(0, 0, 0);
  _panOffset.addScaledVector(_panRight, -dx * _panSpeed);
  _panOffset.addScaledVector(_panFwd, dy * _panSpeed);
  controls.target.add(_panOffset);
  activeCam.position.add(_panOffset);
  controls.update();
}

// ── 框选 ────────────────────────────────────────────────────
const marqueeEl = document.getElementById('marquee');
const MARQUEE_MIN_PX = 3;      // 位移阈值：小于它算点击，不算框选

function _marqueeRect() {
  if (!marquee) return null;
  const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
  const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
  return { x0, y0, x1, y1 };
}
function _marqueeUpdate() {
  if (!marqueeEl || !marquee) return;
  const r = renderer.domElement.getBoundingClientRect();
  const m = _marqueeRect();
  marqueeEl.hidden = false;
  marqueeEl.style.left = (m.x0 - r.left) + 'px';
  marqueeEl.style.top = (m.y0 - r.top) + 'px';
  marqueeEl.style.width = (m.x1 - m.x0) + 'px';
  marqueeEl.style.height = (m.y1 - m.y0) + 'px';
}
function _marqueeHide() {
  if (marqueeEl) marqueeEl.hidden = true;
}
// 对象在屏幕上的包围盒（世界坐标角点 → project → 屏幕 AABB）
function _screenAABB(pts) {
  const r = renderer.domElement.getBoundingClientRect();
  let x0 = +Infinity, y0 = +Infinity, x1 = -Infinity, y1 = -Infinity;
  const v = new THREE.Vector3();
  for (const [wx, wz] of pts) {
    v.set(wx, 0, wz).project(activeCam);
    const sx = r.left + (v.x * 0.5 + 0.5) * r.width;
    const sy = r.top + (-v.y * 0.5 + 0.5) * r.height;
    if (sx < x0) x0 = sx; if (sx > x1) x1 = sx;
    if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
  }
  return { x0, y0, x1, y1 };
}
// 框选命中：屏幕 AABB 与框选矩形相交即选中（CAD 常用的宽松判定）
function _marqueeHits(m) {
  if (!m) return [];
  const hit = [];
  const inter = (b) => !(b.x1 < m.x0 || b.x0 > m.x1 || b.y1 < m.y0 || b.y0 > m.y1);
  (doc.walls || []).forEach((w, wi) => {
    if (!inter(_screenAABB([[w.ax - CX, w.az - CZ], [w.bx - CX, w.bz - CZ]]))) return;
    hit.push({ kind: 'wall', wi });
  });
  (doc.floors || []).forEach((f, fi) => {
    const xs = [f.x1, f.x2], zs = [f.z1, f.z2];
    const pts = [[xs[0] - CX, zs[0] - CZ], [xs[1] - CX, zs[0] - CZ],
                 [xs[1] - CX, zs[1] - CZ], [xs[0] - CX, zs[1] - CZ]];
    if (!inter(_screenAABB(pts))) return;
    hit.push({ kind: 'floor', fi });
  });
  (doc.furniture || []).forEach((f, fi) => {
    const def = FURN[f.type]; if (!def) return;
    const sc = (def.scale || 1) * (f.scale != null ? f.scale : 1);
    const hw = (def.w * sc) / 2, hd = (def.d * sc) / 2;
    const pts = [[f.x - hw - CX, f.z - hd - CZ], [f.x + hw - CX, f.z - hd - CZ],
                 [f.x + hw - CX, f.z + hd - CZ], [f.x - hw - CX, f.z + hd - CZ]];
    if (!inter(_screenAABB(pts))) return;
    hit.push({ kind: 'furniture', fi });
  });
  return hit;
}
function _marqueeFinish() {
  const m = _marqueeRect();
  const moved = marquee && (Math.abs(marquee.x1 - marquee.x0) > MARQUEE_MIN_PX
                         || Math.abs(marquee.y1 - marquee.y0) > MARQUEE_MIN_PX);
  const add = marquee && marquee.add;
  marquee = null;
  _marqueeHide();
  if (!moved) {
    // 视作空白处点击：默认清空选择，Shift 保持
    if (!add) { sel = null; rebuild(); refreshProps(); }
    return;
  }
  const hits = _marqueeHits(m);
  _setSelItems(add ? [..._selList(), ...hits] : hits);
  rebuild(); refreshProps();
  if (hits.length) flash(`已选 ${_selList().length} 项`, 'success', 1200);
}

// ── 多选整体拖动 ────────────────────────────────────────────
// 按下时快照原始几何，移动中按同一增量写入，保证相对位置不变。
// 锁定的对象跳过（不参与位移）。
function _batchSnapshot() {
  const out = [];
  for (const s of _selList()) {
    if (s.kind === 'wall') {
      const w = doc.walls[s.wi]; if (!w || w.locked) continue;
      out.push({ kind: 'wall', i: s.wi, ax: w.ax, az: w.az, bx: w.bx, bz: w.bz });
    } else if (s.kind === 'floor') {
      const f = doc.floors[s.fi]; if (!f || f.locked || floorLocked) continue;
      out.push({ kind: 'floor', i: s.fi, x1: f.x1, z1: f.z1, x2: f.x2, z2: f.z2, strips: f.strips || null });
    } else if (s.kind === 'furniture') {
      const f = doc.furniture[s.fi]; if (!f || f.locked) continue;
      out.push({ kind: 'furniture', i: s.fi, x: f.x, z: f.z });
    }
    // 门窗是墙的子级，跟随墙一起移动，不单独快照
  }
  return out;
}
function _batchApply(snap, dx, dz) {
  for (const s of snap) {
    if (s.kind === 'wall') {
      const w = doc.walls[s.i]; if (!w) continue;
      w.ax = s.ax + dx; w.az = s.az + dz; w.bx = s.bx + dx; w.bz = s.bz + dz;
    } else if (s.kind === 'floor') {
      const f = doc.floors[s.i]; if (!f) continue;
      f.x1 = s.x1 + dx; f.z1 = s.z1 + dz; f.x2 = s.x2 + dx; f.z2 = s.z2 + dz;
      // strips 格式 [za, zb, xa, xb]：dz 作用在 z 段，dx 作用在 x 段
      if (s.strips) f.strips = s.strips.map(([za, zb, xa, xb]) => [za + dz, zb + dz, xa + dx, xb + dx]);
    } else if (s.kind === 'furniture') {
      const f = doc.furniture[s.i]; if (!f) continue;
      f.x = s.x + dx; f.z = s.z + dz;
    }
  }
}

renderer.domElement.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  _pokeInteract();
  downXY = [e.clientX, e.clientY];

  // 移动模式:左键按下即平移画布,不做任何拾取/选中(抓手工具)
  if (tool === 'pan') {
    lPan = { x: e.clientX, y: e.clientY };
    renderer.domElement.style.cursor = 'grabbing';
    return;
  }

  // 必须在 select 工具分支之前声明 —— wall / floor / furn 工具分支(4306+)
  // 也要用 p(x,z),而它们在 select 的 { } 块外;若在块内 const,会 ReferenceError。
  // 注意:此处不能 `if (!p) return`,否则 select 工具在刁钻视角(地面射线无交点)
  // 下连空白平移都触发不了;改在每个用 p 的工具分支内单独守卫。
  const p = groundPoint(e);

  // select 工具:空白处按下 = 平移(Shift = 框选);命中构件走 pickAt
  if (tool === 'select') {
    const pk = pickAt(e);
    if (!pk) {
      if (e.shiftKey) {
        marquee = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, add: true };
      } else {
        lPan = { x: e.clientX, y: e.clientY };
        renderer.domElement.style.cursor = 'grabbing';
      }
      return;
    }
    // 命中构件:下面要用 p,这里守卫一下
    if (!p) return;
    const { hit, kind } = pk;
    if (kind === 'end') {
      // 拖墙端点:墙体锁定则禁止
      const wl = doc.walls[hit.wi];
      if (wl && wl.locked) {
        sel = { kind: 'wall', wi: hit.wi };
        rebuild(); refreshProps();
        flash('墙已锁定：禁止移动端点', 'warn', 1500);
        return;
      }
      pushUndo();
      // 缓存原始端点;拖拽中只更新预览 ghost,松开再写回 + 一次 rebuild
      drag = { mode: 'end', wi: hit.wi, end: hit.end, ax: wl.ax, az: wl.az, bx: wl.bx, bz: wl.bz };
    } else {
      const item = hit.kind === 'wall' ? { kind: 'wall', wi: hit.wi }
                 : hit.kind === 'floor' ? { kind: 'floor', fi: hit.fi }
                 : hit.kind === 'furniture' ? { kind: 'furniture', fi: hit.fi }
                 : { kind: hit.kind, wi: hit.wi, oi: hit.oi };

      // Shift 点击：加入 / 移出多选集合，不进入拖动
      if (e.shiftKey) {
        _selToggle(item);
        rebuild(); refreshProps();
        return;
      }

      // 点在已选中的对象上（且当前是多选）→ 保持集合，整体拖动
      const alreadySel = _selList().some(s => _selKey(s) === _selKey(item));
      if (alreadySel && _selList().length > 1) {
        const snap = _batchSnapshot();
        if (snap.length) { pushUndo(); drag = { mode: 'multi', ox: p.x, oz: p.z, items: snap }; }
        rebuild(); refreshProps();
        return;
      }

      // 普通点击：分组对象展开成整组
      const expanded = _expandGroupSel(item);
      _setSelItems(expanded);
      if (expanded.length > 1) {
        const snap = _batchSnapshot();
        if (snap.length) { pushUndo(); drag = { mode: 'multi', ox: p.x, oz: p.z, items: snap }; }
        rebuild(); refreshProps();
        return;
      }

      // 单对象：沿用原有拖动逻辑
      if (hit.kind === 'wall') {
        const wl = doc.walls[hit.wi];
        if (wl && wl.locked) {
          rebuild(); refreshProps();
          flash('墙已锁定：禁止移动', 'warn', 1500);
          return;
        }
        pushUndo();
        drag = { mode: 'move', wi: hit.wi, ox: p.x, oz: p.z, ax: wl.ax, az: wl.az, bx: wl.bx, bz: wl.bz };
        rebuild(); refreshProps();
      } else if (hit.kind === 'floor') {
        const fl = doc.floors[hit.fi];
        if (fl && fl.locked) {
          flash('地面已锁定：禁止移动', 'warn', 1800);
          rebuild(); refreshProps();
          return;
        }
        pushUndo();
        drag = { mode: 'floor', fi: hit.fi, ox: p.x, oz: p.z, x1: fl.x1, z1: fl.z1, x2: fl.x2, z2: fl.z2 };
        rebuild(); refreshProps();
      } else if (hit.kind === 'furniture') {
        const f = doc.furniture[hit.fi];
        if (f && f.locked) {
          flash('家具已锁定：禁止移动', 'warn', 1500);
          rebuild(); refreshProps();
          return;
        }
        pushUndo();
        drag = { mode: 'furn', fi: hit.fi, ox: p.x, oz: p.z, x0: f.x, z0: f.z };
        rebuild(); refreshProps();
      } else if (hit.kind === 'stairs') {
        const s = doc.stairs[hit.si];
        pushUndo();
        drag = { mode: 'stair', si: hit.si, ox: p.x, oz: p.z, x0: s.x, z0: s.z };
        rebuild(); refreshProps();
      } else if (hit.kind === 'door' || hit.kind === 'window') {
        // opening(门/窗):沿所在墙拖动 t,松手写回
        pushUndo();
        drag = { mode: 'open', wi: hit.wi, oi: hit.oi, ot: doc.walls[hit.wi].openings[hit.oi].t };
        rebuild(); refreshProps();
      }
    }
    return;
  }
  if (tool === 'wall') {
    // 画墙：鼠标第一击 = 起点,后续每击推一段墙（链式,直到 Esc/Enter/双击结束）
    // (单段 / 围房模式由 wallMode 决定是否一次成段;此分支统一走链式,Esc 收尾)
    if (!p) return;
    if (!chain) {
      chain = { x: snapV(p.x), z: snapV(p.z) };
      chainPts = [chain];
      lastGround = p;
      flash('链式画墙起点已定：移动鼠标 + 左键推一段墙 · Esc 结束');
      return;
    }
    // 已有 chain 起点 → 这一击为终点,推墙(围房模式吸回起点闭合时生成多边形地面)
    const q = chainNextPoint(p);
    _wallChainAdvance(q);
    lastGround = p;
    rebuild(); refreshProps();
    return;
  }
  if (tool === 'door' || tool === 'window') {
    // 第一步：点选目标墙；第二步：沿该墙吸附放置
    // (door/window 共用同一选择墙流程,放在分支内 mkDoor/mkWin 区分)
    if (placeWall == null || !doc.walls[placeWall]) {
      const pk = pickAt(e);
      if (!pk || pk.hit.kind !== 'wall') return flash('第一步：先左键点选一面墙');
      placeWall = pk.hit.wi; hoverWi = null; clearGhost();
      flash(`已选墙 #${placeWall + 1}：沿墙移动吸附，左键放置；Esc 重选墙`);
      rebuild();
      return;
    }
    const w = doc.walls[placeWall];
    if (!p) return;
    const t = ghost ? ghost._t : projOnWall(w, p);
    if (t == null) return flash('这面墙放不下此尺寸');
    const wdx = w.bx - w.ax, wdz = w.bz - w.az;
    const wL = Math.hypot(wdx, wdz) || 1;
    // 把手朝向放置者：相机在墙的哪一侧，把手就在那一侧
    const camSide = ((camera.position.x + CX - (w.ax + t * wdx)) * -(wdz / wL)
                   + (camera.position.z + CZ - (w.az + t * wdz)) * (wdx / wL)) >= 0 ? 1 : -1;
    pushUndo();
    const op = tool === 'door' ? mkDoor(t, 0.8, { kind: 'single', flip: camSide === -1 }) : mkWin(t, 0.9);
    doc.walls[placeWall].openings.push(op);
    sel = { kind: tool, wi: placeWall, oi: doc.walls[placeWall].openings.length - 1 };
    clearGhost();   // 放置后收起绿色预览，避免叠在刚放好的门窗上
    rebuild(); refreshProps();
    return;
  }
  if (tool === 'floor') {
    if (!p) return;
    if (!floorA) {
      let s0 = { x: snapV(p.x), z: snapV(p.z) };
      const ep = snapToEndpoints(s0, 0.18, null, null);
      if (ep) s0 = { x: ep.x, z: ep.z };
      floorA = s0;
    } else {
      let q = { x: snapV(p.x), z: snapV(p.z) };
      const ep = snapToEndpoints(q, 0.18, null, null);
      if (ep) q = { x: ep.x, z: ep.z };
      if (Math.abs(q.x - floorA.x) < 0.05 || Math.abs(q.z - floorA.z) < 0.05) return flash('地面太小');
      pushUndo();
      doc.floors.push({
        x1: Math.min(floorA.x, q.x), z1: Math.min(floorA.z, q.z),
        x2: Math.max(floorA.x, q.x), z2: Math.max(floorA.z, q.z),
        th: 0.05, color: themeCur().floor.color, tex: themeCur().floor.tex || undefined, lv: activeLv,
      });
      sel = { kind: 'floor', fi: doc.floors.length - 1 };
      floorA = null; clearFloorPreview();
      rebuild(); refreshProps();
    }
    return;
  }
  if (tool === 'furn') {
    if (!furnType) return flash('先在右侧家具库中选择一件家具');
    if (!p) return;
    let nx = snapV(p.x), nz = snapV(p.z);
    const def = FURN[furnType];

    pushUndo();
    doc.furniture.push({ type: furnType, x: nx, z: nz, rot: furnRot, lv: activeLv });
    // 不自动选中新放置的家具: 用户连续放置同一类家具时,左侧家具库面板保持可见,
    // 想编辑已放置家具时再点击它即可。
    rebuild(); refreshProps();
    return;
  }
  if (tool === 'stairs') {
    if (!p) return;
    // 楼梯家具选中 → 作为家具放置(与家具工具同规则:网格吸附 + 贴墙吸附)
    if (stairFurn) {
      let nx = snapV(p.x), nz = snapV(p.z);
      const def = FURN[stairFurn];

      pushUndo();
      doc.furniture.push({ type: stairFurn, x: nx, z: nz, rot: furnRot, lv: activeLv });
      clearGhost();   // 收虚影,可连续放置
      rebuild(); refreshProps();
      return;
    }
    let nx = snapV(p.x), nz = snapV(p.z);
    pushUndo();
    doc.stairs.push({
      type: stairType, x: nx, z: nz, rot: 0,
      width: stairType === 'spiral' ? 1.4 : 0.9,
      depth: 3.0, height: activeLv === 1 ? doc.wallH : 2.8,
      steps: Math.round((activeLv === 1 ? doc.wallH : 2.8) / 0.18),
      lv: 0,
    });
    sel = { kind: 'stairs', si: doc.stairs.length - 1 };
    rebuild(); refreshProps();
    return;
  }
  if (tool === 'delete') {
    const pk = pickAt(e);
    if (!pk) return;   // 空白处：旋转视角已改为右键拖动
    pushUndo();
    if (pk.kind === 'end' || pk.hit.kind === 'wall') {
      doc.walls.splice(pk.hit.wi, 1); sel = null;
    } else if (pk.hit.kind === 'floor') {
      doc.floors.splice(pk.hit.fi, 1); sel = null;
    } else if (pk.hit.kind === 'furniture') {
      doc.furniture.splice(pk.hit.fi, 1); sel = null;
    } else if (pk.hit.kind === 'stairs') {
      doc.stairs.splice(pk.hit.si, 1); sel = null;
    } else if (pk.hit.kind === 'door' || pk.hit.kind === 'window') {
      doc.walls[pk.hit.wi].openings.splice(pk.hit.oi, 1); sel = null;
    }
    rebuild(); refreshProps(); flash('已删除');
    return;
  }
  // (select 工具的空白处按下已在 line 3615 处理为 lPan / marquee;此处仅剩命中构件的拖动)
  if (tool === 'select') {
    const pk = pickAt(e);
    if (!pk) return;
    const { hit, kind } = pk;
    if (kind === 'end') {
      // 拖墙端点:墙体锁定则禁止
      const wl = doc.walls[hit.wi];
      if (wl && wl.locked) {
        sel = { kind: 'wall', wi: hit.wi };
        rebuild(); refreshProps();
        flash('墙已锁定：禁止移动端点', 'warn', 1500);
        return;
      }
      pushUndo();
      // 缓存原始端点;拖拽中只更新预览 ghost,松开再写回 + 一次 rebuild
      drag = { mode: 'end', wi: hit.wi, end: hit.end, ax: wl.ax, az: wl.az, bx: wl.bx, bz: wl.bz };
    } else {
      const item = hit.kind === 'wall' ? { kind: 'wall', wi: hit.wi }
                 : hit.kind === 'floor' ? { kind: 'floor', fi: hit.fi }
                 : hit.kind === 'furniture' ? { kind: 'furniture', fi: hit.fi }
                 : { kind: hit.kind, wi: hit.wi, oi: hit.oi };

      // Shift 点击：加入 / 移出多选集合，不进入拖动
      if (e.shiftKey) {
        _selToggle(item);
        rebuild(); refreshProps();
        return;
      }

      // 点在已选中的对象上（且当前是多选）→ 保持集合，整体拖动
      const alreadySel = _selList().some(s => _selKey(s) === _selKey(item));
      if (alreadySel && _selList().length > 1) {
        const snap = _batchSnapshot();
        if (snap.length) { pushUndo(); drag = { mode: 'multi', ox: p.x, oz: p.z, items: snap }; }
        rebuild(); refreshProps();
        return;
      }

      // 普通点击：分组对象展开成整组
      const expanded = _expandGroupSel(item);
      _setSelItems(expanded);
      if (expanded.length > 1) {
        const snap = _batchSnapshot();
        if (snap.length) { pushUndo(); drag = { mode: 'multi', ox: p.x, oz: p.z, items: snap }; }
        rebuild(); refreshProps();
        return;
      }

      // 单对象：沿用原有拖动逻辑
      if (hit.kind === 'wall') {
        const wl = doc.walls[hit.wi];
        if (wl && wl.locked) {
          rebuild(); refreshProps();
          flash('墙已锁定：禁止移动', 'warn', 1500);
          return;
        }
        pushUndo();
        drag = { mode: 'move', wi: hit.wi, ox: p.x, oz: p.z, ax: wl.ax, az: wl.az, bx: wl.bx, bz: wl.bz };
        rebuild(); refreshProps();
      } else if (hit.kind === 'floor') {
        const fl = doc.floors[hit.fi];
        if (floorLocked || (fl && fl.locked)) {
          // 锁定状态下仅选中、保留 inspector 可改尺寸/材质/层级，但不进入拖动
          flash('地面已锁定：禁止移动', 'warn', 1800);
          rebuild(); refreshProps();
          return;
        }
        pushUndo();
        drag = { mode: 'floor', fi: hit.fi, ox: p.x, oz: p.z, x1: fl.x1, z1: fl.z1, x2: fl.x2, z2: fl.z2 };
        rebuild(); refreshProps();
      } else if (hit.kind === 'furniture') {
        const f = doc.furniture[hit.fi];
        if (f && f.locked) {
          rebuild(); refreshProps();
          flash('家具已锁定：禁止移动', 'warn', 1500);
          return;
        }
        pushUndo();
        drag = { mode: 'furn', fi: hit.fi, ox: p.x, oz: p.z, x0: f.x, z0: f.z };
        rebuild(); refreshProps();
      } else {
        pushUndo();
        // 缓存原始 t 值;拖拽中只更新预览 box,松开再写回 + 一次 rebuild
        drag = { mode: 'open', wi: hit.wi, oi: hit.oi, ot: doc.walls[hit.wi].openings[hit.oi].t };
        rebuild(); refreshProps();
      }
    }
  }
});

renderer.domElement.addEventListener('pointermove', e => {
  _pokeInteract();    // 静止帧跳过 render:鼠标在画面上移动 → 持续渲染
  const p = groundPoint(e);
  // 坐标文字 ~60ms 节流:避免每像素触发 layout/paint
  if (p && performance.now() - _coordsAt > 60) {
    coordsEl.textContent = `x ${p.x.toFixed(2)}  z ${p.z.toFixed(2)} m`;
    _coordsAt = performance.now();
  }

  // ── 吸附提示：在 mousemove 时按工具类型检测最近吸附点并显示高亮圆 ──
  if (p && (tool === 'wall' || tool === 'floor' || tool === 'furn')) {
    let dotKind = null, dotPt = null;
    // 1) 端点吸附（半径 0.18m）
    const ep = snapToEndpoints({ x: snapV(p.x), z: snapV(p.z) }, 0.18, null, null);
    if (ep) { dotKind = 'end'; dotPt = ep; }
    // 2) 网格吸附点（吸附前先看是不是单纯 snap 到网格）
    if (!dotKind && (Math.abs(p.x - snapV(p.x)) < 0.01 || Math.abs(p.z - snapV(p.z)) < 0.01)) {
      dotKind = 'grid'; dotPt = { x: snapV(p.x), z: snapV(p.z) };
    }
    // 3) 画墙正交高亮:正交生效时显示 axis/45° 高亮,Shift 临时放开时只显示端点/网格
    if (!dotKind && tool === 'wall' && chain) {
      const dx = p.x - chain.x, dz = p.z - chain.z;
      const useOrtho = (orthoLock && !e.shiftKey);
      if (useOrtho && Math.abs(dx) >= 0.05 && Math.abs(dz) >= 0.05) {
        const ax = Math.abs(dx) >= Math.abs(dz);
        const q = ax ? { x: snapV(p.x), z: chain.z } : { x: chain.x, z: snapV(p.z) };
        if ((ax && Math.abs(dz) < 0.05) || (!ax && Math.abs(dx) < 0.05)) {
          dotKind = 'axis'; dotPt = q;
        }
        // 45° 角吸附
        const r = Math.abs(Math.abs(dx / dz) - 1);
        if (r < 0.04 && Math.hypot(dx, dz) > 0.1) { dotKind = '45'; dotPt = q; }
      }
    }
    if (dotKind && dotPt) {
      const v = new THREE.Vector3(dotPt.x, 0.02, dotPt.z);
      v.project(activeCam);
      const r = renderer.domElement.getBoundingClientRect();
      const sx = r.left + (v.x * 0.5 + 0.5) * r.width;
      const sy = r.top + (-v.y * 0.5 + 0.5) * r.height;
      if (v.z < 1) showSnapDot(dotKind, sx, sy);
      else hideSnapDot();
    } else hideSnapDot();
  } else hideSnapDot();

// 右键拖动 → 旋转视角
  if (rOrbit && (e.buttons & 2)) {
    const dx = e.clientX - rOrbit.x, dy = e.clientY - rOrbit.y;
    rOrbit.x = e.clientX; rOrbit.y = e.clientY;
    _orbitBy(dx, dy);
    return;
  }
  // 左键拖空白处 → 平移画布
  if (lPan && (e.buttons & 1)) {
    const dx = e.clientX - lPan.x, dy = e.clientY - lPan.y;
    lPan.x = e.clientX; lPan.y = e.clientY;
    _panBy(dx, dy);
    return;
  }
  // 左键拖空白处 → 框选
  if (marquee && (e.buttons & 1)) {
    marquee.x1 = e.clientX; marquee.y1 = e.clientY;
    _marqueeUpdate();
    return;
  }

  if (tool === 'wall' && chain && p) {
    const q = chainNextPoint(p);
    updatePreview(chain, q);
    const len = Math.hypot(q.x - chain.x, q.z - chain.z);
    dimLabel.style.display = 'block';
    dimLabel.style.left = e.clientX - renderer.domElement.getBoundingClientRect().left + 'px';
    dimLabel.style.top = e.clientY - renderer.domElement.getBoundingClientRect().top + 'px';
    dimLabel.textContent = (typedLen ? `输入 ${typedLen}` : '') + `  L = ${len.toFixed(2)} m`;
  }
  if (tool === 'floor' && floorA && p) {
    let q = { x: snapV(p.x), z: snapV(p.z) };
    const ep = snapToEndpoints(q, 0.18, null, null);
    if (ep) q = { x: ep.x, z: ep.z };
    updateFloorPreview(floorA, q);
    dimLabel.style.display = 'block';
    dimLabel.style.left = e.clientX - renderer.domElement.getBoundingClientRect().left + 'px';
    dimLabel.style.top = e.clientY - renderer.domElement.getBoundingClientRect().top + 'px';
    dimLabel.textContent = `地面 ${Math.abs(q.x - floorA.x).toFixed(2)} × ${Math.abs(q.z - floorA.z).toFixed(2)} m`;
  }
  if (tool === 'furn' && furnType && p && !orbit) {
    let sp = { x: snapV(p.x), z: snapV(p.z) };
    updateFurnGhost(sp);
  }
  if (tool === 'stairs' && stairFurn && p && !orbit) {
    let sp = { x: snapV(p.x), z: snapV(p.z) };
    updateFurnGhost(sp, stairFurn);
  }

  if (tool === 'select' && drag && drag.mode === 'floor' && p) {
    const fl = doc.floors[drag.fi];
    const dx = snapV(p.x - drag.ox), dz = snapV(p.z - drag.oz);
    fl.x1 = drag.x1 + dx; fl.x2 = drag.x2 + dx;
    fl.z1 = drag.z1 + dz; fl.z2 = drag.z2 + dz;
    // 增量更新（仅矩形地面，几何在本地坐标，可直接搬 mesh）
    const fm = floorMeshes[drag.fi];
    if (fm && !fl.strips) {
      const cx = (fl.x1 + fl.x2) / 2, cz = (fl.z1 + fl.z2) / 2;
      fm.position.x = cx; fm.position.z = cz;
      drag.pendingRebuild = false;
    } else {
      // strips 合并地面：geometry 在世界坐标，必须重建（罕见路径）
      if (fl.strips) fl.strips = fl.strips.map(([za, zb, xa, xb]) => [za + dz, zb + dz, xa + dx, xb + dx]);
      drag.pendingRebuild = true; rebuild();
    }
  }
  if (tool === 'select' && drag && drag.mode === 'furn' && p) {
    const f = doc.furniture[drag.fi];
    const def = FURN[f.type];
    let nx = snapV(drag.x0 + p.x - drag.ox);
    let nz = snapV(drag.z0 + p.z - drag.oz);

    f.x = nx; f.z = nz;
    // 增量更新：直接搬家具 Group，0 重建
    const fg = furnitureGroups[drag.fi];
    if (fg) {
      if (fg.__instanced) {
        // 重写该 instance 的 matrix(只动 pos;rot/sc 不变)
        // 注意槽位是「同类型内的序号」(fg.slot),不等于全局 fi;并丢弃缓存包围球
        const proto = furnProto[fg.type];
        const instArr = furnInstanced[fg.type];
        const slot = fg.slot ?? drag.fi;
        _furnDummy.position.set(f.x, fg.y, f.z);
        _furnDummy.rotation.set(0, fg.rot, 0);
        _furnDummy.scale.set(fg.sc, fg.sc, fg.sc);
        _furnDummy.updateMatrix();
        for (let pi = 0; pi < proto.parts.length; pi++) {
          _furnMat.multiplyMatrices(_furnDummy.matrix, proto.parts[pi].localMatrix);
          instArr[pi].setMatrixAt(slot, _furnMat);
          instArr[pi].instanceMatrix.needsUpdate = true;
          instArr[pi].boundingSphere = null;
        }
        fg.x = f.x; fg.z = f.z;
      } else {
        fg.position.x = f.x;
        fg.position.z = f.z;
      }
    }
    drag.pendingRebuild = false;
  }
  if (tool === 'select' && drag && drag.mode === 'stair' && p) {
    const s = doc.stairs[drag.si];
    s.x = snapV(drag.x0 + p.x - drag.ox);
    s.z = snapV(drag.z0 + p.z - drag.oz);
    const sg = stairGroups[drag.si];
    if (sg) { sg.position.x = s.x; sg.position.z = s.z; }
    drag.pendingRebuild = false;
  }
  // 多选 / 分组整体拖动：所有成员按同一增量平移，保持相对位置
  if (tool === 'select' && drag && drag.mode === 'multi' && p) {
    const dx = snapV(p.x - drag.ox), dz = snapV(p.z - drag.oz);
    // 拖拽中不写回 doc / rebuild；用预览 ghost 跟手,松开再 batchApply + 一次 rebuild
    _updateDragPreview('multi', drag, { dx, dz });
    drag.pendingRebuild = true;
  }

  if (tool === 'door' || tool === 'window') {
    if (placeWall == null || !doc.walls[placeWall]) {
      // 未选墙：悬停高亮可点选的墙
      const near = p ? nearestWall(p, 0.5) : null;
      const hwi = near ? near.wi : null;
      if (hwi !== hoverWi) { hoverWi = hwi; rebuild(); }
      clearGhost();
    } else {
      // 已选墙：门窗预览沿该墙滑动，严格平行
      hoverWi = null;
      updateGhostOnWall(p);
    }
  }

  if (tool === 'select' && drag && p) {
    const w = doc.walls[drag.wi];
    if (drag.mode === 'end') {
      let q = { x: snapV(p.x), z: snapV(p.z) };
      const ep = snapToEndpoints(q, 0.15, drag.wi, drag.end);
      if (ep) q = { x: ep.x, z: ep.z };
      // 端点拖动：不再立即写回 doc / rebuild；用预览 ghost 跟手,松开再写回
      _updateDragPreview('end', drag, q);
      needProps = true; drag.pendingRebuild = true;
    } else if (drag.mode === 'move') {
      const dx = snapV(p.x - drag.ox), dz = snapV(p.z - drag.oz);
      w.ax = drag.ax + dx; w.az = drag.az + dz;
      w.bx = drag.bx + dx; w.bz = drag.bz + dz;
      // 增量更新：整体平移 wall Group（geometry 在本地坐标，不需重建）
      const wg = wallGroups[drag.wi];
      if (wg) {
        wg.position.x = w.ax;
        wg.position.z = w.az;
      }
      needProps = true; drag.pendingRebuild = false;
    } else if (drag.mode === 'open') {
      // 开洞拖动：默认沿原墙滑动;鼠标靠近其他墙 0.4m 内 → 重新吸附到最近墙
      const SNAP_REATTACH = 0.4;
      const origDx = w.bx - w.ax, origDz = w.bz - w.az;
      const L2 = origDx * origDx + origDz * origDz;
      let t = ((p.x - w.ax) * origDx + (p.z - w.az) * origDz) / L2;
      t = Math.max(0.05, Math.min(0.95, t));
      let targetWi = drag.wi;
      // 找最近的墙(排除自身): 距离 ≤ 0.4m 且新 t 在 [0.05, 0.95] 内
      const near = nearestWall(p, SNAP_REATTACH);
      if (near && near.wi !== drag.wi) {
        targetWi = near.wi;
        t = near.t;
      }
      // 开洞拖动：不再立即写回 doc / rebuild；用预览 box 跟手,松开再写回
      _updateDragPreview('open', drag, { t, targetWi });
      needProps = true; drag.pendingRebuild = true;
    }
  }
});

function snapToEndpoints(p, tol, exclWi, exclEnd) {
  let best = null;
  doc.walls.forEach((w, wi) => {
    [[w.ax, w.az, 0], [w.bx, w.bz, 1]].forEach(([x, z, end]) => {
      if (wi === exclWi && end === exclEnd) return;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d <= tol && (!best || d < best.d)) best = { x, z, d };
    });
  });
  return best;
}
function chainNextPoint(p) {
  let q;
  if (typedLen) {
    const len = parseFloat(typedLen);
    if (len > 0) {
      let dx = p.x - chain.x, dz = p.z - chain.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.01) { dx = 1; dz = 0; }
      q = { x: chain.x + dx / d * len, z: chain.z + dz / d * len };
    }
  }
  if (!q) {
    // 默认正交(锁水平/垂直);按 Shift 临时放开,允许斜着画
    if (orthoLock && !shiftDown) {
      const dx = p.x - chain.x, dz = p.z - chain.z;
      q = Math.abs(dx) >= Math.abs(dz)
        ? { x: snapV(p.x), z: chain.z }
        : { x: chain.x, z: snapV(p.z) };
    } else {
      // Shift 或正交关闭时:自由角度,鼠标方向为准,长度做网格吸附
      const dx = p.x - chain.x, dz = p.z - chain.z;
      q = { x: chain.x + snapV(dx), z: chain.z + snapV(dz) };
    }
  }
  const ep = snapToEndpoints(q, 0.18, null, null);   // 墙角自动吸附合并
  return ep ? { x: ep.x, z: ep.z } : q;
}

// 链式推一段墙到 q(统一 pushUndo)。围房(room)模式下若 q 吸回链起点(环路闭合,
// 至少 3 段),用 floorFromPolygon 按环路多边形生成贴合轮廓的地面并结束链;
// 单段/链式模式闭合只结束语义不变,不自动生成地面。
function _wallChainAdvance(q) {
  const start = chainPts[0];
  const canClose = start && chainPts.length >= 3;
  if (canClose && Math.hypot(q.x - start.x, q.z - start.z) < 0.18) q = { x: start.x, z: start.z };
  pushUndo();
  doc.walls.push(mkWall(chain.x, chain.z, q.x, q.z));
  chainPts.push(q);
  chain = { x: q.x, z: q.z };
  if (canClose && wallMode === 'room' && q.x === start.x && q.z === start.z) {
    const poly = chainPts.slice(0, -1);                 // 尾点与起点重合,去掉
    if (poly.length >= 3) {
      const f = floorFromPolygon(poly, activeLv);
      const area = (f.strips || []).reduce((s, st) => s + (st[1] - st[0]) * (st[3] - st[2]), 0);
      if (f.strips && f.strips.length) doc.floors.push(f);
      flash(area > 0.05 ? `围房已闭合：已按多边形生成地面 ${area.toFixed(1)} ㎡` : '围房已闭合（区域太小，未生成地面）', 'success', 2800);
    }
    chain = null; chainPts = []; typedLen = ''; clearPreview();
  }
}
let shiftDown = false;
addEventListener('keydown', e => { if (e.key === 'Shift') shiftDown = true; });
// 方向键微移（先于主 keydown 处理：避免被 F4 等吞掉；只在 select 工具下生效）
addEventListener('keydown', e => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (tool !== 'select' || !sel) return;
  const step = shiftDown ? 0.5 : 0.05;
  let dx = 0, dz = 0;
  if (e.key === 'ArrowLeft')  dx = -step;
  else if (e.key === 'ArrowRight') dx = +step;
  else if (e.key === 'ArrowUp')    dz = -step;
  else if (e.key === 'ArrowDown')  dz = +step;
  else return;
  e.preventDefault();
  if (nudgeSelected(dx, dz, e.altKey)) flash(`微移 ${dx ? 'X' : 'Z'} ${(dx || dz).toFixed(2)}m`);
});
addEventListener('keyup', e => { if (e.key === 'Shift') shiftDown = false; });
// WASD 松开: 移出按下集合;若仍在减速中,继续 RAF 帧让速度衰减到 0
addEventListener('keyup', e => {
  const kl = (e.key || '').toLowerCase();
  if (_camKeys.has(kl)) {
    _camPressed.delete(kl);
    if (_camFrameId == null && Math.hypot(_camVel.x, _camVel.z) > 0.01) _camStart();
  }
});

// 画墙预览
let previewMesh = null;
function updatePreview(a, b) {
  if (!previewMesh) {
    previewMesh = new THREE.Mesh(box(1, 0.02, 1), M.preview);
    scene.add(previewMesh);
  }
  const dx = b.x - a.x, dz = b.z - a.z;
  const L = Math.max(Math.hypot(dx, dz), 0.01);
  previewMesh.scale.set(L, 1, 0.12);
  previewMesh.position.set((a.x + b.x) / 2 - CX, 0.02, (a.z + b.z) / 2 - CZ);
  previewMesh.rotation.y = -Math.atan2(dz, dx);
}
function clearPreview() {
  if (previewMesh) { previewMesh.geometry.dispose(); scene.remove(previewMesh); previewMesh = null; }
  dimLabel.style.display = 'none';
}

renderer.domElement.addEventListener('pointercancel', e => {
  if (rOrbit) {
    rOrbit = null;
    renderer.domElement.style.cursor = _toolCursor();
  }
  if (lPan) {
    lPan = null;
    renderer.domElement.style.cursor = _toolCursor();
  }
  if (marquee) _marqueeFinish();
});
renderer.domElement.addEventListener('pointerup', e => {
  if (rOrbit) {
    rOrbit = null;
    // 恢复默认 / 工具光标(由 setTool 设过)
    renderer.domElement.style.cursor = _toolCursor();
  }
  if (lPan) {
    lPan = null;
    renderer.domElement.style.cursor = _toolCursor();
  }
  if (marquee) _marqueeFinish();
  if (orbit) orbit = null;          // 兼容遗留状态
  if (drag) {
    // end / open / multi 模式:把预览对应的 doc 数据一次性写回,清预览,然后走一次 rebuild
    if (drag.mode === 'end' && drag._previewQ) {
      const w = doc.walls[drag.wi]; if (w) {
        if (drag.end === 0) { w.ax = drag._previewQ.x; w.az = drag._previewQ.z; }
        else { w.bx = drag._previewQ.x; w.bz = drag._previewQ.z; }
      }
    } else if (drag.mode === 'open' && drag._previewT != null) {
      // 可能拖到了另一面墙上 → 先把 opening 从原墙搬到目标墙
      const targetWi = (drag._previewTargetWi != null) ? drag._previewTargetWi : drag.wi;
      if (targetWi !== drag.wi) {
        const src = doc.walls[drag.wi];
        const op = src && src.openings[drag.oi];
        if (op) {
          src.openings.splice(drag.oi, 1);
          const dst = doc.walls[targetWi];
          if (dst) {
            op.t = drag._previewT;
            dst.openings.push(op);
            sel = { kind: 'opening', wi: targetWi, oi: dst.openings.length - 1 };
          }
        }
      } else {
        const w = doc.walls[drag.wi]; if (w && w.openings[drag.oi]) {
          w.openings[drag.oi].t = drag._previewT;
        }
      }
    } else if (drag.mode === 'multi' && drag._previewDelta) {
      _batchApply(drag.items, drag._previewDelta.dx, drag._previewDelta.dz);
    }
    drag = null;
    _clearDragPreview();
    // 拖拽结束:无条件恢复阴影自动更新并补一次 bake(拖拽期间被冻结)
    if (renderer && renderer.shadowMap) {
      renderer.shadowMap.autoUpdate = true;
      renderer.shadowMap.needsUpdate = true;
    }
    refreshProps();
    rebuild();
  }
  downXY = null;
});

// ============================================================
// 键盘（Turbo Pascal 式 F 键 + 快捷键）
// ============================================================
addEventListener('keydown', e => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    if (e.key === 'Escape') e.target.blur();
    return;                                   // 属性输入框内不响应编辑器快捷键
  }
  // ── WASD 平滑相机: 3D 视角累积速度,2D 视角步进平移 ──
  const kl = (e.key || '').toLowerCase();
  if (_camKeys.has(kl)) {
    if (_isTextInput(e.target)) return;
    e.preventDefault();
    if (activeCam === camera) {
      // 3D: 加入按下集合,启动 RAF 循环
      _camPressed.add(kl);
      _camStart();
    } else {
      // 2D: 步进式平移(每按一下都走一步)
      _camPan2D(kl);
    }
    return;
  }
  const k = e.key;
  if (k === 'F1') { e.preventDefault(); showHelp(); return; }
  if (k === 'F2') { e.preventDefault(); saveDoc(); return; }
  if (k === 'F3') { e.preventDefault(); loadDoc(); return; }
  if (k === 'F4') { e.preventDefault(); setTool('select'); return; }
  // H = 移动画布(抓手)模式,与 Photoshop 惯例一致;再次按 F4 回选择
  if (kl === 'h' && !_camKeys.has('h')) { e.preventDefault(); setTool('pan'); return; }
  if (k === 'F5') { e.preventDefault(); toggleView(); return; }
  // Shift+ 功能键必须在单独键之前,否则先命中默认工具
  if (k === 'F6') { e.preventDefault(); setTool('wall'); return; }
  if (k === 'F7') { e.preventDefault(); setTool('door'); return; }
  if (k === 'F8') { e.preventDefault(); setTool('window'); return; }
  if (k === 'F9') {
    e.preventDefault();
    // 原"删除工具"按钮已移除:F9 改为删除当前选中对象,行为与 inspector 的 Del 按钮一致
    if (_selList().length > 1) { deleteSelection(); }
    else if (sel) {
      pushUndo();
      ctxDelete(sel);   // 内部已 sel=null / rebuild / refreshProps / flash
    } else {
      flash('先选中要删除的对象', 'warn', 1200);
    }
    return;
  }
  if (k === 'F10') { e.preventDefault(); setTool('furn'); return; }
  if (e.shiftKey && k === 'F11') { e.preventDefault(); setTool('stairs'); return; }
  if (k === 'F11') { e.preventDefault(); setTool('floor'); return; }
  if (k === 'f' || k === 'F') { e.preventDefault(); focusOnSel(); return; }
  if (e.ctrlKey && (k === 'p' || k === 'P')) { e.preventDefault(); openCmd(); return; }
  // Tab：画墙工具内切换 single / chain / room 模式
  if (k === 'Tab' && tool === 'wall') {
    e.preventDefault();
    const i = ['single', 'chain', 'room'].indexOf(wallMode);
    wallMode = ['single', 'chain', 'room'][(i + 1) % 3];
    polyPts = []; chain = null; typedLen = ''; clearPreview();
    setWallModeUI();
    flash(`画墙模式 → ${WALL_MODE_NAMES[wallMode]}`);
    return;
  }
  if (e.ctrlKey && (k === 'z' || k === 'Z')) { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
  // 复制 / 粘贴：复用右键菜单的 ctxDuplicate，但粘贴时偏移 +0.3m 避免重叠
  if (e.ctrlKey && (k === 'c' || k === 'C')) {
    const list = _selList();
    if (list.length > 1) {
      clipboard = {
        kind: 'multi',
        payload: list.map(s => { const o = _objOfSel(s); return o ? { kind: s.kind, obj: JSON.parse(JSON.stringify(o)) } : null; }).filter(Boolean),
      };
      toast(`已复制 ${clipboard.payload.length} 项（Ctrl+V 粘贴）`, 'info', 2400);
      e.preventDefault(); return;
    }
    if (sel) {
      const obj = (sel.kind === 'wall') ? doc.walls[sel.wi]
                 : (sel.kind === 'furniture') ? doc.furniture[sel.fi]
                 : (sel.kind === 'floor') ? doc.floors[sel.fi]
                 : doc.walls[sel.wi].openings[sel.oi];
      clipboard = { kind: sel.kind, payload: JSON.parse(JSON.stringify(obj)) };
      toast('已复制 ' + (sel.kind === 'opening' ? '门窗' : sel.kind) + '（Ctrl+V 粘贴）', 'info', 2400);
      e.preventDefault(); return;
    }
  }
  if (e.ctrlKey && (k === 'v' || k === 'V')) {
    if (clipboard && clipboard.kind === 'multi') {
      pushUndo();
      const OFF = 0.3, newSel = [];
      for (const it of clipboard.payload) {
        if (it.kind === 'wall') {
          const o = JSON.parse(JSON.stringify(it.obj));
          o.ax += OFF; o.az += OFF; o.bx += OFF; o.bz += OFF; delete o.gid;
          doc.walls.push(o); newSel.push({ kind: 'wall', wi: doc.walls.length - 1 });
        } else if (it.kind === 'floor') {
          const o = JSON.parse(JSON.stringify(it.obj));
          o.x1 += OFF; o.z1 += OFF; o.x2 += OFF; o.z2 += OFF; delete o.gid;
          if (o.strips) o.strips = o.strips.map(s => [s[0] + OFF, s[1] + OFF, s[2] + OFF, s[3] + OFF]);
          doc.floors.push(o); newSel.push({ kind: 'floor', fi: doc.floors.length - 1 });
        } else if (it.kind === 'furniture') {
          doc.furniture.push({ ...it.obj, x: it.obj.x + OFF, z: (it.obj.z || 0) + OFF, gid: undefined });
          newSel.push({ kind: 'furniture', fi: doc.furniture.length - 1 });
        }
      }
      _setSelItems(newSel);
      rebuild(); refreshProps();
      toast(`已粘贴 ${newSel.length} 项`, 'success'); e.preventDefault(); return;
    }
    if (clipboard && sel) {
      const t = clipboard;
      if (t.kind === 'wall') { const o = JSON.parse(JSON.stringify(t.payload)); o.ax += 0.3; o.az += 0.3; o.bx += 0.3; o.bz += 0.3; pushUndo(); doc.walls.push(o); sel = { kind: 'wall', wi: doc.walls.length - 1 }; }
      else if (t.kind === 'furniture') { const o = { ...t.payload, x: t.payload.x + 0.3, z: (t.payload.z || 0) + 0.3 }; pushUndo(); doc.furniture.push(o); sel = { kind: 'furniture', fi: doc.furniture.length - 1 }; }
      else if (t.kind === 'floor') { const o = JSON.parse(JSON.stringify(t.payload)); o.x1 += 0.3; o.z1 += 0.3; o.x2 += 0.3; o.z2 += 0.3; if (o.strips) o.strips = o.strips.map(s => [s[0]+0.3, s[1]+0.3, s[2]+0.3, s[3]+0.3]); pushUndo(); doc.floors.push(o); sel = { kind: 'floor', fi: doc.floors.length - 1 }; }
      else if (t.kind === 'opening') { const o = { ...t.payload }; pushUndo(); const w = doc.walls[sel.wi]; w.openings.push({ ...o, t: Math.min(0.94, (o.t || 0) + 0.1) }); sel = { kind: 'opening', wi: sel.wi, oi: w.openings.length - 1 }; }
      rebuild(); refreshProps();
      toast('已粘贴', 'success'); e.preventDefault(); return;
    }
  }
  if (e.ctrlKey && (k === 'd' || k === 'D')) {
    if (_selList().length > 1) { e.preventDefault(); duplicateSelection(); return; }
    if (sel) { e.preventDefault(); ctxDuplicate({ kind: sel.kind, wi: sel.wi, fi: sel.fi, oi: sel.oi }); toast('已复制', 'success'); return; }
  }
  // 编组 / 解组
  if (e.ctrlKey && (k === 'g' || k === 'G')) {
    e.preventDefault();
    if (e.shiftKey) ungroupSelection(); else groupSelection();
    return;
  }

  if (k === 'Escape') {
    if (tool === 'floor' && floorA) { floorA = null; clearFloorPreview(); return; }
    if ((tool === 'door' || tool === 'window') && placeWall != null) {
      placeWall = null; hoverWi = null; clearGhost();
      rebuild(); flash('已取消选墙，请重新左键点选一面墙');
      return;
    }
    if (chain) { chain = null; typedLen = ''; polyPts = []; clearPreview(); }
    else if (ghost) clearGhost();
    else if (sel) { sel = null; rebuild(); refreshProps(); }
    hideDialog();
    return;
  }
  if (k === 'Enter' && tool === 'wall') {
    if (typedLen && chain) {
      const p = lastGround || { x: chain.x + 1, z: chain.z };
      const q = chainNextPoint(p);
      _wallChainAdvance(q);
    } else { chain = null; chainPts = []; polyPts = []; }
    typedLen = ''; clearPreview(); rebuild(); refreshProps();
    return;
  }
  if (tool === 'wall' && chain && /^[0-9.]$/.test(k)) { typedLen += k; return; }
  if (tool === 'wall' && chain && k === 'Backspace') { typedLen = typedLen.slice(0, -1); return; }

  if ((k === 'Delete') && sel) {
    e.preventDefault();
    if (_selList().length > 1) { deleteSelection(); markUnsaved(true); return; }
    pushUndo();
    ctxDelete(sel);   // 内部已 sel=null / rebuild / refreshProps / flash
    markUnsaved(true);
    return;
  }
  // ── 大幅平移:Shift + 方向键 = 1m / 格(原微移监听器已实现 +0.5,此处再 +0.5)
  if (tool === 'select' && sel && shiftDown && /^Arrow/.test(k)) {
    e.preventDefault();
    const big = 0.5;
    let dx = 0, dz = 0;
    if (k === 'ArrowLeft')  dx = -big;
    else if (k === 'ArrowRight') dx = +big;
    else if (k === 'ArrowUp')    dz = -big;
    else if (k === 'ArrowDown')  dz = +big;
    if (nudgeSelected(dx, dz, e.altKey)) { markUnsaved(true); flash(`大幅平移 ${dx ? 'X' : 'Z'} ${(dx || dz).toFixed(2)}m`); }
    return;
  }
  // ── Q / E:选中家具精确旋转 ±15°(R 是 45°)
  if ((k === 'q' || k === 'Q' || k === 'e' || k === 'E') && sel && sel.kind === 'furniture' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    pushUndo();
    const f = doc.furniture[sel.fi];
    const dir = (k === 'q' || k === 'Q') ? -1 : 1;
    f.rot = stepRot15(f.rot || 0, dir);
    rebuild(); refreshProps(); markUnsaved(true);
    flash(`家具旋转至 ${Math.round((f.rot || 0) * 180 / Math.PI)}°`);
    return;
  }
  // ── [ / ]:厚度(墙/地面) ±0.02m,门窗宽度 ±0.05m,家具不响应
  if ((k === '[' || k === ']') && sel && !e.ctrlKey && !e.altKey && tool === 'select') {
    e.preventDefault();
    const sign = (k === '[') ? -1 : 1;
    pushUndo();
    if (sel.kind === 'wall') {
      const w = doc.walls[sel.wi];
      w.th = Math.max(0.05, Math.min(0.5, (w.th || 0.12) + sign * 0.02));
      flash(`墙厚 → ${w.th.toFixed(2)}m`);
    } else if (sel.kind === 'floor') {
      const f = doc.floors[sel.fi];
      if (f.strips) { redoStack.push(undoStack.pop()); return flash('组合地面不支持厚度调整', 'warn'); }
      f.th = Math.max(0.02, Math.min(0.5, (f.th || 0.05) + sign * 0.02));
      flash(`地面厚 → ${f.th.toFixed(2)}m`);
    } else if (sel.kind === 'opening') {
      const op = doc.walls[sel.wi].openings[sel.oi];
      op.width = Math.max(0.3, Math.min(3.0, (op.width || 0.9) + sign * 0.05));
      flash(`${op.type === 'door' ? '门' : '窗'}宽 → ${op.width.toFixed(2)}m`);
    } else {
      // 家具无合适字段,撤回本次 pushUndo
      redoStack.push(undoStack.pop());
      return;
    }
    rebuild(); refreshProps(); markUnsaved(true);
    return;
  }
  // ── WASD / Shift+WASD:世界 XZ 平移(0.1m / 1m),仅 select 工具下对 sel 生效
  if (tool === 'select' && sel && /^[wasd]$/i.test(k) && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const step = e.shiftKey ? 1.0 : 0.1;
    let dx = 0, dz = 0;
    if (k === 'a' || k === 'A') dx = -step;
    else if (k === 'd' || k === 'D') dx = +step;
    else if (k === 'w' || k === 'W') dz = -step;
    else if (k === 's' || k === 'S') dz = +step;
    if (nudgeSelected(dx, dz, false)) { markUnsaved(true); flash(`WASD 平移 ${dx ? 'X' : 'Z'} ${(dx || dz).toFixed(2)}m`); }
    return;
  }
  if ((k === 'r' || k === 'R') && sel && sel.kind === 'floor') {
    const f0 = doc.floors[sel.fi];
    if (f0 && f0.strips) return flash('识别生成的组合地面暂不支持旋转，可删除后重新识别');
    pushUndo();
    const f = doc.floors[sel.fi];
    const cx = (f.x1 + f.x2) / 2, cz = (f.z1 + f.z2) / 2;
    const hw = (f.x2 - f.x1) / 2, hd = (f.z2 - f.z1) / 2;
    f.x1 = cx - hd; f.x2 = cx + hd; f.z1 = cz - hw; f.z2 = cz + hw;
    rebuild(); refreshProps(); flash('地面已旋转 90°');
    return;
  }
  if ((k === 'r' || k === 'R') && tool === 'furn' && furnType) {
    furnRot = stepRot45(furnRot, shiftDown ? -1 : 1);
    if (ghost) ghost.rotation.y = furnRot;
    flash(`家具旋转至 ${Math.round(furnRot * 180 / Math.PI)}°`);
    return;
  }
  if ((k === 'r' || k === 'R') && tool === 'stairs' && stairFurn) {
    furnRot = stepRot45(furnRot, shiftDown ? -1 : 1);
    if (ghost) ghost.rotation.y = furnRot;
    flash(`楼梯家具旋转至 ${Math.round(furnRot * 180 / Math.PI)}°`);
    return;
  }
  // R / Shift+R：选中已放置家具 → 45° 量子步进（shift 逆时针）
  if ((k === 'r' || k === 'R') && sel && sel.kind === 'furniture') {
    pushUndo();
    const f = doc.furniture[sel.fi];
    f.rot = stepRot45(f.rot || 0, shiftDown ? -1 : 1);
    rebuild(); refreshProps();
    flash(`家具旋转至 ${Math.round(f.rot * 180 / Math.PI)}°`);
    return;
  }
  if ((k === 'r' || k === 'R') && sel && sel.kind === 'door') {
    pushUndo();
    const op = doc.walls[sel.wi].openings[sel.oi];
    op.hinge *= -1; rebuild(); refreshProps(); flash('门铰链已换边');
    return;
  }
  if ((k === 't' || k === 'T') && sel && sel.kind === 'door') {
    pushUndo();
    const op = doc.walls[sel.wi].openings[sel.oi];
    op.flip = !op.flip; rebuild(); refreshProps(); flash('门开向已翻转');
    return;
  }
  if (k === 'g' || k === 'G') { grid.visible = !grid.visible; flash(`网格 ${grid.visible ? '开' : '关'}`); return; }
  if (k === 'v' || k === 'V') { toggleView(); return; }
});

let lastGround = null;
renderer.domElement.addEventListener('pointermove', e => {
  const p = groundPoint(e);
  if (p) lastGround = p;
}, true);

// ============================================================
// 视图切换 / 网格
// ============================================================
let topView = false;
// 顶层 toggle 入口: 保留快捷键 F5/V 调用
function toggleView() {
  setView(topView ? '3d' : '2d');
}

// 借鉴 blueprint3d-babylon ViewController.setView —— 单一权威入口,负责:
//   1) body / stage 视图标记 + ARIA
//   2) 切换按钮文字/aria-pressed
//   3) 显示重置按钮
//   4) 中断 drag/ghost/画墙等临时状态
//   5) 切换活动相机、相机机位、controls 目标
//   6) 触发引擎 resize 与提示文案
// nextView: '2d' | '3d'
function setView(nextView) {
  const wantTop = (nextView === '2d');
  topView = wantTop;
  // 首次切换时确保 body 拥有默认视图类
  if (!document.body.classList.contains('view-2d') && !document.body.classList.contains('view-3d')) {
    document.body.classList.add(wantTop ? 'view-2d' : 'view-3d');
  }
  // 1) DOM 标记
  const stageEl = document.getElementById('stage');
  if (stageEl) stageEl.dataset.view = wantTop ? '2d' : '3d';
  document.body.classList.toggle('view-2d', wantTop);
  document.body.classList.toggle('view-3d', !wantTop);
  // 2) 切换按钮
  const vbtn = document.getElementById('btn-view-toggle');
  if (vbtn) {
    vbtn.textContent = wantTop ? '3D' : '2D';
    vbtn.setAttribute('aria-pressed', String(!wantTop));
    vbtn.title = wantTop ? '切换到 3D 透视视图 (V / F5)' : '切换到 2D 俯视视图 (V / F5)';
  }
  // 3) 重置按钮显现
  const rst = document.getElementById('btn-reset-view');
  if (rst) rst.classList.remove('hidden');
  // 4) 清掉遗留临时状态
  if (drag) { drag = null; _clearDragPreview?.(); }
  if (typeof clearGhost === 'function') clearGhost();
  if (typeof _cancelWallDraw === 'function') _cancelWallDraw();
  // 5) 切相机
  if (wantTop) {
    activeCam = orthoCam;
    controls.object = orthoCam;
    orthoCam.up.set(0, 0, -1);
    if (grid) grid.visible = false;   // 网格由 SVG 自己画,3D 网格隐藏避免双层
    fitViewToContent();
    // 切到 SVG 2D 渲染:把 orthoCam 视野映射到 svg viewBounds
    if (typeof render2dInit === 'function') render2dInit();
    if (typeof render2dFit === 'function') render2dFit();
  } else {
    activeCam = camera;
    controls.object = camera;
    camera.position.set(6.5, 7.2, 8.5);
    controls.target.set(0, 0.4, 0);
    updateOrthoFrustum();
    if (grid) grid.visible = true;
    requestAnimationFrame(() => {
      if (renderer && typeof renderer.setSize === 'function') {
        renderer.setSize(window.innerWidth, window.innerHeight);
      }
    });
  }
  // 6) 提示 + 重绘
  flash(wantTop ? '2D 俯视正交视图（适合画墙布门窗）' : '3D 透视视图');
  setHint?.();
  _needsRender = true;
}

// 借鉴 blueprint3d-babylon ViewGeometry.fitBoundsToViewport
// 根据 doc.walls / doc.furniture / doc.floors 计算包围盒,调整 orthoCam.left/right/top/bottom 让内容居中可见
function fitViewToContent() {
  if (!orthoCam) return;
  if (!doc.walls.length && !doc.furniture.length && !doc.floors.length) {
    updateOrthoFrustum();
    return;
  }
  const xs = [], zs = [];
  doc.walls.forEach(w => { xs.push(w.ax, w.bx); zs.push(w.az, w.bz); });
  doc.floors.forEach(f => { xs.push(f.x1, f.x2); zs.push(f.z1, f.z2); });
  doc.furniture.forEach(f => {
    const def = FURN[f.type] || {};
    xs.push(f.x - (def.w || 0) / 2, f.x + (def.w || 0) / 2);
    zs.push(f.z - (def.d || 0) / 2, f.z + (def.d || 0) / 2);
  });
  if (!xs.length) return;
  const minX = Math.min(...xs) - 1.5, maxX = Math.max(...xs) + 1.5;
  const minZ = Math.min(...zs) - 1.5, maxZ = Math.max(...zs) + 1.5;
  const w = maxX - minX, h = maxZ - minZ;
  const aspect = window.innerWidth / Math.max(1, window.innerHeight);
  let halfW, halfH;
  if (w / h > aspect) { halfW = w / 2; halfH = halfW / aspect; }
  else                { halfH = h / 2; halfW = halfH * aspect; }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  orthoCam.left = cx - halfW;   orthoCam.right = cx + halfW;
  orthoCam.top = cz - halfH;    orthoCam.bottom = cz + halfH;
  orthoCam.updateProjectionMatrix();
  orthoCam.position.set(cx, 20, cz);
  orthoCam.lookAt(cx, 0, cz);
  controls.target.set(cx, 0, cz);
  _needsRender = true;
}

// 重置视图按钮:2D 时回到内容框,3D 时回到默认机位
function resetView() {
  if (topView) {
    fitViewToContent();
    flash('2D 视图已重置到内容范围');
  } else {
    camera.position.set(6.5, 7.2, 8.5);
    controls.target.set(0, 0.4, 0);
    updateOrthoFrustum();
    _needsRender = true;
    flash('3D 视图已重置');
  }
}

// 视图预设：顶/前/侧/轴测 + 平滑过渡
const VIEW_PRESETS = {
  top:   { pos: [0, 22, 0.01],  tgt: [0, 0, 0],     ortho: true,  up: [0, 0, -1] },
  front: { pos: [0, 0, 14],     tgt: [0, 1.2, 0],   ortho: false, up: [0, 1, 0]  },
  side:  { pos: [14, 1.5, 0],   tgt: [0, 1.2, 0],   ortho: false, up: [0, 1, 0]  },
  iso:   { pos: [6.5, 7.2, 8.5],tgt: [0, 0.4, 0],   ortho: false, up: [0, 1, 0]  },
};
let camTween = null;
function setViewPreset(name) {
  const p = VIEW_PRESETS[name]; if (!p) return;
  // 切到正交顶视图时与 toggleView 同步 topView 状态
  if (name === 'top' && !topView) toggleView();
  else if (name !== 'top' && topView) toggleView();
  // 取消旧动画
  if (camTween) cancelAnimationFrame(camTween);
  const cam = (name === 'top') ? orthoCam : camera;
  const fromPos = cam.position.clone();
  const fromTgt = controls.target.clone();
  const toPos = new THREE.Vector3().fromArray(p.pos);
  const toTgt = new THREE.Vector3().fromArray(p.tgt);
  const fromUp = cam.up.clone();
  const toUp = new THREE.Vector3().fromArray(p.up);
  const dur = 500, t0 = performance.now();
  function step() {
    const t = Math.min(1, (performance.now() - t0) / dur);
    const k = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;   // easeInOutQuad
    cam.position.lerpVectors(fromPos, toPos, k);
    controls.target.lerpVectors(fromTgt, toTgt, k);
    cam.up.lerpVectors(fromUp, toUp, k).normalize();
    cam.lookAt(controls.target);
    if (name === 'top') updateOrthoFrustum();
    controls.update();
    if (t < 1) camTween = requestAnimationFrame(step);
    else camTween = null;
  }
  step();
  const labels = { top: '俯视正交视图', front: '正视图', side: '侧视图', iso: '轴测视图' };
  flash(labels[name], 'info');
}

// ============================================================
// 属性面板
// ============================================================
const propsBody = document.getElementById('propsBody');

// 单个选择项的包围盒（供聚焦使用）
function _boxOfSelItem(s) {
  if (!s) return null;
  if (s.kind === 'wall') {
    const w = doc.walls[s.wi]; if (!w) return null;
    return new THREE.Box3(
      new THREE.Vector3(Math.min(w.ax, w.bx) - w.th, 0, Math.min(w.az, w.bz) - w.th),
      new THREE.Vector3(Math.max(w.ax, w.bx) + w.th, w.h || doc.wallH, Math.max(w.az, w.bz) + w.th));
  }
  if (s.kind === 'door' || s.kind === 'window' || s.kind === 'opening') {
    const w = doc.walls[s.wi]; if (!w || !w.openings[s.oi]) return null;
    const op = w.openings[s.oi];
    const L = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1;
    const t0 = op.t - op.width / 2 / L, t1 = op.t + op.width / 2 / L;
    return new THREE.Box3(
      new THREE.Vector3(Math.min(w.ax, w.bx) + t0 * Math.abs(w.bx - w.ax), 0, Math.min(w.az, w.bz) + t0 * Math.abs(w.bz - w.az)),
      new THREE.Vector3(Math.min(w.ax, w.bx) + t1 * Math.abs(w.bx - w.ax), op.height || 2.05, Math.min(w.az, w.bz) + t1 * Math.abs(w.bz - w.az)));
  }
  if (s.kind === 'floor') {
    const f = doc.floors[s.fi]; if (!f) return null;
    return new THREE.Box3(
      new THREE.Vector3(Math.min(f.x1, f.x2), 0, Math.min(f.z1, f.z2)),
      new THREE.Vector3(Math.max(f.x1, f.x2), f.th || 0.05, Math.max(f.z1, f.z2)));
  }
  if (s.kind === 'furniture') {
    const f = doc.furniture[s.fi]; if (!f) return null;
    const def = FURN[f.type]; if (!def) return null;
    const sc = (def.scale || 1) * (f.scale != null ? f.scale : 1);
    const hw = (def.w * sc) / 2, hd = (def.d * sc) / 2;
    return new THREE.Box3(
      new THREE.Vector3(f.x - hw, 0, f.z - hd),
      new THREE.Vector3(f.x + hw, def.h || 1, f.z + hd));
  }
  return null;
}
// 聚焦相机到选中物体：平滑插值 controls.target + 距离（多选取并集包围盒）
function focusOnSel() {
  if (!sel) return flash('当前无选中', 'info');
  let box = null;
  for (const s of _selList()) {
    const b = _boxOfSelItem(s);
    if (!b) continue;
    box = box ? box.union(b) : b;
  }
  if (!box) return;
  const center = new THREE.Vector3(); box.getCenter(center);
  const size = new THREE.Vector3(); box.getSize(size);
  const radius = Math.max(size.x, size.y, size.z, 0.6);
  const dist = radius * 2.6;
  // 平滑过渡
  const start = { p: activeCam.position.clone(), t: controls.target.clone() };
  const end = { p: center.clone().add(new THREE.Vector3(dist, dist * 0.7, dist)), t: center };
  const dur = 380, t0 = performance.now();
  function step() {
    const k = Math.min(1, (performance.now() - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);  // easeOutCubic
    activeCam.position.lerpVectors(start.p, end.p, e);
    controls.target.lerpVectors(start.t, end.t, e);
    activeCam.lookAt(controls.target);
    if (k < 1) requestAnimationFrame(step);
    else flash(`已聚焦 ${sel.kind === 'furniture' ? FURN[doc.furniture[sel.fi].type].name : sel.kind}`, 'success', 900);
  }
  step();
}
globalThis.__focusOnSel = focusOnSel;

// ── 首次引导气泡 ──
const _OB_STEPS = [
  { sel: '.railbtn[data-tool="wall"]', title: '画一堵墙', desc: '点击左侧「画墙」按钮（快捷键 F6），然后在画布上点两个点画出第一面墙。会自动吸附端点。' },
  { sel: '.railbtn[data-tool="door"]', title: '放一扇门', desc: '点击「门」（F7），先在墙上点一下，再沿墙移动到合适位置点一下即可放置。' },
  { sel: '#btnNew', title: '保存方案', desc: '按 Ctrl+S 保存方案，按 Ctrl+O 打开新文件，或用命令面板（Ctrl+P）。' },
];
function startOnboard() {
  const wrap = document.getElementById('onboard');
  const pop = document.getElementById('obPop');
  const stepEl = document.getElementById('obStep');
  const titleEl = document.getElementById('obTitle');
  const descEl = document.getElementById('obDesc');
  const nextBtn = document.getElementById('obNext');
  const skipBtn = document.getElementById('obSkip');
  if (!wrap) return;
  // 高亮 overlay
  let hl = wrap.querySelector('.ob-highlight');
  if (!hl) { hl = document.createElement('div'); hl.className = 'ob-highlight'; wrap.appendChild(hl); }
  let i = 0;
  function render() {
    if (i >= _OB_STEPS.length) { end(); return; }
    const s = _OB_STEPS[i];
    const target = document.querySelector(s.sel);
    if (!target) { i++; render(); return; }
    target.scrollIntoView({ block: 'center', inline: 'center' });
    const r = target.getBoundingClientRect();
    hl.style.left = (r.left - 4) + 'px';
    hl.style.top = (r.top - 4) + 'px';
    hl.style.width = (r.width + 8) + 'px';
    hl.style.height = (r.height + 8) + 'px';
    stepEl.textContent = `${i + 1} / ${_OB_STEPS.length}`;
    titleEl.textContent = s.title;
    descEl.textContent = s.desc;
    // pop 位置：目标右下
    pop.style.left = Math.min(r.right + 16, window.innerWidth - 360 - 8) + 'px';
    pop.style.top = Math.max(8, r.top - 20) + 'px';
    pop.style.transform = 'none';
    nextBtn.textContent = i === _OB_STEPS.length - 1 ? '完成 ✓' : '下一步 →';
    wrap.hidden = false;
  }
  function end() {
    wrap.hidden = true;
    try { localStorage.setItem('tp3d_onboard_done', '1'); } catch {}
  }
  nextBtn.onclick = () => { i++; render(); };
  skipBtn.onclick = end;
  hl.onclick = end;
  render();
}
globalThis.__startOnboard = startOnboard;

// ── 命令面板（Cmd+P / Ctrl+P） ──
const _CMDS = [
  { cat: '工具', name: '画墙 (F6)', kb: 'F6', fn: () => setTool('wall') },
  { cat: '工具', name: '放门 (F7)', kb: 'F7', fn: () => setTool('door') },
  { cat: '工具', name: '放窗 (F8)', kb: 'F8', fn: () => setTool('window') },
  { cat: '工具', name: '画地面 (F11)', kb: 'F11', fn: () => setTool('floor') },
  { cat: '工具', name: '放家具 (F10)', kb: 'F10', fn: () => setTool('furn') },
  { cat: '工具', name: '选择 (F4)', kb: 'F4', fn: () => setTool('select') },
  { cat: '工具', name: '移动画布 (H)', kb: 'H', fn: () => setTool('pan') },
  { cat: '工具', name: '删除当前选中 (F9 / Del)', kb: 'F9', fn: () => { if (sel) { pushUndo(); ctxDelete(sel); sel = null; rebuild(); refreshProps(); } } },
  { cat: '视图', name: '切换俯视/透视 (F5)', kb: 'F5', fn: () => toggleView() },
  { cat: '视图', name: '聚焦当前选中 (F)', kb: 'F', fn: () => focusOnSel() },
  { cat: '视图', name: '重置视图', fn: () => { camera.position.set(6.5, 7.2, 8.5); controls.target.set(0, 0, 0); controls.update(); } },
  { cat: '文件', name: '保存方案 (F2 / Ctrl+S)', kb: 'F2', fn: () => saveDoc() },
  { cat: '文件', name: '打开方案 (F3 / Ctrl+O)', kb: 'F3', fn: () => loadDoc() },
  { cat: '文件', name: '导出 JSON', fn: () => exportJSON() },
  { cat: '文件', name: '导出 GLB', fn: () => exportGLB() },
  { cat: '文件', name: '新建方案', fn: () => newDoc() },
  { cat: '编辑', name: '撤销 (Ctrl+Z)', kb: '⌘Z', fn: () => undo() },
  { cat: '编辑', name: '重做 (Ctrl+Y)', kb: '⌘Y', fn: () => redo() },
  { cat: '房间', name: '识别房间（按墙生成地面）', fn: () => detectRooms() },
  { cat: '房间', name: '切换显示面积标签', fn: () => { toggleAreaLabels(); } },
  { cat: '教程', name: '显示快捷键速查 (F1)', kb: 'F1', fn: () => showHelp() },
  { cat: '教程', name: '重新显示引导气泡', fn: () => { localStorage.removeItem('tp3d_onboard_done'); startOnboard(); } },
];
function openCmd() {
  const p = document.getElementById('cmdPalette');
  const inp = document.getElementById('cmdInput');
  const list = document.getElementById('cmdList');
  if (!p) return;
  p.hidden = false;
  inp.value = '';
  let sel = 0;
  function render() {
    const q = inp.value.trim().toLowerCase();
    const items = _CMDS.map((c, i) => ({ ...c, i }))
      .filter(c => !q || c.name.toLowerCase().includes(q) || c.cat.toLowerCase().includes(q));
    if (!items.length) { list.innerHTML = '<div class="cmd-empty">无匹配命令</div>'; return; }
    list.innerHTML = items.map(c =>
      `<div class="cmd-item ${c.i === sel ? 'sel' : ''}" data-i="${c.i}">
        <span class="cat">${c.cat}</span>
        <span class="name">${c.name}</span>
        ${c.kb ? `<span class="kb">${c.kb}</span>` : ''}
      </div>`).join('');
    list.querySelectorAll('.cmd-item').forEach(el => {
      el.onclick = () => { _CMDS[+el.dataset.i].fn(); closeCmd(); };
      el.onmouseenter = () => { sel = +el.dataset.i; render(); };
    });
    const s = list.querySelector('.cmd-item.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  }
  function closeCmd() { p.hidden = true; }
  inp.oninput = () => { sel = 0; render(); };
  inp.onkeydown = e => {
    if (e.key === 'Escape') { closeCmd(); e.preventDefault(); }
    else if (e.key === 'Enter') { const items = list.querySelectorAll('.cmd-item'); if (items[sel]) items[sel].click(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, list.querySelectorAll('.cmd-item').length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
  };
  p.querySelector('.cmd-mask').onclick = closeCmd;
  render();
  setTimeout(() => inp.focus(), 0);
}
globalThis.__openCmd = openCmd;

function refreshProps() {
  // 悬空选中守卫:sel 指向已删除/越界的实体时清掉,防止属性面板读 undefined 崩溃
  if (sel) {
    const dangling =
      (sel.kind === 'wall' && !doc.walls[sel.wi]) ||
      (sel.kind === 'floor' && !(doc.floors || [])[sel.fi]) ||
      (sel.kind === 'furniture' && !(doc.furniture || [])[sel.fi]) ||
      (sel.kind === 'stairs' && !(doc.stairs || [])[sel.si]) ||
      ((sel.kind === 'door' || sel.kind === 'window' || sel.kind === 'opening') &&
        (!(doc.walls || [])[sel.wi] || !(doc.walls[sel.wi].openings || [])[sel.oi]));
    if (dangling) { sel = null; _selMirror = null; }
  }
  needProps = false;
  // inspector 显示/隐藏:
  //  - 选中对象(墙/门/窗/地面/家具) → 显示(对象属性),互斥占用左栏
  //  - furn/floor 工具激活但没选对象 → 显示(家具库 / 地面工具面板),
  //    属于 inspector 自身内容,不需要让 theme/outline 让位
  //  - 其他工具且无选中 → 收起
  // 必须在最前面执行 —— 下面各 sel 分支末尾都 return,放末尾会被跳过
  const inspectorEl = document.getElementById('inspector');
  if (inspectorEl) {
    const hasObjSel = sel && (sel.kind === 'wall' || sel.kind === 'door' || sel.kind === 'window'
      || sel.kind === 'floor' || sel.kind === 'furniture' || sel.kind === 'opening' || sel.kind === 'multi');
    const toolPanel = !sel && (tool === 'furn' || tool === 'floor' || tool === 'stairs');
    const shouldOpen = hasObjSel || toolPanel;
    inspectorEl.classList.toggle('open', !!shouldOpen);
    // 工具面板(家具库/地面工具)会自动撑出 inspector,占满左侧,与 filesPanel 并存时
    // 视觉/空间都过于拥挤;此场景下收起 filesPanel 释放左侧栏位。
    // 仅工具面板触发,选中对象时不收(用户可能正在文件栏浏览并选中)。
    if (toolPanel && typeof window.__filesToggle === 'function') {
      window.__filesToggle(false, { silent: true });
    }
    if (hasObjSel) {
      // 选中对象时让 inspector 优先于 theme,关闭它让出左侧栏位
      // 大纲面板不收: 用户主动点大纲项进去选对象时,大纲本身就是导航工具,
      // 让它保持展开便于继续浏览/切换其它对象
      if (typeof window.__themeToggle === 'function') window.__themeToggle(false, { silent: true });
    }
  }
  // 把所有 sw 按钮升级为带 cube预览的版本
  queueMicrotask(() => propsBody.querySelectorAll('.sw').forEach(upgradeSwToCube));
  // 有选中对象时，注入"聚焦"按钮（统一处理）
  if (sel && (sel.kind === 'wall' || sel.kind === 'door' || sel.kind === 'window' ||
              sel.kind === 'floor' || sel.kind === 'furniture' || sel.kind === 'opening' || sel.kind === 'multi')) {
    queueMicrotask(() => {
      // 先清掉旧的避免堆叠
      const old = propsBody.querySelector('#pFocus');
      if (old) old.parentElement?.remove();
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.id = 'pFocus';
      btn.textContent = '🎯 聚焦此对象 (F)';
      btn.style.background = 'var(--accent-soft)';
      btn.style.color = 'var(--accent)';
      btn.style.fontWeight = '600';
      btn.onclick = focusOnSel;
      const wrap = document.createElement('div');
      wrap.className = 'btnrow';
      wrap.appendChild(btn);
      const h3 = propsBody.querySelector('h3');
      if (h3 && h3.nextSibling) propsBody.insertBefore(wrap, h3.nextSibling);
      else propsBody.prepend(wrap);
    });
  }
  if (!sel && tool === 'stairs') {
    // 楼梯工具面板:参数化三型 + 楼梯类家具 GLB(从家具库「健身玩具」迁移而来)
    const stairFurnItems = Object.entries(FURN).filter(([k, d]) => d.cat === 'stairs');
    const typeBtns = [['straight', '直跑'], ['lshape', 'L 型'], ['spiral', '螺旋']]
      .map(([t, n]) => `<button class="styleBtn ${stairFurn === '' && stairType === t ? 'on' : ''}" data-stairtype="${t}">${n}</button>`).join('');
    const furnBtns = stairFurnItems.map(([k, d]) =>
      `<button class="fitem ${stairFurn === k ? 'active' : ''}" data-stairfurn="${k}">
        <span class="em">${d.icon || '▦'}</span>${d.name}</button>`).join('');
    propsBody.innerHTML = `
      <h3>楼梯工具</h3>
      <div class="note">左键放置参数化楼梯,可连续放置;自动按层高计算踏步数。</div>
      <div class="frow" style="margin-bottom:4px"><label>参数化楼梯</label></div>
      <div class="styleRow">${typeBtns}</div>
      <div class="frow" style="margin:10px 0 4px"><label>楼梯家具（GLB 模型）</label></div>
      <div class="fgrid">${furnBtns}</div>
      <div class="note">选中楼梯家具后左键放置(作为家具,可缩放/换型/贴墙);R 旋转 45°。</div>`;
    propsBody.querySelectorAll('[data-stairtype]').forEach(b => b.onclick = () => {
      stairType = b.dataset.stairtype;
      stairFurn = '';
      clearGhost();
      refreshProps();
    });
    propsBody.querySelectorAll('[data-stairfurn]').forEach(b => b.onclick = () => {
      stairFurn = b.dataset.stairfurn;
      furnRot = 0;
      clearGhost();
      refreshProps();
    });
    return;
  }
  if (!sel && tool === 'floor') {
    propsBody.innerHTML = `
      <h3>地面工具</h3>
      <div class="note">左键定第一个角 → 移动预览 → 左键定对角。<br>自动吸附墙角与网格；可画多块分色地面。</div>
      <div class="frow"><label>现有地面</label><span>${(doc.floors || []).length} 块</span></div>
      <div class="btnrow"><button class="btn" id="pAutoFloor">按墙围合区域生成地面</button></div>`;
    $('pAutoFloor').onclick = createFloorFromWalls;
    return;
  }
  if (!sel && tool === 'furn') {
    const q = (_furnSearch || '').toLowerCase();
    const onKey = (k) => furnType === k;
    const item = (k, d) => `<button class="fitem ${onKey(k) ? 'active' : ''}" data-furn="${k}">
        <span class="em">${d.icon || '▦'}</span>${d.name}${d.custom ? `<span class="fdel" data-fdel="${d.custom}" title="删除此模型">✕</span>` : ''}</button>`;
    // 按 cat 分组
    const groups = {};
    Object.entries(FURN).forEach(([k, d]) => {
      if (d.cat === 'stairs') return;   // 楼梯类家具归入「楼梯」工具面板,家具库不展示
      if (q && !d.name.toLowerCase().includes(q) && !k.toLowerCase().includes(q)) return;
      const c = d.cat || 'other';
      (groups[c] = groups[c] || []).push([k, d]);
    });
    // 分类顺序：固定按使用频率
    const CAT_ORDER = FURN_CAT_ORDER;
    const CAT_NAMES = FURN_CAT_NAMES;
    let html = `<h3>家具库</h3>
      <input id="furnSearch" class="fsearch" placeholder="🔍 搜索家具（中文/英文）…" value="${q.replace(/"/g,'&quot;')}">
      <div class="btnrow"><button class="btn" id="fImportModel">＋ 导入 3D 模型 (GLB)</button></div>
      <div class="note">选择家具后左键放置。R 旋转 45°（Shift+R 逆时针）。</div>`;
    let totalShown = 0;
    for (const cat of CAT_ORDER) {
      const items = groups[cat];
      if (!items || !items.length) continue;
      totalShown += items.length;
      html += `<details class="fcat" open><summary>${CAT_NAMES[cat]} <span class="cnt">${items.length}</span></summary><div class="fgrid">`;
      items.forEach(([k, d]) => { html += item(k, d); });
      html += `</div></details>`;
    }
    if (q && totalShown === 0) html += `<div class="note" style="margin-top:8px">无匹配项</div>`;
    if (furnType) html += `<div class="note" style="margin-top:8px">当前：<b>${FURN[furnType].name}</b>（${FURN[furnType].w.toFixed(2)} × ${FURN[furnType].d.toFixed(2)} m）</div>`;
    propsBody.innerHTML = html;
    const searchEl = document.getElementById('furnSearch');
    if (searchEl) {
      searchEl.addEventListener('compositionstart', () => { _furnSearchComposing = true; });
      searchEl.addEventListener('compositionend', (e) => {
        _furnSearchComposing = false;
        _furnSearch = e.target.value;
        refreshProps();
      });
      searchEl.oninput = (e) => {
        if (_furnSearchComposing) return;   // 中文 IME 组合中不触发刷新
        _furnSearch = e.target.value;
        refreshProps();
      };
      // 渲染后保持焦点
      if (q) {
        searchEl.focus();
        const L = searchEl.value.length;
        try { searchEl.setSelectionRange(L, L); } catch(e) {}
      }
    }
    propsBody.querySelectorAll('[data-furn]').forEach(b => {
      b.onclick = (ev) => {
        const del = ev.target.closest && ev.target.closest('[data-fdel]');
        if (del) { ev.stopPropagation(); deleteCustomAsset(del.dataset.fdel); return; }
        furnType = b.dataset.furn; furnRot = 0; clearGhost(); refreshProps();
      };
    });
    const fi = $('fImportModel');
    if (fi) fi.onclick = importModel;
    return;
  }
  if (!sel) {
    propsBody.innerHTML = `
      <h3>文档属性</h3>
      <div class="frow"><label>层高 (m)</label><input id="pWallH" type="number" step="0.05" value="${doc.wallH}"></div>
      <div class="note">地面块：用 F11 地面工具绘制（可画多块、分色、分厚度）。</div>
      <div class="note">当前：${doc.walls.length} 面墙 · ${doc.walls.reduce((s, w) => s + (w.openings || []).filter(o => o.type === 'door').length, 0)} 樘门 · ${doc.walls.reduce((s, w) => s + (w.openings || []).filter(o => o.type === 'window').length, 0)} 扇窗 · ${(doc.floors || []).length} 块地面 · ${(doc.furniture || []).length} 件家具</div>
      <div class="note">提示：F6 画墙，F7/F8 在墙上点一下放门窗，选择后可拖拽端点与门窗位置。</div>`;
    bindNum('pWallH', v => { doc.wallH = v; rebuild(); });
    if (doc.underlay) {
      propsBody.insertAdjacentHTML('beforeend', `
        <h3>平面图底图</h3>
        <div class="frow"><label>宽度 (m)</label><input id="uW" type="number" step="0.25" value="${doc.underlay.w.toFixed(2)}"></div>
        <div class="frow"><label>不透明度</label><input id="uO" type="number" step="0.05" min="0.05" max="1" value="${doc.underlay.opacity.toFixed(2)}"></div>
        <div class="frow"><label>中心 X (m)</label><input id="uCX" type="number" step="0.1" value="${doc.underlay.cx.toFixed(2)}"></div>
        <div class="frow"><label>中心 Z (m)</label><input id="uCZ" type="number" step="0.1" value="${doc.underlay.cz.toFixed(2)}"></div>
        <div class="btnrow"><button class="btn" id="uHide">${doc.underlay.visible ? '隐藏底图' : '显示底图'}</button>
        <button class="btn" id="uDel">移除</button></div>`);
      bindNum('uW', v => { doc.underlay.w = v; rebuild(); });
      bindNum('uO', v => { doc.underlay.opacity = v; rebuild(); });
      bindNum('uCX', v => { doc.underlay.cx = v; rebuild(); });
      bindNum('uCZ', v => { doc.underlay.cz = v; rebuild(); });
      $('uHide').onclick = () => { doc.underlay.visible = !doc.underlay.visible; rebuild(); refreshProps(); };
      $('uDel').onclick = removeUnderlay;
    } else {
      propsBody.insertAdjacentHTML('beforeend', `
        <div class="btnrow"><button class="btn" id="uImport">导入平面图底图</button></div>`);
      $('uImport').onclick = importUnderlay;
    }
    return;
  }
  if (sel.kind === 'multi') {
    const list = _selList();
    const KN = { wall: '墙', floor: '地面', furniture: '家具', door: '门', window: '窗', opening: '门窗' };
    const counts = {};
    list.forEach(s => { counts[s.kind] = (counts[s.kind] || 0) + 1; });
    const summary = Object.entries(counts).map(([k, n]) => `${KN[k] || k} ${n}`).join(' · ');
    const anyGrouped = list.some(s => _gidOf(s));
    propsBody.innerHTML = `
      <h3>已选 ${list.length} 项</h3>
      <div class="note">${summary}</div>
      <div class="btnrow">
        <button class="btn" id="pmGroup">成组 (Ctrl+G)</button>
        <button class="btn" id="pmUngroup"${anyGrouped ? '' : ' disabled'}>解组 (Ctrl+Shift+G)</button>
      </div>
      <div class="btnrow">
        <button class="btn" id="pmLock">全部锁定</button>
        <button class="btn" id="pmUnlock">全部解锁</button>
      </div>
      <div class="btnrow">
        <button class="btn" id="pmHide">全部隐藏</button>
        <button class="btn" id="pmShow">全部显示</button>
      </div>
      <div class="btnrow"><button class="btn" id="pmDup">复制一份 (Ctrl+D)</button></div>
      <div class="btnrow"><button class="btn" id="pmDel" style="color:var(--danger)">删除所选 (Del)</button></div>
      <div class="note">拖动其中任意一项可整体移动；Shift+点击可加选 / 移出。</div>`;
    $('pmGroup').onclick = groupSelection;
    $('pmUngroup').onclick = ungroupSelection;
    $('pmLock').onclick = () => setSelectionLock(true);
    $('pmUnlock').onclick = () => setSelectionLock(false);
    $('pmHide').onclick = () => setSelectionHidden(true);
    $('pmShow').onclick = () => setSelectionHidden(false);
    $('pmDup').onclick = duplicateSelection;
    $('pmDel').onclick = deleteSelection;
    return;
  }
  if (sel.kind === 'wall') {
    const w = doc.walls[sel.wi];
    const dx = w.bx - w.ax, dz = w.bz - w.az;
    const L = Math.hypot(dx, dz);
    const ang = Math.atan2(dz, dx) * 180 / Math.PI;
    const swRow = (key, label) => `
      <div class="frow" style="margin-bottom:2px"><label>${label}</label></div>
      <div class="swgrid">${PRESETS.map(p =>
        `<button class="sw ${w[key] === p.c ? 'on' : ''}" data-k="${key}" data-c="${p.c}" title="${p.n}" style="background:${p.c}"></button>`).join('')
      }<button class="sw" data-k="${key}" data-c="" title="恢复默认" style="background:#fff;color:#a00;font-weight:700">✕</button></div>`;
    propsBody.innerHTML = `
      <h3>墙 #${sel.wi + 1}</h3>
      <details class="propSection" open>
        <summary class="propSecTitle">几何尺寸</summary>
        <div class="frow"><label>起点 A X (m)</label><input id="pAx" type="number" step="0.05" value="${w.ax.toFixed(2)}"></div>
        <div class="frow"><label>起点 A Z (m)</label><input id="pAz" type="number" step="0.05" value="${w.az.toFixed(2)}"></div>
        <div class="frow"><label>终点 B X (m)</label><input id="pBx" type="number" step="0.05" value="${w.bx.toFixed(2)}"></div>
        <div class="frow"><label>终点 B Z (m)</label><input id="pBz" type="number" step="0.05" value="${w.bz.toFixed(2)}"></div>
        <div class="frow"><label>长度 (m)</label><input id="pLen" type="number" step="0.05" value="${L.toFixed(2)}"></div>
        <div class="frow"><label>厚度 (m)</label><input id="pTh" type="number" step="0.01" min="0.06" max="0.5" value="${w.th}"></div>
        <div class="frow"><label>高度 (m)</label><input id="pH" type="number" step="0.05" min="0.5" max="6" value="${(w.h || doc.wallH || 2.75).toFixed(2)}"></div>
        <div class="frow"><label>角度 (°)</label><span style="font-variant-numeric:tabular-nums">${ang.toFixed(1)}°</span></div>
        <div class="frow"><label>门/窗数量</label><span>${(w.openings || []).length}</span></div>
        <div class="frow"><label>锁定(禁止拖动)</label><div class="seg">
          <button id="pWLockY" class="${w.locked ? 'on' : ''}">是</button>
          <button id="pWLockN"  class="${!w.locked ? 'on' : ''}">否</button></div></div>
      </details>
      <details class="propSection" open>
        <summary class="propSecTitle">半墙</summary>
        <div class="frow"><label>启用半墙</label><div class="seg">
          <button id="pHWYes" class="${w.halfWall ? 'on' : ''}">是</button>
          <button id="pHWNo"  class="${!w.halfWall ? 'on' : ''}">否</button></div></div>
        <div class="frow"><label>分界线高度 (m)</label>
          <input id="pHH" type="number" step="0.05" min="0.2" max="${((w.h != null ? w.h : doc.wallH || 2.75) - 0.1).toFixed(2)}"
           value="${(w.halfHeight != null ? w.halfHeight : 1.2).toFixed(2)}"
           ${!w.halfWall ? 'disabled style="opacity:0.5"' : ''}></div>
        <div class="note">下半段用现有墙面材质,上半段走默认浅灰白。<br>门窗洞口保持完整(穿过上下分界线),窗台会被自动夹到分界线以上。</div>
      </details>
      <details class="propSection" open>
        <summary class="propSecTitle">玻璃墙</summary>
        <div class="frow"><label>改为磨砂半透玻璃</label><div class="seg">
          <button id="pGlassY" class="${w.glass ? 'on' : ''}">是</button>
          <button id="pGlassN" class="${!w.glass ? 'on' : ''}">否</button></div></div>
        <div class="note">开关=是时,该墙渲染为浅蓝白磨砂半透面板(opacity 0.35),不随主题变色,不影响开门窗洞。</div>
      </details>
      <details class="propSection" open>
        <summary class="propSecTitle">外观材质</summary>
        ${swRow('matIn', '内面材质')}
        ${swRow('matOut', '外面材质')}
        <div class="frow" style="margin-top:8px"><label>墙面纹理</label></div>
        <div class="styleRow">${renderTexPickerHTML('wallTex', w.wallTex)}</div>
        <div class="frow" style="margin-top:4px"><label>墙面基色</label><input id="pWallCol" type="color" value="${w.wallBase || '#e6e1d8'}" style="width:64px;height:26px;padding:0;border:1px solid var(--border-strong);border-radius:var(--r-sm)"></div>
      </details>
      <div class="note">拖动墙上两个橙色端点可改变走向与长度；端点坐标输入会同步刷新长度和方向。</div>
      <div class="btnrow"><button class="btn" id="pFlip">翻转方向 (A↔B)</button><button class="btn" id="pDel">删除此墙 (Del)</button></div>`;
    bindNum('pAx', v => { w.ax = v; rebuild(); refreshProps(); });
    bindNum('pAz', v => { w.az = v; rebuild(); refreshProps(); });
    bindNum('pBx', v => { w.bx = v; rebuild(); refreshProps(); });
    bindNum('pBz', v => { w.bz = v; rebuild(); refreshProps(); });
    bindNum('pLen', v => {
      const d = Math.hypot(dx, dz) || 1;
      w.bx = w.ax + dx / d * v; w.bz = w.az + dz / d * v; rebuild(); refreshProps();
    });
    bindNum('pTh', v => { w.th = v; rebuild(); });
    bindNum('pH', v => { w.h = v; rebuild(); });
    // 半墙:启用开关 + 分界线高度
    $('pHWYes').onclick = () => {
      if (w.halfWall) return;
      pushUndo();
      w.halfWall = true;
      if (w.halfHeight == null) w.halfHeight = 1.2;
      rebuild(); refreshProps();
    };
    $('pHWNo').onclick = () => {
      if (!w.halfWall) return;
      pushUndo();
      delete w.halfWall;
      rebuild(); refreshProps();
    };
    const hhInput = $('pHH');
    if (hhInput) {
      let _hhCommitted = false;
      hhInput.addEventListener('input', () => {
        const max = (w.h != null ? w.h : doc.wallH) - 0.1;
        const v = Math.max(0.2, Math.min(parseFloat(hhInput.value) || 1.2, max));
        if (w.halfWall) {
          _hhCommitted = true;
          w.halfHeight = v;
          rebuild(); refreshProps();
        }
      });
      hhInput.addEventListener('change', () => {
        if (w.halfWall && _hhCommitted) {
          _hhCommitted = false;
          pushUndo();
        }
      });
    }
    propsBody.querySelectorAll('.sw').forEach(b => b.onclick = () => {
      pushUndo();
      if (b.dataset.c) w[b.dataset.k] = b.dataset.c; else delete w[b.dataset.k];
      rebuild(); refreshProps();
    });
    bindTexPickers(propsBody, w, 'wallTex', () => { pushUndo(); rebuild(); refreshProps(); });
    const wcol = document.getElementById('pWallCol');
    if (wcol) wcol.addEventListener('input', () => { w.wallBase = wcol.value; rebuild(); });
    $('pWLockY').onclick = () => {
      if (w.locked) return;
      pushUndo(); w.locked = true; rebuild(); refreshProps(); outlineTree && outlineTree.render(); flash('墙已锁定', 'warn', 1500);
    };
    $('pWLockN').onclick = () => {
      if (!w.locked) return;
      pushUndo(); delete w.locked; rebuild(); refreshProps(); outlineTree && outlineTree.render(); flash('墙已解锁');
    };
    // 玻璃墙开关:切换 w.glass 标志 + 重新应用主题色(玻璃墙自身忽略主题,所以关掉时回填当前主题)
    const pgY = $('pGlassY'), pgN = $('pGlassN');
    if (pgY) pgY.onclick = () => {
      if (w.glass) return;
      pushUndo(); w.glass = true; rebuild(); refreshProps();
    };
    if (pgN) pgN.onclick = () => {
      if (!w.glass) return;
      pushUndo(); delete w.glass;
      const t = THEMES[THEME]; if (t) { w.wallBase = t.wall.base; w.wallTex = t.wall.tex || undefined; }
      rebuild(); refreshProps();
    };
    $('pFlip').onclick = () => {
      pushUndo();
      const ax = w.ax, az = w.az;
      w.ax = w.bx; w.az = w.bz; w.bx = ax; w.bz = az;
      rebuild(); refreshProps();
    };
    $('pDel').onclick = () => { pushUndo(); doc.walls.splice(sel.wi, 1); sel = null; rebuild(); refreshProps(); };
    return;
  }
  if (sel.kind === 'door' || sel.kind === 'window' || sel.kind === 'opening') {
    const w = doc.walls[sel.wi], op = w.openings[sel.oi];
    const isDoor = sel.kind === 'door' || (sel.kind === 'opening' && op.type === 'door');
    if (isDoor) {
      const wallLen = Math.hypot(w.bx - w.ax, w.bz - w.az);
      const distA = (op.t * wallLen).toFixed(2);
      const curKind = op.kind || 'single';
      const doorOpts = DOOR_STYLES.map(s =>
        `<button class="styleBtn ${curKind === s.k ? 'on' : ''}" data-kind="${s.k}">${s.icon} ${s.n}</button>`).join('');
      const leafOpts = LEAF_PRESETS.map(p =>
        `<button class="sw ${op.leafColor === p.c ? 'on' : ''}" data-leaf="${p.c}" title="${p.n}" style="background:${p.c}"></button>`).join('');
      propsBody.innerHTML = `
        <h3>门（墙 #${sel.wi + 1}）</h3>
        <details class="propSection" open>
          <summary class="propSecTitle">几何尺寸</summary>
          <div class="frow"><label>宽度 (m)</label><input id="pW" type="number" step="0.05" min="0.5" max="2.4" value="${op.width}"></div>
          <div class="frow"><label>高度 (m)</label><input id="pH" type="number" step="0.05" min="0.5" max="${Math.max(0.5, ((w.h != null ? w.h : doc.wallH) || 2.75) - 0.15).toFixed(2)}" value="${op.height}"></div>
          <div class="frow"><label>沿墙位置 t (0-1)</label><input id="pT" type="number" step="0.01" min="0.05" max="0.95" value="${op.t.toFixed(2)}"></div>
          <div class="frow"><label>距 A 端 (m)</label><input id="pDistA" type="number" step="0.05" min="0" max="${wallLen.toFixed(2)}" value="${distA}"></div>
        </details>
        <details class="propSection" open>
          <summary class="propSecTitle">样式 / 朝向</summary>
          <div class="styleRow">${doorOpts}</div>
          <!-- 拱形门已下线,门不再显示拱形 shape 行 -->
          <div class="frow"><label>铰链侧</label><div class="seg">
            <button id="pHL" class="${op.hinge === -1 ? 'on' : ''}">A 端</button>
            <button id="pHR" class="${op.hinge === 1 ? 'on' : ''}">B 端</button></div></div>
          <div class="frow"><label>开向</label><div class="seg">
            <button id="pFA" class="${!op.flip ? 'on' : ''}">一侧</button>
            <button id="pFB" class="${op.flip ? 'on' : ''}">另一侧</button></div></div>
        </details>
        <details class="propSection" open>
          <summary class="propSecTitle">外观</summary>
          <div class="frow" style="margin-bottom:2px"><label>门扇颜色</label></div>
          <div class="swgrid">${leafOpts}<button class="sw ${!op.leafColor || op.leafColor === 'default' ? 'on' : ''}" data-leaf="" title="恢复默认" style="background:#fff;color:#a00;font-weight:700">✕</button></div>
          <div class="frow" style="margin:8px 0 4px"><label>门扇纹理</label></div>
          <div class="styleRow">${renderTexPickerHTML('leafTex', op.leafTex)}</div>
        </details>
        <div class="frow"><label>开关状态</label><div class="seg">
            <button id="pOClosed" class="${!op.isOpen ? 'on' : ''}">关</button>
            <button id="pOOpen" class="${op.isOpen ? 'on' : ''}">开 90°</button></div></div>
        <div class="note">快捷键：R 换铰链边，T 翻转开向。沿墙拖动门可调整位置。</div>
        <div class="btnrow"><button class="btn" id="pDel">删除 (Del)</button></div>`;
      bindNum('pW', v => { op.width = v; rebuild(); });
      bindNum('pH', v => { op.height = v; rebuild(); });
      bindNum('pT', v => { op.t = Math.min(0.95, Math.max(0.05, v)); rebuild(); refreshProps(); });
      bindNum('pDistA', v => { op.t = Math.min(0.95, Math.max(0.05, v / wallLen)); rebuild(); refreshProps(); });
      propsBody.querySelectorAll('.styleBtn').forEach(b => b.onclick = () => {
        const newKind = b.dataset.kind;
        const oldKind = op.kind || 'single';
        if (oldKind !== 'double' && newKind === 'double') {
          op.width = Math.min(2.4, +(op.width * 2).toFixed(2));
        } else if (oldKind === 'double' && newKind !== 'double') {
          op.width = Math.max(0.5, +(op.width / 2).toFixed(2));
        }
        pushUndo(); op.kind = newKind; rebuild(); refreshProps();
      });
      propsBody.querySelectorAll('[data-leaf]').forEach(b => b.onclick = () => {
        pushUndo();
        if (b.dataset.leaf) op.leafColor = b.dataset.leaf; else delete op.leafColor;
        rebuild(); refreshProps();
      });
      bindTexPickers(propsBody, op, 'leafTex', () => { pushUndo(); rebuild(); refreshProps(); });
      $('pHL').onclick = () => { pushUndo(); op.hinge = -1; rebuild(); refreshProps(); };
      $('pHR').onclick = () => { pushUndo(); op.hinge = 1; rebuild(); refreshProps(); };
      $('pFA').onclick = () => { pushUndo(); op.flip = false; rebuild(); refreshProps(); };
      $('pFB').onclick = () => { pushUndo(); op.flip = true; rebuild(); refreshProps(); };
      if ($('pOClosed')) $('pOClosed').onclick = () => { pushUndo(); op.isOpen = false; rebuild(); refreshProps(); };
      if ($('pOOpen')) $('pOOpen').onclick = () => { pushUndo(); op.isOpen = true; rebuild(); refreshProps(); };
      $('pDel').onclick = () => { pushUndo(); w.openings.splice(sel.oi, 1); sel = null; rebuild(); refreshProps(); };
    } else {  // window
      const wallLenW = Math.hypot(w.bx - w.ax, w.bz - w.az);
      const distAW = (op.t * wallLenW).toFixed(2);
      const curKind = op.kind || 'single';
      const winOpts = WIN_STYLES.map(s =>
        `<button class="styleBtn ${curKind === s.k ? 'on' : ''}" data-kind="${s.k}">${s.icon} ${s.n}</button>`).join('');
      const leafOpts = LEAF_PRESETS.map(p =>
        `<button class="sw ${op.leafColor === p.c ? 'on' : ''}" data-leaf="${p.c}" title="${p.n}" style="background:${p.c}"></button>`).join('');
      const glassOpts = GLASS_PRESETS.map(p =>
        `<button class="sw ${op.glassColor === p.c ? 'on' : ''}" data-glass="${p.c}" title="${p.n}" style="background:${p.c}"></button>`).join('');
      propsBody.innerHTML = `
        <h3>窗（墙 #${sel.wi + 1}）</h3>
        <details class="propSection" open>
          <summary class="propSecTitle">几何尺寸</summary>
          <div class="frow"><label>宽度 (m)</label><input id="pW" type="number" step="0.05" min="0.4" max="2.4" value="${op.width}"></div>
          <div class="frow"><label>高度 (m)</label><input id="pH" type="number" step="0.05" min="0.3" max="${Math.max(0.3, ((w.h != null ? w.h : doc.wallH) || 2.75) - (op.sill || 0) - 0.05).toFixed(2)}" value="${op.height}"></div>
          <div class="frow"><label>窗台高 (m)</label><input id="pS" type="number" step="0.05" min="0" max="${Math.max(0, ((w.h != null ? w.h : doc.wallH) || 2.75) - (op.height || 0.9) - 0.05).toFixed(2)}" value="${op.sill}"></div>
          <div class="frow"><label>沿墙位置 t (0-1)</label><input id="pT" type="number" step="0.01" min="0.02" max="0.98" value="${op.t.toFixed(2)}"></div>
          <div class="frow"><label>距 A 端 (m)</label><input id="pDistA" type="number" step="0.05" min="0" max="${wallLenW.toFixed(2)}" value="${distAW}"></div>
        </details>
        <details class="propSection" open>
          <summary class="propSecTitle">样式</summary>
          <div class="styleRow">${winOpts}</div>
        </details>
        <details class="propSection" open>
          <summary class="propSecTitle">外观</summary>
          <div class="frow" style="margin-bottom:2px"><label>窗框颜色</label></div>
          <div class="swgrid">${leafOpts}<button class="sw ${!op.leafColor || op.leafColor === 'default' ? 'on' : ''}" data-leaf="" title="恢复默认" style="background:#fff;color:#a00;font-weight:700">✕</button></div>
          <div class="frow" style="margin:6px 0 2px"><label>玻璃颜色</label></div>
          <div class="swgrid">${glassOpts}<button class="sw ${!op.glassColor || op.glassColor === 'default' ? 'on' : ''}" data-glass="" title="恢复默认" style="background:#fff;color:#a00;font-weight:700">✕</button></div>
        </details>
        <div class="note">快捷键：W 选墙后可拖动窗体调整位置。窗台高度不能超过墙高 - 窗高。</div>
        <div class="btnrow"><button class="btn" id="pDel">删除 (Del)</button></div>`;
      bindNum('pW', v => { op.width = v; rebuild(); });
      bindNum('pH', v => { op.height = v; rebuild(); });
      bindNum('pS', v => { op.sill = v; rebuild(); });
      bindNum('pT', v => { op.t = Math.min(0.98, Math.max(0.02, v)); rebuild(); refreshProps(); });
      bindNum('pDistA', v => { op.t = Math.min(0.98, Math.max(0.02, v / wallLenW)); rebuild(); refreshProps(); });
      propsBody.querySelectorAll('.styleBtn').forEach(b => b.onclick = () => {
        pushUndo(); op.kind = b.dataset.kind; rebuild(); refreshProps();
      });
      propsBody.querySelectorAll('[data-leaf]').forEach(b => b.onclick = () => {
        pushUndo();
        if (b.dataset.leaf) op.leafColor = b.dataset.leaf; else delete op.leafColor;
        rebuild(); refreshProps();
      });
      bindTexPickers(propsBody, op, 'leafTex', () => { pushUndo(); rebuild(); refreshProps(); });
      propsBody.querySelectorAll('[data-glass]').forEach(b => b.onclick = () => {
        pushUndo();
        if (b.dataset.glass) op.glassColor = b.dataset.glass; else delete op.glassColor;
        rebuild(); refreshProps();
      });
      $('pDel').onclick = () => { pushUndo(); w.openings.splice(sel.oi, 1); sel = null; rebuild(); refreshProps(); };
    }
    return;
  }
  if (sel.kind === 'floor') {
    const f = doc.floors[sel.fi];
    const w = Math.abs(f.x2 - f.x1), d = Math.abs(f.z2 - f.z1);
    const cx = (f.x1 + f.x2) / 2, cz = (f.z1 + f.z2) / 2;
    const lv = f.lv || 0;
    const locked = !!f.locked;
    propsBody.innerHTML = `
      <h3>地面 #${sel.fi + 1}</h3>
      <details class="propSection" open>
        <summary class="propSecTitle">几何尺寸</summary>
        <div class="frow"><label>宽 (m)</label><input id="pFLW" type="number" step="0.1" min="0.2" value="${w.toFixed(2)}"></div>
        <div class="frow"><label>深 (m)</label><input id="pFLD" type="number" step="0.1" min="0.2" value="${d.toFixed(2)}"></div>
        <div class="frow"><label>厚度 (m)</label><input id="pFLTh" type="number" step="0.01" min="0.01" max="0.5" value="${(f.th || 0.05).toFixed(2)}"></div>
        <div class="frow"><label>中心 X (m)</label><input id="pFLCX" type="number" step="0.1" value="${cx.toFixed(2)}"></div>
        <div class="frow"><label>中心 Z (m)</label><input id="pFLCZ" type="number" step="0.1" value="${cz.toFixed(2)}"></div>
        <div class="frow"><label>所在楼层</label><input id="pFLLV" type="number" step="1" min="0" max="20" value="${lv}"></div>
      </details>
      <details class="propSection" open>
        <summary class="propSecTitle">外观</summary>
        <div class="frow"><label>颜色</label><input id="pFLCol" type="color" value="${f.color || '#dcd6cc'}" style="width:86px;height:24px;padding:0;border:2px solid;border-color:#555 #fff #fff #555"></div>
        <div class="frow" style="margin-top:8px"><label>纹理样式</label></div>
        <div class="styleRow">${renderTexPickerHTML('tex', f.tex)}</div>
        <div class="frow"><label>锁定</label><div class="seg">
          <button id="pFLLockY" class="${locked ? 'on' : ''}">是</button>
          <button id="pFLLockN" class="${!locked ? 'on' : ''}">否</button></div></div>
      </details>
      <div class="note">锁定后"识别房间 / 按墙围合生成"不会替换该地面，便于自定义地板。</div>
      <div class="btnrow"><button class="btn" id="pLRot">旋转 90° (R)</button></div>
      <div class="btnrow"><button class="btn" id="pDel">删除 (Del)</button></div>`;
    bindNum('pFLW', v => { const ccx = (f.x1 + f.x2) / 2; f.x1 = ccx - v / 2; f.x2 = ccx + v / 2; rebuild(); refreshProps(); });
    bindNum('pFLD', v => { const ccz = (f.z1 + f.z2) / 2; f.z1 = ccz - v / 2; f.z2 = ccz + v / 2; rebuild(); refreshProps(); });
    bindNum('pFLTh', v => { f.th = v; rebuild(); });
    bindNum('pFLCX', v => { const dx2 = (f.x2 - f.x1) / 2; f.x1 = v - dx2; f.x2 = v + dx2; rebuild(); refreshProps(); });
    bindNum('pFLCZ', v => { const dz2 = (f.z2 - f.z1) / 2; f.z1 = v - dz2; f.z2 = v + dz2; rebuild(); refreshProps(); });
    bindNum('pFLLV', v => { f.lv = Math.max(0, Math.round(v)); rebuild(); refreshProps(); });
    const fc2 = document.getElementById('pFLCol');
    if (fc2) fc2.addEventListener('input', () => { f.color = fc2.value; rebuild(); });
    bindTexPickers(propsBody, f, 'tex', () => { pushUndo(); rebuild(); refreshProps(); });
    $('pFLLockY').onclick = () => { pushUndo(); f.locked = true; rebuild(); refreshProps(); };
    $('pFLLockN').onclick = () => { pushUndo(); delete f.locked; rebuild(); refreshProps(); };
    $('pLRot').onclick = () => { pushUndo(); const cxx = (f.x1 + f.x2) / 2, czz = (f.z1 + f.z2) / 2, hw2 = (f.x2 - f.x1) / 2, hd2 = (f.z2 - f.z1) / 2; f.x1 = cxx - hd2; f.x2 = cxx + hd2; f.z1 = czz - hw2; f.z2 = czz + hw2; rebuild(); refreshProps(); };
    $('pDel').onclick = () => { pushUndo(); doc.floors.splice(sel.fi, 1); sel = null; rebuild(); refreshProps(); };
    return;
  }
  if (sel.kind === 'furniture') {
    const f = doc.furniture[sel.fi], def = FURN[f.type];
    const locked = !!f.locked;
    const flv = f.lv || 0;
    const options = Object.entries(FURN).map(([k, v]) =>
      `<option value="${k}" ${k === f.type ? 'selected' : ''}>${v.icon} ${v.name}</option>`).join('');
    propsBody.innerHTML = `
      <h3>${def ? def.icon + ' ' + def.name : '家具'}</h3>
      <details class="propSection" open>
        <summary class="propSecTitle">位置 / 尺寸</summary>
        <div class="frow"><label>类型</label><select id="pFType" style="max-width:160px">${options}</select></div>
        <div class="frow"><label>中心 X (m)</label><input id="pFX" type="number" step="0.05" value="${(f.x || 0).toFixed(2)}"></div>
        <div class="frow"><label>中心 Z (m)</label><input id="pFZ" type="number" step="0.05" value="${(f.z || 0).toFixed(2)}"></div>
        <div class="frow"><label>角度 (°)</label><input id="pFRot" type="number" step="15" value="${Math.round((f.rot || 0) * 180 / Math.PI)}"></div>
        <div class="frow"><label>缩放</label><input id="pFSc" type="number" step="0.1" min="0.3" max="3" value="${(f.scale || 1).toFixed(2)}"></div>
        <div class="frow"><label>楼层</label><input id="pFLv" type="number" step="1" min="0" max="20" value="${flv}"></div>
        <div class="frow"><label>占地 (只读)</label><span>${def.w.toFixed(2)} × ${def.d.toFixed(2)} m</span></div>
        <div class="frow"><label>锁定</label><div class="seg">
          <button id="pFLockY" class="${locked ? 'on' : ''}">是</button>
          <button id="pFLockN" class="${!locked ? 'on' : ''}">否</button></div></div>
      </details>
      <div class="note">F4 选择工具下可直接拖动移动；R 顺时针转 45°（Shift+R 逆时针，自动对齐 45° 网格）。</div>
      <div class="btnrow"><button class="btn" id="pRot">旋转 45° (R)</button></div>
      <div class="btnrow"><button class="btn" id="pDel">删除 (Del)</button></div>`;
    const selType = document.getElementById('pFType');
    if (selType) selType.addEventListener('change', () => { pushUndo(); f.type = selType.value; rebuild(); refreshProps(); });
    bindNum('pFX', v => { f.x = v; rebuild(); });
    bindNum('pFZ', v => { f.z = v; rebuild(); });
    bindNum('pFRot', v => { f.rot = (v % 360) * Math.PI / 180; rebuild(); refreshProps(); });
    bindNum('pFSc', v => { f.scale = Math.max(0.3, Math.min(3, v)); rebuild(); });
    bindNum('pFLv', v => { f.lv = Math.max(0, Math.round(v)); rebuild(); refreshProps(); });
    $('pFLockY').onclick = () => { pushUndo(); f.locked = true; rebuild(); refreshProps(); };
    $('pFLockN').onclick = () => { pushUndo(); delete f.locked; rebuild(); refreshProps(); };
    $('pRot').onclick = () => { pushUndo(); f.rot = stepRot45(f.rot || 0, 1); rebuild(); refreshProps(); };
    $('pDel').onclick = () => { pushUndo(); doc.furniture.splice(sel.fi, 1); sel = null; rebuild(); refreshProps(); };
    return;
  }
  if (sel.kind === 'stairs') {
    const s = doc.stairs[sel.si];
    const typeOpts = ['straight', 'lshape', 'spiral'].map(t =>
      `<button class="styleBtn ${s.type === t ? 'on' : ''}" data-stair="${t}">${{straight:'直跑',lshape:'L型',spiral:'螺旋'}[t]}</button>`).join('');
    propsBody.innerHTML = `
      <h3>楼梯 #${sel.si + 1}</h3>
      <details class="propSection" open>
        <summary class="propSecTitle">类型 / 几何</summary>
        <div class="styleRow">${typeOpts}</div>
        <div class="frow"><label>宽 (m)</label><input id="pSW" type="number" step="0.05" min="0.6" max="2.5" value="${(s.width || 0.9).toFixed(2)}"></div>
        <div class="frow"><label>踏步深 (m)</label><input id="pSD" type="number" step="0.05" min="1" max="6" value="${(s.depth || 3).toFixed(2)}"></div>
        <div class="frow"><label>总高 (m)</label><input id="pSH" type="number" step="0.05" min="0.6" max="6" value="${(s.height || 2.8).toFixed(2)}"></div>
        <div class="frow"><label>踏步数</label><input id="pSS" type="number" step="1" min="3" max="40" value="${s.steps || Math.round((s.height || 2.8) / 0.18)}"></div>
      </details>
      <details class="propSection" open>
        <summary class="propSecTitle">位置</summary>
        <div class="frow"><label>中心 X (m)</label><input id="pSX" type="number" step="0.05" value="${(s.x || 0).toFixed(2)}"></div>
        <div class="frow"><label>中心 Z (m)</label><input id="pSZ" type="number" step="0.05" value="${(s.z || 0).toFixed(2)}"></div>
        <div class="frow"><label>角度 (°)</label><input id="pSRot" type="number" step="15" value="${Math.round((s.rot || 0) * 180 / Math.PI)}"></div>
        <div class="frow"><label>楼层</label><input id="pSLv" type="number" step="1" min="0" max="20" value="${s.lv || 0}"></div>
      </details>
      <div class="btnrow"><button class="btn" id="pSRot45">旋转 45° (R)</button></div>
      <div class="btnrow"><button class="btn" id="pDel">删除 (Del)</button></div>`;
    propsBody.querySelectorAll('[data-stair]').forEach(b => b.onclick = () => {
      pushUndo(); s.type = b.dataset.stair;
      // 切到螺旋时自动放宽宽
      if (s.type === 'spiral' && (s.width || 0.9) < 1.2) s.width = 1.4;
      rebuild(); refreshProps();
    });
    bindNum('pSW', v => { s.width = v; rebuild(); });
    bindNum('pSD', v => { s.depth = v; rebuild(); });
    bindNum('pSH', v => { s.height = v; rebuild(); refreshProps(); });
    bindNum('pSS', v => { s.steps = v; rebuild(); });
    bindNum('pSX', v => { s.x = v; rebuild(); });
    bindNum('pSZ', v => { s.z = v; rebuild(); });
    bindNum('pSRot', v => { s.rot = (v % 360) * Math.PI / 180; rebuild(); refreshProps(); });
    bindNum('pSLv', v => { s.lv = Math.max(0, Math.round(v)); rebuild(); refreshProps(); });
    $('pSRot45').onclick = () => { pushUndo(); s.rot = stepRot45(s.rot || 0, 1); rebuild(); refreshProps(); };
    $('pDel').onclick = () => { pushUndo(); doc.stairs.splice(sel.si, 1); sel = null; rebuild(); refreshProps(); };
    return;
  }
  // window 分支已并入上面 door/window 联合块，到此不会执行
}
// 数字输入绑定：±按钮 + Shift+滚轮微调 + 双击复位
// opts: { default: 数字, step: 0.01, page: 0.1, min, max, onCommit }
function bindNum(id, fn, opts = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const step = +(el.step || opts.step || 0.01);
  const min = el.min !== '' ? +el.min : (opts.min ?? -Infinity);
  const max = el.max !== '' ? +el.max : (opts.max ?? Infinity);
  const def = opts.default != null ? opts.default : +el.value;

const commit = (v, opts = {}) => {
    const { undo = true } = opts;
    v = Math.max(min, Math.min(max, +v.toFixed(4)));
    el.value = v;
    if (undo) pushUndo();
    fn(v);
  };

  // 立即生效:每次按键都尝试 commit(input 事件,实时)。
  // 但只第一次入栈(记录"编辑前"快照),后续 input 只生效不入栈。
  // 这样一次完整编辑 = 1 个 undo 节点 = undo 一次回退到原值。
  let _editing = false;
  el.addEventListener('input', () => {
    const raw = el.value;
    if (raw === '' || raw === '-' || raw === '.' || raw === '-.') return;
    const v = parseFloat(raw);
    if (!isNaN(v)) {
      if (!_editing) {
        _editing = true;
        pushUndo();             // 入栈一次:起点快照
      }
      fn(Math.max(min, Math.min(max, v)));   // 实时生效,不入栈
    }
  });

  // change:重置编辑标志(±按钮/滚轮/双击走 change 或直接调 commit)
  el.addEventListener('change', () => {
    _editing = false;
    const v = parseFloat(el.value);
    if (!isNaN(v) && el.value !== String(parseFloat(el.value))) {
      // 用户在 change 时值不是合法的数字串,补一下
      el.value = Math.max(min, Math.min(max, v));
    }
  });

  // blur 也重置,避免下次聚焦时残留
  el.addEventListener('blur', () => { _editing = false; });

  // Shift+滚轮：微调；普通滚轮：缩放
  el.addEventListener('wheel', e => {
    if (!e.shiftKey) return;
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    const cur = parseFloat(el.value) || 0;
    commit(cur + dir * step);
  }, { passive: false });

  // 双击复位默认值
  el.addEventListener('dblclick', () => commit(def));

  // 输入框包裹一层 flex，让相邻的 ±按钮对齐
  if (el.parentElement && !el.parentElement.classList.contains('num-wrap')) {
    const wrap = document.createElement('div');
    wrap.className = 'num-wrap';
    el.parentElement.insertBefore(wrap, el);
    wrap.appendChild(el);
    el.classList.add('num-input');
    const minus = document.createElement('button');
    minus.className = 'num-btn'; minus.type = 'button'; minus.textContent = '−';
    minus.title = `−${step}`; minus.tabIndex = -1;
    const plus = document.createElement('button');
    plus.className = 'num-btn'; plus.type = 'button'; plus.textContent = '+';
    plus.title = `+${step}`; plus.tabIndex = -1;
    wrap.appendChild(minus); wrap.appendChild(plus);
    const click = d => () => {
      const cur = parseFloat(el.value) || 0;
      commit(cur + d * step);
    };
    minus.onclick = click(-1); plus.onclick = click(1);
  }
}

// ============================================================
// 工具切换 / 状态栏
// ============================================================
const HINTS = {
  pan: '移动模式：左键拖动 = 平移画布（不会选中/拖动任何对象）· 滚轮缩放 · 右键拖动 = 旋转视角',
  select: '左键选择并拖拽（墙/端点/门窗）· 空白处左键拖 = 框选（Shift 加选）· 右键拖动 = 旋转视角 · 方向键微移 5cm（Shift×10）· Del 删除',
  wall: '左键画墙 · Tab 切 单段/链式/围房 · 输入数字精确定长 · 默认正交(水平/垂直)· Shift 临时放开可斜着画 · Enter/Esc 结束',
  door: '两步放门：① 左键点选一面墙 → ② 沿墙移动吸附后左键放置（把手自动朝向您）· R 换铰链 · T 翻把手/开向 · Esc 重选墙',
  window: '两步放窗：① 左键点选一面墙 → ② 沿墙移动吸附后左键放置（可连续）· Esc 重选墙 · 右键拖动旋转视角',
  delete: '左键点击要删除的墙/门/窗 · 空白处左键拖动 = 旋转整个视图',
  floor: '两步画地面：左键定第一角 → 移动预览 → 左键定对角 · 吸附墙角/网格 · Esc 取消',
  furn: '两步放家具：① 右侧面板选家具 → ② 空白处左键放置（可连续）· R 旋转 45° 自动对齐 · 靠近墙 0.3m 自动贴齐靠墙 · Alt 强制不贴 · F4 返回选择',
  stairs: '左键放置楼梯(直跑/L型/螺旋,左侧面板切换)· 也可在面板选楼梯家具放置 · Esc 结束',
};
// 工具对应的光标(移动模式=抓手,选择=默认,其余=十字)
function _toolCursor() {
  return tool === 'pan' ? 'grab' : (tool === 'select' ? 'default' : 'crosshair');
}
function setTool(t) {
  tool = t;
  chain = null; typedLen = ''; polyPts = []; clearPreview(); clearGhost(); clearFloorPreview();
  floorA = null; placeWall = null; hoverWi = null;
  // 切到 furn/wall/door/window/floor/delete 时清掉选中，避免属性面板被 "选中对象" 视图占据看不到工具/库
  if (t !== 'select' && t !== 'pan' && sel) { sel = null; }
  document.querySelectorAll('.railbtn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  renderer.domElement.style.cursor = _toolCursor();
  const _svg2dEl = document.getElementById('svg2d');
  if (_svg2dEl) _svg2dEl.style.cursor = _toolCursor();   // 2D 俯视层的光标
  buildHandles();
  setWallModeUI();
  setHint(); refreshProps();
}
function setWallModeUI() {
  const seg = document.getElementById('wallModeSeg');
  if (!seg) return;
  seg.style.display = (tool === 'wall') ? '' : 'none';
  seg.querySelectorAll('[data-wm]').forEach(b =>
    b.classList.toggle('active', b.dataset.wm === wallMode));
  const ob = document.getElementById('btnOrtho');
  if (ob) ob.classList.toggle('active', orthoLock);
}
function setHint() {
  let s = HINTS[tool];
  if (tool === 'wall') s += ` ｜ 模式：${WALL_MODE_NAMES[wallMode]}（Tab 切换）`;
  if (tool === 'wall') s += ` ｜ 角度：${orthoLock ? '正交(按 Shift 自由)' : '自由(按 Shift 正交)'}`;
  document.getElementById('hint').textContent = s + (topView ? ' ｜ 当前：俯视正交' : ' ｜ 当前：透视');
}
function flash(msg, type = 'info') {
  toast(msg, type, 1800);
}

// 通用 Toast 系统（右下角堆叠）
const toastWrap = document.getElementById('toastWrap');
const toastIcons = { info: 'ℹ', success: '✓', warn: '⚠', error: '✕' };
function toast(msg, type = 'info', duration = 4000) {
  if (!toastWrap) { console.log('[toast]', type, msg); return { close: () => {} }; }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span class="ic">${toastIcons[type] || '•'}</span><span class="msg">${msg}</span><button class="x" aria-label="关闭">×</button>`;
  const close = () => {
    if (el.classList.contains('removing')) return;
    el.classList.add('removing');
    setTimeout(() => el.remove(), 240);
  };
  el.querySelector('.x').onclick = close;
  el.onmouseenter = () => clearTimeout(el._t);
  el.onmouseleave = () => { if (duration > 0) el._t = setTimeout(close, 1200); };
  toastWrap.appendChild(el);
  if (duration > 0) el._t = setTimeout(close, type === 'error' ? Math.max(duration, 6000) : duration);
  return { close };
}

// 撤销栈提示
function refreshUndoTip() {
  const tip = document.getElementById('undoTip');
  if (!tip) return;
  const u = undoStack.length, r = redoStack.length;
  tip.textContent = (u || r) ? `↶ ${u}  ↷ ${r}` : '';
  tip.title = u ? `可撤销 ${u} 步\n可重做 ${r} 步` : '';
  syncUndoButtons();
}

// ───────────────── 大纲树 ─────────────────
const outlineTree = (() => {
  const body = document.getElementById('otBody');
  const countEl = document.getElementById('otCount');
  let lastLv = -1;

  function visible(kind, idx) {
    return doc.hidden && doc.hidden[`${kind}:${idx}`];
  }
  function kindPlural(kind) { return kind === 'wall' ? 'walls' : kind === 'floor' ? 'floors' : kind + 's'; }
  function label(kind, idx) {
    if (kind === 'wall') {
      const w = doc.walls[idx];
      const L = Math.hypot(w.bx - w.ax, w.bz - w.az);
      return `${w.glass ? '玻璃墙' : '墙'} #${idx + 1} · ${L.toFixed(2)} m · ${(w.openings || []).length} 洞口`;
    }
    if (kind === 'floor') {
      const f = doc.floors[idx];
      const w = Math.abs(f.x2 - f.x1), d = Math.abs(f.z2 - f.z1);
      return `地面 #${idx + 1} · ${w.toFixed(2)} × ${d.toFixed(2)}`;
    }
    if (kind === 'furniture') {
      const f = doc.furniture[idx];
      const def = FURN[f.type];
      return (def ? def.icon + ' ' : '') + (def ? def.name : '家具') + ' #${idx + 1}'.replace('${idx + 1}', idx + 1);
    }
    if (kind === 'stairs') {
      const s = doc.stairs[idx];
      const tName = { straight: '直跑', lshape: 'L 型', spiral: '螺旋' }[s.type] || '楼梯';
      return `⌇ ${tName} #${idx + 1} · ${s.steps || Math.round((s.height || 2.8) / 0.18)} 级`;
    }
    return '';
  }
  function render() {
    if (!body) return;
    if (typeof activeLv !== 'undefined' && activeLv !== lastLv) { lastLv = activeLv; }
    const groups = [
      { k: 'walls',     ic: '▥', t: '墙' },
      { k: 'floors',    ic: '▦', t: '地面' },
      { k: 'stairs',    ic: '⌇', t: '楼梯' },
      { k: 'furniture', ic: '⌂', t: '家具' },
    ];
    let html = '', n = 0;
    for (const g of groups) {
      const rawArr = doc[g.k] || [];
      const items = rawArr.map((_, i) => i).filter(i => {
        const o = doc[g.k][i];
        const lv = o.lv || 0;
        return lv === (typeof activeLv !== 'undefined' ? activeLv : 0);
      });
      if (!items.length) continue;
      html += `<div class="otGrp">${g.ic} ${g.t} <span style="float:right;opacity:.6">${items.length}</span></div>`;
      for (const i of items) {
        const singular = g.k.replace(/s$/, '');                       // walls→wall, floors→floor
        const isSel = _selHas(singular, i);
        const hid = !!visible(g.k, i);
        const obj = doc[g.k][i];
        const locked = !!obj.locked;
        const grouped = !!obj.gid;
        html += `<div class="otItem ${isSel ? 'sel' : ''} ${hid ? 'hidden' : ''} ${locked ? 'locked' : ''}" data-k="${singular}" data-i="${i}">
          <span class="ic">${g.ic}</span>
          <span class="lbl" title="${label(singular, i).replace(/"/g,'"')}">${grouped ? '⊞ ' : ''}${label(singular, i)}</span>
          <span class="lock" title="${locked ? '已锁定(点击解锁)' : '未锁定(点击锁定,锁定后不可拖动)'}">${locked ? '🔒' : '🔓'}</span>
          <span class="del" title="删除此对象">🗑</span>
          <span class="vis" title="${hid ? '显示' : '隐藏'}">${hid ? '🚫' : '👁'}</span>
        </div>`;
        n++;
      }
    }
    // 门窗作为墙的子级也展开
    let opHtml = '';
    let opCount = 0;
    (doc.walls || []).forEach((w, wi) => {
      (w.openings || []).forEach((op, oi) => {
        const lv = w.lv || 0;
        if (lv !== (typeof activeLv !== 'undefined' ? activeLv : 0)) return;
        const isSel = _selList().some(s => (s.kind === 'door' || s.kind === 'window' || s.kind === 'opening') && s.wi === wi && s.oi === oi);
        const isDoor = op.type === 'door';
        const isElev = isDoor && op.kind === 'elevator';
        opHtml += `<div class="otItem ${isSel ? 'sel' : ''}" data-k="opening" data-wi="${wi}" data-oi="${oi}">
          <span class="ic">${isElev ? '⊟' : (isDoor ? '🚪' : '🪟')}</span>
          <span class="lbl">${isElev ? '电梯门' : (isDoor ? '门' : '窗')} · 墙#${wi + 1}</span>
          <span class="vis" title="跳到墙上" style="opacity:.4">↗</span>
        </div>`;
        opCount++;
      });
    });
    if (opHtml) {
      html += `<div class="otGrp">▥ 门窗 <span style="float:right;opacity:.6">${opCount}</span></div>` + opHtml;
      n += opCount;
    }
    body.innerHTML = html || `<div class="otEmpty">本层无对象</div>`;
    if (countEl) countEl.textContent = n ? `${n} 项` : '';
  }
  // 点击：左半边选中；右侧三个小图标:🔒 锁定/🗑 删除/👁 隐藏
  body && body.addEventListener('click', e => {
    const it = e.target.closest('.otItem');
    if (!it) return;
    const k = it.dataset.k;
    // 锁定切换(门/窗项无 lock 图标,不会进这里)
    if (e.target.classList.contains('lock') && k !== 'opening') {
      const idx = +it.dataset.i;
      const obj = (k === 'wall') ? doc.walls[idx]
                : (k === 'floor') ? doc.floors[idx]
                : (k === 'furniture') ? doc.furniture[idx] : null;
      if (obj) {
        pushUndo();
        if (obj.locked) { delete obj.locked; flash('已解锁'); }
        else            { obj.locked = true; flash('已锁定(禁止拖动)', 'warn', 1500); }
        rebuild(); render();
      }
      return;
    }
    // 删除
    if (e.target.classList.contains('del') && k !== 'opening') {
      const idx = +it.dataset.i;
      const t = { kind: k, wi: idx, fi: idx };
      pushUndo();
      ctxDelete(t);
      // ctxDelete 内部 sel=null + rebuild + refreshProps;这里同步刷新大纲
      render();
      return;
    }
    if (e.target.classList.contains('vis')) {
      // 隐藏切换
      doc.hidden = doc.hidden || {};
  // 屋面功能已下线:旧档里的屋面数据直接剥离
  if ((doc.roofs || []).length) console.info('[normDoc] 已移除', doc.roofs.length, '个屋面(功能已下线)');
  delete doc.roofs;
      const key = (k === 'opening') ? `opening:${it.dataset.wi}:${it.dataset.oi}` : `${k}:${it.dataset.i}`;
      if (doc.hidden[key]) { delete doc.hidden[key]; flash('已显示'); }
      else { doc.hidden[key] = true; flash('已隐藏（仅大纲/视图，不影响数据）'); }
      rebuild(); render();
      return;
    }
    const item = k === 'wall' ? { kind: 'wall', wi: +it.dataset.i }
               : k === 'floor' ? { kind: 'floor', fi: +it.dataset.i }
               : k === 'stairs' ? { kind: 'stairs', si: +it.dataset.i }
               : k === 'furniture' ? { kind: 'furniture', fi: +it.dataset.i }
               : k === 'opening' ? { kind: 'opening', wi: +it.dataset.wi, oi: +it.dataset.oi }
               : null;
    if (!item) return;
    if (e.shiftKey) { _selToggle(item); }                 // Shift 加选 / 移出
    else if (k === 'opening') { _setSelItems([item]); }   // 门窗不展开分组
    else { _setSelItems(_expandGroupSel(item)); }         // 分组对象 → 选中整组
    rebuild(); refreshProps();
  });
  document.getElementById('otRefresh')?.addEventListener('click', () => render());
  document.getElementById('otHideAll')?.addEventListener('click', () => {
    doc.hidden = doc.hidden || {};
    (doc.walls || []).forEach((w, i) => { if ((w.lv || 0) === activeLv) doc.hidden[`wall:${i}`] = true; });
    (doc.floors || []).forEach((_, i) => { if ((doc.floors[i].lv || 0) === activeLv) doc.hidden[`floor:${i}`] = true; });
    (doc.stairs || []).forEach((_, i) => { if ((doc.stairs[i].lv || 0) === activeLv) doc.hidden[`stairs:${i}`] = true; });
    (doc.furniture || []).forEach((_, i) => { if ((doc.furniture[i].lv || 0) === activeLv) doc.hidden[`furniture:${i}`] = true; });
    rebuild(); render(); flash('当前层全部隐藏', 'success');
  });
  document.getElementById('otShowAll')?.addEventListener('click', () => {
    doc.hidden = {};
    rebuild(); render(); flash('全部已显示', 'success');
  });
  return { render };
})();

// Rail 侧页注册表:三个面板(files / theme / outline)共享一个互斥集合
// 注册的回调负责自身 .open 切换;helper 在打开任一面板前先关闭其它已开面板。
// 顺序无关,任何 toggle 都可以第一个注册。
const __railSidePanels = [];
function __registerRailSidePanel(name, closeFn) {
  __railSidePanels.push({ name, close: closeFn });
}
function __closeOtherRailSidePanels(exceptName) {
  for (const p of __railSidePanels) {
    if (p.name === exceptName) continue;
    p.close();
  }
}
globalThis.__registerRailSidePanel = __registerRailSidePanel;
globalThis.__closeOtherRailSidePanels = __closeOtherRailSidePanels;

document.querySelectorAll('.railbtn[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));

// 大纲按钮：toggle 左侧 outlinePanel（与 inspector 并排显示，可同时打开）
// 用户在 outline 里点击对象时,大纲面板保持展开,inspector 同步显示属性 → 两栏并列
(function () {
  const btn = document.getElementById('btnOutline');
  const panel = document.getElementById('outlinePanel');
  const inspector = document.getElementById('inspector');
  if (!btn || !panel) return;
  function toggle(force, opts) {
    const silent = opts && opts.silent;
    const willOpen = typeof force === 'boolean' ? force : !panel.classList.contains('open');
    // 打开前先关掉 rail 上的其它侧页(files / theme),保证同一时刻最多一个 .open
    if (willOpen) __closeOtherRailSidePanels('outline');
    panel.classList.toggle('open', willOpen);
    btn.classList.toggle('active', willOpen);
    // 不再隐藏 inspector: 大纲和 inspector 现在并排在左栏,可以同时显示
    if (inspector && willOpen) {
      inspector.classList.remove('collapsed-by-outline');
    }
    if (willOpen && typeof outlineTree !== 'undefined' && outlineTree.render) {
      outlineTree.render();
      if (!silent) flash('大纲面板已打开', 'success');
    } else if (!willOpen && !silent) {
      flash('大纲面板已关闭');
    }
  }
  btn.onclick = () => toggle();
  window.addEventListener('keydown', e => {
    if (e.key === 'F12') { e.preventDefault(); toggle(); }
  });
  // 注册到 rail 互斥集合;延迟到 IIFE 末尾再注册以保证 __railSidePanels 已声明
  __registerRailSidePanel('outline', () => toggle(false, { silent: true }));
  // 暴露给 E2E
  globalThis.__outlineToggle = toggle;
})();

// 文件工作区面板 toggle：默认收起,点击 rail「文件」按钮展开/收起
(function () {
  const btn = document.getElementById('btnFiles');
  const panel = document.getElementById('filesPanel');
  if (!btn || !panel) return;
  function toggle(force, opts) {
    const silent = opts && opts.silent;
    const willOpen = typeof force === 'boolean' ? force : !panel.classList.contains('open');
    // 打开前先关掉 rail 上的其它侧页(theme / outline),保证同一时刻最多一个 .open
    if (willOpen) __closeOtherRailSidePanels('files');
    panel.classList.toggle('open', willOpen);
    btn.classList.toggle('active', willOpen);
    if (typeof renderFilesPanel === 'function') renderFilesPanel();
    if (!silent) {
      if (willOpen) flash('文件工作区已打开', 'success');
      else          flash('文件工作区已关闭');
    }
  }
  btn.onclick = () => toggle();
  // 注册到 rail 互斥集合
  __registerRailSidePanel('files', () => toggle(false, { silent: true }));
  // 暴露给 E2E
  globalThis.__filesToggle = toggle;
})();

// 主题面板 toggle：默认收起,点击 rail「主题」按钮展开/收起
// 与 inspector/outline/filesPanel 左栏互斥:打开主题时关闭它们
(function () {
  const btn = document.getElementById('btnTheme');
  const panel = document.getElementById('themePanel');
  if (!btn || !panel) return;
  function toggle(force, opts) {
    const silent = opts && opts.silent;
    const willOpen = typeof force === 'boolean' ? force : !panel.classList.contains('open');
    // 打开前先关掉 rail 上的其它侧页(files / outline),统一通过注册表关闭
    if (willOpen) __closeOtherRailSidePanels('theme');
    panel.classList.toggle('open', willOpen);
    btn.classList.toggle('active', willOpen);
    // 打开主题时收起 inspector,避免左栏重叠
    if (willOpen) {
      const insp = document.getElementById('inspector');
      if (insp) { insp.classList.remove('open'); insp.classList.add('collapsed-by-theme'); }
      if (typeof renderThemePanel === 'function') renderThemePanel();
    } else {
      // 关闭主题时释放 collapsed-by-theme
      const insp = document.getElementById('inspector');
      if (insp) insp.classList.remove('collapsed-by-theme');
    }
    if (!silent) {
      if (willOpen) flash('主题面板已打开', 'success');
      else          flash('主题面板已关闭');
    }
  }
  btn.onclick = () => toggle();
  // 注册到 rail 互斥集合
  __registerRailSidePanel('theme', () => toggle(false, { silent: true }));
  // 暴露给 E2E
  globalThis.__themeToggle = toggle;
})();

// 画墙模式分段控件：单击切换
document.querySelectorAll('#wallModeSeg [data-wm]').forEach(b => {
  b.onclick = () => {
    wallMode = b.dataset.wm;
    polyPts = []; chain = null; typedLen = ''; clearPreview();
    setWallModeUI();
    flash(`画墙模式 → ${WALL_MODE_NAMES[wallMode]}`);
  };
});

// 「正交」按钮:切换画墙角度锁定。默认开(强制 90°);关闭后允许斜着画。
// 按住 Shift 临时反转(无论开关):开正交时 Shift=自由,关正交时 Shift=正交。
const btnOrtho = document.getElementById('btnOrtho');
if (btnOrtho) {
  btnOrtho.onclick = () => {
    orthoLock = !orthoLock;
    btnOrtho.classList.toggle('active', orthoLock);
    flash(orthoLock ? '正交锁定:画墙强制水平/垂直(按 Shift 临时放开可斜着画)'
                    : '正交已关:画墙可任意角度(按 Shift 临时正交)');
  };
}

setWallModeUI();

// ============================================================
// 顶栏 / 工具栏 / 楼层切换（Pascal 式布局）
// ============================================================
function refreshTopbar() {
  const seg = document.getElementById('lvSeg');
  if (!seg) return;
  seg.innerHTML = doc.levels.map((L, i) =>
    `<button class="tb ${i === activeLv ? 'active' : ''}" data-lv="${i}">${L.name}</button>`).join('')
    + `<button class="tb" id="tbAddLv" title="向上加一层">＋</button>`;
  seg.querySelectorAll('[data-lv]').forEach(b => b.onclick = () => {
    activeLv = +b.dataset.lv;
    controls.target.y = levelY(activeLv) + 0.8;
    rebuild(); refreshProps();
    flash(`已切换到 ${doc.levels[activeLv].name}（标高 ${levelY(activeLv).toFixed(2)} m）`);
  });
  const add = document.getElementById('tbAddLv');
  if (add) add.onclick = () => {
    pushUndo();
    const last = doc.levels[doc.levels.length - 1];
    doc.levels.push({ name: (doc.levels.length + 1) + 'F', elev: (last ? last.elev : 0) + 3 });
    activeLv = doc.levels.length - 1;
    controls.target.y = levelY(activeLv) + 0.8;
    rebuild(); refreshProps(); refreshTopbar();
    flash(`已添加 ${doc.levels[activeLv].name}`);
  };
  document.querySelectorAll('#lvModeSeg [data-lvm]').forEach(b => {
    b.classList.toggle('active', b.dataset.lvm === lvMode);
    b.onclick = () => {
      lvMode = b.dataset.lvm;
      controls.target.y = levelY(activeLv) + 0.8;
      rebuild(); refreshProps();
      flash(lvMode === 'stacked' ? '堆叠视图：按真实标高整栋显示' : lvMode === 'explode' ? '分解视图：各层垂直拉开便于逐层检查' : '单层视图：只显示当前选中楼层');
    };
  });
}

document.querySelectorAll('.railbtn[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
// 顶栏操作按钮（顶栏里 btnNew/btnOpen/btnSave 是死按钮已删除,快捷键走命令面板）
$('btnJson').onclick = exportJSON;
$('btnGLB').onclick = exportGLB;
if ($('btnDXF')) $('btnDXF').onclick = exportDXF;
globalThis.exportDXF = exportDXF;
$('btnUnderlay').onclick = importUnderlay;
if ($('btnImportModel')) $('btnImportModel').onclick = importModel;
if ($('btnImportPlan')) $('btnImportPlan').onclick = importPlanHtml;
if ($('btnImportAI'))   $('btnImportAI').onclick = importPlanHtmlFromAI;
$('btnRooms').onclick = detectRooms;
$('btnArea').onclick = toggleAreaLabels;
// 地面层锁定：禁止鼠标拖动 + 方向键微移（视图下拉菜单）
const _btnFLock = $('btnFloorLock');
function setFloorLocked(v, opts) {
  const skipRebuild = !!(opts && opts.skipRebuild);
  floorLocked = !!v;
  try { localStorage.setItem('tp3d_floorLocked', floorLocked ? '1' : '0'); } catch (e) {}
  if (_btnFLock) {
    _btnFLock.classList.toggle('on', floorLocked);
    const icon = _btnFLock.querySelector('.dicon');
    const lbl = _btnFLock.querySelector('.dlabel');
    const kb = _btnFLock.querySelector('.dkb');
    if (icon) icon.textContent = floorLocked ? '🔒' : '🔓';
    if (lbl) lbl.textContent = floorLocked ? '已锁定地面层（点击解锁）' : '锁定地面层（禁止移动）';
    if (kb) kb.textContent = floorLocked ? '已开启' : '关闭';
    _btnFLock.title = floorLocked ? '地面层已锁定：禁止通过鼠标移动' : '锁定地面层，禁止通过鼠标移动';
  }
  if (skipRebuild) return;
  // 解除可能存在的拖动状态，避免锁后还能继续拖
  if (floorLocked && drag && drag.mode === 'floor') drag = null;
  rebuild();
  refreshProps();
  toast(floorLocked ? '地面层已锁定：禁止移动' : '地面层已解锁', floorLocked ? 'warn' : 'success', 1600);
}
if (_btnFLock) {
  _btnFLock.onclick = () => setFloorLocked(!floorLocked);
  // 初始化按钮文案/图标:跳过 rebuild/refresh,因为 doc 此时可能还未赋值
  if (floorLocked) { setFloorLocked(true, { skipRebuild: true }); }
}

// 层高设置(无选中对象时也能用,顶栏「视图」下拉入口)
const _btnWallH = $('btnWallH');
function syncWallHKb() {
  const kb = _btnWallH && _btnWallH.querySelector('.dkb');
  if (kb) kb.textContent = (doc.wallH || 2.75).toFixed(2) + ' m';
}
function openWallHDialog() {
  const cur = doc.wallH || 2.75;
  tpDialog('层高设置',
    `<div class="note">设置新建墙的默认高度（已有墙的高度不受影响）。</div>
     <div class="frow" style="margin-top:12px"><label>层高 (m)</label>
       <input id="tpWallH" type="number" step="0.05" min="0.5" max="6" value="${cur.toFixed(2)}" style="flex:1"></div>`,
    [
      { t: '取消' },
      { t: '确定', primary: true, fn: () => {
        const v = parseFloat(document.getElementById('tpWallH').value);
        if (!isNaN(v) && v >= 0.5 && v <= 6) {
          pushUndo(); doc.wallH = v; rebuild(); refreshProps(); syncWallHKb();
          flash('层高已设为 ' + v.toFixed(2) + ' m');
        } else {
          flash('层高范围 0.5 ~ 6 m', 'warn');
        }
      }},
    ]
  );
}
if (_btnWallH) {
  _btnWallH.onclick = () => { closeAllDD(); openWallHDialog(); };
}

// 模型保存目录:设置 / 更改 / 取消关联
async function _pickAssetDir() {
  if (!DIR_PICKER_SUPPORT) {
    toast('当前浏览器不支持选择目录(仅 Chromium 系)', 'warn', 4000);
    return;
  }
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite' });
    await setAssetDirHandle(h);
    _syncAssetDirKb();
    toast(`已设置模型保存目录: ${h.name || '当前目录'}`, 'success', 2400);
    // 同步把已有未落盘的资产补一份到磁盘
    const missing = (doc.assets || []).filter(a => !a.dirStored);
    if (missing.length) {
      let ok = 0;
      for (const m of missing) {
        const rec = await assetGet(m.id);
        if (rec && rec.bytes) {
          try { await _writeAssetToDisk(m.id, rec.bytes); m.dirStored = true; ok++; } catch (e) { /* 跳过 */ }
        }
      }
      if (ok) { markUnsaved(true); toast(`已将 ${ok} 个已有模型同步到磁盘目录`, 'success', 2400); }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    toast('设置目录失败: ' + (e?.message || e), 'error', 4000);
  }
}
async function _clearAssetDir() {
  await clearAssetDirHandle();
  _syncAssetDirKb();
  toast('已取消关联(下次导入只会保存到本机数据库)', 'success', 2400);
}
const _btnAssetDir = $('btnAssetDir');
if (_btnAssetDir) {
  _btnAssetDir.onclick = () => {
    closeAllDD();
    const name = _assetDirDisplayName();
    tpDialog('模型保存目录',
      `<div class="note">
        导入的 3D 模型(GLB)会保存到这个磁盘目录,<b>项目文件夹拷走后模型也会跟着走</b>。<br>
        浏览器规则要求首次必须手动授权一次目录,之后不再询问。<br><br>
        <b>当前目录:</b> ${name ? `<code>${name}</code>` : '<i>未设置</i>'}<br><br>
        ${name ? '更改会<b>同步</b>已有模型到新目录(逐个复制)。取消关联则只留本机数据库副本。' : ''}
      </div>`,
      [
        { t: '关闭' },
        ...(name ? [{ t: '取消关联', fn: _clearAssetDir }] : []),
        { t: name ? '更改…' : '选目录…', primary: true, fn: _pickAssetDir },
      ]);
  };
}

// 底图设置(无选中对象时也能用)
const _btnUlaySet = $('btnUnderlaySet');
function syncUnderlayKb() {
  const kb = _btnUlaySet && _btnUlaySet.querySelector('.dkb');
  if (!kb) return;
  if (doc.underlay) {
    kb.textContent = doc.underlay.visible !== false ? '已加载' : '已隐藏';
  } else {
    kb.textContent = '未导入';
  }
}
function openUnderlaySetDialog() {
  if (!doc.underlay) {
    tpDialog('底图设置', `<div class="note">当前没有底图。请先在「导入」下拉里加载平面图底图。</div>`,
      [{ t: '关闭' }, { t: '导入底图', primary: true, fn: importUnderlay }]);
    return;
  }
  const u = doc.underlay;
  tpDialog('底图设置',
    `<div class="frow"><label>宽度 (m)</label>
       <input id="tpUW" type="number" step="0.25" value="${u.w.toFixed(2)}" style="flex:1"></div>
     <div class="frow"><label>不透明度</label>
       <input id="tpUO" type="number" step="0.05" min="0.05" max="1" value="${u.opacity.toFixed(2)}" style="flex:1"></div>
     <div class="frow"><label>中心 X (m)</label>
       <input id="tpUCX" type="number" step="0.1" value="${u.cx.toFixed(2)}" style="flex:1"></div>
     <div class="frow"><label>中心 Z (m)</label>
       <input id="tpUCZ" type="number" step="0.1" value="${u.cz.toFixed(2)}" style="flex:1"></div>
     <div class="note">提示：导入按钮在「导入」下拉菜单里。</div>`,
    [
      { t: '取消' },
      { t: u.visible !== false ? '隐藏' : '显示', fn: () => {
        pushUndo(); u.visible = !(u.visible !== false); rebuild(); refreshProps(); syncUnderlayKb();
      }},
      { t: '确定', primary: true, fn: () => {
        const w  = parseFloat(document.getElementById('tpUW').value);
        const o  = parseFloat(document.getElementById('tpUO').value);
        const cx = parseFloat(document.getElementById('tpUCX').value);
        const cz = parseFloat(document.getElementById('tpUCZ').value);
        if (isNaN(w) || w < 0.1) return flash('宽度无效', 'warn');
        pushUndo();
        u.w = w; u.opacity = isNaN(o) ? u.opacity : Math.max(0.05, Math.min(1, o));
        if (!isNaN(cx)) u.cx = cx;
        if (!isNaN(cz)) u.cz = cz;
        rebuild(); refreshProps(); syncUnderlayKb();
        flash('底图已更新');
      }},
    ]
  );
}
if (_btnUlaySet) {
  _btnUlaySet.onclick = () => { closeAllDD(); openUnderlaySetDialog(); };
}

// 启动时同步两个 kb 标签
function _syncTopbarKb() {
  syncWallHKb();
  syncUnderlayKb();
  _syncAssetDirKb();
}
function _syncAssetDirKb() {
  const kb = $('btnAssetDirKb');
  const item = $('btnAssetDir');
  if (!item) return;
  if (!DIR_PICKER_SUPPORT) { item.style.display = 'none'; return; }
  item.style.display = '';
  if (!kb) return;
  const name = _assetDirDisplayName();
  kb.textContent = name ? `📁 ${name}` : '未设置';
}
// 顶栏下拉菜单
function closeAllDD() { document.querySelectorAll('.ddrop.open').forEach(d => d.classList.remove('open')); }
document.querySelectorAll('.ddrop').forEach(d => {
  const trg = d.querySelector('.dtrigger');
  if (!trg) return;
  trg.onclick = (e) => {
    e.stopPropagation();
    const wasOpen = d.classList.contains('open');
    closeAllDD();
    if (!wasOpen) d.classList.add('open');
  };
  d.querySelectorAll('.ditem').forEach(it => {
    it.addEventListener('click', () => closeAllDD());
  });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.ddrop')) closeAllDD();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllDD();
});
refreshUndoTip();
syncUndoButtons();

// ── 右键构件菜单（Pascal node-action-menu 式）──
const ctxMenu = document.getElementById('ctxMenu');
let rdownXY = null, ctxTarget = null;
renderer.domElement.addEventListener('pointerdown', e => {
  if (e.button === 2) {
    rdownXY = [e.clientX, e.clientY];
    rOrbit = { x: e.clientX, y: e.clientY };
  }
});
function ctxDuplicate(h) {
  pushUndo();
  if (h.kind === 'wall') {
    const w0 = doc.walls[h.wi];
    const dx = w0.bx - w0.ax, dz = w0.bz - w0.az;
    const L = Math.hypot(dx, dz) || 1;
    const o = w0.th + 0.1;
    const nw = JSON.parse(JSON.stringify(w0));
    nw.ax += -dz / L * o; nw.az += dx / L * o;
    nw.bx += -dz / L * o; nw.bz += dx / L * o;
    doc.walls.push(nw);
    sel = { kind: 'wall', wi: doc.walls.length - 1 };
  } else if (h.kind === 'furniture') {
    const f0 = doc.furniture[h.fi];
    // 智能偏移: 若贴墙,朝墙反方向移动 0.5m;否则对角线 +0.5/+0.5
    const fp = { x: f0.x, z: f0.z };
    const wallNear = nearestWall(fp, 0.3);
    let nf;
    if (wallNear) {
      // 沿墙面法线推 0.5m,保持与原家具同侧(避免穿墙)
      const wDx = doc.walls[wallNear.wi].bx - doc.walls[wallNear.wi].ax;
      const wDz = doc.walls[wallNear.wi].bz - doc.walls[wallNear.wi].az;
      const ang = Math.atan2(wDz, wDx);
      const nx = Math.sin(ang), nz = -Math.cos(ang);
      // 计算原家具相对墙点的法线分量:正=一侧,负=另一侧
      const sideDot = (fp.x - wallNear.px) * nx + (fp.z - wallNear.pz) * nz;
      const dir = sideDot >= 0 ? 1 : -1;
      nf = { ...f0, x: wallNear.px + nx * 0.5 * dir, z: wallNear.pz + nz * 0.5 * dir };
    } else {
      nf = { ...f0, x: f0.x + 0.5, z: f0.z + 0.5 };
    }
    doc.furniture.push(nf);
    sel = { kind: 'furniture', fi: doc.furniture.length - 1 };
  } else if (h.kind === 'floor') {
    const f0 = doc.floors[h.fi];
    const nf = JSON.parse(JSON.stringify(f0));
    nf.x1 += 0.5; nf.x2 += 0.5; nf.z1 += 0.5; nf.z2 += 0.5;
    if (nf.strips) nf.strips = nf.strips.map(([za, zb, xa, xb]) => [za + 0.5, zb + 0.5, xa + 0.5, xb + 0.5]);
    doc.floors.push(nf);
    sel = { kind: 'floor', fi: doc.floors.length - 1 };
  } else {
    const w0 = doc.walls[h.wi], op0 = w0.openings[h.oi];
    let t = op0.t + (op0.width + 0.1) / Math.hypot(w0.bx - w0.ax, w0.bz - w0.az);
    t = Math.min(0.94, t);
    w0.openings.push({ ...op0, t });
    sel = { kind: h.kind, wi: h.wi, oi: w0.openings.length - 1 };
  }
  rebuild(); refreshProps();
}
renderer.domElement.addEventListener('contextmenu', e => {
  e.preventDefault();
  const r = renderer.domElement.getBoundingClientRect();
  if (rdownXY && Math.hypot(e.clientX - rdownXY[0], e.clientY - rdownXY[1]) > 5) { ctxMenu.style.display = 'none'; return; }
  pointerNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointerNdc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, activeCam);
  const hits = raycaster.intersectObjects(pickMeshes, true).filter(h => {
    let o = h.object;
    while (o) { if (o.visible === false) return false; o = o.parent; }
    return true;
  });
  if (!hits.length) { ctxMenu.style.display = 'none'; return; }
  let o = hits[0].object;
  while (o && !(o.userData && o.userData.kind)) o = o.parent;
  const ud = o && o.userData ? { ...o.userData } : null;
  // InstancedMesh:instanceId → doc.fi
  if (ud && hits[0].instanceId != null && o.userData.instanceMap) {
    ud.fi = o.userData.instanceMap.get(hits[0].instanceId);
  }
  if (!ud || !ud.kind) { ctxMenu.style.display = 'none'; return; }
  ctxTarget = { kind: ud.kind, wi: ud.wi ?? 0, oi: ud.oi, fi: ud.fi, si: ud.si, ri: ud.ri };
  const items = [];
  if (ud.kind === 'door') items.push({ t: '翻把手/开向', kb: 'T', fn: () => { pushUndo(); const op = doc.walls[ctxTarget.wi].openings[ctxTarget.oi]; op.flip = !op.flip; rebuild(); refreshProps(); flash('已翻转开向', 'success'); } });
  if (ud.kind === 'furniture') items.push({ t: '旋转 45°', kb: 'R', fn: () => { pushUndo(); const f = doc.furniture[ctxTarget.fi]; f.rot = stepRot45(f.rot || 0, 1); rebuild(); refreshProps(); flash('已旋转 45°', 'success'); } });
  if (ud.kind === 'floor' && !doc.floors[ctxTarget.fi].strips) items.push({ t: '旋转 90°', kb: 'R', fn: () => { pushUndo(); const f = doc.floors[ctxTarget.fi]; const cx = (f.x1 + f.x2) / 2, cz = (f.z1 + f.z2) / 2, hw = (f.x2 - f.x1) / 2, hd = (f.z2 - f.z1) / 2; f.x1 = cx - hd; f.x2 = cx + hd; f.z1 = cz - hw; f.z2 = cz + hw; rebuild(); refreshProps(); flash('已旋转 90°', 'success'); } });
  items.push({ t: '复制', kb: 'Ctrl+D', fn: () => { ctxDuplicate(ctxTarget); flash('已复制', 'success'); } });
  if (sel && (sel.kind === 'wall' || sel.kind === 'furniture' || sel.kind === 'floor' || sel.kind === 'opening')) {
    items.push({ t: '撤销最近一步', kb: 'Ctrl+Z', fn: () => undo() });
  }
  items.push({ sep: true });
  items.push({ t: '删除', danger: true, kb: 'Del', fn: () => { ctxDelete(ctxTarget); } });
  ctxMenu.innerHTML = items.map((it, i) =>
    it.sep ? '<div class="csep"></div>' : `<div class="ci ${it.danger ? 'danger' : ''}" data-i="${i}"><span class="lbl">${it.t}</span><span class="kb">${it.kb || ''}</span></div>`).join('');
  ctxMenu.style.display = 'block';
  // 边界：菜单宽高未知，做最小矩形限制
  const mw = ctxMenu.offsetWidth || 180, mh = ctxMenu.offsetHeight || items.length * 32;
  ctxMenu.style.left = Math.max(8, Math.min(e.clientX - r.left, r.width - mw - 8)) + 'px';
  ctxMenu.style.top = Math.max(8, Math.min(e.clientY - r.top, r.height - mh - 8)) + 'px';
  ctxMenu.querySelectorAll('.ci').forEach(el => el.onclick = () => {
    const it = items[+el.dataset.i];
    ctxMenu.style.display = 'none';
    it.fn && it.fn();
  });
});
function ctxDelete(t) {
  if (t.kind === 'wall') doc.walls.splice(t.wi, 1);
  else if (t.kind === 'furniture') doc.furniture.splice(t.fi, 1);
  else if (t.kind === 'floor') doc.floors.splice(t.fi, 1);
  else if (t.kind === 'stairs') doc.stairs.splice(t.si, 1);
  else doc.walls[t.wi].openings.splice(t.oi, 1);
  sel = null; _selMirror = null; rebuild(); refreshProps(); flash('已删除');
}
document.addEventListener('pointerdown', e => {
  if (!ctxMenu.contains(e.target)) ctxMenu.style.display = 'none';
});

// ============================================================
// 对话框
// ============================================================// ============================================================
// 对话框
// ============================================================
const overlay = document.getElementById('overlay');
function tpDialog(title, bodyHTML, buttons = [{ t: '关闭' }]) {
  const isPrimary = (i) => i === buttons.length - 1;
  overlay.innerHTML = `<div class="tpdlg"><h3>${title}</h3><div class="body">${bodyHTML}</div><div class="foot"></div></div>`;
  const foot = overlay.querySelector('.foot');
  buttons.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.className = 'btn' + (isPrimary(i) ? ' primary' : '');
    btn.textContent = b.t;
    btn.onclick = () => { hideDialog(); b.fn && b.fn(); };
    foot.appendChild(btn);
  });
  overlay.classList.add('show');
}
function hideDialog() { overlay.classList.remove('show'); }
function showHelp() {
  tpDialog('快捷键一览', `
    <table>
      <tr><td class="k">F1</td><td>本帮助</td><td class="k">F2</td><td>保存到本地</td></tr>
      <tr><td class="k">F3</td><td>打开本地存档</td><td class="k">F4</td><td>选择工具 · H 移动画布</td></tr>
      <tr><td class="k">F5</td><td>俯视/透视切换</td><td class="k">F6</td><td>画墙工具</td></tr>
      <tr><td class="k">F7</td><td>放门（先点选墙）</td><td class="k">F8</td><td>放窗（先点选墙）/ 性能面板 (Ctrl+F8)</td></tr>
      <tr><td class="k">F9</td><td>删除当前选中</td><td class="k">F10</td><td>家具库</td></tr>
      <tr><td class="k">F11</td><td>画地面</td><td class="k">G</td><td>网格开关</td></tr>
      <tr><td class="k">Ctrl+Z / Y</td><td>撤销 / 重做</td><td class="k">Ctrl+C/V/D</td><td>复制/粘贴/重复</td></tr>
      <tr><td class="k">Del</td><td>删除选中</td><td class="k">R / T</td><td>旋转 / 翻转</td></tr>
      <tr><td class="k">R / T</td><td>门：换铰链 / 翻开向</td><td class="k">Enter</td><td>结束画墙链</td></tr>
      <tr><td class="k">方向键</td><td>选中对象微移 5cm（Shift×10）· Alt 仅调墙一端</td><td class="k">数字键</td><td>画墙时输入精确长度</td></tr>
      <tr><td class="k">Shift+方向</td><td>大幅平移 1m / 格</td><td class="k">WASD</td><td>世界轴平移 0.1m（Shift ×10）</td></tr>
      <tr><td class="k">Q / E</td><td>家具微旋 ±15°</td><td class="k">[ / ]</td><td>墙厚 / 地厚 / 门窗宽</td></tr>
      <tr><td class="k">Esc</td><td>取消 / 取消选择</td><td class="k">Tab</td><td>画墙：单段/链式/围房 切换</td></tr>
      <tr><td class="k">右键拖动</td><td>旋转视角</td><td class="k">空白处左键拖</td><td>框选（Shift 加选）</td></tr>
      <tr><td class="k">Ctrl+G / Ctrl+Shift+G</td><td>成组 / 解组</td><td class="k">Shift+点击</td><td>加选 / 移出多选</td></tr>
    </table>`);
}
overlay.addEventListener('click', e => { if (e.target === overlay) hideDialog(); });

// ============================================================
// 启动 + 动画循环
// ============================================================
const saved = localStorage.getItem('tp3d_plan');
// 启动兜底一律用空场景(不再加载示例户型 —— 用户看到"莫名的木纹小房间"就是它):
//   草稿正常 → 载入;草稿损坏/字段缺失 → 清掉草稿数据,空场景启动
function _emptyBootDoc() {
  return { name: '未命名', wallH: 2.75, levels: [{ name: '1F', elev: 0 }],
    walls: [], furniture: [], floors: [], stairs: [], hidden: {} };
}
let _bootDoc = null;
let _bootDraftJunk = false;
if (saved) {
  try { _bootDoc = JSON.parse(saved); }
  catch (e) { console.error('[boot] 本地草稿损坏,已清掉:', e); _bootDraftJunk = true; }
}
doc = _bootDoc || _emptyBootDoc();
try { normDoc(); } catch (e) {
  console.error('[boot] 草稿数据不完整,已清掉并空场景启动:', e);
  _bootDraftJunk = true;
  doc = _emptyBootDoc(); normDoc();
}
if (_bootDraftJunk) {
  try { localStorage.removeItem('tp3d_plan'); } catch (e2) {}
  doc.name = '未命名';
}
migrateDoubleDoorWidth();
_hydrateCustomAssets();     // 异步把自定义模型字节从 IndexedDB 灌进缓存，完成后自动重建
getAssetDirHandle().catch(() => { /* 启动静默,不打断 */ });  // 提前取出目录句柄,_ensureAssetDir 不再弹窗直接用
_syncAssetDirKb();
_exposeE2E();
_syncTopbarKb();

// 首次访问触发引导气泡（延迟到首次渲染后，避免找不到 DOM）
let _onboardDone = false;
try { _onboardDone = !!localStorage.getItem('tp3d_onboard_done'); } catch {}
if (!_onboardDone) setTimeout(() => { if (!_onboardDone) startOnboard(); }, 600);

// 预加载 GLB：分批异步（首屏只加载最常用的 N 个，其余在 requestIdleCallback 中后台加载）
const _glbFiles = [...new Set(Object.values(FURN).map(d => d.file).filter(Boolean))];
// 按调用频次粗排：常用分类（bed/bath/kitchen/furn/hvac/opening/media）优先
const _glbPriority = (file) => {
  const k = Object.entries(FURN).find(([_, d]) => d.file === file);
  if (!k) return 99;
  const cat = k[1].cat;
  const order = { bed: 0, bath: 1, kitchen: 2, furn: 3, hvac: 4, opening: 5, media: 6, light: 7, misc: 8, outdoor: 9, safety: 10, medical: 11, sport: 12, other: 13 };
  return order[cat] ?? 14;
};
_glbFiles.sort((a, b) => _glbPriority(a) - _glbPriority(b));
const _FIRST_BATCH = 60;  // 首屏加载前 60 个
const _firstBatch = _glbFiles.slice(0, _FIRST_BATCH);
const _restBatch = _glbFiles.slice(_FIRST_BATCH);

// ── 材质 sw cube 预览：共享 rAF 循环渲染所有可见的 .sw canvas ──
const _swCanvases = new Set();
let _swTickId = 0;
function _registerSwCanvas(c) {
  _swCanvases.add(c);
  if (!_swTickId) _swTickId = requestAnimationFrame(_tickSwCanvases);   // 空闲挂起后由注册唤醒
}
let _swAngle = 0;
function _tickSwCanvases() {
  _swAngle += 0.025;
  let any = false;
  for (const c of _swCanvases) {
    if (!c.isConnected) { _swCanvases.delete(c); continue; }
    any = true;
    const ctx = c.getContext('2d');
    const w = c.width = c.clientWidth * devicePixelRatio;
    const h = c.height = c.clientHeight * devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    // 解析 sw 的颜色：从父按钮 data-c，或自身 background
    const btn = c.parentElement;
    const hex = (btn.dataset.c || getComputedStyle(btn).backgroundColor || '#ccc').trim();
    const col = parseHexColor(hex);
    // 3D 立方体三面
    const cx = w / 2, cy = h / 2, sz = Math.min(w, h) * 0.30;
    const ang = _swAngle;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    function project(x, y, z) { return [cx + (x * cos - z * sin), cy + (y - (x * sin + z * cos) * 0.5)]; }
    // 顶面（亮 30%）
    const top = [project(-sz, -sz, -sz), project(sz, -sz, -sz), project(sz, -sz, sz), project(-sz, -sz, sz)];
    // 左面（暗 25%）
    const left = [project(-sz, -sz, -sz), project(-sz, -sz, sz), project(-sz, sz, sz), project(-sz, sz, -sz)];
    // 右面（基色）
    const right = [project(-sz, -sz, sz), project(sz, -sz, sz), project(sz, sz, sz), project(-sz, sz, sz)];
    function shade(c, t) { return `rgb(${(c[0]*t)|0},${(c[1]*t)|0},${(c[2]*t)|0})`; }
    function poly(pts, fill) {
      ctx.fillStyle = fill; ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    poly(top, shade(col, 1.30));
    poly(left, shade(col, 0.75));
    poly(right, shade(col, 1.00));
  }
  // 已无挂载在文档里的色块 → 挂起循环,等下次注册再唤醒
  _swTickId = any ? requestAnimationFrame(_tickSwCanvases) : 0;
}


function parseHexColor(v) {
  if (v.startsWith('#')) {
    const h = v.length === 4
      ? v.slice(1).split('').map(c => c + c).join('')
      : v.slice(1);
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  }
  const m = v.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : [200, 200, 200];
}

// 包装函数：把任何 sw 升级为带 cube预览的版本
function upgradeSwToCube(btn) {
  if (btn.querySelector('canvas.sw-cube')) return;
  const c = document.createElement('canvas');
  c.className = 'sw-cube';
  btn.appendChild(c);
  _registerSwCanvas(c);
}

async function _loadBatch(files, label) {
  return Promise.all(files.map(f => loadGLB(f).catch(e => console.warn('GLB load fail', f, e))));
}

// 首屏同步加载前 N 个（保证首屏可见分类的 GLB 已就绪）
const _glbReady = _loadBatch(_firstBatch, '首屏')
  .then(() => {
    rebuild();
    toast(`已预加载 ${_firstBatch.length}/${_glbFiles.length} 个常用 GLB，其余后台加载中`, 'success', 1800);
    // 后台分批加载剩余（每批 20 个，requestIdleCallback 让位给 UI）
    let i = 0;
    const tick = () => {
      const batch = _restBatch.slice(i, i + 20);
      if (!batch.length) return;
      i += 20;
      _loadBatch(batch).then(() => {
        if (i < _restBatch.length && window.requestIdleCallback) {
          window.requestIdleCallback(tick, { timeout: 1000 });
        } else if (i < _restBatch.length) {
          setTimeout(tick, 200);
        } else {
          toast(`全部 ${_glbFiles.length} 个 GLB 已后台加载完成`, 'success', 1200);
        }
      });
    };
    if (window.requestIdleCallback) window.requestIdleCallback(tick, { timeout: 1000 });
    else setTimeout(tick, 300);
  });

rebuild3D();
refreshProps();
setTool('select');
flash(saved && !_bootDraftJunk ? '已载入本地存档' : '已就绪：F6 开始画墙');

// 接线视图切换 / 重置按钮
const _btnViewToggle = $('btn-view-toggle');
if (_btnViewToggle) _btnViewToggle.onclick = toggleView;
const _btnResetView = $('btn-reset-view');
if (_btnResetView) _btnResetView.onclick = resetView;

if (new URLSearchParams(location.search).get('view') === 'top') toggleView();
if (new URLSearchParams(location.search).get('glbtest')) setTimeout(() => exportGLB(), 1200);

fitCanvas();
new ResizeObserver(fitCanvas).observe(canvasWrap);

// ── 静止帧跳过 render：仅在 dirty / 相机 tween / 控件交互时渲染 ──
// (idle skip:鼠标不动后 250ms 停止调用 renderer.render,让 GPU 休眠)
// _lastInteractAt / _pokeInteract 已提前到 _needsRender 旁声明(修启动期 TDZ 崩溃)

// ── 性能监控面板(F8 切换显示;默认隐藏) ──
let _perfPanel = null, _perfBody = null, _perfVisible = false;
let _perfFpsFrames = 0, _perfFpsStart = performance.now(), _perfFpsMs = 0;
function _setupPerfPanel() {
  _perfPanel = document.getElementById('perfPanel');
  if (!_perfPanel) return;
  _perfBody = _perfPanel.querySelector('.perfBody');
  document.getElementById('perfToggle')?.addEventListener('click', () => {
    _perfPanel.classList.toggle('collapsed');
  });
  // Ctrl+F8 快捷键切换显示(F8 已让给"放窗")
  addEventListener('keydown', e => {
    if (e.key === 'F8' && e.ctrlKey && !e.target.matches('input,textarea')) {
      e.preventDefault();
      _perfVisible = !_perfVisible;
      _perfPanel.hidden = !_perfVisible;
    }
  });
}

// ── 外观切换(深 / 浅 / 跟随系统) ──
let _appearance = (() => {
  try { return localStorage.getItem('tp3d.appearance') || 'auto'; }
  catch (e) { return 'auto'; }
})();
const _appearanceMq = matchMedia('(prefers-color-scheme: dark)');
function _resolvedAppearance() {
  if (_appearance === 'auto') return _appearanceMq.matches ? 'dark' : 'light';
  return _appearance;
}
function _applyAppearance() {
  const cur = _resolvedAppearance();
  document.documentElement.setAttribute('data-theme', cur);
  // 更新下拉里的 active 标记
  const menu = document.getElementById('appearanceMenu');
  if (menu) {
    menu.querySelectorAll('.ci[data-app]').forEach(el => {
      el.classList.toggle('active', el.dataset.app === _appearance);
    });
  }
}
function _setupAppearance() {
  _applyAppearance();
  const btn = document.getElementById('btnAppearance');
  const menu = document.getElementById('appearanceMenu');
  const panel = menu.querySelector('.ap-panel');
  if (!btn || !menu || !panel) return;
  const isOpen = () => getComputedStyle(menu).display !== 'none';
  const close = () => { menu.style.display = 'none'; };
  const show = () => { menu.style.display = 'block'; };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (isOpen()) { close(); return; }
    show();
  });
  panel.querySelectorAll('.ci[data-app]').forEach(el => {
    el.addEventListener('click', () => {
      _appearance = el.dataset.app;
      try { localStorage.setItem('tp3d.appearance', _appearance); } catch (e) {}
      _applyAppearance();
      close();
    });
  });
  document.getElementById('appearanceClose')?.addEventListener('click', close);
  // Esc 关闭
  document.addEventListener('keydown', e => {
    if (isOpen() && e.key === 'Escape') close();
  }, true);
  // 点击遮罩(命中 menu 但不在 panel 内)关闭 — panel 子元素点击不关;
  // target 必须是 menu 自身(对应 ::before 背景),外部元素(如 #btnAppearance)不算
  menu.addEventListener('click', e => {
    if (e.target === menu) close();
  });
  // 跟随系统时,系统切换自动响应
  _appearanceMq.addEventListener?.('change', () => {
    if (_appearance === 'auto') _applyAppearance();
  });
}
function _updatePerfPanel() {
  if (!_perfPanel || !_perfVisible) return;
  _perfFpsFrames++;
  const now = performance.now();
  const elapsed = now - _perfFpsStart;
  if (elapsed >= 500) {       // 每 500ms 更新一次 FPS
    const fps = _perfFpsFrames * 1000 / elapsed;
    _perfFpsMs = elapsed / _perfFpsFrames;
    _perfFpsFrames = 0;
    _perfFpsStart = now;
    document.getElementById('perfFps').textContent = fps.toFixed(0);
    document.getElementById('perfMs').textContent = _perfFpsMs.toFixed(1);
    const info = renderer.info;
    document.getElementById('perfCalls').textContent = info.render.calls;
    document.getElementById('perfTris').textContent = info.render.triangles.toLocaleString();
    document.getElementById('perfGeos').textContent = info.memory.geometries;
    document.getElementById('perfRebuild').textContent = _rebuildCount;
  }
}

let _perfConsoleCounter = 0;
function animate() {
  requestAnimationFrame(animate);
  // 自愈:相机状态一旦出现 NaN(异常路径写入),一切交互/拾取都会静默失灵 —— 发现即修复
  {
    const tgt = controls.target;
    if (!isFinite(tgt.x + tgt.y + tgt.z)) {
      tgt.set(0, topView ? 0 : 0.4, 0);
      if (topView) { orthoCam.position.set(0, 20, 0); fitViewToContent(); }
      else camera.position.set(6.5, 7.2, 8.5);
      _needsRender = true;
    }
    if (!isFinite(camera.position.x + camera.position.y + camera.position.z)) {
      camera.position.set(6.5, 7.2, 8.5);
      _needsRender = true;
    }
    if (Number.isNaN(orthoCam.left + orthoCam.right + orthoCam.top + orthoCam.bottom)) {
      updateOrthoFrustum();   // 2D 下 canvas 隐藏时跳过(视锥对 SVG 渲染无意义)
    }
  }
  if (dirty) { dirty = false; rebuild3D(); if (needProps) refreshProps(); _needsRender = true; }
  controls.update();
  const interact = (performance.now() - _lastInteractAt) < 250;
  const tweening = camTween != null;
  if (_needsRender || interact || tweening || dirty) {
    renderer.render(scene, activeCam);
    _needsRender = false;
  }
  _updatePerfPanel();
  // 开发模式调试:每 60 帧打印一次 renderer.info
  _perfConsoleCounter++;
  if (_perfConsoleCounter % 60 === 0 && window.__perfDebug) {
    const info = renderer.info;
    console.log(`[perf] frame=${info.render.frame} calls=${info.render.calls} tris=${info.render.triangles} geos=${info.memory.geometries} rebuilds=${_rebuildCount}`);
  }
}
_setupPerfPanel();
_setupAppearance();
animate();

// ============================================================
// 多文件工作区（File System Access + IndexedDB）
// ============================================================

// 启动时把 IndexedDB 里的句柄恢复到 filesIndex._handle
async function _restoreHandles() {
  for (const entry of filesIndex) {
    try {
      const h = await idbGet(entry.id);
      if (h) entry._handle = h;
      // 快照标记(面板徽标"浏览器本地"用;快照本身在切换时按需读取)
      const s = await idbGet('snap:' + entry.id);
      if (s && s.json) entry._hasSnap = true;
    } catch (e) { /* 静默 */ }
  }
}

// ── 主题面板(侧栏 #themePanel) ────────────────────────────────
function renderThemePanel() {
  const list = document.getElementById('thList');
  if (!list) return;
  const sw = (c) => `<span class="th-sw" style="background:${c}"></span>`;
  list.innerHTML = Object.entries(THEMES).map(([k, th]) => {
    const on = (THEME === k) ? ' on' : '';
    const glass = th.window.glassColor === 'default' ? '#cfe6f2' : th.window.glassColor;
    const isCustom = !th.builtIn;
    const hasOverride = !!th.builtIn && !!th.override;
    // 全部主题都显示 ⋯ 菜单(内置主题可以编辑/恢复出厂/复制/导出)
    const menuBtn = `<button class="th-card-menu" data-menu="${k}" title="主题操作" aria-label="主题操作">⋯</button>`;
    // 名称后缀:自定义显示「·自定义」;内置被改过显示「·我的版本」;出厂原样无后缀
    let badge = '';
    if (isCustom) badge = ' <span style="font-size:10px;color:var(--ink-3)">·自定义</span>';
    else if (hasOverride) badge = ' <span style="font-size:10px;color:var(--accent)">·我的版本</span>';
    return `
      <div class="th-card${on}${hasOverride ? ' override' : ''}" role="button" tabindex="0" data-k="${k}"${isCustom ? ' data-custom="1"' : ''}>
        <div class="th-name">${th.icon} ${th.n}${badge}</div>
        <div class="th-desc">${th.desc}</div>
        <div class="th-swatches">${sw(th.wall.base)}${sw(th.floor.color)}${sw(th.door.leafColor)}${sw(glass)}</div>
        ${menuBtn}
      </div>`;
  }).join('');
  list.querySelectorAll('.th-card').forEach(btn => {
    btn.onclick = (e) => {
      if (e.target.closest('.th-card-menu')) return; // ⋯ 按钮自己处理
      themeApply(btn.dataset.k);
    };
    btn.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (e.target.closest('.th-card-menu')) return;
        themeApply(btn.dataset.k);
      }
    };
  });
  list.querySelectorAll('.th-card-menu').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openThemeMenu(btn.dataset.menu, btn);
    };
  });
  const cur = document.getElementById('thCur');
  if (cur) cur.textContent = (THEMES[THEME] || THEMES.simple).n;

  // 「半墙」全局勾选 —— 控制新建墙是否默认启用半墙
  const panel = document.getElementById('themePanel');
  if (panel) {
    let toggle = document.getElementById('thHalfWallToggle');
    if (!toggle) {
      toggle = document.createElement('label');
      toggle.id = 'thHalfWallToggle';
      toggle.className = 'th-toggle';
      toggle.innerHTML = `<input type="checkbox" id="thHalfWallChk"> <span>新建墙默认半墙</span>`;
      // 插在 #thList 之后、.th-foot 之前
      const listEl = document.getElementById('thList');
      const footEl = panel.querySelector('.th-foot');
      if (footEl && listEl) panel.insertBefore(toggle, footEl);
      else if (listEl) listEl.parentElement.insertBefore(toggle, listEl.nextSibling);
      else panel.appendChild(toggle);
      toggle.querySelector('#thHalfWallChk').onchange = (e) => {
        halfWallDefault = e.target.checked;
        try { localStorage.setItem('tp3d_halfwall_default', halfWallDefault ? '1' : '0'); } catch (err) { /* 忽略 */ }
        flash(halfWallDefault ? '已开启:新建墙默认半墙' : '已关闭');
      };
    }
    toggle.querySelector('#thHalfWallChk').checked = halfWallDefault;
  }

  // 主题编辑器模式(管理态): 当处于编辑态,渲染或刷新编辑器表单
  if (typeof _themeEditingKey !== 'undefined' && _themeEditingKey && THEMES[_themeEditingKey]) {
    if (typeof renderThemeEditor === 'function') renderThemeEditor(_themeEditingKey);
  }
}

// ════════════════════════════════════════════════════════════
// 主题编辑器(CRUD + 实时预览 + 导入/导出)
// ════════════════════════════════════════════════════════════

// 当前正在编辑的主题 key;null = 列表态
let _themeEditingKey = null;
// staging 主题: 编辑时所有字段先写到 staging,「保存」才写回 THEMES[key] + 持久化
// 取消 = 丢弃 staging(还原成原始 THEMES[_themeEditingKey])
// 「预览」:staging 改一个字段就立刻 rebuild,画布实时反映
let _themeStaging = null;
let _themeStagingOrig = null; // 进入编辑时的快照,「取消」用来还原

// 16 进制颜色合法
function _isHex(c) { return /^#[0-9a-fA-F]{6}$/.test(String(c || '')); }
function _normHex(c) { return _isHex(c) ? c.toLowerCase() : '#cccccc'; }

// 生成不冲突的自定义 key(custom-1, custom-2, ...)
function _genCustomKey() {
  let i = 1;
  while (THEMES['custom-' + i]) i++;
  return 'custom-' + i;
}

// 深拷贝一个主题对象(避免共享引用)
function _cloneTheme(t) { return JSON.parse(JSON.stringify(t)); }

// 进入编辑模式(key 已存在或新建 staging 对象)
function themeEditStart(key) {
  if (!THEMES[key]) return;
  _themeEditingKey = key;
  _themeStagingOrig = _cloneTheme(THEMES[key]);
  _themeStaging = _cloneTheme(THEMES[key]);
  const panel = document.getElementById('themePanel');
  if (panel) panel.classList.add('edit-mode');
  const ep = document.getElementById('thEditPane');
  if (ep) ep.hidden = false;
  const manage = document.getElementById('thManageBtn');
  if (manage) manage.classList.add('on');
  renderThemeEditor(key);
  // 立刻应用 staging 到画布(实时预览)
  _themeApplyStaging();
}

// 取消编辑(还原)
function themeEditCancel() {
  if (!_themeEditingKey) return;
  // 还原 staging 回原值
  if (_themeEditingKey && _themeStagingOrig) {
    THEMES[_themeEditingKey] = _cloneTheme(_themeStagingOrig);
    // 重新跑一次 themeApply 当前 THEME(因为 staging 可能改过 THEME 字段;用当前 THEME 避免)
    themeApply(THEME, { silent: true });
  }
  _themeEditingKey = null;
  _themeStaging = null;
  _themeStagingOrig = null;
  const panel = document.getElementById('themePanel');
  if (panel) panel.classList.remove('edit-mode');
  const ep = document.getElementById('thEditPane');
  if (ep) { ep.hidden = true; ep.innerHTML = ''; }
  const manage = document.getElementById('thManageBtn');
  if (manage) manage.classList.remove('on');
  flash('已取消编辑');
}

// 保存编辑
function themeEditSave() {
  if (!_themeEditingKey || !_themeStaging) return;
  const key = _themeEditingKey;
  const t = _themeStaging;
  if (!t.n || !String(t.n).trim()) return flash('名称不能为空', 'error');
  // 规范化所有色
  t.wall.base = _normHex(t.wall.base);
  t.floor.color = _normHex(t.floor.color);
  t.door.leafColor = _normHex(t.door.leafColor);
  t.window.leafColor = _normHex(t.window.leafColor);
  t.door.glassColor = _normHex(t.door.glassColor);
  t.window.glassColor = _normHex(t.window.glassColor);
  // 写回
  THEMES[key] = t;
  // 根据是否内置走不同持久化路径:
  // - 内置:覆盖对象存到 tp3d_theme_overrides;保留 builtIn: true,加 override: true
  // - 自定义:存到 tp3d_custom_themes;保留 builtIn: false
  const isBuiltin = !!t.builtIn;
  if (isBuiltin) {
    t.builtIn = true;
    t.override = true;
    _saveBuiltinOverrides();
  } else {
    _saveCustomThemes();
  }
  // 退出编辑态
  _themeEditingKey = null; _themeStaging = null; _themeStagingOrig = null;
  const panel = document.getElementById('themePanel');
  if (panel) panel.classList.remove('edit-mode');
  const ep = document.getElementById('thEditPane');
  if (ep) { ep.hidden = true; ep.innerHTML = ''; }
  const manage = document.getElementById('thManageBtn');
  if (manage) manage.classList.remove('on');
  // 应用并 flash
  themeApply(key, { silent: true });
  flash(`已保存主题: ${t.n}`);
  // 刷新列表(高亮 + 名字)
  renderThemePanel();
}

// 临时把 staging 应用到 THEMES 当前 key 并 rebuild(实时预览,不动 localStorage)
function _themeApplyStaging() {
  if (!_themeEditingKey || !_themeStaging) return;
  const key = _themeEditingKey;
  // 临时写回 THEMES(渲染需要)
  THEMES[key] = _themeStaging;
  // 用 staging 模拟一次 themeApply 的回填,不要触发 flash
  const t = _themeStaging;
  for (const w of (doc.walls || [])) {
    if (w.glass) { continue; }
    w.wallBase = t.wall.base;
    w.wallTex = t.wall.tex || undefined;
    for (const op of (w.openings || [])) {
      if (op.type === 'door') {
        op.leafColor = t.door.leafColor;
        op.leafTex = t.door.leafTex || undefined;
      } else if (op.type === 'window') {
        op.leafColor = t.window.leafColor;
        op.leafTex = t.window.leafTex || undefined;
        if (t.window.glassColor !== 'default') op.glassColor = t.window.glassColor;
      }
    }
  }
  for (const f of (doc.floors || [])) {
    f.color = t.floor.color;
    f.tex = t.floor.tex || undefined;
  }
  // 如果当前 THEME 不是编辑中的 key,临时切到 staging 用于渲染
  if (THEME !== key) {
    const oldTheme = THEME;
    THEME = key;
    rebuild();
    THEME = oldTheme;
  } else {
    rebuild();
  }
}

// 编辑器表单渲染
function renderThemeEditor(key) {
  const ep = document.getElementById('thEditPane');
  if (!ep || !THEMES[key]) return;
  const t = _themeStaging || THEMES[key];
  const isBuiltIn = !!THEMES[key].builtIn;
  const hasOverride = isBuiltIn && !!THEMES[key].override;
  // 工具函数:生成色块行(可重置)
  const swRow = (fieldPath, label, presets) => {
    const v = _getDeep(t, fieldPath) || '';
    const isDefault = v === 'default' || v === '';
    const buttons = presets.map(p => `<button class="sw ${v === p.c ? 'on' : ''}" data-set="${fieldPath}" data-val="${p.c}" title="${p.n}" style="background:${p.c}"></button>`).join('');
    const resetBtn = `<button class="sw ${isDefault ? 'on' : ''}" data-set="${fieldPath}" data-val="default" title="恢复默认" style="background:#fff;color:#a00;font-weight:700">✕</button>`;
    const colorInput = `<input type="color" data-color="${fieldPath}" value="${_normHex(v)}">`;
    return `<div class="th-form-row">
      <label>${label}</label>
      <div class="swgrid" style="align-items:center">${buttons}${resetBtn}${colorInput}</div>
    </div>`;
  };
  const texRow = (fieldPath, label) => {
    const v = _getDeep(t, fieldPath) || '';
    const buttons = TEX_OPTIONS.map(o => `<button class="styleBtn ${v === o.k ? 'on' : ''}" data-set="${fieldPath}" data-val="${o.k}">${o.icon} ${o.n}</button>`).join('');
    return `<div class="th-form-row">
      <label>${label}</label>
      <div class="styleRow">${buttons}</div>
    </div>`;
  };
  const inputRow = (fieldPath, label, placeholder) => {
    const v = _getDeep(t, fieldPath) || '';
    return `<div class="th-form-row">
      <label>${label}</label>
      <input type="text" data-text="${fieldPath}" value="${String(v).replace(/"/g, '&quot;')}" placeholder="${placeholder || ''}">
    </div>`;
  };

  // 内置 + 已被用户改过 → 标题加「(我的版本)」;内置未改 → 「(出厂)」;自定义 → 原样
  let titleSuffix = '';
  if (isBuiltIn && hasOverride) titleSuffix = ' <span style="font-size:11px;color:var(--accent)">(我的版本)</span>';
  else if (isBuiltIn) titleSuffix = ' <span style="font-size:11px;color:var(--ink-3)">(出厂)</span>';
  // 内置:保存即覆盖原主题 → 「保存」按钮 label 改为「保存为我的版本」更明确
  const saveLabel = isBuiltIn ? '保存为我的版本' : '保存';
  const subHint = isBuiltIn
    ? '内置主题编辑后保存为「我的版本」,会顶替原主题外观;点「恢复出厂」可还原。'
    : '改动实时预览,点「保存」写入 localStorage';
  // 内置且已被改过才显示「恢复出厂」按钮(否则没必要)
  const resetBtn = (isBuiltIn && hasOverride)
    ? `<button class="btn" id="thEditResetBtn" title="恢复出厂默认">↺ 恢复出厂</button>` : '';

  ep.innerHTML = `
    <h3 class="th-form-h">编辑主题: ${t.n}${titleSuffix}</h3>
    <div class="th-form-sub">${subHint}</div>
    <details class="propSection" open>
      <summary class="propSecTitle">基础信息</summary>
      ${inputRow('n', '名称', '如:暖灰橡木')}
      ${inputRow('icon', '图标 (1 字符)', '如:◯ ▥ ▦')}
      ${inputRow('desc', '描述', '一句话说明')}
    </details>
    <details class="propSection" open>
      <summary class="propSecTitle">墙面</summary>
      ${swRow('wall.base', '基色', PRESETS)}
      ${texRow('wall.tex', '纹理')}
    </details>
    <details class="propSection">
      <summary class="propSecTitle">地面</summary>
      ${swRow('floor.color', '基色', PRESETS)}
      ${texRow('floor.tex', '纹理')}
    </details>
    <details class="propSection">
      <summary class="propSecTitle">门</summary>
      ${swRow('door.leafColor', '门扇颜色', LEAF_PRESETS)}
      ${texRow('door.leafTex', '门扇纹理')}
    </details>
    <details class="propSection">
      <summary class="propSecTitle">窗</summary>
      ${swRow('window.leafColor', '窗框颜色', LEAF_PRESETS)}
      ${texRow('window.leafTex', '窗框纹理')}
      ${swRow('window.glassColor', '玻璃颜色', GLASS_PRESETS)}
    </details>
    <div class="th-form-foot">
      ${resetBtn}
      <button class="btn" id="thEditCancelBtn">取消</button>
      <button class="btn primary" id="thEditSaveBtn">${saveLabel}</button>
    </div>
  `;
  // 事件绑定
  ep.querySelectorAll('[data-set]').forEach(btn => {
    btn.onclick = () => {
      const path = btn.dataset.set;
      const val = btn.dataset.val;
      _setDeep(_themeStaging, path, val);
      _themeApplyStaging();
      renderThemeEditor(key); // 刷新高亮
    };
  });
  ep.querySelectorAll('[data-color]').forEach(inp => {
    inp.oninput = () => {
      const path = inp.dataset.color;
      _setDeep(_themeStaging, path, inp.value);
      _themeApplyStaging();
    };
  });
  ep.querySelectorAll('[data-text]').forEach(inp => {
    inp.oninput = () => {
      const path = inp.dataset.text;
      _setDeep(_themeStaging, path, inp.value);
      // 名称改动时同步更新标题
      if (path === 'n') {
        const h = ep.querySelector('.th-form-h');
        if (h) h.textContent = `编辑主题: ${inp.value}${titleSuffix}`;
      }
    };
  });
  const saveBtn = ep.querySelector('#thEditSaveBtn');
  if (saveBtn) saveBtn.onclick = () => themeEditSave();
  const cancelBtn = ep.querySelector('#thEditCancelBtn');
  if (cancelBtn) cancelBtn.onclick = () => themeEditCancel();
  const resetBtnEl = ep.querySelector('#thEditResetBtn');
  if (resetBtnEl) resetBtnEl.onclick = () => {
    if (typeof tpDialog === 'function') {
      tpDialog('恢复出厂', `<div class="note">确定把「${t.n}」恢复到出厂默认?这会丢失你对它的所有改动。</div>`,
        [{ t: '恢复', fn() { themeReset(key); } }, { t: '取消' }]);
    } else if (confirm('确定恢复出厂?')) {
      themeReset(key);
    }
  };
}

function _getDeep(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function _setDeep(obj, path, val) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = val;
}

// ── CRUD: 新建 / 复制 / 删除 / 导入 / 导出 ──
// 把内置主题恢复到出厂默认(清除我的版本覆盖)
function themeReset(key) {
  if (!THEMES[key] || !THEMES[key].builtIn) return flash('只能重置内置主题', 'error');
  if (!THEMES_BUILTIN[key]) return flash('出厂模板缺失', 'error');
  // 还原内存对象为出厂模板
  THEMES[key] = JSON.parse(JSON.stringify(THEMES_BUILTIN[key]));
  // 持久化:删掉该 key 的覆盖
  _saveBuiltinOverrides();
  // 退出编辑态(如果正在编辑这个 key)
  if (_themeEditingKey === key) themeEditCancel();
  // 重新应用当前主题
  themeApply(key, { silent: true });
  renderThemePanel();
  flash(`已恢复出厂: ${THEMES[key].n}`);
}

function themeNew() {
  const key = _genCustomKey();
  const base = _cloneTheme(THEMES[THEME] || THEMES_BUILTIN.simple);
  base.n = '新建主题';
  base.icon = '✦';
  base.desc = '我的自定义主题';
  base.builtIn = false;
  THEMES[key] = base;
  _saveCustomThemes();
  themeApply(key, { silent: true });
  themeEditStart(key);
  flash('已新建主题,请编辑后保存');
}

function themeDuplicate(srcKey) {
  if (!THEMES[srcKey]) return;
  const newKey = _genCustomKey();
  const cp = _cloneTheme(THEMES[srcKey]);
  cp.n = (cp.n || '主题') + ' 副本';
  cp.builtIn = false;
  THEMES[newKey] = cp;
  _saveCustomThemes();
  themeApply(newKey, { silent: true });
  themeEditStart(newKey);
  flash('已复制主题,请编辑后保存');
}

function themeDelete(key) {
  if (!THEMES[key] || THEMES[key].builtIn) return flash('内置主题不能删除', 'error');
  if (typeof tpDialog === 'function') {
    tpDialog('删除主题', `<div class="note">确定删除「${THEMES[key].n}」?此操作无法撤销。</div>`,
      [{ t: '删除', fn() { _themeDeleteNow(key); } }, { t: '取消' }]);
  } else {
    if (!confirm('删除主题「' + THEMES[key].n + '」?')) return;
    _themeDeleteNow(key);
  }
}
function _themeDeleteNow(key) {
  const wasCurrent = (THEME === key);
  delete THEMES[key];
  _saveCustomThemes();
  // 退出编辑态(如果正在编辑这个 key)
  if (_themeEditingKey === key) themeEditCancel();
  if (wasCurrent) themeApply('simple', { silent: true });
  else themeApply(THEME, { silent: true });
  renderThemePanel();
  flash('已删除主题');
}

function themeExportAll() {
  const out = {};
  for (const [k, t] of Object.entries(THEMES)) {
    if (!t.builtIn) out[k] = t;
  }
  if (!Object.keys(out).length) return flash('没有自定义主题可导出', 'warn');
  const blob = new Blob([JSON.stringify({ tp3dThemes: 1, themes: out }, null, 2)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tp3d-themes-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash(`已导出 ${Object.keys(out).length} 个主题`);
}

function themeExportOne(key) {
  if (!THEMES[key] || THEMES[key].builtIn) return flash('内置主题不能单独导出', 'error');
  const out = { [key]: THEMES[key] };
  const blob = new Blob([JSON.stringify({ tp3dThemes: 1, themes: out }, null, 2)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `tp3d-theme-${key}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash(`已导出主题: ${THEMES[key].n}`);
}

function themeImport() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        const themes = obj && (obj.themes || obj); // 兼容 raw map
        if (!themes || typeof themes !== 'object') throw new Error('格式错误');
        let added = 0, renamed = 0;
        for (const [k, t] of Object.entries(themes)) {
          if (!t || typeof t !== 'object' || !t.n) continue;
          let finalK = k;
          if (THEMES[finalK] || !/^[a-zA-Z0-9_-]+$/.test(finalK)) {
            finalK = k + '-imported'; renamed++;
            let i = 2;
            while (THEMES[finalK]) finalK = k + '-imported-' + (i++);
          }
          t.builtIn = false;
          THEMES[finalK] = t;
          added++;
        }
        _saveCustomThemes();
        renderThemePanel();
        flash(`已导入 ${added} 个主题${renamed ? `(${renamed} 个重命名)` : ''}`);
      } catch (e) {
        flash('导入失败: ' + e.message, 'error');
      }
    };
    reader.readAsText(f);
  };
  inp.click();
}

// ── 主题卡 ⋯ 弹出菜单 ──
function openThemeMenu(key, anchorBtn) {
  closeThemeMenu();
  const m = document.getElementById('themeMenu');
  if (!m || !THEMES[key]) return;
  const th = THEMES[key];
  const isBuiltin = !!th.builtIn;
  const hasOverride = isBuiltin && !!th.override;
  // 内置:编辑 / 复制 / 导出 / [重置出厂(只有被改过才显示)] / [分隔 + 删除(隐藏)]
  // 自定义:编辑 / 复制 / 导出 / [分隔 + 删除]
  const items = [
    { act: 'edit', icon: '✎', label: '编辑' },
    { act: 'duplicate', icon: '⎘', label: '复制' },
    { act: 'export', icon: '⤒', label: '导出' },
  ];
  if (isBuiltin && hasOverride) {
    items.push({ sep: true });
    items.push({ act: 'reset', icon: '↺', label: '恢复出厂' });
  }
  if (!isBuiltin) {
    items.push({ sep: true });
    items.push({ act: 'delete', icon: '🗑', label: '删除', danger: true });
  }
  m.innerHTML = items.map(it => {
    if (it.sep) return '<div class="th-menu-sep"></div>';
    return `<div class="th-menu-item${it.danger ? ' danger' : ''}" data-act="${it.act}" data-k="${key}">${it.icon} ${it.label}</div>`;
  }).join('');
  // 定位:相对 anchorBtn 左下角
  const r = anchorBtn.getBoundingClientRect();
  m.style.left = r.right - 110 + 'px';
  m.style.top = (r.bottom + 4) + 'px';
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
  anchorBtn.classList.add('on');
  // 事件
  m.querySelectorAll('.th-menu-item').forEach(it => {
    it.onclick = () => {
      const act = it.dataset.act;
      const k = it.dataset.k;
      closeThemeMenu();
      if (act === 'edit') themeEditStart(k);
      else if (act === 'duplicate') themeDuplicate(k);
      else if (act === 'export') themeExportOne(k);
      else if (act === 'delete') themeDelete(k);
      else if (act === 'reset') themeReset(k);
    };
  });
  // 点别处关闭
  setTimeout(() => {
    document.addEventListener('click', closeThemeMenu, { once: true });
  }, 0);
}
function closeThemeMenu() {
  const m = document.getElementById('themeMenu');
  if (m) { m.classList.remove('open'); m.innerHTML = ''; m.setAttribute('aria-hidden', 'true'); }
  document.querySelectorAll('.th-card-menu.on').forEach(b => b.classList.remove('on'));
}

// ── 启动时绑定主题面板按钮(管理 / 新建 / 导入 / 导出) ──
(function _bootThemePanel() {
  const manageBtn = document.getElementById('thManageBtn');
  if (manageBtn) manageBtn.onclick = () => {
    if (_themeEditingKey && THEMES[_themeEditingKey]) {
      // 已经在编辑 → 关掉
      themeEditCancel();
    } else {
      // 进入管理态:打开编辑当前主题
      themeEditStart(THEME || 'simple');
    }
  };
  const newBtn = document.getElementById('thNewBtn');
  if (newBtn) newBtn.onclick = themeNew;
  const impBtn = document.getElementById('thImportBtn');
  if (impBtn) impBtn.onclick = themeImport;
  const expBtn = document.getElementById('thExportBtn');
  if (expBtn) expBtn.onclick = themeExportAll;
})();

function renderFilesPanel() {
  const list = document.getElementById('fpList');
  if (!list) return;
  if (!filesIndex.length) {
    list.innerHTML = `
      <div class="fp-empty">
        还没有打开任何文件。<br>
        点击 <b>＋ 新建</b> 选一个位置开始,<br>
        或 <b>⤓ 打开</b> 一个 <code>.tp3d.json</code>。
      </div>`;
    return;
  }
  list.innerHTML = '';
  for (const entry of filesIndex) {
    const div = document.createElement('div');
    div.className = 'fp-item';
    if (entry.id === currentFileId) div.classList.add('current');
    if (entry.id === currentFileId && unsaved) div.classList.add('dirty');
    div.dataset.id = entry.id;
    div.innerHTML = `
      <div class="fp-row1">
        <span class="fp-ico">${(entry._handle || entry._srv) ? '📄' : (entry._hasSnap ? '💾' : '⚠')}</span>
        <span class="fp-name"></span>
        <span class="fp-cur">当前</span>
      </div>
      <div class="fp-row2">
        <span class="fp-dot"></span>
        <span class="fp-time"></span>
      </div>`;
    div.querySelector('.fp-name').textContent = entry.name;
    div.querySelector('.fp-time').textContent =
      (entry._handle || entry._srv) ? fmtTimeAgo(entry.updatedAt) : (entry._hasSnap ? '浏览器本地' : '权限失效');
    div.addEventListener('click', () => switchToEntry(entry.id));
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      _showFileContextMenu(e.clientX, e.clientY, entry);
    });
    list.appendChild(div);
  }
}

function _showFileContextMenu(x, y, entry) {
  const m = document.getElementById('ctxMenu');
  if (!m) return;
  m.innerHTML = '';
  const items = [
    { t: '打开', icon: '⤓', fn: () => switchToEntry(entry.id) },
    { t: '复制文件名', icon: '⎘', fn: async () => {
      try { await navigator.clipboard.writeText(entry.fileName || entry.name); toast('文件名已复制', 'success', 1200); }
      catch (e) { toast('复制失败:请手动选择', 'warn', 1500); }
    }},
    { t: '重命名', icon: '✎', fn: () => _renameEntry(entry) },
    entry._srv
      ? { t: '删除文件(含磁盘)', icon: '🗑', danger: true, fn: () => _removeEntry(entry) }
      : { t: '从列表移除(不删磁盘文件)', icon: '✕', danger: true, fn: () => _removeEntry(entry) },
  ];
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'ci' + (it.danger ? ' danger' : '');
    b.innerHTML = `<span class="ic">${it.icon}</span><span>${it.t}</span>`;
    b.onclick = () => { m.style.display = 'none'; it.fn(); };
    m.appendChild(b);
  }
  // 显示:直接操作 DOM,避免依赖未声明的 helper
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  m.style.display = 'block';
}

function _renameEntry(entry) {
  tpDialog('重命名', `
    <div class="frow"><label>显示名</label><input id="rnName" type="text" value=""></div>
    <div class="note">提示:这只会改变列表中显示的名称,真实文件名通过"另存为"才能改。</div>`,
    [
      { t: '保存', fn: () => {
        const inp = document.getElementById('rnName');
        const v = (inp?.value || '').trim();
        if (!v) return toast('名称不能为空', 'warn');
        const doRename = async () => {
          // 服务器文件:磁盘文件名一起改(读旧 → 写新 → 删旧)
          if (entry._srv && entry.fileName && await srvProbe()) {
            try {
              const oldName = entry.fileName;
              const newName = safeFileName(v) + '.tp3d.json';
              if (newName !== oldName) {
                const text = await srvGet(oldName);
                const obj = JSON.parse(text);
                obj.name = v; obj.updatedAt = Date.now();
                await srvPut(newName, JSON.stringify(obj, null, 2));
                await srvDel(oldName);
                entry.fileName = newName;
              }
            } catch (e) { return toast('重命名失败:' + (e?.message || e), 'error', 5000); }
          }
          entry.name = v;
          if (currentFileId === entry.id) doc.name = v;
          saveFilesIndex();
          renderFilesPanel();
          if (currentFileId === entry.id) markUnsaved(true);   // 名字变了,自动保存会落新名
          toast('已重命名为:' + v, 'success', 1200);
        };
        doRename();
      }},
      { t: '取消' },
    ]);
  // 启动后填默认值
  setTimeout(() => {
    const inp = document.getElementById('rnName');
    if (inp) { inp.value = entry.name; inp.select(); }
  }, 50);
}

async function _removeEntry(entry) {
  // 不弹确认框(按需求):服务器文件直接删盘;当前文件切到空场景,
  // 内容仍留在 localStorage 草稿里(重载页面可找回),不静默清空
  try {
    if (entry._srv && entry.fileName && await srvProbe()) await srvDel(entry.fileName);
  } catch (e) { /* 盘上文件删不掉也要移出列表 */ }
  await idbDel(entry.id);
  snapDel(entry.id);
  filesIndex = filesIndex.filter(e => e.id !== entry.id);
  saveFilesIndex();
  if (entry.id === currentFileId) {
    currentFileId = null; currentHandle = null;
    doc = { name: '未命名', wallH: 2.75, levels: [{name:'1F', elev:0}], walls: [], furniture: [], floors: [], stairs: [], hidden: {} };
    sel = null; undoStack.length = 0; redoStack.length = 0;
    rebuild(); refreshProps(); markUnsaved(false);
  }
  renderFilesPanel();
  toast('已删除:' + entry.name, 'success', 1400);
}

// 重新选择文件位置(权限失效时用):把 entry._handle 重新指向一个新句柄
async function _relocateEntry(entry) {
  if (!FS_SUPPORT) return toast('当前浏览器不支持文件句柄', 'warn', 1800);
  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: 'TP3D 文件', accept: { 'application/json': ['.tp3d.json', '.json'] } }],
    });
    entry._handle = handle;
    entry.fileName = handle.name;
    entry.updatedAt = Date.now();
    await idbPut(entry.id, handle);
    saveFilesIndex();
    renderFilesPanel();
    toast('已重新关联文件位置', 'success', 1200);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    toast('关联失败:' + (e?.message || e), 'error', 5000);
  }
}

// 降级提示:仅当"既不支持 FSA 又没有本地服务器"时显示 banner。
// 文件面板不再因此隐藏 —— 服务器/快照机制都能建档切换
function _applyFsSupport() {
  const banner = document.getElementById('fsBanner');
  if (banner) banner.hidden = FS_SUPPORT || _srvOk === true;
}

// 旧版 localStorage.tp3d_plan 迁移:启动后弹一次
async function maybeMigrateOldPlan() {
  // 服务器模式下由 _srvReconcile 静默迁移(写 editor 目录),不走弹窗
  if (await srvProbe()) return;
  if (!FS_SUPPORT) return;
  if (localStorage.getItem('tp3d_migrated_v2')) return;
  const oldPlan = localStorage.getItem('tp3d_plan');
  if (!oldPlan) {
    localStorage.setItem('tp3d_migrated_v2', '1');
    return;
  }
  tpDialog('导入旧档案?', '<div class="note">检测到旧版本保存在浏览器中的档案,是否导入为新的本地文件?<br><br>选择"另存为新文件"会让你选择保存位置;<br>选择"丢弃"将清除旧数据。</div>',
    [
      { t: '另存为新文件', fn: async () => {
        try {
          let parsed;
          try { parsed = JSON.parse(oldPlan); } catch (e) { toast('旧档案已损坏', 'error'); localStorage.removeItem('tp3d_plan'); localStorage.setItem('tp3d_migrated_v2', '1'); return; }
          doc = parsed; doc.name = doc.name || '旧档案';
          normDoc();
          sel = null; rebuild(); refreshProps(); markUnsaved(true);
          await saveDocAs();
          localStorage.removeItem('tp3d_plan');
          localStorage.setItem('tp3d_migrated_v2', '1');
          renderFilesPanel();
        } catch (e) { toast('迁移失败:' + (e?.message || e), 'error'); }
      }},
      { t: '丢弃', fn() {
        localStorage.removeItem('tp3d_plan');
        localStorage.setItem('tp3d_migrated_v2', '1');
        toast('旧档案已丢弃', 'warn', 1400);
      }},
      { t: '稍后', fn() { localStorage.setItem('tp3d_migrated_v2', '1'); } },
    ]);
}

// 让 doc 变更函数标记 dirty:hook 进 pushUndo,这样所有"修改类"动作(undo 不算)都会标脏
const _origPushUndo = pushUndo;
pushUndo = function () {
  _origPushUndo();
  // 注意:undo/redo 自己 pushUndo 时也会被 hook — 显式跳过
  if (_inUndoRedo) return;
  markUnsaved(true);
};
let _inUndoRedo = false;
const _origUndo = undo;
undo = function () { _inUndoRedo = true; _origUndo(); _inUndoRedo = false; markUnsaved(true); };
const _origRedo = redo;
redo = function () { _inUndoRedo = true; _origRedo(); _inUndoRedo = false; markUnsaved(true); };
// ctxDelete 也属于"修改",但它没经过 pushUndo(直接删),显式 hook
const _origCtxDelete = ctxDelete;
ctxDelete = function (selOrKind) {
  pushUndo();
  _origCtxDelete(selOrKind);
  markUnsaved(true);
};

// hook 装完后,把"已 hook 的版本"重新挂到 window。
// _exposeE2E() 里的 globalThis.pushUndo = pushUndo 在 hook 之前,
  // 那时 pushUndo 还是原始版本,测试里调它不会触发 markUnsaved。
globalThis.pushUndo = pushUndo;
globalThis.undo = undo;
globalThis.redo = redo;
globalThis.markUnsaved = markUnsaved;

// 启动挂载
loadFilesIndex();
_applyFsSupport();
// 服务器模式启动对账:editor 目录 ↔ 文件面板
//  · 目录里有而列表没有的 .tp3d.json → 自动加入面板
//  · 列表里标 _srv 但盘上已消失的 → 去掉 _srv 标记(回落快照/句柄)
//  · 旧 localStorage 草稿 → 静默建档写盘(替代原来的"导入旧档案?"弹窗)
async function _srvReconcile() {
  if (!await srvProbe()) { _applyFsSupport(); return; }
  try {
    const disk = await srvList();
    const byName = new Map(disk.map(f => [f.name, f]));
    // 1. 盘上有、列表没有 → 建档
    for (const f of disk) {
      if (filesIndex.some(e => e.fileName === f.name)) continue;
      filesIndex.unshift({
        id: newId(),
        name: f.name.replace(/\.tp3d\.json$/i, ''),
        fileName: f.name,
        updatedAt: f.mtime,
        _srv: true,
      });
    }
    // 2. 列表里 _srv 但盘上没了 → 取消标记
    for (const e of filesIndex) {
      if (e._srv && e.fileName && !byName.has(e.fileName)) e._srv = false;
    }
    saveFilesIndex();
  } catch (e) { /* 对账失败不影响主流程 */ }
  // 3. 旧草稿静默迁移(不再弹"导入旧档案?"对话框)
  try {
    const draft = localStorage.getItem('tp3d_plan');
    if (draft && !localStorage.getItem('tp3d_migrated_v2')) {
      const d = JSON.parse(draft);
      const fname = safeFileName(d.name || '旧档案') + '.tp3d.json';
      let ent = filesIndex.find(e => e.fileName === fname);
      if (!ent) {
        await srvPut(fname, JSON.stringify({ tp3dVersion: TP3D_VERSION, name: d.name || '旧档案', updatedAt: Date.now(), doc: d }, null, 2));
        ent = { id: newId(), name: d.name || '旧档案', fileName: fname, updatedAt: Date.now(), _srv: true };
        filesIndex.unshift(ent);
      }
      // boot 时 doc 已经从草稿载入 → 挂上 currentFileId,后续编辑自动落盘
      currentFileId = ent.id;
      ent._hasSnap = true;
      saveFilesIndex();
      localStorage.setItem('tp3d_migrated_v2', '1');
    }
  } catch (e) { /* 草稿损坏:跳过迁移 */ }
  renderFilesPanel();
  _applyFsSupport();
}
(async () => { await _restoreHandles(); await _srvReconcile(); renderFilesPanel(); })();

// 侧栏 + 顶栏按钮绑定
const _fpNew = document.getElementById('fpNew');
const _fpOpen = document.getElementById('fpOpen');
if (_fpNew) _fpNew.onclick = () => newDoc();
if (_fpOpen) _fpOpen.onclick = () => openPicker();

// 主题面板渲染一次(后面切换主题时由 themeApply 触发更新)
renderThemePanel();

// 测试钩子: 把主题编辑相关内部函数暴露到 window,便于端到端测试触发流程
// (不影响正常用户使用;这些函数只在测试 / DevTools 里手动调)
if (typeof window !== 'undefined') {
  window._themeDeleteNow = _themeDeleteNow;
  window.themeNew = themeNew;
  window.themeApply = themeApply;
  window.themeImport = themeImport;
  window.themeEditStart = themeEditStart;
  window.themeEditSave = themeEditSave;
  window.themeEditCancel = themeEditCancel;
  window.themeReset = themeReset;
  window._themeStagingSet = (key, path, value) => {
    if (!_themeStaging) return;
    const parts = path.split('.');
    let obj = _themeStaging;
    for (let i = 0; i < parts.length - 1; i++) {
      if (obj[parts[i]] == null) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
  };
}

// 快捷键:在原 keydown 处理器基础上加 Ctrl+S / Ctrl+Shift+S / Ctrl+O
// 原代码已处理 Ctrl+Z/Y/C/V/D,补这三个
document.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.ctrlKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveDoc();
    return;
  }
  if (e.ctrlKey && e.shiftKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveDocAs();
    return;
  }
  if (e.ctrlKey && !e.shiftKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    openPicker();
    return;
  }
});

// 全屏切换时让 dirty 红点 / 标题重新对齐
window.addEventListener('resize', () => markUnsaved(unsaved));
// 画布尺寸变化时重算正交视锥：属性面板/大纲开关会改变画布宽度，
// 不重算会让俯视正交视图的投影与实际点击位置错位。
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => updateOrthoFrustum()).observe(renderer.domElement);
}

// 启动迁移提示(延迟到首帧后,避免阻塞)
setTimeout(() => { maybeMigrateOldPlan(); }, 800);

// 兜底删除:ctxMenu 显示/隐藏已内联在 _showFileContextMenu 中
