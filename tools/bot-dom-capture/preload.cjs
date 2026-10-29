'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Serialized into the browser; no surrounding Node state or page data escapes. */
function sanitizeDocument(source = document) {
  const safeText = new Set([
    "What's your name?", 'Your name', 'Ask to join', 'Ask to join without microphone & camera',
    'Join now', 'Switch here', 'Other ways to join', 'Sign in', 'More options',
    'Turn off microphone', 'Turn on microphone', 'Turn off camera', 'Turn on camera',
    'Microphone muted by system', 'Asking to be let in', 'Asking to join',
    'Waiting for someone to let you in', 'Return to home screen', 'Try again', 'Go back',
    'Got it', 'You can’t join this video call', "You can't join this video call",
  ]);
  const knownJsCodes = new Set(['YPqjbf', 'V67aGc', 'O626Fe']);
  const clone = source.documentElement.cloneNode(true);
  clone.querySelectorAll('script,noscript,style,template,link,meta,base,iframe,frame,object,embed,svg,canvas,video,audio,img,source,picture').forEach(node => node.remove());
  clone.querySelectorAll('[data-participant-id],[data-self-name],[data-email]:not(input):not(textarea),[aria-label^="Google Account"],a[href*="accounts.google"]').forEach(node => node.remove());
  const comments = source.createTreeWalker(clone, 128 /* SHOW_COMMENT */);
  const discardedComments = [];
  while (comments.nextNode()) discardedComments.push(comments.currentNode);
  discardedComments.forEach(node => node.remove());
  for (const element of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const { name, value } = attribute;
      const keep =
        (name === 'lang' && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(value)) ||
        (name === 'dir' && /^(ltr|rtl)$/.test(value)) ||
        (name === 'role' && /^(button|dialog|alertdialog|heading|textbox|combobox|listbox|option|status|alert|presentation)$/.test(value)) ||
        (name === 'type' && /^(text|button|submit|checkbox|radio)$/.test(value)) ||
        (name === 'disabled') ||
        (/^(aria-hidden|aria-expanded|aria-disabled|data-is-muted)$/.test(name) && /^(true|false)$/.test(value)) ||
        (/^(aria-label|placeholder|title|alt)$/.test(name) && safeText.has(value)) ||
        (/^(jsname|jscontroller)$/.test(name) && knownJsCodes.has(value));
      if (!keep) element.removeAttribute(name);
      else if (name === 'disabled') element.setAttribute(name, '');
    }
    if (element.matches('input,textarea')) {
      element.removeAttribute('value');
      element.textContent = '';
    }
  }
  const walker = source.createTreeWalker(clone, 4 /* SHOW_TEXT */);
  let node;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
    node.nodeValue = text ? (safeText.has(text) ? text : '[redacted]') : '';
  }
  clone.querySelectorAll('title').forEach(title => { title.textContent = 'Sanitized local diagnostic'; });
  return '<!doctype html>\n' + clone.outerHTML;
}

