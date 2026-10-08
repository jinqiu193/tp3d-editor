# TP3D · AI-Powered Floor Plan Editor

[English](#english) · [中文](#中文)

---

## English

### What is TP3D?

TP3D is a browser-based **AI-powered 3D floor plan editor** built with vanilla JavaScript and Three.js — no build tools, no dependencies to install, just open and go.

Unlike traditional CAD software, TP3D combines **AI generation**, **real-time dual-view rendering** (2D SVG + 3D), and a curated **3D furniture library** into a single creative workflow for interior designers, architects, and anyone who wants to visualize a space in minutes.

### The Killer Feature: AI Generation

Type a description → get a complete floor plan with walls, doors, windows, and furniture. Three AI capabilities, all in the top toolbar:

| Feature | What it does |
|---|---|
| **✨ AI 生成户型** | Describe your layout in plain Chinese — e.g. *"两室一厅 80㎡，南向客厅带阳台，主卧朝南带独立卫生间"* — and the AI generates walls, openings, and furniture placements into a new plan file. No drawing required. |
| **🎨 AI 装修风格** | Describe a design style — e.g. *"北欧极简，白墙+浅木"* — and the AI generates 4 themed color/material packages with live previews. Pick one to apply instantly. |
| **🪑 AI 生成家具** | Describe any furniture — e.g. *"1920s 工业风金属台灯"* — the AI generates name, category, icon, and dimensions; you drag-and-drop your own GLB file to auto-import it into the library. |

All AI calls are routed through a streaming API (SSE), with real-time progress feedback. Results are parsed as structured JSON and imported directly into the scene.

### Other Highlights

- **Dual-mode rendering** — 2D SVG floor plan (`render2d.js`) and 3D Three.js scene (`main.js`) update simultaneously; switch views with one click
- **Room auto-detection** — Draw wall loops → one click auto-generates floor surfaces using raster-fill room-finding algorithm
- **200+ 3D models** — Home / Office / Medical furniture library with DRACO compression and InstancedMesh rendering
- **33+ code-built models** — Procedurally generated furniture with zero external asset dependency
- **HDRI + SSAO** — Poly Haven studio HDRIs for realistic reflections; screen-space ambient occlusion for depth
- **Floor plan file format** — `.tp3d.json` with silent auto-save via local Python API; no dialogs, no interruptions
- **Export** — GLTF/GLB scene export, DXF 2D floor plan export for AutoCAD
- **2D/3D HTML import** — Upload any third-party 3D floor plan HTML file; AI extracts walls, floors, and furniture from its code and imports them into TP3D

### Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JavaScript (ES Modules), ~13,000 lines |
| 3D Rendering | Three.js |
| 2D Rendering | SVG (Browser Native Skia) |
| Geometry | BufferGeometryUtils / three-bvh-csg / three-mesh-bvh |
| Lighting | RGBELoader + Poly Haven HDRIs |
| Post-processing | SSAO (three.js postprocessing) |
| Model Compression | DRACO (WASM decode) |
| AI Backend | MiniMax (Claude-compatible API) |
| Local Server | Python 3 stdlib `http.server` |

### Quick Start

#### Windows

Double-click `启动编辑器.bat` — it starts the server and opens the browser automatically.

#### Manual

```bash
python _serve.py 8137
# Then open http://127.0.0.1:8137
```

> Requires Python 3 in PATH.

### Directory Structure

```
editor/
├── index.html              # Main page (UI + styles, ~2500 lines)
├── main.js                 # 3D scene + AI logic (~13000 lines)
├── render2d.js             # 2D SVG floor plan renderer
├── _serve.py              # Local static server + API (AI proxy, file API)
├── 启动编辑器.bat           # Windows one-click launcher
├── json/                   # Floor plan data (.tp3d.json)
├── libs/
│   ├── three.module.js     # Three.js core
│   ├── items/             # 200+ furniture GLB models
│   ├── draco/             # DRACO WASM decoder
│   ├── postprocessing/    # SSAO, EffectComposer, ShaderPass
│   ├── shaders/           # CopyShader, SSAOShader, OutputShader
│   ├── environments/       # Poly Haven HDRI files
│   └── textures/           # PBR wood floor textures
└── utils/                  # Utility functions
```

### Floor Plan File Format

`.tp3d.json` files in `json/` contain the complete scene: wall geometry, openings, furniture placements, materials, themes, and camera state.

### License

[MIT License](LICENSE)

---

## 中文

### TP3D 是什么？

TP3D 是一款运行在浏览器中的 **AI 驱动 3D 户型编辑器**，使用原生 JavaScript + Three.js 构建，无需安装任何依赖，打开即用。

与传统 CAD 软件不同，TP3D 将 **AI 生成**、**实时双视角渲染**（2D SVG 平面图 + 3D 立体视角）和 **3D 家具库** 整合在同一个创作流程中，让室内设计师、建筑师以及任何想快速可视化空间的人，都能在几分钟内完成户型搭建。

### 核心亮点：AI 功能

输入一段文字描述 → 直接得到完整户型平面图（含墙体、门窗、家具）。三大 AI 能力，全部集成在顶部工具栏：

| 功能 | 说明 |
|---|---|
| **✨ AI 生成户型** | 用自然语言描述你的布局——比如 *"两室一厅 80㎡，南向客厅带阳台，主卧朝南带独立卫生间，次卧朝北"*——AI 自动生成墙体、门窗和家具，新建为一个户型文件，完全不需要手动绘图。 |
| **🎨 AI 装修风格** | 输入风格关键词——比如 *"北欧极简，白墙+浅木"*——AI 一次生成 4 个候选主题配色包，含实时预览效果，选中即应用到当前户型。 |
| **🪑 AI 生成家具** | 描述任何家具——比如 *"1920s 工业风金属台灯"*——AI 生成名称、分类、图标和尺寸元数据；拖入你自己的 GLB 文件即可自动入库并进入放置模式。 |

所有 AI 调用均通过流式 API（SSE）实现，界面实时显示生成进度。结果以结构化 JSON 解析，直接导入场景。

### 其他亮点

- **双模式实时渲染** — 2D SVG 平面图（`render2d.js`）与 3D Three.js 立体场景（`main.js`）同步更新，一键切换视角
- **自动房间识别** — 画好墙线后一键，AI 驱动的栅格填充算法自动识别围合区域并生成地面
- **200+ 3D 模型库** — 家居 / 办公 / 医疗家具，DRACO 压缩 + InstancedMesh 渲染优化
- **33+ 代码构建家具** — 程序化生成，零外部资产依赖，精度可控
- **HDRI 影棚光 + SSAO** — Poly Haven HDRIs 真实材质反射；屏幕空间环境光遮蔽增强立体感
- **户型文件静默保存** — 本地 Python API 自动读写 `.tp3d.json`，无弹窗、不打断
- **多格式导出** — GLTF/GLB 整场景导出、DXF 平面图导出（兼容 AutoCAD）
- **外部 3D HTML 导入** — 上传任意第三方 3D 户型 HTML 文件，AI 从代码中解析结构并迁移到 TP3D

### 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | 原生 JavaScript（ES Modules），约 13,000 行代码 |
| 3D 渲染 | Three.js |
| 2D 渲染 | SVG（浏览器原生 Skia） |
| 几何运算 | BufferGeometryUtils / three-bvh-csg / three-mesh-bvh |
| 光照 | RGBELoader + Poly Haven HDRI 影棚光 |
| 后处理 | SSAO（three.js postprocessing） |
| 模型压缩 | DRACO（WASM 解码） |
| AI 后端 | MiniMax（Claude 兼容 API） |
| 本地服务 | Python 3 标准库 `http.server` |

### 快速开始

#### Windows

双击 `启动编辑器.bat`，脚本自动启动本地服务器并打开浏览器。

#### 手动启动

```bash
python _serve.py 8137
# 然后在浏览器打开 http://127.0.0.1:8137
```

> 需要 Python 3 已加入系统 PATH。

### 目录结构

```
editor/
├── index.html              # 主页面（UI + 样式，约 2500 行）
├── main.js                 # 3D 场景 + AI 逻辑（约 13000 行）
├── render2d.js             # 2D SVG 平面图渲染器
├── _serve.py              # 本地静态服务器 + API（AI 代理、文件 API）
├── 启动编辑器.bat           # Windows 一键启动脚本
├── json/                   # 户型数据文件（.tp3d.json）
├── libs/
│   ├── three.module.js     # Three.js 核心库
│   ├── items/              # 200+ 家具 GLB 模型
│   ├── draco/             # DRACO WASM 解码器
│   ├── postprocessing/     # SSAO、EffectComposer、ShaderPass 后处理
│   ├── shaders/            # CopyShader、SSAOShader、OutputShader
│   ├── environments/       # Poly Haven HDRI 影棚光照文件
│   └── textures/           # PBR 木地板纹理贴图
└── utils/                  # 工具函数
```

### 户型文件格式

`.tp3d.json` 格式保存于 `json/` 目录，包含完整场景数据：墙体几何、门窗、家具摆放、材质、主题及相机状态。

### 许可证

[MIT License](LICENSE)
