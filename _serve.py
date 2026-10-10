#!/usr/bin/env python3
"""带 no-cache 头的本地静态服务器 + 户型文件 API。

文件 API(读写限定在 <服务器目录>/json/ 内,只接受 .json):
  GET  /api/files/list            → {"files": [{name, mtime, size}]}
  GET  /api/files/get?name=X      → 文件原始内容(text/plain)
  POST /api/files/put?name=X      → 请求体即文件内容,写盘成功 {"ok":true,"bytes":N,"mtime":ms}
  POST /api/files/del?name=X      → 删除文件 {"ok":true}

设计目的:浏览器沙箱不允许网页直接写任意路径(File System Access 必须弹授权),
本地开发场景下由服务器代写 editor/json 目录,前端即可全程静默保存、无任何弹窗。
启动时把服务器根目录遗留的 *.tp3d.json 一次性迁移进 json/。
"""
import http.server
import socketserver
import json
import math
import os
import re
import shutil
import sys
import time as _time
import urllib.error
import urllib.request
from urllib.parse import urlparse, parse_qs, unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
DIR = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))
JSON_DIR = os.path.join(DIR, 'json')
ITEMS_DIR = os.path.join(DIR, 'libs', 'items')
_DIR_NAME_RE = re.compile(r'^[A-Za-z0-9_\-]{1,64}$')

os.makedirs(JSON_DIR, exist_ok=True)

# 一次性迁移:根目录遗留的户型文件 → json/(同名不覆盖)
try:
    for fn in os.listdir(DIR):
        if fn.lower().endswith('.json') and not os.path.exists(os.path.join(JSON_DIR, fn)):
            shutil.move(os.path.join(DIR, fn), os.path.join(JSON_DIR, fn))
            print(f"[migrate] {fn} -> json/")
except OSError:
    pass

_NAME_RE = re.compile(r'^[^\\/:*?"<>|\x00-\x1f]+$')   # 禁路径分隔符与控制字符


# ── AI 户型生成(可选,需本地密钥文件) ──────────────────────────
# 密钥文件是纯文本一行 API key,默认 ~/.auto-coder/keys/minimax_m3-1-flash-preview
AI_BASE_URL = os.environ.get('TP3D_AI_BASE_URL', 'https://api.minimaxi.com/v1')
AI_MODEL = os.environ.get('TP3D_AI_MODEL', 'MiniMax-M3.1-Flash-Preview')
AI_KEY_FILE = os.environ.get(
    'TP3D_AI_KEY_FILE',
    os.path.join(os.path.expanduser('~'), '.auto-coder', 'keys', 'minimax_m3-1-flash-preview'))
AI_TIMEOUT = 600
# low=十几秒出图(推荐交互场景); 留空或 medium/high = 自适应思考(更精细,1~4 分钟)
AI_REASONING_EFFORT = os.environ.get('TP3D_AI_REASONING_EFFORT', 'low')