const OUTPUT = '/var/local/vexa-dom-capture';
function install() {
  const directory = fs.lstatSync(OUTPUT);
  const markerPath = path.join(OUTPUT, 'LOCAL_DIAGNOSTIC_ONLY.json');
  const markerStat = fs.lstatSync(markerPath);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 ||
      !markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o777) !== 0o600 || markerStat.uid !== directory.uid) {
    throw new Error('LOCAL_CAPTURE_PRIVATE_CONSENT_REQUIRED');
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker.local_only !== true || marker.format_version !== 1 || !['failure', 'checkpoints'].includes(marker.mode)) {
    throw new Error('LOCAL_CAPTURE_PRIVATE_CONSENT_REQUIRED');
  }
  let sequence = 0;
  let pending = Promise.resolve();
  let renderingPageCreations = 0;
  let currentPage;
  const captured = new Set();
  const attached = new WeakSet();
  const contexts = new WeakSet();
  const browsers = new WeakSet();

  function writePrivate(name, content) {
    const descriptor = fs.openSync(path.join(OUTPUT, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      if (process.getuid?.() === 0) fs.fchownSync(descriptor, directory.uid, directory.gid);
      fs.writeFileSync(descriptor, content);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  async function capture(page, stage, index, state) {
    const stem = String(index).padStart(2, '0') + '-' + stage;
    let rendering;
    try {
      const html = await page.evaluate(sanitizeDocument);
      if (state.expired) return Buffer.alloc(0);
      writePrivate(stem + '.html', html);
      // Never screenshot the live bot page. The PNG contains only this sanitized rendering.
      // playwright-extra navigates a newly created page to about:blank. Do not
      // attach the capture hook to our renderer or its screenshot awaits itself.
      renderingPageCreations++;
      try {
        rendering = await page.context().newPage();
      } finally {
        renderingPageCreations--;
      }
      if (state.expired) return Buffer.alloc(0);
      await rendering.route('**/*', route => route.abort());
      await rendering.setViewportSize(page.viewportSize() || { width: 1024, height: 768 });
      await rendering.setContent(html, { waitUntil: 'domcontentloaded' });
      if (state.expired) return Buffer.alloc(0);
      const png = await rendering.screenshot({ fullPage: true, timeout: 3000 });
      if (state.expired) return Buffer.alloc(0);
      writePrivate(stem + '.rendered.png', png);
      writePrivate(stem + '.status.json', JSON.stringify({ stage, result: 'saved', representation: 'sanitized_dom_rendering' }) + '\n');
      return png;
    } catch {
      try { writePrivate(stem + '.status.json', JSON.stringify({ stage, result: 'capture_failed' }) + '\n'); } catch { /* no raw exception or alternate output */ }
      return Buffer.alloc(0);
    } finally {
      if (rendering) await rendering.close().catch(() => {});
    }
  }

  function enqueue(stage) {
    if (!currentPage || captured.has(stage) || sequence >= 16) return pending;
    captured.add(stage);
    const index = ++sequence;
    const page = currentPage;
    pending = pending.then(async () => {
      const state = { expired: false };
      let timer;
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
          state.expired = true;
          try {
            writePrivate(String(index).padStart(2, '0') + '-' + stage + '.status.json',
              JSON.stringify({ stage, result: 'capture_timeout' }) + '\n');
          } catch { /* no raw exception or alternate output */ }
          resolve(Buffer.alloc(0));
        }, 5000);
      });
      try {
        return await Promise.race([capture(page, stage, index, state), timeout]);
      } finally {
        clearTimeout(timer);
      }
    });
    return pending;
  }

  function attach(page) {
    if (attached.has(page)) return;
    attached.add(page);
    currentPage = page;
    const waitForSelector = page.waitForSelector.bind(page);
    page.waitForSelector = async (...args) => {
      await pending;
      return waitForSelector(...args);
    };
    page.screenshot = async (options = {}) => {
      await pending;
      const name = path.basename(String(options.path || ''));
      if (/-not-found\.png$/.test(name)) return enqueue('selector_failure');
      if (name === 'bot-checkpoint-3-no-indicators.png') return enqueue('admission_timeout');
      if (name === 'bot-checkpoint-auth-signed-out.png') return enqueue('auth_signed_out');
      if (marker.mode !== 'checkpoints') return Buffer.alloc(0);
      const checkpoints = {
        'bot-checkpoint-0-after-navigation.png': 'navigation',
        'bot-checkpoint-0-name-field-found.png': 'name_field_found',
        'bot-checkpoint-0-after-ask-to-join.png': 'join_click',
        'bot-checkpoint-0-after-join-now.png': 'authenticated_join_click',
        'bot-checkpoint-auth-lobby.png': 'authenticated_lobby',
        'bot-checkpoint-1-admission-start.png': 'admission_start',
        'bot-checkpoint-2-admitted.png': 'admitted',
        'bot-checkpoint-4-waiting-room.png': 'waiting_room',
      };
      return enqueue(checkpoints[name] || 'checkpoint');
    };
    const closePage = page.close.bind(page);
    page.close = async (...args) => {
      await pending;
      return closePage(...args);
    };
    const context = page.context();
    if (!contexts.has(context)) {
      contexts.add(context);
      const closeContext = context.close.bind(context);
      context.close = async (...args) => {
        await pending;
        return closeContext(...args);
      };
    }
    const browser = context.browser();
    if (browser && !browsers.has(browser)) {
      browsers.add(browser);
      const closeBrowser = browser.close.bind(browser);
      browser.close = async (...args) => {
        await pending;
        return closeBrowser(...args);
      };
    }
  }

  const host = require('/app/core/meetings/modules/join/dist/_host.js');
  const originalLog = host.logJSON;
  host.logJSON = event => {
    originalLog(event);
    if (event.event === 'join.selector_miss') void enqueue('selector_failure');
    if (event.event === 'admission.rejected') void enqueue('admission_rejected');
    if (event.event === 'admission.failed') void enqueue('admission_failed');
    if (marker.mode === 'checkpoints' && event.event === 'join.name_entry' && event.success === true) void enqueue('name_entry');
  };
  // Pinned Playwright internals; this local preload is tested against the actual bot image.
  const playwrightEntry = fs.realpathSync(require.resolve('playwright', { paths: ['/app/core/meetings/modules/join'] }));
  const corePackage = require.resolve('playwright-core/package.json', { paths: [path.dirname(playwrightEntry)] });
  const { Page } = require(path.join(path.dirname(corePackage), 'lib/client/page.js'));
  const goto = Page.prototype.goto;
  Page.prototype.goto = async function (...args) {
    if (renderingPageCreations === 0) attach(this);
    return goto.apply(this, args);
  };
  return { captureDeadline: () => enqueue('operator_deadline') };
}

module.exports = { sanitizeDocument, install };
if (module.parent?.id === 'internal/preload') {
  module.exports.captureDeadline = install().captureDeadline;
}
