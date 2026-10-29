import { lstat, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { BrowserContext, Page } from '@vexa/remote-browser';

// Screenshot creates missing parents. Resolve components in filesystem order: a missing prefix
// followed by '..' must not hide an existing alias later in the path.
async function effectiveDestination(path: string): Promise<string> {
  const pending = path.split('/').reverse();
  let output = isAbsolute(path) ? '/' : process.cwd();
  let symlinks = 0;
  while (pending.length) {
    const part = pending.pop()!;
    if (!part || part === '.') continue;
    if (part === '..') {
      output = dirname(output);
      continue;
    }
    const next = join(output, part);
    try {
      const entry = await lstat(next);
      if (entry.isSymbolicLink()) {
        // Match Linux's symlink traversal limit, including dangling-link cycles.
        if (++symlinks > 40) throw Object.assign(new Error('checkpoint_screenshot_symlink_limit'), { code: 'ELOOP' });
        const target = await readlink(next);
        if (isAbsolute(target)) output = '/';
        const parts = target.split('/');
        for (let i = parts.length - 1; i >= 0; i--) pending.push(parts[i]);
        continue;
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    output = next;
  }
  return output;
}

/** Instance-scoped: protect this bot's pages, including contexts created after launch. */
export function installCheckpointScreenshotPolicy(context: BrowserContext): void {
  const noPixels = Buffer.alloc(0);
  const pages = new WeakSet<Page>();
  const contexts = new WeakSet<BrowserContext>();
  const protectPage = (page: Page): void => {
    if (pages.has(page)) return;
    pages.add(page);
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async options => {
      if (options?.path) {
        const output = await effectiveDestination(options.path);
        const root = await effectiveDestination('/app/storage/screenshots');
        if (output === root || output.startsWith(root + '/')) return noPixels;
      }
      return screenshot(options);
    };
  };
  const protectContext = (target: BrowserContext): void => {
    if (contexts.has(target)) return;
    contexts.add(target);
    for (const page of target.pages()) protectPage(page);
    target.on('page', protectPage);
  };
  protectContext(context);
  const browser = context.browser();
  if (!browser) return;
  for (const existing of browser.contexts()) protectContext(existing);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const target = await newContext(...args);
    protectContext(target);
    return target;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    protectContext(page.context());
    return page;
  };
}
