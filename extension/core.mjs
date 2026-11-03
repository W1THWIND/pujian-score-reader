export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Detect five parallel, equally spaced long lines, then pair staves for piano.
// No semantic deletion: crops are suggestions with generous annotation margins.
export function analyzeScore({ data, width, height }) {
  const ink = new Uint32Array(height);
  const left = Math.floor(width * .04), right = Math.ceil(width * .96);
  for (let y = 0; y < height; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * width + x) * 4;
      if (data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114 < 170 && data[i + 3] > 100) ink[y]++;
    }
  }
  const candidates = [];
  for (let y = 0; y < height; y++) {
    if (ink[y] < width * .40) continue;
    let end = y, best = y;
    while (end + 1 < height && ink[end + 1] >= width * .40) {
      end++;
      if (ink[end] > ink[best]) best = end;
    }
    candidates.push(best);
    y = end;
  }
  const staves = [];
  for (let i = 0; i + 4 < candidates.length;) {
    const lines = candidates.slice(i, i + 5);
    const gaps = lines.slice(1).map((y, j) => y - lines[j]);
    const gap = gaps.reduce((a, b) => a + b, 0) / 4;
    if (gap >= 2 && gap < height * .025 && gaps.every(g => Math.abs(g - gap) <= Math.max(1.5, gap * .23))) {
      staves.push({ top: lines[0], bottom: lines[4], gap });
      i += 5;
    } else i++;
  }
  if (staves.length < 2 || staves.length % 2) return { crop: { left: 0, right: 1, top: 0, bottom: 1 }, cuts: [], confidence: 'manual', staffCount: staves.length };
  const systems = [];
  for (let i = 0; i < staves.length; i += 2) systems.push({ top: staves[i].top, bottom: staves[i + 1].bottom, gap: staves[i].gap });
  const first = systems[0], last = systems.at(-1);
  let xMin = width, xMax = 0;
  const row = Math.round(first.top);
  for (let x = 0; x < width; x++) {
    const i = (row * width + x) * 4;
    if (data[i] < 170) { xMin = Math.min(xMin, x); xMax = Math.max(xMax, x); }
  }
  const crop = {
    left: clamp((xMin - width * .045) / width, 0, .3),
    right: clamp((xMax + width * .035) / width, .7, 1),
    top: clamp((first.top - first.gap * 12) / height, 0, 1),
    bottom: clamp((last.bottom + last.gap * 9) / height, 0, 1),
  };
  const cuts = [];
  for (let i = 0; i < systems.length - 1; i++) {
    const a = systems[i], b = systems[i + 1];
    const start = Math.ceil(a.bottom + a.gap * 4), end = Math.floor(b.top - b.gap * 4);
    let best = Math.round((a.bottom + b.top) / 2), cost = Infinity;
    for (let y = start; y <= end; y++) {
      const c = ink[y - 1] + ink[y] + ink[y + 1] + Math.abs(y - (a.bottom + b.top) / 2) * .1;
      if (c < cost) { cost = c; best = y; }
    }
    cuts.push(best / height);
  }
  return { crop, cuts, confidence: 'suggested', staffCount: staves.length };
}

export function segments(pages, mode) {
  const out = [];
  pages.forEach((page, pageIndex) => {
    const c = page.crop;
    const ys = mode === 'page' ? [c.top, c.bottom] : [c.top, ...page.cuts, c.bottom];
    for (let i = 0; i < ys.length - 1; i++) out.push({ page: pageIndex, row: i, top: ys[i], bottom: ys[i + 1], left: c.left, right: c.right });
  });
  return out;
}

export function nextPosition(position, length, mode, direction) {
  const target = position + (mode === 'two' ? 2 : 1) * direction;
  return target >= length ? position : clamp(target, 0, Math.max(0, length - 1));
}

export function sanitizeLayout(page) {
  const c = page.crop;
  c.left = clamp(c.left, 0, .94); c.right = clamp(c.right, c.left + .05, 1);
  c.top = clamp(c.top, 0, .94); c.bottom = clamp(c.bottom, c.top + .05, 1);
  page.cuts = page.cuts.filter(y => Number.isFinite(y) && y > c.top + .008 && y < c.bottom - .008).sort((a, b) => a - b).filter((v, i, a) => !i || v - a[i - 1] > .008);
  return page;
}

export function createClickGate(now = () => performance.now()) {
  let last = -Infinity;
  return {
    accept(delay) { const t = now(); if (t - last < delay) return false; last = t; return true; },
    reset() { last = -Infinity; },
  };
}
