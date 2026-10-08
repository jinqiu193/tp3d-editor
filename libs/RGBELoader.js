// RGBELoader.js — 从 Three.js r160 官方源码移植（MIT License）
// 解析 Radiance RGBE (.hdr) 文件为半浮点 DataTexture
// 标准 .hdr 文件头:
//   #?RADIANCE\n
//   FORMAT=32-bit_rle_rgbe\n
//   \n                    ← 空行(分隔)
//   -Y 512 +X 1024\n      ← 分辨率
//   <binary RGBE data>    ← 每像素 4 字节 RGBE,大小 = 4 * width * height
import * as THREE from './three.module.js';

const RGBELoader = function RGBELoader(manager) {
  this.manager = manager !== undefined ? manager : THREE.DefaultLoadingManager;
  this.type = THREE.HalfFloatType;
};

RGBELoader.prototype = {
  constructor: RGBELoader,

  load(url, onLoad, onProgress, onError) {
    const scope = this;
    const texture = new THREE.DataTexture();
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;

    const onErrorCallback = (e) => {
      if (onError) onError(e);
      console.error('RGBELoader: Failed to load', url, e);
    };

    const loader = new THREE.FileLoader(this.manager);
    loader.setResponseType('arraybuffer');
    loader.load(url,
      (buffer) => {
        scope._parser(buffer).then(({ data, width, height }) => {
          texture.image = { data, width, height };
          texture.needsUpdate = true;
          if (onLoad) onLoad(texture);
        }).catch(onErrorCallback);
      },
      onProgress,
      onErrorCallback,
    );
    return texture;
  },

  _parser(buffer) {
    return new Promise((resolve, reject) => {
      try {
        const bytes = new Uint8Array(buffer);
        // 1) 校验 magic "#?"
        if (bytes[0] !== 0x23 || bytes[1] !== 0x3F) {
          throw new Error('RGBELoader: Not an RGBE file (missing #? magic)');
        }
        // 2) 跳过头部到 resolution 行开头。HDR 文件: ...\nFORMAT=...\n\n-Y <h> +X <w>\n...
        // 先找 "\n\n" (空行),再下一行就是 resolution
        let pos = 0;
        let blankPos = -1;
        for (let i = 0; i < 1024 && i + 1 < bytes.length; i++) {
          if (bytes[i] === 0x0A && bytes[i + 1] === 0x0A) { blankPos = i + 2; break; }
        }
        if (blankPos < 0) throw new Error('RGBELoader: Cannot find blank line separator in header');
        pos = blankPos;
        // 3) 解析 "-Y <h> +X <w>"
        let line = '';
        while (pos < bytes.length && bytes[pos] !== 0x0A) line += String.fromCharCode(bytes[pos++]);
        const m = line.match(/[-+]Y\s+(\d+)\s+[-+]X\s+(\d+)/);
        if (!m) throw new Error('RGBELoader: Cannot parse resolution: ' + JSON.stringify(line));
        const height = parseInt(m[1], 10);
        const width = parseInt(m[2], 10);
        pos++; // skip \n
        // 4) 解码 RGBE scanlines (非 RLE 路径,1K HDR 通常如此)
        const out = new Float32Array(width * height * 4);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const r = bytes[pos], g = bytes[pos + 1], b = bytes[pos + 2], e = bytes[pos + 3];
            const f = Math.pow(2, e - 128) / 255;
            const o = (y * width + x) * 4;
            out[o]     = r * f;
            out[o + 1] = g * f;
            out[o + 2] = b * f;
            out[o + 3] = 1.0;
            pos += 4;
          }
        }
        resolve({ data: out, width, height });
      } catch (e) { reject(e); }
    });
  },
};

export { RGBELoader };