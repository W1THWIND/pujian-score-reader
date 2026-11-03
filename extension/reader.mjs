import * as pdfjs from './vendor/pdf.mjs';
import { analyzeScore, segments, nextPosition, sanitizeLayout, clamp, createClickGate } from './core.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;
const $ = id => document.getElementById(id);
const state = { pdf: null, id: null, name: '', pages: [], mode: 'page', position: 0, active: false, mouseEnabled: false, busy: false, editing: 0 };
localStorage.removeItem('pedal-remote-key');
const cache = new Map();
let renderVersion = 0, noticeTimer, wakeLock, editVersion = 0;
const history = [];
const gate = createClickGate();
const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open('pedal-score', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('files'); req.result.createObjectStore('settings'); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
// A rejected database request is reported when used, without preventing reading.
dbPromise.catch(() => {});
async function storage(store, method, key, value) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, method === 'get' ? 'readonly' : 'readwrite');
    const req = method === 'put' ? tx.objectStore(store).put(value, key) : tx.objectStore(store)[method](key);
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('存储操作中断'));
  });
}
function notice(text, duration = 4500) {
  $('notice').textContent = text; $('notice').classList.add('show');
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').classList.remove('show'), duration);
}
function run(fn) { return (...args) => { const fail = e => { console.error(e); notice(`操作未完成：${e.message}`); }; try { Promise.resolve(fn(...args)).catch(fail); } catch (e) { fail(e); } }; }
function save() {
  if (!state.id) return;
  $('saveState').textContent = '保存中…';
  // Capture current file identity and layout before the user switches files.
  const id = state.id;
  const value = structuredClone({ pages: state.pages, position: state.position, mode: state.mode, overlap: $('overlap').checked, delay: Number($('delay').value) });
  (async () => {
    try { await storage('settings', 'put', id, value); $('saveState').textContent = '已保存到本机'; }
    catch { $('saveState').textContent = '未保存'; notice('浏览器存储空间不足或不可用，当前仍可阅读。'); }
  })();
}
async function canvasFor(pdf, index, width = 1400) {
  const page = await pdf.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
  page.cleanup();
  return canvas;
}
async function source(index) {
  if (cache.has(index)) { const c = cache.get(index); cache.delete(index); cache.set(index, c); return c; }
  const doc = state.pdf;
  const canvas = await canvasFor(doc, index, 1800);
  if (doc === state.pdf) {
    cache.set(index, canvas);
    if (cache.size > 4) cache.delete(cache.keys().next().value);
  }
  return canvas;
}
function available() {
  const yes = Boolean(state.pdf) && !state.busy;
  for (const id of ['mode', 'editButton', 'fullscreen', 'perform', 'startPerformance', 'forget']) $(id).disabled = !yes;
  $('openButton').disabled = state.busy; $('welcomeOpen').disabled = state.busy;
  $('overlap').disabled = !yes || state.mode === 'page';
  $('prev').disabled = !yes || state.position <= 0;
  $('next').disabled = !yes || nextPosition(state.position, segments(state.pages, state.mode).length, state.mode, 1) === state.position;
}
async function load(bytes, name) {
  if (state.busy) return;
  state.busy = true; setActive(false); setMouseEnabled(false); available(); $('loading').hidden = false;
  let nextPdf;
  try {
    $('loadingText').textContent = '正在读取 PDF…';
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false,
      cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href, cMapPacked: true,
      standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href,
      wasmUrl: new URL('./vendor/wasm/', import.meta.url).href });
    nextPdf = await task.promise;
    let saved;
    try { saved = await storage('settings', 'get', id); } catch { /* Reading works without storage. */ }
    const pages = [];
    if (saved?.pages?.length === nextPdf.numPages) {
      pages.push(...saved.pages.map(sanitizeLayout));
    } else {
      for (let i = 0; i < nextPdf.numPages; i++) {
        $('loadingText').textContent = `正在识别谱行 · ${i + 1} / ${nextPdf.numPages} 页`;
        const canvas = await canvasFor(nextPdf, i, 1100);
        pages.push(analyzeScore(canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height)));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    renderVersion++; cache.clear();
    const old = state.pdf;
    state.pdf = nextPdf; state.id = id; state.name = name; state.pages = pages;
    state.mode = ['page', 'row', 'two'].includes(saved?.mode) ? saved.mode : $('mode').value;
    state.position = clamp(saved?.position || 0, 0, segments(pages, state.mode).length - 1);
    $('mode').value = state.mode;
    $('overlap').checked = saved?.overlap ?? true;
    $('delay').value = saved?.delay ?? 350; $('delayValue').textContent = `${$('delay').value} ms`;
    $('docName').textContent = name; $('docMeta').textContent = `${nextPdf.numPages} 页 · 本地处理 · 已识别 ${segments(pages, 'row').length} 个阅读段`;
    $('welcome').hidden = true; $('score').hidden = false;
    if (old) await old.destroy();
    try { await storage('files', 'put', id, { bytes, name }); localStorage.setItem('pedal-last', id); }
    catch { notice('无法保存 PDF 到本机；本次阅读不受影响。'); }
    const manual = pages.filter(p => p.confidence === 'manual').length;
    notice(saved ? '已恢复此谱的翻页节点和阅读位置。' : manual ? `${manual} 页未可靠识别，已保留整页；请在“调整裁边与翻页节点”中检查。` : '谱行识别完成。请检查裁边与节点，再点击“开始演奏”。', 7500);
    save();
  } catch (e) {
    if (nextPdf && nextPdf !== state.pdf) await nextPdf.destroy();
    notice(e.name === 'PasswordException' ? '此 PDF 有密码，请先使用解锁后的副本。' : `无法打开 PDF：${e.message}`, 7000);
  } finally {
    state.busy = false; $('loading').hidden = true; available();
    if (state.pdf) await draw();
  }
}
async function draw() {
  if (!state.pdf || state.busy) return;
  const version = ++renderVersion;
  const list = segments(state.pages, state.mode);
  state.position = clamp(state.position, 0, list.length - 1);
  const pos = state.position;
  const current = list[pos];
  // Line modes show two upcoming systems; each click advances one or two systems.
  const shown = list.slice(pos, pos + (state.mode === 'page' ? 1 : 2)).map(s => ({ ...s, previous: false }));
  if (state.mode !== 'page' && $('overlap').checked && pos > 0) shown.unshift({ ...list[pos - 1], previous: true });
  const items = [];
  for (const seg of shown) {
    const canvas = await source(seg.page);
    if (version !== renderVersion) return;
    const w = (seg.right - seg.left) * canvas.width, h = (seg.bottom - seg.top) * canvas.height;
    const drawWidth = seg.previous ? 1400 * .55 : 1400;
    items.push({ seg, canvas, w, h, drawWidth, normalizedHeight: h / w * drawWidth });
  }
  const gap = state.mode === 'page' ? 0 : 32;
  const totalHeight = items.reduce((n, item) => n + item.normalizedHeight, 0) + gap * (items.length - 1);
  const canvas = $('score'); canvas.width = 1400; canvas.height = Math.ceil(totalHeight);
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 0;
  for (const item of items) {
    const { seg, canvas: src, w, h, drawWidth, normalizedHeight } = item;
    ctx.drawImage(src, seg.left * src.width, seg.top * src.height, w, h, (1400 - drawWidth) / 2, y, drawWidth, normalizedHeight);
    if (seg.previous) {
      ctx.fillStyle = '#ffffff88'; ctx.fillRect(0, y, 1400, normalizedHeight);
      ctx.fillStyle = '#618371'; ctx.font = '18px sans-serif'; ctx.fillText('上一行 · 衔接参考', 15, y + 23);
    }
    y += normalizedHeight;
    if (gap) { ctx.fillStyle = '#edf1e9'; ctx.fillRect(0, y, 1400, gap); y += gap; }
  }
  const fit = Math.min(($('stage').clientWidth - 24) / 1400, ($('stage').clientHeight - 20) / totalHeight);
  canvas.style.width = `${Math.max(1, 1400 * fit)}px`; canvas.style.height = `${Math.max(1, totalHeight * fit)}px`;
  $('position').textContent = state.mode === 'page' ? `第 ${current.page + 1} / ${state.pages.length} 页` : `第 ${current.page + 1} 页 · 谱行 ${pos + 1} / ${list.length}`;
  $('docMeta').textContent = `${state.pages.length} 页 · 本地处理 · ${segments(state.pages, 'row').length} 个阅读段`;
  $('stateLabel').textContent = state.active ? '● 演奏中' : '阅读与设置';
  available();
}
async function turn(direction, filtered = true) {
  if (!state.pdf || state.busy || $('editor').open) return false;
  if (filtered && !gate.accept(Number($('delay').value))) return false;
  const list = segments(state.pages, state.mode);
  const next = nextPosition(state.position, list.length, state.mode, direction);
  if (next === state.position) { notice(direction > 0 ? '已经是最后一段了。' : '已经到开头了。'); return false; }
  state.position = next; save(); await draw();
  return true;
}
async function keepAwake() {
  if (!state.active || document.visibilityState !== 'visible' || wakeLock) return;
  try { wakeLock = await navigator.wakeLock?.request('screen'); wakeLock?.addEventListener('release', () => { wakeLock = null; }); }
  catch { /* Browser may not provide wake lock on extension pages. */ }
}
function setActive(active) {
  state.active = active && Boolean(state.pdf) && !state.busy && !$('editor').open;
  gate.reset();
  document.body.classList.toggle('playing', state.active);
  $('stateLabel').textContent = state.active ? '● 演奏中' : state.pdf ? '阅读与设置' : '准备开始';
  if (state.active) { $('stage').focus(); keepAwake(); }
  else { wakeLock?.release().catch(() => {}); wakeLock = null; }
  if (state.pdf && !state.busy) run(draw)();
}
function setMouseEnabled(enabled) {
  state.mouseEnabled = enabled && Boolean(state.pdf) && !state.busy;
  gate.reset();
  $('perform').setAttribute('aria-checked', String(state.mouseEnabled));
  $('switchText').textContent = state.mouseEnabled ? '鼠标左右键翻页已开启' : '鼠标左右键翻页已关闭';
  $('stage').classList.toggle('active', state.mouseEnabled);
}
function rememberEdit() { history.push({ index: state.editing, layout: structuredClone(state.pages[state.editing]) }); if (history.length > 50) history.shift(); }
function overlay() {
  const page = state.pages[state.editing], c = page.crop, host = $('handles'); host.replaceChildren();
  const shades = [ { left: 0, top: 0, width: 1, height: c.top }, { left: 0, top: c.bottom, width: 1, height: 1 - c.bottom }, { left: 0, top: c.top, width: c.left, height: c.bottom - c.top }, { left: c.right, top: c.top, width: 1 - c.right, height: c.bottom - c.top } ];
  for (const s of shades) { const div = document.createElement('div'); div.className = 'crop-shade'; for (const k of Object.keys(s)) div.style[k] = `${s[k] * 100}%`; host.append(div); }
  const handles = [...page.cuts.map((value, i) => ({ value, type: 'cut', index: i, text: `节点 ${i + 1}` })), ...['top', 'bottom', 'left', 'right'].map(type => ({ value: c[type], type, text: { top: '上边界', bottom: '下边界', left: '左边界', right: '右边界' }[type] }))];
  for (const h of handles) {
    const vertical = ['left', 'right'].includes(h.type);
    const el = document.createElement('div');
    el.className = `handle ${vertical ? 'vertical' : 'horizontal'} ${h.type === 'cut' ? '' : 'crop'}`;
    el.style[vertical ? 'left' : 'top'] = `${h.value * 100}%`;
    el.dataset.kind = h.type; el.dataset.index = h.index ?? '';
    el.setAttribute('role', 'slider'); el.tabIndex = 0; el.setAttribute('aria-label', h.text); el.setAttribute('aria-valuenow', Math.round(h.value * 100)); el.setAttribute('aria-valuemin', 0); el.setAttribute('aria-valuemax', 100);
    const label = document.createElement('span'); label.textContent = h.text; el.append(label);
    if (h.type === 'cut') {
      const remove = document.createElement('button'); remove.className = 'remove-cut'; remove.textContent = '×'; remove.setAttribute('aria-label', `删除节点 ${h.index + 1}`);
      remove.addEventListener('pointerdown', e => e.stopPropagation());
      remove.addEventListener('click', () => { rememberEdit(); page.cuts.splice(h.index, 1); overlay(); }); el.append(remove);
    }
    function change(v) {
      if (h.type === 'cut') page.cuts[h.index] = clamp(v, (page.cuts[h.index - 1] ?? c.top) + .012, (page.cuts[h.index + 1] ?? c.bottom) - .012);
      else {
        const limits = { top: [0, Math.min(c.bottom - .05, (page.cuts[0] ?? 1) - .012)], bottom: [Math.max(c.top + .05, (page.cuts.at(-1) ?? 0) + .012), 1], left: [0, c.right - .05], right: [c.left + .05, 1] };
        c[h.type] = clamp(v, ...limits[h.type]);
      }
      overlay();
    }
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return; e.preventDefault(); rememberEdit();
      const move = event => { const rect = host.getBoundingClientRect(); change(vertical ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height); };
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    });
    el.addEventListener('keydown', e => { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); rememberEdit(); change(h.value + (['ArrowDown', 'ArrowRight'].includes(e.key) ? .003 : -.003)); host.querySelector(`[data-kind="${h.type}"][data-index="${h.index ?? ''}"]`)?.focus(); } });
    host.append(el);
  }
  $('undo').disabled = !history.length;
  $('recognition').textContent = page.confidence === 'manual' ? '未可靠识别五线谱，请手动添加节点；已保留整页。' : `识别到 ${page.staffCount} 组五线谱 · 当前 ${page.cuts.length + 1} 个阅读段 · 请检查配对与标记`;
}
async function drawEditor() {
  const version = ++editVersion;
  $('editPageLabel').textContent = `第 ${state.editing + 1} / ${state.pages.length} 页`;
  $('editPrev').disabled = state.editing === 0; $('editNext').disabled = state.editing === state.pages.length - 1;
  const canvas = await source(state.editing); if (version !== editVersion || !$('editor').open) return;
  $('editCanvas').width = canvas.width; $('editCanvas').height = canvas.height;
  $('editCanvas').getContext('2d').drawImage(canvas, 0, 0); overlay();
}
$('editButton').addEventListener('click', run(async () => { setActive(false); history.length = 0; state.editing = segments(state.pages, state.mode)[state.position].page; $('editor').showModal(); await drawEditor(); }));
$('closeEdit').addEventListener('click', () => $('editor').close());
$('editor').addEventListener('close', run(async () => { state.pages.forEach(sanitizeLayout); state.position = clamp(state.position, 0, segments(state.pages, state.mode).length - 1); save(); await draw(); }));
$('editPrev').addEventListener('click', run(async () => { if (state.editing > 0) { state.editing--; await drawEditor(); } }));
$('editNext').addEventListener('click', run(async () => { if (state.editing < state.pages.length - 1) { state.editing++; await drawEditor(); } }));
$('addCut').addEventListener('click', () => { const p = state.pages[state.editing]; const ys = [p.crop.top, ...p.cuts, p.crop.bottom]; let i = 0; for (let j = 1; j < ys.length - 1; j++) if (ys[j + 1] - ys[j] > ys[i + 1] - ys[i]) i = j; if (ys[i + 1] - ys[i] < .04) return notice('节点已经很密了。'); rememberEdit(); p.cuts.push((ys[i] + ys[i + 1]) / 2); sanitizeLayout(p); overlay(); });
$('undo').addEventListener('click', run(async () => { const prev = history.pop(); if (prev) { state.pages[prev.index] = prev.layout; state.editing = prev.index; await drawEditor(); } }));
$('resetCrop').addEventListener('click', () => { rememberEdit(); state.pages[state.editing].crop = { left: 0, right: 1, top: 0, bottom: 1 }; overlay(); });
$('reanalyze').addEventListener('click', run(async () => { const index = state.editing; $('reanalyze').disabled = true; try { const canvas = await canvasFor(state.pdf, index, 1100); history.push({ index, layout: structuredClone(state.pages[index]) }); state.pages[index] = analyzeScore(canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height)); if (index === state.editing) overlay(); } finally { $('reanalyze').disabled = false; } }));
for (const id of ['openButton', 'welcomeOpen']) $(id).addEventListener('click', () => $('file').click());
$('file').addEventListener('change', run(async () => { const file = $('file').files[0]; $('file').value = ''; if (file) await load(await file.arrayBuffer(), file.name); }));
document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); setActive(false); });
$('stage').addEventListener('dragover', e => { e.preventDefault(); });
$('stage').addEventListener('drop', run(async e => { e.preventDefault(); if (state.active || state.busy) return; const file = e.dataTransfer.files[0]; if (file) await load(await file.arrayBuffer(), file.name); }));
$('perform').addEventListener('click', () => setMouseEnabled(!state.mouseEnabled));
$('startPerformance').addEventListener('click', () => { setMouseEnabled(true); setActive(true); });
$('stage').addEventListener('click', run(async e => { if (state.mouseEnabled && e.button === 0 && !e.target.closest('button,a,input,select')) await turn(1); }));
$('stage').addEventListener('contextmenu', run(async e => { if (state.mouseEnabled) { e.preventDefault(); await turn(-1); } }));
$('prev').addEventListener('click', run(() => turn(-1, false)));
$('next').addEventListener('click', run(() => turn(1, false)));
$('mode').addEventListener('change', run(async () => { const old = segments(state.pages, state.mode)[state.position]; state.mode = $('mode').value; const list = segments(state.pages, state.mode); state.position = Math.max(0, list.findIndex(s => s.page === old.page && s.bottom > old.top + .001)); save(); await draw(); }));
$('overlap').addEventListener('change', run(async () => { save(); await draw(); }));
$('delay').addEventListener('input', () => { $('delayValue').textContent = `${$('delay').value} ms`; save(); });
document.addEventListener('keydown', run(async e => {
  if (e.key === 'Escape') { setActive(false); return; }
  if (!state.active || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('button,input,select,textarea') || $('editor').open) return;
  if ([' ', 'ArrowRight', 'PageDown', 'ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); await turn(['ArrowLeft', 'PageUp'].includes(e.key) ? -1 : 1); }
}));
$('fullscreen').addEventListener('click', run(async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }));
document.addEventListener('fullscreenchange', () => { $('fullscreen').textContent = document.fullscreenElement ? '⛶ 退出全屏' : '⛶ 全屏阅读'; });
document.addEventListener('visibilitychange', () => { if (document.hidden) setActive(false); });
let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(run(draw), 100); }).observe($('stage'));
$('forget').addEventListener('click', run(async () => {
  if (!state.id || !confirm('清除此谱在浏览器中保存的文件和调整记录？原始 PDF 不会被修改。')) return;
  setActive(false); setMouseEnabled(false); renderVersion++;
  await storage('settings', 'delete', state.id); await storage('files', 'delete', state.id);
  localStorage.removeItem('pedal-last'); await state.pdf.destroy();
  state.pdf = null; state.id = null; state.pages = []; state.position = 0; cache.clear();
  $('welcome').hidden = false; $('score').hidden = true; $('docName').textContent = '把双手留给音乐'; $('docMeta').textContent = '本地 PDF 乐谱阅读器'; $('position').textContent = '等待导入乐谱'; $('saveState').textContent = '离线可用'; available(); notice('此谱的本地记录已清除。');
}));
run(async () => { const last = localStorage.getItem('pedal-last'); if (last) { const file = await storage('files', 'get', last); if (file && !state.pdf && !state.busy) await load(file.bytes, file.name); } })();