_AI_SYSTEM = '''你是 TP3D 户型编辑器的户型生成引擎。根据用户的文字描述，输出一个完整可渲染的户型 JSON。

【坐标系】单位=米。x 向右，z 向下（即 2D 平面图方向）。户型左上角放在 (0,0)，整体范围 x∈[0,W]、z∈[0,D]。
方位约定：北=-z（平面图上方），南=+z（下方），东=+x，西=-x。"南向"指主要采光窗/阳台在 z 较大的一侧。

【输出格式】只输出一个 JSON 对象（不要 markdown 代码块、不要解释文字），结构如下：
{
 "summary": "一句话概括这个户型",
 "name": "户型名，10字以内",
 "wallH": 2.75,
 "levels": [{"name":"1F","elev":0}],
 "walls": [
   {"ax":0,"az":0,"bx":9.6,"bz":0,"th":0.2,"openings":[
      {"type":"door","t":0.5,"width":0.95},
      {"type":"window","t":0.3,"width":1.5}
   ]}
 ],
 "floors": [{"x1":0,"z1":0,"x2":9.6,"z2":8.4,"th":0.15,"color":"#dcd6cc"}],
 "furniture": [
   {"type":"bed","x":1.0,"z":1.25,"rot":0}
 ]
}

【墙体规则】
- 墙由两端点 (ax,az)→(bx,bz) 定义。外墙 th=0.2，内墙 th=0.12。
- 端点必须精确对齐：外墙一圈闭合，内墙两端必须落在其他墙段上，不留缝隙、不重叠画两遍。
- openings.t = 洞口【中心】在墙长上的比例(0~1)，洞口边缘距墙两端 ≥0.15，同一面墙上相邻洞口净距 ≥0.3。
- 门：width 0.8~1.0（入户门 1.2~1.5）。窗：width 0.9~2.4，height 1.5~1.8，sill 0.9。
- 卧室至少一扇窗（南墙或北墙）；卫生间开小窗(width 0.6)或不开窗；入户门开在南侧外墙或用户指定的入户方向。

【家具规则】
- type 必须严格从下方目录中选取，禁止编造。
- x,z = 家具中心点坐标。家具必须完整放在房间内部：任何一边距墙 ≥0.05（贴墙家具如衣柜/马桶/洗手台可距墙 0.05~0.15），家具之间不重叠。
- rot 单位=弧度，只能取 0、1.5708、3.1416、-1.5708。rot=0 时家具正面朝 +z（南/平面图下方）。
- 床：rot=0 时床头贴 -z 侧（床头在房间北侧）。床头要靠南墙则 rot=3.1416，靠东墙(+x 侧)则 rot=1.5708，靠西墙则 rot=-1.5708。
- 沙发面向电视柜摆放（两者相对，沙发 rot 使其正面朝向电视）。
- 餐桌用 "dining"（自带 4 椅）。厨房沿一面墙布置 kitchen/kitchenCabinet/stove/fridge。
- 马桶、洗手台、浴缸、淋浴、衣柜、鞋柜、书柜等贴墙家具：rot 使其【背靠】所在墙。
- 每个房间家具数量适中：卧室=床+床头柜 1~2 个+衣柜+可选书桌；客厅=沙发+茶几+电视柜+电视；卫生间=马桶+洗手台+可选淋浴或浴缸；厨房=厨房柜体+冰箱。
- 所有家具面积之和 ≤ 套内面积约 40%，保留通行空间。

【可用家具目录】type|名称|宽w米|深d米
{catalog}

【任务】
按用户描述生成户型。描述未提到的细节按常规设计习惯补全。只输出 JSON。'''


# ── AI 装修主题（与 /api/ai/style 配对） ──────────────────────
_AI_STYLE_SYSTEM = '''你是 TP3D 户型编辑器的室内设计风格引擎。根据用户的文字描述（风格名/关键词/场景），
输出 4 个差异明显的装修主题方案，覆盖不同色温/材质/氛围，用户可在 UI 中预览后择一应用。

【输出格式】只输出一个 JSON 对象（不要 markdown 代码块、不要解释文字），结构如下：
{
  "themes": [
    {
      "name": "主题名（4字以内）",
      "icon": "单字符 emoji 或符号（1-2 字符：◯ ▥ ▦ ◫ ⬛ 🪵 🎋 🌿 🌸 🏔）",
      "desc": "一句话说明这个风格的氛围/适用场景（30 字以内）",
      "wall":   {"base": "#xxxxxx", "tex": "wood|grid|tile|空字符串"},
      "floor":  {"color": "#xxxxxx", "tex": "wood|grid|tile|wood-floor-040|空字符串"},
      "door":   {"leafColor": "#xxxxxx", "leafTex": "wood|grid|tile|空字符串", "glassColor": "default|#xxxxxx"},
      "window": {"leafColor": "#xxxxxx", "leafTex": "wood|grid|tile|空字符串", "glassColor": "default|#xxxxxx"}
    },
    ...（共 4 个主题，必须覆盖不同风格差异，不要重复相似色）
  ]
}

【颜色规则】
- base/leafColor/glassColor：必须以 # 开头的 6 位 hex（如 #c8a06a），不能简写为 #fff。
- 4 个主题的 wall base 色相应明显不同（冷/暖/中/鲜），便于对比选择。

【纹理规则】
- 墙 tex 只能选 wood/grid/tile 或空字符串
- 地 tex 可选 wood/grid/tile/wood-floor-040 或空字符串
- 门/窗 leafTex 只能选 wood/grid/tile 或空字符串（门窗贴木纹最常见）
- "wood-floor-040" 是高清 PBR 木地板，只适合 floor

【任务】
根据用户描述的装修风格，输出 4 个差异明显的主题候选，覆盖从冷到暖、从简到繁的渐变，让用户有选挑空间。'''


