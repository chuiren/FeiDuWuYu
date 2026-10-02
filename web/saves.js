/*
 * Save backup: export all saves as a ZIP, import a ZIP (or a single .lsd).
 *
 * Works through the Emscripten FS exported on the EasyRPG module
 * (Module.FS). Saves live in the IDBFS mount "<cwd>/Save"; this file never
 * touches IndexedDB directly — after importing it calls FS.syncfs(false) and
 * the runtime's IDBFS persists the files itself.
 */
(function () {
  'use strict';

  let player = null;
  const buttons = [];

  function saveDir() {
    const FS = player.FS;
    for (const dir of [FS.cwd() + '/Save', '/easyrpg/Save']) {
      const info = FS.analyzePath(dir);
      if (info.exists && FS.isDir(info.object.mode)) return dir;
    }
    throw new Error('找不到存档目录');
  }

  // The runtime loads saves from IndexedDB asynchronously after startup
  // (FS.syncfs(true) in its preRun). Reading or writing before that finishes
  // would see no saves, and imported files would be dropped by the load.
  function fsBusy() {
    return player.FS.syncFSRequests > 0;
  }

  function waitIdle(timeoutMs = 15000) {
    return new Promise(resolve => {
      const start = Date.now();
      const poll = () => (!fsBusy() || Date.now() - start > timeoutMs) ? resolve() : setTimeout(poll, 100);
      poll();
    });
  }

  function listFiles(dir, prefix = '') {
    const FS = player.FS;
    const out = [];
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const path = dir + '/' + name;
      const mode = FS.stat(path).mode;
      if (FS.isDir(mode)) out.push(...listFiles(path, prefix + name + '/'));
      else if (FS.isFile(mode)) out.push({ rel: prefix + name, path });
    }
    return out;
  }

  function timestamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
  }

  function isStandalone() {
    return navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches;
  }

  function deliver(bytes, name) {
    const file = new File([bytes], name, { type: 'application/zip' });
    // Home-screen apps on iOS cannot follow download links; the share sheet
    // offers "Save to Files" instead
    if (isStandalone() && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch(e => {
        if (e.name !== 'AbortError') alert('分享失败：' + e.message);
      });
      return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function exportSaves() {
    if (fsBusy()) {
      alert('正在读取存档，请稍候再试。');
      return;
    }
    try {
      const dir = saveDir();
      const files = listFiles(dir);
      if (files.length === 0) {
        alert('还没有存档。');
        return;
      }
      const entries = files.map(f => ({ name: 'Save/' + f.rel, data: player.FS.readFile(f.path) }));
      deliver(window.RuinaZip.create(entries), `ruina-save-${timestamp()}.zip`);
    } catch (e) {
      console.error('[saves] export failed', e);
      alert('导出存档失败：' + e.message);
    }
  }

  const UNSAFE_SEGMENT = /[\x00-\x1f\x7f:*?"<>|]/;

  /**
   * Maps an archive entry name to a path relative to the Save directory.
   * Returns null for junk entries to skip; throws for unsafe paths.
   */
  function targetPath(name) {
    const segs = name.replace(/\\/g, '/').split('/');
    if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) {
      throw new Error('不安全的路径：' + name);
    }
    if (segs.some(s => s === '' || s === '.' || s === '..' || UNSAFE_SEGMENT.test(s))) {
      throw new Error('不安全的路径：' + name);
    }
    const last = segs[segs.length - 1];
    if (segs[0] === '__MACOSX' || last.startsWith('._') || last === '.DS_Store' || last === 'Thumbs.db') {
      return null;
    }
    // Files below a "Save" folder (at any level, e.g. inside a wrapper
    // folder), or loose files at the top level of the archive
    const saveIdx = segs.findIndex(s => s.toLowerCase() === 'save');
    let rel;
    if (saveIdx >= 0 && saveIdx < segs.length - 1) rel = segs.slice(saveIdx + 1);
    else if (segs.length === 1) rel = segs;
    else return null;
    if (rel.length > 4) throw new Error('路径层级过深：' + name);
    return rel.join('/');
  }

  function mkdirs(base, rel) {
    const FS = player.FS;
    const segs = rel.split('/').slice(0, -1);
    let path = base;
    for (const seg of segs) {
      path += '/' + seg;
      if (!FS.analyzePath(path).exists) FS.mkdir(path);
    }
  }

  async function importFile(file) {
    await waitIdle();
    const dir = saveDir();
    let entries;
    if (/\.lsd$/i.test(file.name)) {
      entries = [{ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }];
    } else {
      entries = await window.RuinaZip.read(await file.arrayBuffer());
    }

    const plan = [];
    for (const entry of entries) {
      const rel = targetPath(entry.name);
      if (rel) plan.push({ rel, data: entry.data });
    }
    if (plan.length === 0) {
      alert('文件里没有找到存档。');
      return;
    }

    const FS = player.FS;
    const existing = plan.filter(p => FS.analyzePath(dir + '/' + p.rel).exists);
    let message = `将导入 ${plan.length} 个存档文件：\n` + plan.map(p => p.rel).join('\n');
    if (existing.length) {
      message += `\n\n⚠️ 以下 ${existing.length} 个已有存档会被覆盖：\n` + existing.map(p => p.rel).join('\n');
    }
    message += '\n\n导入后游戏会重新载入。继续吗？';
    if (!confirm(message)) return;

    for (const p of plan) {
      const path = dir + '/' + p.rel;
      if (FS.analyzePath(path).exists && FS.isDir(FS.stat(path).mode)) {
        throw new Error('目标是文件夹：' + p.rel);
      }
      mkdirs(dir, p.rel);
      FS.writeFile(path, p.data);
    }

    await new Promise((resolve, reject) => FS.syncfs(false, err => err ? reject(err) : resolve()));
    alert(`已导入 ${plan.length} 个存档文件，游戏将重新载入。`);
    location.reload();
  }

  function pickImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.lsd,application/zip';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      importFile(file).catch(e => {
        console.error('[saves] import failed', e);
        alert('导入存档失败：' + e.message);
      });
    });
    document.body.append(input);
    input.click();
  }

  function addButton(emoji, label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'unselectable addon-button';
    button.textContent = emoji;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = true;
    button.addEventListener('click', onClick);
    const controls = document.getElementById('controls');
    controls.insertBefore(button, document.getElementById('controls-fullscreen'));
    buttons.push(button);
  }

  addButton('💾', '导出存档 (Download Save)', exportSaves);
  addButton('📂', '导入存档 (Upload Save)', pickImport);

  window.addEventListener('easyrpg-ready', event => {
    player = event.detail;
    waitIdle().then(() => {
      for (const b of buttons) b.disabled = false;
    });
  });
})();
