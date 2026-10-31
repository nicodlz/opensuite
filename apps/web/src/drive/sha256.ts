// Incremental SHA-256 keeps memory bounded for large uploads. Blocks are read
// straight from the input and scratch space is reused, so the hot loop does
// not allocate.
const K = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export class Sha256 {
  private state = Int32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  private w = new Int32Array(64);
  private buffer = new Uint8Array(64);
  private used = 0;
  private length = 0;
  update(data: Uint8Array) {
    this.length += data.length;
    let offset = 0;
    if (this.used > 0) {
      const count = Math.min(64 - this.used, data.length);
      this.buffer.set(data.subarray(0, count), this.used);
      this.used += count;
      offset = count;
      if (this.used < 64) return;
      this.block(this.buffer, 0);
      this.used = 0;
    }
    for (; offset + 64 <= data.length; offset += 64) this.block(data, offset);
    if (offset < data.length) {
      this.buffer.set(data.subarray(offset));
      this.used = data.length - offset;
    }
  }
  private block(bytes: Uint8Array, at: number) {
    const w = this.w;
    const s = this.state;
    for (let i = 0, j = at; i < 16; i++, j += 4)
      w[i] =
        ((bytes[j] ?? 0) << 24) |
        ((bytes[j + 1] ?? 0) << 16) |
        ((bytes[j + 2] ?? 0) << 8) |
        (bytes[j + 3] ?? 0);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      w[i] =
        (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) +
        (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) +
        (w[i - 16] ?? 0) +
        (w[i - 7] ?? 0);
    }
    let a = s[0] ?? 0,
      b = s[1] ?? 0,
      c = s[2] ?? 0,
      d = s[3] ?? 0,
      e = s[4] ?? 0,
      f = s[5] ?? 0,
      g = s[6] ?? 0,
      h = s[7] ?? 0;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h +
          (((e >>> 6) | (e << 26)) ^
            ((e >>> 11) | (e << 21)) ^
            ((e >>> 25) | (e << 7))) +
          ((e & f) ^ (~e & g)) +
          (K[i] ?? 0) +
          (w[i] ?? 0)) |
        0;
      const t2 =
        ((((a >>> 2) | (a << 30)) ^
          ((a >>> 13) | (a << 19)) ^
          ((a >>> 22) | (a << 10))) +
          ((a & b) ^ (a & c) ^ (b & c))) |
        0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    s[0] = (s[0] ?? 0) + a;
    s[1] = (s[1] ?? 0) + b;
    s[2] = (s[2] ?? 0) + c;
    s[3] = (s[3] ?? 0) + d;
    s[4] = (s[4] ?? 0) + e;
    s[5] = (s[5] ?? 0) + f;
    s[6] = (s[6] ?? 0) + g;
    s[7] = (s[7] ?? 0) + h;
  }
  digest() {
    const bits = this.length * 8;
    this.buffer[this.used++] = 0x80;
    if (this.used > 56) {
      this.buffer.fill(0, this.used);
      this.block(this.buffer, 0);
      this.used = 0;
    }
    this.buffer.fill(0, this.used, 56);
    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, Math.floor(bits / 0x100000000));
    view.setUint32(60, bits >>> 0);
    this.block(this.buffer, 0);
    return [...this.state]
      .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
      .join("");
  }
}
export async function hashChunks(
  file: Blob,
  signal: AbortSignal,
  progress: (fraction: number) => void,
  chunk = 8 * 1024 * 1024,
) {
  const hash = new Sha256();
  const read = async (offset: number): Promise<void> => {
    if (offset >= file.size) return;
    signal.throwIfAborted();
    hash.update(
      new Uint8Array(await file.slice(offset, offset + chunk).arrayBuffer()),
    );
    progress(Math.min(offset + chunk, file.size) / file.size);
    await read(offset + chunk);
  };
  await read(0);
  signal.throwIfAborted();
  return hash.digest();
}
