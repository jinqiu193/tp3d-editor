# TP3D · 户型编辑器

一个基于原生 JavaScript + Three.js 的 3D 户型/户型编辑器，支持 2D 平面图与 3D 立体图双模式实时编辑，适用于室内设计、家装方案快速搭建与 3D 自动化建模场景。

## 功能特性

- **双模式渲染**：2D SVG 平面图（`render2d.js`）+ 3D Three.js 立体场景（`main.js`），两路同步更新
- **墙体 / 门窗**：画墙、插门、开窗，支持门把手方向自动判定、门窗洞口裁切
- **家具库**：内置 200+ 家具与设备模型（家居 / 办公 / 医疗场景），使用 GLB + DRACO 压缩，InstancedMesh 优化性能
- **原生代码建模**：除 GLB 外，另用代码构建 33+ 种原生家具，精细可辨认
- **户型文件管理**：本地服务器 API 读写 `.tp3d.json` 户型文件，静默保存无弹窗
- **导出**：支持 GLTF/GLB 导出
- **交互**：WASD 漫游、平移缩放、选择删除、网格吸附、Gizmo 变换

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 JavaScript (ES Modules) |
| 3D 渲染 | Three.js |
| 2D 渲染 | SVG (浏览器原生 Skia) |
| 几何运算 | BufferGeometryUtils / three-bvh-csg / three-mesh-bvh |
| 模型压缩 | DRACO (WASM 解码) |
| 本地服务 | Python 3 标准库 `http.server` |

## 快速开始

### Windows

双击 `启动编辑器.bat`，脚本会自动启动本地服务器并打开浏览器。

### 手动启动

```bash
# 启动本地服务器（提供静态托管 + 户型文件 API）
python _serve.py 8137

# 浏览器打开
# http://127.0.0.1:8137
```

> 需要安装 Python 3 并加入 PATH。

## 目录结构

```
editor/
├── index.html          # 主页面（UI + 样式）
├── main.js             # 3D 场景核心逻辑
├── render2d.js         # 2D SVG 平面图渲染
├── _serve.py           # 本地静态服务器 + 户型文件 API
├── 启动编辑器.bat       # Windows 一键启动
├── json/               # 户型数据文件 (.tp3d.json)
├── libs/
│   ├── three.module.js # Three.js
│   ├── items/          # 家具/设备 GLB 模型库
│   ├── draco/          # DRACO WASM 解码器
│   └── ...             # 其他 Three.js 插件
└── utils/              # 工具函数
```

## 户型文件格式

户型以 `.tp3d.json` 格式保存，包含墙体、门窗、家具等完整场景数据，存储在 `json/` 目录下。

## 许可证

[MIT License](LICENSE)