_TEX_ALLOWED = {'', 'wood', 'grid', 'tile'}
_FLOOR_TEX_ALLOWED = _TEX_ALLOWED | {'wood-floor-040'}
_HEX_RE = re.compile(r'^#[0-9a-fA-F]{6}$')


def _validate_ai_theme(t):
    """钳制 AI 输出主题;丢弃非法 hex/tex,补默认值。返回 None 表示该主题无效。"""
    if not isinstance(t, dict):
        return None
    name = str(t.get('name') or '').strip()[:10]
    icon = str(t.get('icon') or '◯')[:2]
    desc = str(t.get('desc') or '').strip()[:80]
    if not name:
        return None

    def _slot(d_in, sect, tex_ok):
        d = d_in if isinstance(d_in, dict) else {}
        base = str(d.get('base') or d.get('color') or d.get('leafColor') or '#dddddd')
        if not _HEX_RE.match(base):
            base = '#dddddd'
        tex = str(d.get('tex') or d.get('leafTex') or '')
        if tex not in tex_ok:
            tex = ''
        glass = str(d.get('glassColor') or 'default') or 'default'
        if glass != 'default' and not _HEX_RE.match(glass):
            glass = 'default'
        return {'base': base, 'tex': tex, 'leafColor': base, 'leafTex': tex, 'color': base, 'glassColor': glass}

    wall = _slot(t.get('wall'), 'wall', _TEX_ALLOWED)
    floor = _slot(t.get('floor'), 'floor', _FLOOR_TEX_ALLOWED)
    door = _slot(t.get('door'), 'door', _TEX_ALLOWED)
    window = _slot(t.get('window'), 'window', _TEX_ALLOWED)
    return {'name': name, 'icon': icon, 'desc': desc,
            'wall': wall, 'floor': floor, 'door': door, 'window': window}


def _catalog_text(catalog):
    rows = []
    for c in catalog[:200]:
        try:
            rows.append(f"{c[0]}|{c[1]}|{float(c[2]):.2f}×{float(c[3]):.2f}")
        except Exception:
            continue
    return '\n'.join(rows) if rows else '(空)'


# ── AI 家具元数据（与 /api/ai/furniture-meta 配对） ──────────────────────
# 用户输入文字描述 → AI 输出 name/cat/w/d/h/icon（不含 GLB 字节;字节由前端让用户上传/指定 blender-mcp 生成）
_AI_FURN_META_SYSTEM = '''你是 TP3D 户型编辑器的家具元数据生成器。用户描述想要的家具/装饰,输出适配编辑器 FURN 注册表的元数据。

【可用分类】custom, bed, bath, kitchen, hvac, furn, light, media, misc, outdoor, safety, medical, other

【输出格式】只输出一个 JSON 对象（不要 markdown 代码块、不要解释文字），结构如下：
{
  "name": "家具中文名（≤12 字）",
  "cat": "furn|bed|kitchen|light|misc|...（严格从上方可用分类中选）",
  "w": 0.5,   // 宽度（米）,0.1 ~ 1.5
  "d": 0.5,   // 深度（米）,0.1 ~ 1.5
  "h": 0.5,   // 高度（米）,0.1 ~ 2.5
  "icon": "🪑", // 单字符 emoji 表示类别（🛏 🪑 🛋 ☕ 🪞 🪟 💡 🪴 🎨 📦 ⬛ 🏛 等）
  "yOff": 0,  // 模型离地高度补偿（贴墙/挂墙用,正数=抬高,负数=下沉,默认 0）
  "desc": "一句话描述这件家具的形态/材质/用途（40 字以内）"
}

【规则】
- 家具尺寸：台面小件 0.3~0.6m；桌椅 0.4~0.8m；床 1.5~2.2m 宽 / 2.0~2.2m 深；柜 0.4~1.0m 宽 / 0.3~0.6m 深 / 1.0~2.2m 高。
- icon 必须能直接表达这个家具的类别。
- 描述文字"形态/材质/用途"让用户能想象出来,例如:"胡桃木框架,米色绒面坐垫,带扶手"'''


_FURN_CAT_OK = {'custom', 'bed', 'bath', 'kitchen', 'hvac', 'furn', 'light', 'media', 'misc', 'outdoor', 'safety', 'medical', 'other'}


