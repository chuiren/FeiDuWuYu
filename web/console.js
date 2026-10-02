/*
 * 🎮 Console: on-screen keyboard for keys touch devices cannot send
 * (Shift, Ctrl, Alt, Esc, Tab, …).
 *
 * Input path: SDL3 in index.js listens for keydown/keyup and reads
 * code/key/keyCode and the modifier flags from the event; a document-level
 * listener also calls event.getModifierState(). So we dispatch real
 * KeyboardEvent objects on the canvas (they bubble to document and window).
 *
 * Every key is a real press/release: keydown on pointerdown, keyup on
 * pointerup/pointercancel/lostpointercapture. Several keys can be held at
 * once with multi-touch (hold Shift, tap Z). All held keys are released when
 * the console closes, the page is hidden or the window loses focus, so a
 * modifier can never stay stuck.
 *
 * EasyRPG samples the keyboard state once per frame, so a tap shorter than a
 * frame would be missed. A key therefore stays down for at least
 * MIN_HOLD_MS; an earlier release is delayed until then.
 */
(function () {
  'use strict';

  const KEYS = {
    Shift:  { key: 'Shift',   code: 'ShiftLeft',   keyCode: 16, location: 1, label: 'Shift', modifier: 'shiftKey' },
    Ctrl:   { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1, label: 'Ctrl',  modifier: 'ctrlKey' },
    Alt:    { key: 'Alt',     code: 'AltLeft',     keyCode: 18, location: 1, label: 'Alt',   modifier: 'altKey' },
    Esc:    { key: 'Escape',  code: 'Escape',      keyCode: 27, label: 'Esc' },
    Tab:    { key: 'Tab',     code: 'Tab',         keyCode: 9,  label: 'Tab' },
    Enter:  { key: 'Enter',   code: 'Enter',       keyCode: 13, label: 'Enter' },
    Space:  { key: ' ',       code: 'Space',       keyCode: 32, label: 'Space' },
    Up:     { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38, label: '↑' },
    Down:   { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40, label: '↓' },
    Left:   { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37, label: '←' },
    Right:  { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, label: '→' },
    Z: { key: 'z', code: 'KeyZ', keyCode: 90, label: 'Z', letter: true },
    X: { key: 'x', code: 'KeyX', keyCode: 88, label: 'X', letter: true },
    C: { key: 'c', code: 'KeyC', keyCode: 67, label: 'C', letter: true },
    A: { key: 'a', code: 'KeyA', keyCode: 65, label: 'A', letter: true },
  };

  const LAYOUT = {
    left: [['', 'Up', ''], ['Left', 'Down', 'Right']],
    right: [['Shift', 'Ctrl', 'Alt'], ['Esc', 'Tab', 'Enter'], ['Z', 'X', 'C', 'A'], ['Space']],
  };

  const MIN_HOLD_MS = 100;

  const canvas = document.getElementById('canvas');
  const held = new Map();      // key id -> number of pointers holding it
  const down = new Map();      // key id -> time of keydown (down for the game)
  const pending = new Map();   // key id -> { timer, deadline } of a delayed keyup
  const pointers = new Map();  // pointerId -> { id, node }

  function modifierState() {
    const state = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
    for (const id of down.keys()) {
      if (KEYS[id].modifier) state[KEYS[id].modifier] = true;
    }
    return state;
  }

  function dispatch(type, id) {
    const spec = KEYS[id];
    const mods = modifierState();
    const key = spec.letter && mods.shiftKey ? spec.key.toUpperCase() : spec.key;
    const event = new KeyboardEvent(type, {
      key, code: spec.code, location: spec.location || 0,
      bubbles: true, cancelable: true, ...mods,
    });
    // keyCode/which cannot be set through the constructor
    Object.defineProperty(event, 'keyCode', { get: () => spec.keyCode });
    Object.defineProperty(event, 'which', { get: () => spec.keyCode });
    canvas.dispatchEvent(event);
  }

  function keyUp(id) {
    if (!down.has(id)) return;
    down.delete(id);  // delete first so the modifier flags exclude it
    dispatch('keyup', id);
  }

  function press(id) {
    held.set(id, (held.get(id) || 0) + 1);
    if (pending.has(id)) {
      // Pressed again before the delayed keyup: it simply stays down
      clearTimeout(pending.get(id).timer);
      pending.delete(id);
    } else if (!down.has(id)) {
      down.set(id, performance.now());  // set first so the modifier flags include it
      dispatch('keydown', id);
    }
  }

  function release(id) {
    const count = held.get(id) || 0;
    if (count > 1) {
      held.set(id, count - 1);
      return;
    }
    if (count === 0) return;
    held.delete(id);

    const now = performance.now();
    let deadline = (down.get(id) ?? now) + MIN_HOLD_MS;
    // A modifier must not go up before a key still waiting for its keyup
    // (hold Shift, quick tap Z, lift Shift: Z goes up first)
    if (KEYS[id].modifier) {
      for (const p of pending.values()) deadline = Math.max(deadline, p.deadline);
    }
    if (deadline <= now) {
      keyUp(id);
    } else {
      const timer = setTimeout(() => { pending.delete(id); keyUp(id); }, deadline - now);
      pending.set(id, { timer, deadline });
    }
  }

  function releaseAll() {
    for (const { node } of pointers.values()) node.classList.remove('active');
    pointers.clear();
    held.clear();
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    // Release normal keys before modifiers
    const ids = [...down.keys()].sort((a, b) => !!KEYS[a].modifier - !!KEYS[b].modifier);
    for (const id of ids) keyUp(id);
  }

  function endPointer(event) {
    const entry = pointers.get(event.pointerId);
    if (!entry) return;
    pointers.delete(event.pointerId);
    if (![...pointers.values()].some(p => p.node === entry.node)) entry.node.classList.remove('active');
    release(entry.id);
  }

  function makeKey(id) {
    if (!id) return document.createElement('span');
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'console-key' + (KEYS[id].modifier ? ' modifier' : '') + (id === 'Space' ? ' wide' : '');
    node.textContent = KEYS[id].label;
    node.dataset.consoleKey = id;

    node.addEventListener('pointerdown', event => {
      event.preventDefault();
      try { node.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
      pointers.set(event.pointerId, { id, node });
      node.classList.add('active');
      press(id);
    });
    node.addEventListener('pointerup', endPointer);
    node.addEventListener('pointercancel', endPointer);
    node.addEventListener('lostpointercapture', endPointer);
    node.addEventListener('contextmenu', event => event.preventDefault());
    return node;
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'console-panel';
    panel.className = 'unselectable';
    panel.hidden = true;
    for (const side of ['left', 'right']) {
      const group = document.createElement('div');
      group.className = 'console-group console-' + side;
      for (const row of LAYOUT[side]) {
        const line = document.createElement('div');
        line.className = 'console-row';
        for (const id of row) line.append(makeKey(id));
        group.append(line);
      }
      panel.append(group);
    }
    document.getElementById('viewport').append(panel);
    return panel;
  }

  const panel = buildPanel();

  function setOpen(open) {
    if (!open) releaseAll();
    panel.hidden = !open;
    toggle.classList.toggle('active', open);
    // The stock touch pad would overlap the console
    document.body.classList.toggle('console-open', open);
    canvas.focus();
  }

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'unselectable addon-button';
  toggle.textContent = '🎮';
  toggle.title = '虚拟键盘 (Console)';
  toggle.setAttribute('aria-label', '虚拟键盘 (Console)');
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  document.getElementById('controls').insertBefore(toggle, document.getElementById('controls-fullscreen'));

  window.addEventListener('blur', releaseAll);
  window.addEventListener('pagehide', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  window.RuinaInput = { press, release, releaseAll, held, down, keys: KEYS };
})();
