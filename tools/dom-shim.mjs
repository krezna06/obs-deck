/*
  A deliberately small HTML/DOM shim.

  Purpose: run the deck's own inline <script> straight out of site/index.html
  under Node, so the connection logic, SHA-256 auth handshake, request plumbing
  and button rendering are all exercised for real rather than reimplemented in
  the test. It supports only the element/attribute/selector surface the deck
  actually touches.
*/

function decodeEntities(s) {
  return String(s).replace(/&(amp|lt|gt|quot|#39|apos);/g, (m, e) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'",
  }[e]));
}

const VOID_TAGS = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr']);

function getAttrMap(attrText, el) {
  const attrs = {};
  if (attrText) {
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))|([a-zA-Z_:][-a-zA-Z0-9_:.]*)/g;
    let m;
    while ((m = re.exec(attrText))) {
      const name = (m[1] || m[5] || '').toLowerCase();
      const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
      attrs[name] = value;
      el._attrs[name] = value;
      if (name.startsWith('data-')) el.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
  }

  // Mirror the properties real DOM elements expose, since the constructor ran
  // before these attributes were known.
  if (attrs.id !== undefined) el.id = attrs.id;
  if (attrs.class !== undefined) { el.className = attrs.class; }
  if (attrs.value !== undefined) el.value = attrs.value;
  if (attrs.type !== undefined) el.type = attrs.type;

  return attrs;
}

class ClassList {
  constructor(el) { this.el = el; }
  get _set() { return new Set((this.el._attrs.class || '').split(/\s+/).filter(Boolean)); }
  _write(set) { const v = [...set].join(' '); this.el._attrs.class = v; this.el.className = v; }
  add(...names) { const s = this._set; names.forEach((n) => s.add(n)); this._write(s); }
  remove(...names) { const s = this._set; names.forEach((n) => s.delete(n)); this._write(s); }
  contains(name) { return this._set.has(name); }
  toggle(name, force) {
    const has = this.contains(name);
    const want = force === undefined ? !has : !!force;
    if (want && !has) this.add(name);
    else if (!want && has) this.remove(name);
    return want;
  }
}

class Style {
  constructor() { this._props = {}; }
  setProperty(k, v) { this._props[k] = v; }
  getPropertyValue(k) { return this._props[k] || ''; }
  get cssText() { return Object.entries(this._props).map(([k, v]) => `${k}:${v}`).join(';'); }
}

class Element {
  constructor(tagName, attrs = {}) {
    this.tagName = String(tagName).toUpperCase();
    this._attrs = { ...attrs };
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this._text = '';
    this._listeners = {};
    this.dataset = {};
    this.style = new Style();
    this.classList = new ClassList(this);
    this.id = attrs.id || '';
    /* className must stay in step with the class attribute, exactly as the real
       DOM does, because classList reads through to the attribute. */
    if (attrs.class !== undefined) this._attrs.class = attrs.class;
    for (const k of Object.keys(attrs)) {
      if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = attrs[k];
      if (k === 'type' || k === 'value') this[k] = attrs[k];
    }
  }

  get attrs() { return this._attrs; }

  get className() { return this._attrs.class || ''; }
  set className(v) {
    this._attrs.class = String(v);
  }