def _validate_ai_furn_meta(data):
    if not isinstance(data, dict):
        return None
    name = str(data.get('name') or '').strip()[:30]
    cat = str(data.get('cat') or 'misc')
    if cat not in _FURN_CAT_OK:
        cat = 'misc'
    try:
        w = float(data.get('w') or 0.5)
        d = float(data.get('d') or 0.5)
        h = float(data.get('h') or 0.5)
    except (TypeError, ValueError):
        return None
    w = max(0.1, min(2.5, w))
    d = max(0.1, min(2.5, d))
    h = max(0.1, min(3.0, h))
    icon = str(data.get('icon') or '📦')[:4] or '📦'
    try:
        yOff = float(data.get('yOff') or 0)
    except (TypeError, ValueError):
        yOff = 0
    yOff = max(-1.5, min(1.5, yOff))
    desc = str(data.get('desc') or '').strip()[:120]
    if not name:
        return None
    return {'name': name, 'cat': cat, 'w': round(w, 3), 'd': round(d, 3),
            'h': round(h, 3), 'icon': icon, 'yOff': round(yOff, 3), 'desc': desc}


def _api_ai_furniture_meta(body):
    t0 = _time.time()
    try:
        req = json.loads(body.decode('utf-8')) if body else {}
    except Exception:
        return {'ok': False, 'error': '请求体必须是 JSON'}
    prompt = str(req.get('prompt') or '').strip()
    if not prompt:
        return {'ok': False, 'error': '描述为空'}
    if len(prompt) > 500:
        prompt = prompt[:500]
    if not os.path.exists(AI_KEY_FILE):
        return {'ok': False, 'error': f'未找到 AI 密钥文件: {AI_KEY_FILE}'}
    with open(AI_KEY_FILE, encoding='utf-8') as fh:
        key = fh.read().strip()
    if not key:
        return {'ok': False, 'error': 'AI 密钥文件为空'}

    base_msgs = [
        {'role': 'system', 'content': _AI_FURN_META_SYSTEM},
        {'role': 'user', 'content': prompt},
    ]
    content, err = _ai_chat(key, base_msgs)
    if err:
        return {'ok': False, 'error': err}
    data = _try_json(content)
    if data is None:
        msgs = base_msgs + [
            {'role': 'assistant', 'content': content[:4000]},
            {'role': 'user', 'content': '上面的输出不是合法 JSON。请重新输出，只输出一个合法 JSON 对象，不要任何解释或代码块标记。'},
        ]
        content, err = _ai_chat(key, msgs)
        if err:
            return {'ok': False, 'error': err}
        data = _try_json(content)
        if data is None:
            return {'ok': False, 'error': 'AI 返回的内容不是合法 JSON，请换个描述重试', 'raw': content[:2000]}

    meta = _validate_ai_furn_meta(data)
    if not meta:
        return {'ok': False, 'error': 'AI 输出的元数据不合法（缺名称/尺寸）', 'raw': content[:2000]}
    return {'ok': True, 'meta': meta, 'elapsed': round(_time.time() - t0, 1)}


def _try_json(content):
    """宽容解析:剥代码块围栏、截取首尾大括号。失败返回 None。"""
    if not content:
        return None
    s = content.strip()
    s = re.sub(r'^```(?:json)?\s*', '', s)
    s = re.sub(r'\s*```$', '', s)
    i, j = s.find('{'), s.rfind('}')
    if i < 0 or j <= i:
        return None
    try:
        return json.loads(s[i:j + 1])
    except Exception:
        return None


