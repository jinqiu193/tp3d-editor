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
import os
import re
import shutil
import sys
from urllib.parse import urlparse, parse_qs, unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
DIR = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))
JSON_DIR = os.path.join(DIR, 'json')

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
        except ValueError as e:
            return self._json({'ok': False, 'error': str(e)}, 400)
        except OSError as e:
            return self._json({'ok': False, 'error': str(e)}, 500)
        return self._json({'ok': False, 'error': 'unknown endpoint'}, 404)


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with _Server(("", PORT), Handler) as httpd:
    print(f"serving {DIR} at http://127.0.0.1:{PORT} (no-cache + files api -> {JSON_DIR})")
    httpd.serve_forever()
