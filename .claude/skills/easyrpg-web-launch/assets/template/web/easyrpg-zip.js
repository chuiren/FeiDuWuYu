/*
 * Minimal ZIP support for save backups (no external dependencies).
 *
 * - create(): builds an uncompressed (STORE) archive synchronously, so it can
 *   run inside a click handler without losing user activation.
 * - read(): parses an archive; STORE entries always work, DEFLATE entries
 *   (e.g. archives re-zipped by the iOS Files app) need DecompressionStream.
 */
(function () {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  /**
   * @param {{name: string, data: Uint8Array}[]} files
   * @returns {Uint8Array}
   */
  function create(files) {
    const enc = new TextEncoder();
    const { time, day } = dosDateTime(new Date());
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const file of files) {
      const name = enc.encode(file.name);
      const data = file.data;
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);        // version needed
      local.setUint16(6, 0x0800, true);    // UTF-8 names
      local.setUint16(8, 0, true);         // STORE
      local.setUint16(10, time, true);
      local.setUint16(12, day, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      locals.push(new Uint8Array(local.buffer), name, data);

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(10, 0, true);
      central.setUint16(12, time, true);
      central.setUint16(14, day, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, data.length, true);
      central.setUint32(24, data.length, true);
      central.setUint16(28, name.length, true);
      central.setUint32(42, offset, true);
      centrals.push(new Uint8Array(central.buffer), name);

      offset += 30 + name.length + data.length;
    }

    const centralSize = centrals.reduce((n, a) => n + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
    let pos = 0;
    for (const part of parts) { out.set(part, pos); pos += part.length; }
    return out;
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('此浏览器不支持解压缩的 ZIP，请使用本页面导出的备份文件');
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * @param {ArrayBuffer} buffer
   * @param {{maxEntries?: number, maxTotalSize?: number}} limits
   * @returns {Promise<{name: string, data: Uint8Array}[]>} file entries only
   */
  async function read(buffer, limits = {}) {
    const maxEntries = limits.maxEntries ?? 1000;
    const maxTotal = limits.maxTotalSize ?? 64 * 1024 * 1024;
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xFFFF); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件');

    const count = view.getUint16(eocd + 10, true);
    let pos = view.getUint32(eocd + 16, true);
    if (count > maxEntries) throw new Error('ZIP 内文件过多');

    const utf8 = new TextDecoder('utf-8');
    const result = [];
    let total = 0;

    for (let i = 0; i < count; i++) {
      if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) {
        throw new Error('ZIP 目录损坏');
      }
      const flags = view.getUint16(pos + 8, true);
      const method = view.getUint16(pos + 10, true);
      const crc = view.getUint32(pos + 16, true);
      const compSize = view.getUint32(pos + 20, true);
      const size = view.getUint32(pos + 24, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const localOffset = view.getUint32(pos + 42, true);
      const name = utf8.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
      pos += 46 + nameLen + extraLen + commentLen;

      if (flags & 1) throw new Error('不支持加密的 ZIP');
      if (name.endsWith('/')) continue;

      total += size;
      if (total > maxTotal) throw new Error('ZIP 内容过大');

      if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error('ZIP 文件损坏');
      }
      const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      if (start + compSize > bytes.length) throw new Error('ZIP 文件损坏');
      const raw = bytes.subarray(start, start + compSize);

      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error('不支持的 ZIP 压缩方式: ' + method);

      if (data.length !== size || crc32(data) !== crc) throw new Error('ZIP 校验失败: ' + name);
      result.push({ name, data });
    }
    return result;
  }

  window.EasyRPGZip = { create, read, crc32 };
})();