def _ai_chat(key, messages):
    payload = {
        'model': AI_MODEL,
        'messages': messages,
        'response_format': {'type': 'json_object'},
        'temperature': 0.5,
    }
    if AI_REASONING_EFFORT:
        payload['reasoning_effort'] = AI_REASONING_EFFORT
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    rq = urllib.request.Request(
        AI_BASE_URL.rstrip('/') + '/chat/completions', data=body, method='POST',
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(rq, timeout=AI_TIMEOUT) as r:
            resp = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8')[:300]
        except Exception:
            pass
        return None, f'AI API HTTP {e.code}: {detail}'
    except Exception as e:  # noqa: BLE001
        return None, f'AI 请求失败: {e}'
    br = resp.get('base_resp') or {}
    if br.get('status_code', 0) != 0:
        return None, 'AI API 错误: ' + str(br.get('status_msg'))
    try:
        return resp['choices'][0]['message']['content'], None
    except Exception:
        return None, 'AI 响应格式异常: ' + json.dumps(resp, ensure_ascii=False)[:300]


def _num(v, lo, hi, default):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f:  # NaN
        return default
    return max(lo, min(hi, f))


def _norm_rot(v):
    """吸附到 90° 的整数倍,再归一化到 [-π, π)。模型偶尔输出角度制(如 90),先识别转换。"""
    rot = _num(v, -360, 360, 0.0)
    if abs(rot) > 7:          # 超出弧度合理范围 → 按角度制处理
        rot = math.radians(rot)
    k = round(rot / (math.pi / 2))
    rot = (k * math.pi / 2 + math.pi) % (2 * math.pi) - math.pi
    return round(rot, 4)


def _validate_ai_doc(data, catalog):
    """钳制 AI 输出为可渲染的 doc;丢弃非法项并计数。catalog: {type: [type,name,w,d]} 或 None。"""
    stats = {'walls': 0, 'openings': 0, 'furniture': 0, 'floors': 0, 'droppedFurniture': 0, 'droppedOverlap': 0, 'overlapWarn': 0}
    catalog_map = {row[0]: row for row in catalog} if isinstance(catalog, list) and catalog else {}
    walls_out = []
    for w in (data.get('walls') or [])[:160]:
        if not isinstance(w, dict):
            continue
        ax = _num(w.get('ax'), -300, 300, 0)
        az = _num(w.get('az'), -300, 300, 0)
        bx = _num(w.get('bx'), -300, 300, 0)
        bz = _num(w.get('bz'), -300, 300, 0)
        if (ax - bx) ** 2 + (az - bz) ** 2 < 0.09:   # <0.3m 的碎墙丢弃
            continue
        th = _num(w.get('th'), 0.06, 0.6, 0.12)
        wall_len = math.hypot(bx - ax, bz - az)
        ops_out = []
        for op in (w.get('openings') or [])[:14]:
            if not isinstance(op, dict):
                continue
            typ = op.get('type')
            if typ not in ('door', 'window'):
                continue
            t = _num(op.get('t'), 0.0, 300.0, 0.5)
            if t > 1.0 and wall_len > 0.5:
                t /= wall_len          # 模型把 t 当米数输出了 → 换算成比例
            t = max(0.04, min(0.96, t))
            if typ == 'door':
                width = _num(op.get('width'), 0.5, 2.4, 0.9)
            else:
                width = _num(op.get('width'), 0.4, 3.6, 1.2)
            o = {'type': typ, 't': round(t, 4), 'width': round(width, 3)}
            if typ == 'window':
                o['height'] = round(_num(op.get('height'), 0.4, 2.4, 1.65), 3)
                o['sill'] = round(_num(op.get('sill'), 0.0, 2.0, 0.9), 3)
            ops_out.append(o)
        walls_out.append({'ax': round(ax, 3), 'az': round(az, 3), 'bx': round(bx, 3),
                          'bz': round(bz, 3), 'th': round(th, 3), 'openings': ops_out, 'lv': 0})
        stats['openings'] += len(ops_out)

    furn_out = []
    for f in (data.get('furniture') or [])[:300]:
        if not isinstance(f, dict):
            continue
        ftype = str(f.get('type') or '')
        if not ftype:
            continue
        if catalog and ftype not in catalog_map:
            stats['droppedFurniture'] += 1
            continue
        furn_out.append({'type': ftype,
                         'x': round(_num(f.get('x'), -300, 300, 0), 3),
                         'z': round(_num(f.get('z'), -300, 300, 0), 3),
                         'rot': _norm_rot(f.get('rot')), 'lv': 0})

    # ── 家具-家具 AABB 重叠剔除(参考 openfloorplan-main/js/project.js:1110 思路) ──
    # 旋转 90° 倍数时 w/d 对调,避免因朝向旋转让两个 AABB 看似不重叠但实际相交
    def _aabb_of(item):
        info = catalog_map.get(item.get('type')) if catalog_map else None
        if not info or len(info) < 4:
            return None
        try:
            w, d = float(info[2]), float(info[3])
        except (TypeError, ValueError):
            return None
        if w <= 0 or d <= 0:
            return None
        rot = float(item.get('rot') or 0)
        if abs(abs(rot) - math.pi / 2) < 0.01:  # 90° → 互换
            w, d = d, w
        x, z = float(item.get('x', 0)), float(item.get('z', 0))
        return (x - w / 2, z - d / 2, x + w / 2, z + d / 2)
    furn_clean = []
    for item in furn_out:
        a = _aabb_of(item)
        if a is None:
            furn_clean.append(item); continue
        conflict = False
        for prev in furn_clean:
            b = _aabb_of(prev)
            if b is None:
                continue
            # AABB 重叠(两盒在 X 或 Z 上不相交则不重叠)
            if not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1]):
                conflict = True
                stats['droppedOverlap'] += 1
                break
        if not conflict:
            furn_clean.append(item)
    furn_out = furn_clean
    stats['overlapWarn'] = stats['droppedOverlap']

    floors_out = []
    for fl in (data.get('floors') or [])[:20]:
        if not isinstance(fl, dict):
            continue
        x1 = _num(fl.get('x1'), -300, 300, 0)
        z1 = _num(fl.get('z1'), -300, 300, 0)
        x2 = _num(fl.get('x2'), -300, 300, 0)
        z2 = _num(fl.get('z2'), -300, 300, 0)
        if x1 > x2:
            x1, x2 = x2, x1
        if z1 > z2:
            z1, z2 = z2, z1
        if x2 - x1 < 0.2 or z2 - z1 < 0.2:
            continue
        color = str(fl.get('color') or '#dcd6cc')
        if not re.match(r'^#[0-9a-fA-F]{3,8}$', color):
            color = '#dcd6cc'
        floors_out.append({'x1': round(x1, 3), 'z1': round(z1, 3), 'x2': round(x2, 3),
                           'z2': round(z2, 3), 'th': round(_num(fl.get('th'), 0.05, 1.0, 0.15), 3),
                           'color': color, 'lv': 0})

    levels = [{'name': '1F', 'elev': 0}]
    lv_in = data.get('levels')
    if isinstance(lv_in, list) and lv_in:
        out = []
        for l in lv_in[:5]:
            if isinstance(l, dict):
                out.append({'name': str(l.get('name') or '1F')[:20],
                            'elev': _num(l.get('elev'), -50, 50, 0)})
        if out:
            levels = out

    name = str(data.get('name') or 'AI户型').strip()[:40] or 'AI户型'
    stats['walls'] = len(walls_out)
    stats['furniture'] = len(furn_out)
    stats['floors'] = len(floors_out)
    doc = {'name': name,
           'wallH': round(_num(data.get('wallH'), 2.2, 6.0, 2.75), 2),
           'levels': levels, 'walls': walls_out, 'floors': floors_out,
           'furniture': furn_out, 'stairs': [], 'hidden': {}}
    return doc, stats


