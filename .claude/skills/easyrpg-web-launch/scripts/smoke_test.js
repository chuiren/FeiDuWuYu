#!/usr/bin/env node
/*
 * Headless smoke test for an EasyRPG web site (served over http://localhost
 * or https — service workers need a secure context).
 *
 *   NODE_PATH=$(npm root -g) node smoke_test.js http://localhost:8000/ [--out DIR] [--keys "Enter*10,ArrowUp,..."]
 *
 * Checks: game starts, EasyRPG's engine/patch log lines, HTTP errors, page
 * exceptions, offline preparation completes, and an offline reload starts the
 * game. Optional --keys plays a key sequence (Key*N repeats, Key:ms holds)
 * and screenshots after it. Screenshots go to --out (default: cwd).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const url = args.find(a => /^https?:/.test(a));
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outDir = opt('--out') || '.';
const keys = opt('--keys');
if (!url) { console.error('usage: smoke_test.js URL [--out DIR] [--keys SEQ]'); process.exit(2); }

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'easyrpg-smoke-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    viewport: { width: 960, height: 720 }, args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const p = ctx.pages()[0] || await ctx.newPage();
  const logs = [], httpErrors = [], pageErrors = [];
  p.on('console', m => logs.push(m.text()));
  p.on('pageerror', e => pageErrors.push(e.message));
  p.on('response', r => { if (r.status() >= 400) httpErrors.push(r.status() + ' ' + decodeURIComponent(r.url())); });
  const started = () => p.waitForFunction(() => !!window.easyrpgPlayer, null, { timeout: 180000 });
  let failed = false;
  const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failed = true; };

  await p.goto(url);
  await started();
  await p.waitForTimeout(6000);
  await p.screenshot({ path: path.join(outDir, 'smoke-1-title.png') });
  const engine = logs.filter(l => /Engine configured|Patch configuration|Assuming older engine|Cannot find RPG_RT|Codepage|encoding/i.test(l));
  console.log('INFO EasyRPG log:\n  ' + (engine.join('\n  ') || '(none)'));
  check(true, 'game started');

  if (keys) {
    for (const part of keys.split(',')) {
      const [k, n] = part.split('*');
      const [key, hold] = k.split(':');
      for (let i = 0; i < (Number(n) || 1); i++) {
        await p.keyboard.down(key); await p.waitForTimeout(Number(hold) || 80);
        await p.keyboard.up(key); await p.waitForTimeout(800);
      }
    }
    await p.waitForTimeout(1500);
    await p.screenshot({ path: path.join(outDir, 'smoke-2-after-keys.png') });
  }

  const status = await p.evaluate(() => window.EasyRPGOffline && EasyRPGOffline.status);
  if (!status || status.mode === 'unsupported' || status.mode === 'online') {
    console.log('INFO offline layer inactive (' + JSON.stringify(status) + ') — no offline-manifest.json? skipping offline test');
  } else {
    await p.waitForFunction(() => ['ready', 'error'].includes(EasyRPGOffline.status.mode), null, { timeout: 300000 });
    const st = await p.evaluate(() => EasyRPGOffline.status);
    check(st.mode === 'ready', 'offline preparation ' + JSON.stringify(st));
    await ctx.setOffline(true);
    await p.reload();
    await started();
    await p.waitForTimeout(5000);
    await p.screenshot({ path: path.join(outDir, 'smoke-3-offline.png') });
    check(true, 'offline reload started the game');
    await ctx.setOffline(false);
  }

  check(httpErrors.length === 0, 'HTTP errors: ' + (httpErrors.slice(0, 10).join(' | ') || 'none'));
  check(pageErrors.length === 0, 'page exceptions: ' + (pageErrors.slice(0, 5).join(' | ') || 'none'));
  console.log('INFO screenshots in ' + path.resolve(outDir));
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
