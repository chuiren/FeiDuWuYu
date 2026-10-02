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

  const canvas = document.getElementById('canvas');
  const held = new Map();      // key id -> number of pointers holding it
  const pointers = new Map();  // pointerId -> { id, node }

  function modifierState() {
    const state = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
    for (const id of held.keys()) {
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

  function press(id) {
    const count = held.get(id) || 0;
    if (count === 0) {
      held.set(id, 1);   // set first so the modifier flags include this key
      dispatch('keydown', id);
    } else {
      held.set(id, count + 1);
    }
  }

  function release(id) {
    const count = held.get(id) || 0;
    if (count <= 1) {
      if (count === 1) {
        held.delete(id);  // delete first so the modifier flags exclude it
        dispatch('keyup', id);
      }
    } else {
      held.set(id, count - 1);
    }
  }

  function releaseAll() {
    for (const { node } of pointers.values()) node.classList.remove('active');
    pointers.clear();
    // Release normal keys before modifiers
    const ids = [...held.keys()].sort((a, b) => !!KEYS[a].modifier - !!KEYS[b].modifier);
    for (const id of ids) {
      held.delete(id);
      dispatch('keyup', id);
    }
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

  window.RuinaInput = { press, release, releaseAll, held, keys: KEYS };
})();