def _api_ai_style(body):
    """AI 装修主题:输入风格描述,返回 4 个候选主题(墙/地/门/窗配色+纹理)。"""
    t0 = _time.time()
    try:
        req = json.loads(body.decode('utf-8')) if body else {}
    except Exception:
        return {'ok': False, 'error': '请求体必须是 JSON'}
    prompt = str(req.get('prompt') or '').strip()
    if not prompt:
        return {'ok': False, 'error': '描述为空'}
    if len(prompt) > 500:
        prompt = prompt[:500]
    if not os.path.exists(AI_KEY_FILE):
        return {'ok': False, 'error': f'未找到 AI 密钥文件: {AI_KEY_FILE}'}
    with open(AI_KEY_FILE, encoding='utf-8') as fh:
        key = fh.read().strip()
    if not key:
        return {'ok': False, 'error': 'AI 密钥文件为空'}

    base_msgs = [
        {'role': 'system', 'content': _AI_STYLE_SYSTEM},
        {'role': 'user', 'content': prompt},
    ]
    content, err = _ai_chat(key, base_msgs)
    if err:
        return {'ok': False, 'error': err}
    data = _try_json(content)
    if data is None:
        msgs = base_msgs + [
            {'role': 'assistant', 'content': content[:4000]},
            {'role': 'user', 'content': '上面的输出不是合法 JSON。请重新输出，只输出一个合法 JSON 对象，不要任何解释或代码块标记。'},
        ]
        content, err = _ai_chat(key, msgs)
        if err:
            return {'ok': False, 'error': err}
        data = _try_json(content)
        if data is None:
            return {'ok': False, 'error': 'AI 返回的内容不是合法 JSON，请换个描述重试', 'raw': content[:2000]}

    raw = data.get('themes') if isinstance(data, dict) else None
    if not isinstance(raw, list) or not raw:
        return {'ok': False, 'error': 'AI 未返回 themes 数组'}
    themes = []
    for t in raw[:6]:
        v = _validate_ai_theme(t)
        if v:
            themes.append(v)
    if not themes:
        return {'ok': False, 'error': '所有主题均不合法（颜色/纹理格式错误）', 'raw': content[:2000]}
    return {'ok': True, 'themes': themes, 'elapsed': round(_time.time() - t0, 1)}


