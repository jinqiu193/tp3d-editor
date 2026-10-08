# libs/items/ 资产来源与许可

每个子目录里都附 `license.txt`，原文来源。所有模型在入库前都经过 `_tools/gltf2glb.py` 打包 + `_tools/draco_compress.mjs` Draco 压缩到 ≤3MB。

## CC-BY-4.0（可商用，需注明作者）

| folder | 名称 | 作者 |
|--------|------|------|
| glam-velvet-sofa | Glam Velvet Sofa | Eric Chadwick / Wayfair LLC (CC BY 4.0) |
| modern-coffee-table | Modern Coffee Table | Poly Haven |
| modern-armchair | Modern Armchair | Poly Haven |
| modern-cabinet | Modern Cabinet | Poly Haven |
| hospital-door | Hospital Door | anasrar (sketchfab) |
| hospital-bench | Hospital bench | nkulekoqiniso (sketchfab) |
| hospital-sharps-container | Hospital Sharps Container | cig3d (sketchfab) |
| pulse-oximeter | Pulse oximeter Ⅱ | 星医療酸器 (sketchfab) |
| medical-exam-lamp | Medical examination lamp | Chenchanchong (sketchfab) |
| hospital-bed | Hospital Bed | Logan S. (sketchfab) |
| modern-table | Modern Table | khanhnguyen1189 (sketchfab) |
| hospital-bedside-cabinet | Hospital medical bedside cabinet | Chenchanchong (sketchfab) |
| hospital-exam-chair | Hospital examination and treatment chair | Chenchanchong (sketchfab) |
| air-conditioner | Air conditioning | Speed (sketchfab) |
| hospital-medicine-cabinet | Hospital Medicine Storage Cabinet | Chenchanchong (sketchfab) |
| medical-surgical-cart | Medical Props (Surgical Cart 拆分) | coa white (sketchfab) |
| medical-equipment-7/8/9/19/20/25/26/41/43 | Medical Equipment (各 mesh 拆分) | A9908244 (sketchfab) |

## CC-BY-NC-4.0（**仅限非商用**）

| folder | 名称 | 作者 |
|--------|------|------|
| aveiro-cabinet | Aveiro Cabinet, Natural Oak and White | MADE.COM (sketchfab) |

## 环境/贴图（CC0）

- libs/environments/studio_small_03_1k.hdr — Poly Haven Studio Small 03
- libs/textures/wood-floor-040/ — ambientCG WoodFloor040 三贴图（baseColor/normal/roughness）

## 衍生/自建

- libs/items/<自定义名>/ — 用户通过"导入 3D 模型"按钮上传的 GLB，不打包进项目文件。

## How to add a new model

1. 把 `.gltf + .bin + textures/` 放到 `_tools/_zip_inspect/<name>/`
2. `python _tools/gltf2glb.py _tools/_zip_inspect/<name>/scene.gltb /tmp/x.glb` 看打包后大小
3. `node _tools/draco_compress.mjs /tmp/x.glb` 看压缩后大小（必须 ≤3MB）
4. 复制到 `libs/items/<name>/model.glb` + `libs/items/<name>/license.txt`
5. 在 main.js `FURN` 表 + `_PRELOAD_FILES` 里注册
6. 跑 `node _tools/_smoke_new_furn.mjs` 验证

或者用脚本（一次性批量）：
```
node _tools/_import_zip_models.mjs "D:\path\to\model.zip" <out-folder-name> [scale]
```
