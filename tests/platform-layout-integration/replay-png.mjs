import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const sha = b => createHash('sha256').update(b).digest('hex');
export function decodePNG(bytes) {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Not PNG');
  let width, height, depth, color, interlace, palette, transparency; const idat = [];
  for (let offset = 8; offset < bytes.length;) { const size = bytes.readUInt32BE(offset), type = bytes.subarray(offset + 4, offset + 8).toString(), data = bytes.subarray(offset + 8, offset + 8 + size); if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; } else if (type === 'IDAT') idat.push(data); else if (type === 'PLTE') palette = data; else if (type === 'tRNS') transparency = data; offset += size + 12; }
  if (depth !== 8 || interlace !== 0) throw new Error('Unsupported PNG depth/interlace: ' + depth + '/' + interlace);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[color]; if (!channels) throw new Error('Unsupported PNG color type ' + color);
  const stride = width * channels, packed = inflateSync(Buffer.concat(idat)), raw = Buffer.alloc(height * stride);
  if (packed.length !== height * (stride + 1)) throw new Error('PNG scanline length mismatch');
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) { const filter = packed[y * (stride + 1)]; for (let x = 0; x < stride; x++) { const value = packed[y * (stride + 1) + 1 + x], left = x >= channels ? raw[y * stride + x - channels] : 0, above = y ? raw[(y - 1) * stride + x] : 0, upperLeft = y && x >= channels ? raw[(y - 1) * stride + x - channels] : 0; const delta = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : NaN; if (!Number.isFinite(delta)) throw new Error('Unsupported PNG filter ' + filter); raw[y * stride + x] = (value + delta) & 255; } }
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { const p = i * channels, q = i * 4; if (color === 6) raw.copy(pixels, q, p, p + 4); else if (color === 2) { raw.copy(pixels, q, p, p + 3); pixels[q + 3] = 255; } else if (color === 3) { const index = raw[p]; pixels[q] = palette[index * 3]; pixels[q + 1] = palette[index * 3 + 1]; pixels[q + 2] = palette[index * 3 + 2]; pixels[q + 3] = transparency?.[index] ?? 255; } else { pixels[q] = pixels[q + 1] = pixels[q + 2] = raw[p]; pixels[q + 3] = color === 4 ? raw[p + 1] : 255; } }
  return { width, height, pixels, pixel_sha256: sha(pixels), bit_depth: depth, color_type: color, interlace };
}
export function comparePixels(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { pixels_equal: false, dimensions_equal: false, old: [a.width, a.height], new: [b.width, b.height] };
  let count = 0, max = 0, minX = a.width, minY = a.height, maxX = -1, maxY = -1;
  for (let p = 0; p < a.width * a.height; p++) { let differs = false; for (let c = 0; c < 4; c++) { const delta = Math.abs(a.pixels[p * 4 + c] - b.pixels[p * 4 + c]); if (delta) differs = true; max = Math.max(max, delta); } if (differs) { count++; const x = p % a.width, y = Math.floor(p / a.width); minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); } }
  return { pixels_equal: count === 0, dimensions_equal: true, width: a.width, height: a.height, differing_pixels: count, max_channel_delta: max, difference_bounds: count ? { minX, minY, maxX, maxY } : null, old_pixel_sha256: a.pixel_sha256, new_pixel_sha256: b.pixel_sha256, method: 'PNG zlib + scanline-filter decode to RGBA8; exact per-channel comparison, no tolerance' };
}