def _api_ai_generate(body):
    t0 = _time.time()
    try:
        req = json.loads(body.decode('utf-8')) if body else {}
    except Exception:
        return {'ok': False, 'error': '请求体必须是 JSON'}
    prompt = str(req.get('prompt') or '').strip()
    if not prompt:
        return {'ok': False, 'error': '描述为空'}
    if len(prompt) > 4000:
        prompt = prompt[:4000]
    catalog = req.get('catalog') if isinstance(req.get('catalog'), list) else []
    if not os.path.exists(AI_KEY_FILE):
        return {'ok': False, 'error': f'未找到 AI 密钥文件: {AI_KEY_FILE}'}
    with open(AI_KEY_FILE, encoding='utf-8') as fh:
        key = fh.read().strip()
    if not key:
        return {'ok': False, 'error': 'AI 密钥文件为空'}

    base_msgs = [
        {'role': 'system', 'content': _AI_SYSTEM.replace('{catalog}', _catalog_text(catalog))},
        {'role': 'user', 'content': prompt},
    ]
    content, err = _ai_chat(key, base_msgs)
    if err:
        return {'ok': False, 'error': err}
    data = _try_json(content)
    if data is None:
        msgs = base_msgs + [
            {'role': 'assistant', 'content': content[:4000]},
            {'role': 'user', 'content': '上面的输出不是合法 JSON。请重新输出，只输出一个合法 JSON 对象，不要任何解释或代码块标记。'},
        ]
        content, err = _ai_chat(key, msgs)
        if err:
            return {'ok': False, 'error': err}
        data = _try_json(content)
        if data is None:
            return {'ok': False, 'error': 'AI 返回的内容不是合法 JSON，请换个描述重试', 'raw': content[:2000]}

    cat_map = None
    if catalog:
        cat_map = {}
        for c in catalog:
            try:
                cat_map[str(c[0])] = c
            except Exception:
                continue
    try:
        doc, stats = _validate_ai_doc(data, cat_map)
    except Exception as e:  # noqa: BLE001
        return {'ok': False, 'error': f'生成结果校验失败: {e}'}
    if not stats['walls']:
        return {'ok': False, 'error': 'AI 没有生成有效墙体，请补充描述（如面积、房间数）后重试'}
    stats['elapsed'] = round(_time.time() - t0, 1)
    return {'ok': True, 'doc': doc, 'stats': stats,
            'summary': str(data.get('summary') or '')[:200]}


def _safe_name(raw):
    """校验并归一化文件名:仅允许 basename,必须是 .json。"""
    name = unquote(raw or '').strip()
    if not name:
        raise ValueError('empty name')
    if not _NAME_RE.match(name):
        raise ValueError('illegal name')
    if os.path.basename(name) != name or name in ('.', '..'):
        raise ValueError('path traversal')
    if not name.lower().endswith('.json'):
        name += '.tp3d.json'
    if len(name) > 120:
        raise ValueError('name too long')
    return name


def _json_path(name):
    p = os.path.abspath(os.path.join(JSON_DIR, name))
    if not p.startswith(os.path.abspath(JSON_DIR) + os.sep):
        raise ValueError('path traversal')
    return p


def _safe_dir_name(raw):
    """校验 libs/items/<dir> 中的子目录名:仅字母数字下划线短横线,≤64 字符,禁止路径穿越。"""
    name = unquote(raw or '').strip()
    if not name or not _DIR_NAME_RE.match(name):
        raise ValueError('illegal dir name')
    return name