  setAttribute(name, value) {
    const v = String(value);
    this._attrs[name] = v;
    if (name === 'class') { this.className = v; }
    if (name === 'id') { this.id = v; }
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toLowerCase())] = v;
  }

  getAttribute(name) { return name in this._attrs ? this._attrs[name] : null; }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(v) { this.children.length = 0; this._text = String(v); }

  get innerHTML() { return this._innerHTML ?? ''; }

  set innerHTML(html) {
    this._innerHTML = String(html);
    this.children.length = 0;
    this._text = '';
    for (const child of parseHtml(String(html))) this._adopt(child);
  }

  _adopt(child) {
    child.parentNode = this;
    this.children.push(child);
  }

  appendChild(child) { this._adopt(child); return child; }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    return child;
  }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    const a = this._listeners[type];
    if (a) this._listeners[type] = a.filter((x) => x !== fn);
  }

  dispatch(type, event = {}) {
    const ev = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
    /* Collect any promises the handlers return, so tests can await a handler
       that is itself async instead of guessing at timings. */
    this._lastDispatch = (this._listeners[type] || []).map((fn) => fn(ev));
    return ev;
  }

  click(event = {}) { return this.dispatch('click', event); }

  _walk(out = []) {
    for (const c of this.children) { out.push(c); c._walk(out); }
    return out;
  }

  _matches(selector) {
    return matchSelector(this, selector);
  }

  querySelectorAll(selector) {
    return this._walk().filter((el) => matchSelector(el, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  get firstElementChild() { return this.children[0] || null; }

  /* The deck only reads .value / .checked and writes .value / .placeholder. */
  get placeholder() { return this._attrs.placeholder || ''; }
  set placeholder(v) { this.setAttribute('placeholder', v); }
  get value() { return this._value !== undefined ? this._value : (this._attrs.value ?? ''); }
  set value(v) { this._value = String(v); }
  get checked() { return !!this._checked; }
  set checked(v) { this._checked = !!v; }
  get disabled() { return !!this._attrs.disabled; }
  set disabled(v) { if (v) this._attrs.disabled = 'true'; else delete this._attrs.disabled; }
}

function matchSelector(el, selector) {
  const sel = selector.trim();
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  return el.tagName === sel.toUpperCase();
}

/** Tokenizer that understands raw-text elements such as <script> and <style>. */
export function parseHtml(html) {
  const root = [];
  const stack = [];
  let i = 0;

  const push = (node) => {
    if (stack.length) stack[stack.length - 1]._adopt(node);
    else root.push(node);
  };

  const RAW = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);

  while (i < html.length) {
    const lt = html.indexOf('<', i);

    if (lt === -1) {
      const text = html.slice(i);
      if (text.trim()) {
        const node = new Element('#text');
        node._text = decodeEntities(text);
        push(node);
      }
      break;
    }

    if (lt > i) {
      const text = html.slice(i, lt);
      if (text.trim()) {
        const node = new Element('#text');
        node._text = decodeEntities(text);
        push(node);
      }
    }

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }

    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    if (html[lt + 1] === '/') {
      const end = html.indexOf('>', lt);
      const name = html.slice(lt + 2, end).trim().toUpperCase();
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tagName === name) { stack.length = k; break; }
      }
      i = end + 1;
      continue;
    }

    const nameMatch = /^<([a-zA-Z][-a-zA-Z0-9]*)/.exec(html.slice(lt));
    if (!nameMatch) { i = lt + 1; continue; }

    const tagName = nameMatch[1].toUpperCase();
    const gt = html.indexOf('>', lt);
    const rawAttrs = html.slice(lt + 1 + nameMatch[1].length, gt === -1 ? html.length : gt);
    const selfClosing = /\/\s*$/.test(rawAttrs) || VOID_TAGS.has(tagName.toLowerCase());

    const el = new Element(tagName);
    getAttrMap(rawAttrs.replace(/\/\s*$/, ''), el);
    push(el);

    if (gt === -1) { i = html.length; continue; }
    i = gt + 1;

    if (selfClosing) continue;

    if (RAW.has(tagName)) {
      const closeRe = new RegExp(`</${tagName}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = closeRe.exec(rest);
      const raw = m ? rest.slice(0, m.index) : rest;
      el._text = raw;
      i += m ? m.index + m[0].length : rest.length;
      continue;
    }

    stack.push(el);
  }

  return root;
}

export function createDocument(html) {
  const roots = parseHtml(html);
  const byId = new Map();

  const collect = (el) => {
    if (el.id) byId.set(el.id, el);
    /* A real <select> takes the value of its selected option — or the first
       one, when none is marked. Without this the deck reads "" and takes the
       wrong branch on transitionMode. */
    if (el.tagName === 'SELECT' && el._value === undefined) {
      const options = el.querySelectorAll('option');
      const selected = options.find((o) => o._attrs.selected !== undefined) || options[0];
      if (selected) el.value = selected._attrs.value !== undefined ? selected._attrs.value : selected.textContent.trim();
    }
    el.children.forEach(collect);
  };
  roots.forEach(collect);

  const doc = {
    _roots: roots,
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (sel) => roots.flatMap((r) => (matchSelector(r, sel) ? [r] : [])).concat(
      roots.flatMap((r) => r.querySelectorAll(sel))
    ),
    querySelector(sel) { return doc.querySelectorAll(sel)[0] || null; },
    createElement: (tag) => new Element(tag),
    addEventListener() {},
    body: roots.find((r) => r.tagName === 'BODY') || roots[0],
    get roots() { return roots; },
  };

  return doc;
}

export { Element };
