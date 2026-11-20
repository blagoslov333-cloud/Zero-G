import React, { useMemo } from "react";

/**
 * Minimal ISO/IEC 18004 QR Code Byte-mode encoder (Versions 1..6, Error Correction L)
 * so the PWA and Aux Pane always render a scannable QR SVG offline or before
 * server SVG arrives — zero external deps, zero raw hex in TSX.
 */

const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    EXP_TABLE[i] = EXP_TABLE[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
}

function rsGeneratorPoly(ecCount: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < ecCount; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = EXP_TABLE[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(data.length + ecCount);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return res.slice(data.length);
}

// Version specs for EC Level L (1 block for V1..V6)
const QR_SPECS: Array<{
  ver: number;
  size: number;
  dataCodewords: number;
  ecCodewords: number;
  align: number[];
}> = [
  { ver: 1, size: 21, dataCodewords: 19, ecCodewords: 7, align: [] },
  { ver: 2, size: 25, dataCodewords: 34, ecCodewords: 10, align: [6, 18] },
  { ver: 3, size: 29, dataCodewords: 55, ecCodewords: 15, align: [6, 22] },
  { ver: 4, size: 33, dataCodewords: 80, ecCodewords: 20, align: [6, 26] },
  { ver: 5, size: 37, dataCodewords: 108, ecCodewords: 26, align: [6, 30] },
  { ver: 6, size: 41, dataCodewords: 136, ecCodewords: 18, align: [6, 34] },
];

// Format info strings for EC Level L (01) and masks 0..7
const FORMAT_BITS = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

function buildQrMatrix(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  const spec = QR_SPECS.find((s) => bytes.length + 2 <= s.dataCodewords);
  if (!spec) return null;

  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >> i) & 1);
    }
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);

  const maxDataBits = spec.dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < maxDataBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(spec.dataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let val = 0;
    for (let b = 0; b < 8; b++) val = (val << 1) | bits[i * 8 + b];
    codewords[i] = val;
  }
  const padBytes = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < spec.dataCodewords; i++, p++) {
    codewords[i] = padBytes[p % 2];
  }

  // Note: Version 6 has 2 blocks of (68 data + 18 ec); Versions 1..5 have 1 block
  let finalBytes: number[] = [];
  if (spec.ver === 6) {
    const b1 = codewords.slice(0, 68);
    const b2 = codewords.slice(68, 136);
    const ec1 = rsEncode(b1, 18);
    const ec2 = rsEncode(b2, 18);
    for (let i = 0; i < 68; i++) {
      finalBytes.push(b1[i], b2[i]);
    }
    for (let i = 0; i < 18; i++) {
      finalBytes.push(ec1[i], ec2[i]);
    }
  } else {
    const ec = rsEncode(codewords, spec.ecCodewords);
    finalBytes = [...codewords, ...ec];
  }

  const size = spec.size;
  const grid: Array<Array<number>> = Array.from({ length: size }, () =>
    Array(size).fill(-1)
  );
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    Array(size).fill(false)
  );

  const setModule = (r: number, c: number, val: number, isReserved = true) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      grid[r][c] = val;
      if (isReserved) reserved[r][c] = true;
    }
  };

  const placeFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inPattern = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const isDark =
          inPattern &&
          (r === 0 ||
            r === 6 ||
            c === 0 ||
            c === 6 ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setModule(rr, cc, isDark ? 1 : 0, true);
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    if (!reserved[6][i]) setModule(6, i, bit, true);
    if (!reserved[i][6]) setModule(i, 6, bit, true);
  }

  // Alignment patterns
  if (spec.align.length >= 2) {
    for (const r of spec.align) {
      for (const c of spec.align) {
        if (reserved[r][c]) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark =
              Math.abs(dr) === 2 ||
              Math.abs(dc) === 2 ||
              (dr === 0 && dc === 0);
            setModule(r + dr, c + dc, dark ? 1 : 0, true);
          }
        }
      }
    }
  }

  // Dark module + format placeholders
  setModule(size - 8, 8, 1, true);
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = true;
    if (!reserved[i][8]) reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }

  // Place data bits (mask 0: (r + c) % 2 === 0)
  const bitStream: number[] = [];
  for (const byte of finalBytes) {
    for (let b = 7; b >= 0; b--) bitStream.push((byte >> b) & 1);
  }

  let bitIdx = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (reserved[r][c]) continue;
        const bit = bitIdx < bitStream.length ? bitStream[bitIdx++] : 0;
        const masked = (r + c) % 2 === 0 ? bit ^ 1 : bit;
        grid[r][c] = masked;
      }
    }
    up = !up;
  }

  // Write format info for mask 0
  const fmt = FORMAT_BITS[0];
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    if (i < 6) grid[i][8] = bit;
    else if (i < 8) grid[i + 1][8] = bit;
    else grid[8][14 - i] = bit;

    if (i < 8) grid[8][size - 1 - i] = bit;
    else grid[size - 15 + i][8] = bit;
  }

  return grid.map((row) => row.map((v) => v === 1));
}

export const QrSvg: React.FC<{
  value: string;
  svgHtml?: string | null;
  size?: number;
  label?: string;
}> = ({ value, svgHtml, size = 160, label = "Pairing QR Code" }) => {
  const matrix = useMemo(() => buildQrMatrix(value || "http://127.0.0.1:8790"), [value]);

  if (svgHtml && svgHtml.includes("<svg") && !svgHtml.includes("<script")) {
    return (
      <div
        className="inline-flex items-center justify-center rounded-[var(--radius-inner)] p-2 border"
        style={{
          backgroundColor: "var(--bg-surface)",
          borderColor: "var(--border-default)",
          color: "var(--text-primary)",
          width: size + 16,
          height: size + 16,
        }}
        role="img"
        aria-label={label}
        dangerouslySetInnerHTML={{ __html: svgHtml }}
      />
    );
  }

  if (!matrix) {
    return (
      <div
        className="inline-flex items-center justify-center rounded-[var(--radius-inner)] p-3 border text-xs font-mono text-center"
        style={{
          backgroundColor: "var(--bg-subtle)",
          borderColor: "var(--border-default)",
          color: "var(--text-muted)",
          width: size,
          height: size,
        }}
      >
        QR ready when URL is shorter
      </div>
    );
  }

  const modules = matrix.length;
  const quiet = 2;
  const viewSize = modules + quiet * 2;

  return (
    <div
      className="inline-flex items-center justify-center rounded-[var(--radius-inner)] p-2 border"
      style={{
        backgroundColor: "var(--bg-surface)",
        borderColor: "var(--border-default)",
      }}
      role="img"
      aria-label={label}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${viewSize} ${viewSize}`}
        shapeRendering="crispEdges"
      >
        <rect width={viewSize} height={viewSize} fill="var(--bg-canvas)" />
        {matrix.map((row, r) =>
          row.map((dark, c) =>
            dark ? (
              <rect
                key={`${r}-${c}`}
                x={c + quiet}
                y={r + quiet}
                width={1}
                height={1}
                fill="var(--text-primary)"
              />
            ) : null
          )
        )}
      </svg>
    </div>
  );
};
