// scripts/gen-mc-skin.mjs
// 生成 MC 默认皮肤（64×64 PNG，标准皮肤 UV 布局，Steve 风格简化配色）。
// 无第三方依赖：手写 PNG 编码（IHDR/IDAT/IEND，zlib 用 node 内置）。
// 用法：node scripts/gen-mc-skin.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const W = 64;
const H = 64;
const OUT = new URL("../src/mc/assets/default-skin.png", import.meta.url);
const px = new Uint8Array(W * H * 4); // 初始全透明（alpha=0）

// —— Steve 风格调色板（RGB）——
const HAIR = [58, 42, 26];
const SKIN = [198, 134, 66];
const SKIN_D = [161, 102, 47];
const EYE_W = [240, 240, 240];
const EYE = [70, 52, 150];
const MOUTH = [110, 66, 40];
const SHIRT = [0, 168, 168];
const SHIRT_D = [0, 140, 140];
const PANTS = [60, 68, 170];
const PANTS_D = [48, 55, 140];
const SHOE = [72, 58, 50];

function fillRect(x, y, w, h, [r, g, b, a = 255]) {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = ((y + j) * W + x + i) * 4;
      px[k] = r; px[k + 1] = g; px[k + 2] = b; px[k + 3] = a;
    }
  }
}

// —— 头（贴图区 y 0-16）——
fillRect(8, 0, 8, 8, HAIR);            // 头顶
fillRect(16, 0, 8, 8, SKIN_D);         // 头底
fillRect(0, 8, 8, 8, HAIR);            // 右侧：上半头发下半脸
fillRect(0, 10, 8, 6, SKIN);
fillRect(16, 8, 8, 8, HAIR);           // 左侧
fillRect(16, 10, 8, 6, SKIN);
fillRect(24, 8, 8, 8, HAIR);           // 后脑勺
fillRect(24, 10, 8, 6, SKIN);
// 正脸（8,8 起 8×8）：发型 2 行 + 脸 + 眼 + 鼻 + 嘴
fillRect(8, 8, 8, 8, SKIN);
fillRect(8, 8, 8, 2, HAIR);
fillRect(8, 9, 1, 1, HAIR);            // 鬓角
fillRect(15, 9, 1, 1, HAIR);
fillRect(10, 12, 1, 1, EYE_W);         // 眼（白+瞳，M2 会被程序化眼型覆盖）
fillRect(11, 12, 1, 1, EYE);
fillRect(13, 12, 1, 1, EYE);
fillRect(14, 12, 1, 1, EYE_W);
fillRect(11, 13, 2, 1, SKIN_D);        // 鼻
fillRect(11, 14, 2, 1, MOUTH);         // 嘴

// —— 躯干（贴图区 y 16-40）——
fillRect(20, 16, 8, 4, SKIN);          // 顶：颈部
fillRect(24, 16, 4, 4, SHIRT);
fillRect(28, 16, 8, 4, SHIRT_D);       // 底
fillRect(20, 20, 8, 12, SHIRT);        // 正面
fillRect(32, 20, 8, 12, SHIRT);        // 背面
fillRect(16, 20, 4, 12, SHIRT_D);      // 右侧
fillRect(28, 20, 4, 12, SHIRT_D);      // 左侧
// 躯干 overlay（jacket 区，16,32 起）：留空（alpha=0），验证空面跳过路径

// —— 右臂（贴图区 40,16 起 16×16）——
fillRect(44, 16, 4, 4, SKIN);          // 顶（肩）
fillRect(48, 16, 4, 4, SKIN_D);        // 底（手）
fillRect(40, 20, 4, 12, SKIN);         // 外侧（观察者可见面）
fillRect(44, 20, 4, 12, SKIN);         // 正面
fillRect(48, 20, 4, 12, SKIN_D);       // 内侧
fillRect(52, 20, 4, 12, SKIN);         // 背面
fillRect(44, 28, 4, 4, SKIN_D);        // 手部阴影（正面下段）

// —— 左臂（64×64 专属区 32,48 起 16×16）——
fillRect(36, 48, 4, 4, SKIN);
fillRect(40, 48, 4, 4, SKIN_D);
fillRect(32, 52, 4, 12, SKIN_D);       // 外侧
fillRect(36, 52, 4, 12, SKIN);         // 正面
fillRect(40, 52, 4, 12, SKIN);         // 内侧（观察者可见面）
fillRect(44, 52, 4, 12, SKIN);         // 背面
fillRect(36, 60, 4, 4, SKIN_D);

// —— 右腿（贴图区 0,16 起 16×16）——
fillRect(4, 16, 4, 4, PANTS);          // 顶
fillRect(8, 16, 4, 4, SHOE);           // 底（脚掌）
fillRect(0, 20, 4, 12, PANTS_D);       // 外侧（观察者可见面）
fillRect(4, 20, 4, 12, PANTS);         // 正面
fillRect(8, 20, 4, 12, PANTS_D);       // 内侧
fillRect(12, 20, 4, 12, PANTS);        // 背面
fillRect(0, 29, 4, 3, SHOE);           // 鞋（各面下段）
fillRect(4, 29, 4, 3, SHOE);
fillRect(8, 29, 4, 3, SHOE);
fillRect(12, 29, 4, 3, SHOE);

// —— 左腿（64×64 专属区 16,48 起 16×16）——
fillRect(20, 48, 4, 4, PANTS);
fillRect(24, 48, 4, 4, SHOE);
fillRect(16, 52, 4, 12, PANTS_D);      // 外侧
fillRect(20, 52, 4, 12, PANTS);        // 正面
fillRect(24, 52, 4, 12, PANTS_D);      // 内侧（观察者可见面）
fillRect(28, 52, 4, 12, PANTS);        // 背面
fillRect(16, 61, 4, 3, SHOE);
fillRect(20, 61, 4, 3, SHOE);
fillRect(24, 61, 4, 3, SHOE);
fillRect(28, 61, 4, 3, SHOE);

// —— PNG 编码（RGBA、8bit、无滤波、无隔行）——
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // 位深
ihdr[9] = 6;  // RGBA
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // 滤波类型 0
  Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, y * (1 + W * 4) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = fileURLToPath(OUT);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`已生成 ${out}（${png.length} 字节）`);