def _api_items_del(qs):
    name = _safe_dir_name(parse_qs(qs).get('dir', [''])[0])
    d = os.path.abspath(os.path.join(ITEMS_DIR, name))
    if not d.startswith(os.path.abspath(ITEMS_DIR) + os.sep):
        raise ValueError('path traversal')
    removed = []
    for fn in ('model.glb', 'thumbnail.webp'):
        p = os.path.join(d, fn)
        if os.path.exists(p):
            os.remove(p)
            removed.append(fn)
    return {'ok': True, 'removed': removed, 'dir': name}


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 静默访问日志,只保留启动行

    # ── 文件 API(全部落在 json/ 子目录)──────────────────────
    def _api_list(self):
        files = []
        try:
            for fn in os.listdir(JSON_DIR):
                if not fn.lower().endswith('.json'):
                    continue
                try:
                    st = os.stat(os.path.join(JSON_DIR, fn))
                    files.append({'name': fn, 'mtime': int(st.st_mtime * 1000), 'size': st.st_size})
                except OSError:
                    pass
        except OSError:
            pass
        files.sort(key=lambda f: -f['mtime'])
        return {'files': files}

    def _api_get(self, qs):
        name = _safe_name(parse_qs(qs).get('name', [''])[0])
        with open(_json_path(name), 'rb') as f:
            data = f.read()
        return 200, data, 'text/plain; charset=utf-8'

    def _api_put(self, qs, body):
        name = _safe_name(parse_qs(qs).get('name', [''])[0])
        path = _json_path(name)
        tmp = path + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(body)
        os.replace(tmp, path)  # 原子替换,断电也不留半截文件
        st = os.stat(path)
        return {'ok': True, 'bytes': len(body), 'mtime': int(st.st_mtime * 1000)}

    def _api_del(self, qs):
        name = _safe_name(parse_qs(qs).get('name', [''])[0])
        path = _json_path(name)
        if os.path.exists(path):
            os.remove(path)
        return {'ok': True}

    def _stream_ai_chat(self, body):
        req = json.loads(body.decode('utf-8'))
        key = _load_ai_key()
        if not key:
            return self._json({'error': 'API key not found. Put your MiniMax API key in ~/.auto-coder/keys/minimax_m3-1-flash-preview'}, 500)
        url = AI_BASE_URL.rstrip('/') + '/anthropic/v1/messages'
        headers = {
            'Authorization': 'Bearer ' + key,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        }
        payload = {
            'model': 'MiniMax-M2.7',
            'max_tokens': req.get('max_tokens', 8192),
            'stream': True,
            'system': req.get('system', ''),
            'messages': [{'role': 'user', 'content': req.get('user', '')}],
        }
        try:
            rq = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'),
                                        method='POST', headers=headers)
            resp = urllib.request.urlopen(rq, timeout=AI_TIMEOUT)
        except Exception as e:
            return self._json({'error': str(e)}, 500)
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Transfer-Encoding', 'chunked')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        while True:
            chunk = resp.read(4096)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        try:
            if u.path == '/api/files/list':
                return self._json(self._api_list())
            if u.path == '/api/files/get':
                code, data, ctype = self._api_get(u.query)
                self.send_response(code)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
            if u.path == '/api/items/del':
                return self._json(_api_items_del(u.query))
        except ValueError as e:
            return self._json({'ok': False, 'error': str(e)}, 400)
        except FileNotFoundError:
            return self._json({'ok': False, 'error': 'not found'}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({'ok': False, 'error': str(e)}, 500)
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        try:
            length = int(self.headers.get('Content-Length') or 0)
            body = self.rfile.read(length) if length else b''
            if u.path == '/api/files/put':
                return self._json(self._api_put(u.query, body))
            if u.path == '/api/files/del':
                return self._json(self._api_del(u.query))
            if u.path == '/api/ai/generate':
                return self._json(_api_ai_generate(body))
            if u.path == '/api/ai/style':
                return self._json(_api_ai_style(body))
            if u.path == '/api/ai/furniture-meta':
                return self._json(_api_ai_furniture_meta(body))
            if u.path == '/api/ai/chat':
                return self._stream_ai_chat(body)
            if u.path == '/api/items/del':
                return self._json(_api_items_del(u.query))
        except ValueError as e:
            return self._json({'ok': False, 'error': str(e)}, 400)
        except OSError as e:
            return self._json({'ok': False, 'error': str(e)}, 500)
        return self._json({'ok': False, 'error': 'unknown endpoint'}, 404)


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    with _Server(("", PORT), Handler) as httpd:
        print(f"serving {DIR} at http://127.0.0.1:{PORT} (no-cache + files api -> {JSON_DIR})")
        httpd.serve_forever()
