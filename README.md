# TP3D · Floor Plan Editor / 户型编辑器

[English](#english) · [中文](#中文)

---

## English

### TP3D · Floor Plan Editor

A browser-based 3D floor plan editor built with vanilla JavaScript and Three.js, featuring real-time dual-view rendering (2D SVG floor plan + 3D perspective) for interior design, rapid home furnishing layout, and 3D automated modeling workflows.

### Features

- **Dual-mode rendering** — 2D SVG floor plan (`render2d.js`) and 3D Three.js scene (`main.js`) update simultaneously; switch freely between views
- **Walls, Doors & Windows** — Draw walls, insert doors and windows with automatic door-handle orientation detection and wall-cutout generation
- **Furniture Library** — 200+ furniture and equipment GLB models across Home / Office / Medical scenes, compressed with DRACO (WASM), rendered via InstancedMesh for performance
- **Code-based Modeling** — 33+ furniture types procedurally built with code (not GLB), offering pixel-precise detail and zero external asset dependency
- **HDRI Lighting** — Studio-quality environment lighting with Poly Haven HDRIs for realistic material reflections
- **SSAO Ambient Occlusion** — Screen-space ambient occlusion post-processing for depth and realism
- **Floor Textures** — PBR wood-floor textures with normal and roughness maps
- **Floor Plan Files** — Local Python server API for silent save/load of `.tp3d.json` floor plan files with no dialogs
- **Export** — GLTF/GLB export of the entire scene
- **Interactions** — WASD fly-through, pan/zoom, select/delete, grid snap, Gizmo transform controls

### Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JavaScript (ES Modules) |
| 3D Rendering | Three.js |
| 2D Rendering | SVG (Browser Native Skia) |
| Geometry | BufferGeometryUtils / three-bvh-csg / three-mesh-bvh |
| Lighting | RGBELoader + Poly Haven HDRIs |
| Post-processing | SSAO (three.js postprocessing) |
| Model Compression | DRACO (WASM decode) |
| Local Server | Python 3 stdlib `http.server` |

### Quick Start

#### Windows

Double-click `启动编辑器.bat` — it starts the local server and opens the browser automatically.

#### Manual

```bash
# Start local server (static hosting + floor plan file API)
python _serve.py 8137

# Open in browser
# http://127.0.0.1:8137
```

> Requires Python 3 added to PATH.

### Directory Structure

```
editor/
├── index.html              # Main page (UI + styles, ~2500 lines)
├── main.js                 # 3D scene core logic
├── render2d.js             # 2D SVG floor plan renderer
├── _serve.py              # Local static server + floor plan file API
├── 启动编辑器.bat           # Windows one-click launcher
├── json/                   # Floor plan data (.tp3d.json)
├── libs/
│   ├── three.module.js     # Three.js
│   ├── items/              # 200+ furniture/equipment GLB models
│   ├── draco/              # DRACO WASM decoder
│   ├── postprocessing/     # SSAO, EffectComposer, ShaderPass
│   ├── shaders/            # CopyShader, SSAOShader, OutputShader
│   ├── environments/       # Poly Haven HDRI studio lighting
│   ├── textures/           # PBR wood floor textures
│   └── ...
└── utils/                  # Utility functions
```

### Floor Plan File Format

Floor plans are saved as `.tp3d.json` in the `json/` directory, containing complete scene data: walls, doors, windows, furniture placements, materials, and camera state.

### License

[MIT License](LICENSE)

---

## 中文

### TP3D · 户型编辑器

一款基于浏览器运行的 3D 户型编辑器，使用原生 JavaScript + Three.js 构建，配备实时双视角渲染（2D SVG 平面图 + 3D 立体视角），适用于室内设计、家装方案快速搭建与 3D 自动化建模场景。

### 功能特性

- **双模式渲染** — 2D SVG 平面图（`render2d.js`）与 3D Three.js 立体场景（`main.js`）实时同步更新，可自由切换视角
- **墙体 / 门窗** — 画墙、插门、开窗，支持门把手方向自动判定、门窗洞口自动裁切
- **家具库** — 内置 200+ 家具与设备 GLB 模型（家居 / 办公 / 医疗场景），DRACO 压缩 + InstancedMesh 渲染优化
- **HDRI 光照** — 采用 Poly Haven HDRI 影棚级环境光照，呈现真实材质反射效果
- **SSAO 环境光遮蔽** — 屏幕空间环境光遮蔽后处理，增强场景立体感与真实感
- **地面纹理** — PBR 木地板纹理，含法线贴图与粗糙度贴图
- **原生代码建模** — 33+ 种家具以代码程序化构建（非 GLB），精度高、无外部资产依赖
- **户型文件管理** — 本地服务器 API 读写 `.tp3d.json` 户型文件，静默保存无弹窗
- **导出** — 支持 GLTF/GLB 整场景导出
- **交互操作** — WASD 漫游飞行、平移缩放、选择删除、网格吸附、Gizmo 变换操控

### 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | 原生 JavaScript (ES Modules) |
| 3D 渲染 | Three.js |
| 2D 渲染 | SVG（浏览器原生 Skia） |
| 几何运算 | BufferGeometryUtils / three-bvh-csg / three-mesh-bvh |
| 光照 | RGBELoader + Poly Haven HDRI 影棚光 |
| 后处理 | SSAO（three.js postprocessing） |
| 模型压缩 | DRACO（WASM 解码） |
| 本地服务 | Python 3 标准库 `http.server` |

### 快速开始

#### Windows

双击 `启动编辑器.bat`，脚本自动启动本地服务器并打开浏览器。

#### 手动启动

```bash
# 启动本地服务器（静态托管 + 户型文件 API）
python _serve.py 8137

# 浏览器打开
# http://127.0.0.1:8137
```

> 需要安装 Python 3 并加入系统 PATH。

### 目录结构

```
editor/
├── index.html              # 主页面（UI + 样式，约 2500 行）
├── main.js                 # 3D 场景核心逻辑
├── render2d.js             # 2D SVG 平面图渲染器
├── _serve.py              # 本地静态服务器 + 户型文件 API
├── 启动编辑器.bat           # Windows 一键启动脚本
├── json/                   # 户型数据文件（.tp3d.json）
├── libs/
│   ├── three.module.js     # Three.js 核心库
│   ├── items/              # 200+ 家具/设备 GLB 模型
│   ├── draco/             # DRACO WASM 解码器
│   ├── postprocessing/     # SSAO、EffectComposer、ShaderPass 后处理
│   ├── shaders/            # CopyShader、SSAOShader、OutputShader
│   ├── environments/       # Poly Haven HDRI 影棚光照文件
│   ├── textures/           # PBR 木地板纹理贴图
│   └── ...                 # 其他 Three.js 插件与工具库
└── utils/                  # 工具函数
```

### 户型文件格式

户型以 `.tp3d.json` 格式保存于 `json/` 目录，包含完整的场景数据：墙体结构、门窗位置、家具摆放、材质设置及相机状态。

### 许可证

[MIT License](LICENSE)
