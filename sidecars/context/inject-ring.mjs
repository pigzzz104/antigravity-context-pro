#!/usr/bin/env node
/**
 * Antigravity 2.0 Input Box Context Ring & Telemetry Popover (Minimalist Design)
 *
 * Cross-platform (macOS / Windows / Linux):
 * - Hosted natively inside the `desktop-context` sidecar (`main.mjs`) so its
 *   lifecycle is 100% bound to Antigravity 2.0 (starts on app launch, exits on quit).
 * - Can also be executed standalone (`node inject-ring.mjs`).
 * - Restrained UI: SVG stroke icons, tabular numerals, zero emojis.
 * - Injects:
 *   1. Input toolbar mini-ring (`#agy-ring-btn`) + floating telemetry popover
 *   2. Quick-launch "Context Usage" entry in the Auxiliary Pane "+ (New Tab)" view
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const TMP_DIR = os.tmpdir();
const PID_FILE = path.join(TMP_DIR, 'agy-input-ring.pid');
export const ACTIVE_CONV_FILE = path.join(TMP_DIR, 'agy-active-conversation.id');

const DEVTOOLS_PORT_FILE =
  process.platform === 'darwin'
    ? path.join(HOME, 'Library/Application Support/Antigravity/DevToolsActivePort')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(HOME, 'AppData/Roaming'), 'Antigravity/DevToolsActivePort')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Antigravity/DevToolsActivePort');

const REPORT_SCRIPT = path.join(HERE, 'context_report.py');

const PYTHON_CANDIDATES =
  process.platform === 'win32'
    ? [
        ['python', []],
        ['py', ['-3']],
        ['python3', []],
      ]
    : [
        ['python3', []],
        ['python', []],
      ];

const POLL_INTERVAL_MS = 2500;
let cdpMsgId = 1;
const activePages = new Map();
const reportCache = new Map();
let resolvedPython = null;

function execPromise(cmd, args, timeout = 8000) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  if (process.platform !== 'win32') {
    env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':');
  }
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

async function findPython() {
  if (resolvedPython) return resolvedPython;
  for (const [cmd, pre] of PYTHON_CANDIDATES) {
    try {
      const out = await execPromise(cmd, [...pre, '--version'], 4000);
      if (/^Python 3\./.test(out.trim())) {
        resolvedPython = { cmd, pre };
        return resolvedPython;
      }
    } catch {}
  }
  return null;
}

function isAntigravityAppRunning() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'], { timeout: 2500, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) {
          resolve(false);
          return;
        }
        resolve(stdout.toLowerCase().includes('antigravity.exe'));
      });
      return;
    }
    execFile('/bin/ps', ['-Ao', 'comm'], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve(false);
        return;
      }
      const running = stdout.split('\n').some((line) => {
        const s = line.trim();
        return s.endsWith('/Antigravity.app/Contents/MacOS/Antigravity') || s === 'antigravity';
      });
      resolve(running);
    });
  });
}

function readDevToolsPort() {
  if (!fs.existsSync(DEVTOOLS_PORT_FILE)) return null;
  try {
    const lines = fs.readFileSync(DEVTOOLS_PORT_FILE, 'utf8').trim().split(/\r?\n/);
    const port = Number.parseInt((lines[0] || '').trim(), 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function listTargetPages(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(1200),
    });
    const list = await res.json();
    return list.filter(
      (p) =>
        p.type === 'page' &&
        p.webSocketDebuggerUrl &&
        p.url &&
        (p.url.includes('127.0.0.1') || p.url.includes('localhost')) &&
        !p.url.includes('devtools://')
    );
  } catch {
    return null;
  }
}

async function standaloneContextReport(conversationId) {
  if (!fs.existsSync(REPORT_SCRIPT)) return null;
  if (!conversationId || !/^[0-9a-f-]{36}$/i.test(conversationId)) return null;
  const cacheKey = conversationId;
  const cached = reportCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 2000) {
    return cached.report;
  }
  const py = await findPython();
  if (!py) return null;

  const args = [...py.pre, REPORT_SCRIPT, '--json', '--conversation-id', conversationId];
  try {
    const stdout = await execPromise(py.cmd, args, 8000);
    const data = JSON.parse(stdout);
    reportCache.set(cacheKey, { report: data, fetchedAt: Date.now() });
    return data;
  } catch {
    return cached ? cached.report : null;
  }
}

const CLIENT_UI_SCRIPT = String.raw`
(() => {
  const RING_ID = 'agy-input-context-ring-wrap';
  const POPOVER_ID = 'agy-input-context-popover';
  const NEW_TAB_CARD_ID = 'new-tab-card-context-usage';
  const HIDE_STYLE_ID = 'agy-context-hide-styles';

  const ICONS = {
    speed: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
    ttft: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>',
    prefill: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    cache: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>',
    turn: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="m17 8-5-5-5 5"/><path d="m17 16-5 5-5-5"/></svg>',
    total: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>',
    panel: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>',
    arrow: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
    grid: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>'
  };

  function setHideStyles(hide) {
    let style = document.getElementById(HIDE_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = HIDE_STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = hide
      ? '[data-tab-id="sidecar__desktop-context/context__/"], #' + NEW_TAB_CARD_ID + ', #' + RING_ID + ' { display: none !important; }'
      : '';
  }

  function getActiveConvId() {
    try {
      if (window.__TSR_ROUTER__?.state) {
        const matches = window.__TSR_ROUTER__.state.matches || [];
        for (let i = matches.length - 1; i >= 0; i--) {
          const cid = matches[i]?.params?.cascadeId || matches[i]?.params?.conversationId;
          if (cid) return cid;
        }
        const pathname = window.__TSR_ROUTER__.state.location?.pathname || '';
        const parts = pathname.split('/');
        const idx = parts.indexOf('c');
        if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
      }
      const mainChat = document.querySelector('div:not([data-testid="conversation-row-sidebar"])[data-cascade-id]');
      if (mainChat?.getAttribute('data-cascade-id')) return mainChat.getAttribute('data-cascade-id');
      const selRow = document.querySelector('[data-selected="true"][data-cascade-id]');
      if (selRow?.getAttribute('data-cascade-id')) return selRow.getAttribute('data-cascade-id');
      const m = window.location.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) return m[0];
    } catch (_) {}
    return '';
  }

  window.__AGY_GET_CONV_ID__ = getActiveConvId;

  function getReduxStore() {
    if (window.__AGY_REDUX_STORE__) return window.__AGY_REDUX_STORE__;
    try {
      const root = document.getElementById('root') || document.body.firstElementChild;
      if (!root) return null;
      const fiberKey = Object.keys(root).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
      if (!fiberKey) return null;
      const queue = [root[fiberKey]];
      const visited = new Set();
      while (queue.length) {
        const f = queue.shift();
        if (!f || visited.has(f)) continue;
        visited.add(f);
        if (f.memoizedProps?.value?.store?.dispatch) {
          window.__AGY_REDUX_STORE__ = f.memoizedProps.value.store;
          return window.__AGY_REDUX_STORE__;
        }
        if (f.child) queue.push(f.child);
        if (f.sibling) queue.push(f.sibling);
      }
    } catch (_) {}
    return null;
  }

  function findDesktopContextSidecarUrl(store) {
    const slot = document.querySelector('[data-sidecar-id="desktop-context/context"]');
    if (slot?.getAttribute('data-sidecar-url')) {
      return slot.getAttribute('data-sidecar-url').split('&conversationId=')[0];
    }
    const iframe = document.querySelector('iframe[src*="desktop-context"]');
    if (iframe?.src) {
      return iframe.src.split('&conversationId=')[0];
    }
    try {
      const st = store?.getState?.();
      const panes = [
        ...Object.values(st?.auxPaneV2?.conversationPanes || {}),
        ...Object.values(st?.auxPaneV2?.newConversationPanes || {})
      ];
      for (const p of panes) {
        for (const t of p?.tabs || []) {
          const url = t?.content?.sidecarView?.url;
          if (url && url.includes('desktop-context')) {
            return url.split('&conversationId=')[0];
          }
        }
      }
    } catch (_) {}
    return '';
  }

  function openContextSidecar() {
    try {
      const store = getReduxStore();
      const convId = getActiveConvId();
      const search = window.__TSR_ROUTER__?.state?.location?.search || {};
      const treeId = convId
        ? { kind: 'cascadeId', cascadeId: convId }
        : search.section
          ? { kind: 'newConversation', sectionId: search.section }
          : { kind: 'home' };

      const sidecarUrl = findDesktopContextSidecarUrl(store);
      const tabId = 'sidecar__desktop-context/context__/';

      if (store && sidecarUrl) {
        store.dispatch({
          type: 'auxPaneV2/setContent',
          payload: {
            treeId,
            content: {
              type: 'sidecarView',
              sidecarView: {
                sidecarId: 'desktop-context/context',
                path: '/',
                url: sidecarUrl,
                title: 'Context Usage',
                queryParams: {}
              }
            },
            tabId,
            keepOpen: true
          }
        });
        store.dispatch({
          type: 'auxPane/setAuxPaneOpen',
          payload: { treeId, isOpen: true }
        });
        if (window.__TSR_ROUTER__?.navigate) {
          window.__TSR_ROUTER__.navigate({
            search: (prev) => ({ ...prev, tab: tabId })
          });
        }
        return;
      }

      const existingTab = document.querySelector('[data-tab-id="sidecar__desktop-context/context__/"]');
      const toggleAuxBtn = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      if (existingTab) {
        const rect = existingTab.getBoundingClientRect();
        if (rect.left >= window.innerWidth - 20 && toggleAuxBtn) {
          toggleAuxBtn.click();
        }
        existingTab.click();
        return;
      }
      if (toggleAuxBtn) toggleAuxBtn.click();
    } catch (_) {}
  }

  window.__AGY_OPEN_CONTEXT_SIDECAR__ = openContextSidecar;

  function ensureAuxNewTabEntry() {
    const newTabView = document.querySelector('[data-testid="aux-pane-new-tab-view"]');
    if (!newTabView) return;
    let btn = document.getElementById(NEW_TAB_CARD_ID);
    if (btn) {
      btn.style.display = '';
      return;
    }

    const previewCard =
      newTabView.querySelector('[data-testid="new-tab-card-new-preview"]') ||
      newTabView.querySelector('[data-testid^="new-tab-card-"]');
    if (!previewCard || !previewCard.parentElement) return;

    btn = document.createElement('button');
    btn.id = NEW_TAB_CARD_ID;
    btn.type = 'button';
    btn.setAttribute('data-testid', NEW_TAB_CARD_ID);
    btn.className = previewCard.className;
    btn.innerHTML =
      '<span class="shrink-0 flex items-center">' +
      ICONS.grid +
      '</span><span>Context Usage</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openContextSidecar();
    });
    previewCard.parentElement.appendChild(btn);
  }

  function fmtTok(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1e6) {
      const v = n / 1e6;
      return Number.isInteger(v) ? v + 'M' : v.toFixed(1) + 'M';
    }
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  function fmtSec(ms) {
    if (!ms || ms <= 0) return '0.00s';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(2) + 's';
  }

  function findInputToolbar() {
    // 1. Locate the composer card
    const composer =
      document.querySelector('.surface-composer-card, [class*="surface-composer"]') ||
      document.querySelector('[data-testid="composer"]') ||
      document.querySelector('form:has(textarea), form:has([contenteditable])');

    // 2. Look specifically for the bottom action bar / footer inside composer
    const footer =
      composer?.querySelector('[class*="input-footer"]') ||
      document.querySelector('[class*="input-footer"]');

    if (footer) {
      // Find the primary send or cancel button (always the last button in the action footer group)
      const sendOrCancelBtn =
        footer.querySelector('button[aria-label*="Cancel"], button[aria-label*="Send"], button[aria-label*="send"], button[data-testid*="send"]') ||
        (() => {
          const btns = Array.from(footer.querySelectorAll('button:not(#agy-ring-btn):not(#agy-open-sidecar-btn)'));
          return btns.length ? btns[btns.length - 1] : null;
        })();

      if (sendOrCancelBtn && sendOrCancelBtn.parentElement) {
        return { mode: 'toolbar', container: sendOrCancelBtn.parentElement, anchorBtn: sendOrCancelBtn };
      }
    }

    // 3. Fallback: traverse upwards from textarea, strictly excluding attachment and preview buttons
    const candidates = [
      ...document.querySelectorAll('textarea'),
      ...document.querySelectorAll('[contenteditable="true"]'),
      ...document.querySelectorAll('[role="textbox"]')
    ].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 180 && rect.height > 18 && rect.bottom > window.innerHeight * 0.35;
    });

    if (!candidates.length) return null;
    const inputEl = candidates[candidates.length - 1];
    const composerCard =
      inputEl.closest('.surface-composer-card, [class*="surface-composer"], [class*="composer"], form') ||
      inputEl.parentElement?.parentElement;

    if (composerCard) {
      const validBtns = Array.from(composerCard.querySelectorAll('button:not(#agy-ring-btn):not(#agy-open-sidecar-btn)'))
        .filter((btn) => {
          const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
          const title = (btn.getAttribute('title') || '').toLowerCase();
          if (aria.includes('remove') || aria.includes('delete') || aria.includes('close') || aria.includes('clear')) return false;
          if (title.includes('remove') || title.includes('delete') || title.includes('close') || title.includes('clear')) return false;
          if (btn.closest('[class*="attachment"], [class*="preview"], [class*="thumbnail"], [class*="pill"], [class*="chip"]')) return false;
          return true;
        });

      if (validBtns.length > 0) {
        const lastBtn = validBtns[validBtns.length - 1];
        return { mode: 'toolbar', container: lastBtn.parentElement, anchorBtn: lastBtn };
      }
    }

    return { mode: 'box', container: inputEl.parentElement };
  }

  function ringColor(pct) {
    if (pct >= 80) return '#ef4444';
    if (pct >= 55) return '#f59e0b';
    return '#10b981';
  }

  const SEG_COLORS = ['#9aa0a6', '#a8c7fa', '#4c8df6', '#f9ab00', '#c58af9'];

  function ensureStyles() {
    let style = document.getElementById('agy-input-ring-styles');
    if (!style) {
      style = document.createElement('style');
      style.id = 'agy-input-ring-styles';
      document.head.appendChild(style);
    }
    style.textContent = [
      '#' + RING_ID + ' { position: relative; display: inline-flex; align-items: center; margin: 0 2px; z-index: 50; font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; }',
      '#agy-ring-btn { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 7px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--muted-foreground, #9aa0a6); font-size: 11.5px; font-weight: 500; font-variant-numeric: tabular-nums; cursor: pointer; user-select: none; transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease; }',
      '#agy-ring-btn:hover, #agy-ring-btn.active { background: rgba(128,128,128,0.1); border-color: rgba(128,128,128,0.18); color: var(--foreground, #e3e3e3); }',
      '#' + POPOVER_ID + ' { position: fixed; width: 276px; padding: 11px 13px; border-radius: 10px; background: var(--card, #1b1c1f); color: var(--foreground, #e3e3e3); border: 1px solid var(--border, rgba(128,128,128,0.22)); box-shadow: 0 10px 28px rgba(0,0,0,0.36); backdrop-filter: blur(16px); font-size: 12px; line-height: 1.35; z-index: 99999; display: none; text-align: left; }',
      '#' + POPOVER_ID + '.open { display: block; }',
      '.agy-m-row { display: grid; grid-template-columns: 15px 1fr auto; align-items: center; gap: 7px; padding: 4px 0; }',
      '.agy-m-icon { display: inline-flex; align-items: center; justify-content: center; color: var(--muted-foreground, #9aa0a6); opacity: 0.65; }',
      '.agy-m-label { color: var(--muted-foreground, #9aa0a6); font-size: 11.5px; }',
      '.agy-m-val { font-variant-numeric: tabular-nums; text-align: right; font-weight: 500; font-size: 12px; }',
      '.agy-m-sub { font-weight: 400; color: var(--muted-foreground, #9aa0a6); font-size: 11px; margin-left: 4px; }',
      '.agy-sep { height: 1px; background: var(--border, rgba(128,128,128,0.16)); margin: 6px 0; }',
      '#agy-open-sidecar-btn { width: 100%; margin-top: 6px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border, rgba(128,128,128,0.2)); background: rgba(128,128,128,0.06); color: var(--muted-foreground, #9aa0a6); font-size: 11px; font-weight: 500; display: flex; align-items: center; justify-content: space-between; cursor: pointer; transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease; }',
      '#agy-open-sidecar-btn:hover { background: rgba(128,128,128,0.14); color: var(--foreground, #e3e3e3); border-color: rgba(128,128,128,0.32); }'
    ].join('\n');
  }

  function positionPopover(btn, pop) {
    const rect = btn.getBoundingClientRect();
    const popWidth = 276;
    const left = Math.max(8, Math.min(window.innerWidth - popWidth - 8, rect.right - popWidth));
    pop.style.left = left + 'px';
    pop.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    pop.style.top = 'auto';
  }

  window.__AGY_RING_RENDER__ = function() {
    ensureStyles();

    const convId = getActiveConvId();
    const r = window.__AGY_RING_DATA__;
    const hasContext = Boolean(
      convId &&
      r &&
      !r.error &&
      (r.conversation_id === convId || !r.conversation_id) &&
      Number(r.used_tokens) > 0
    );

    setHideStyles(!hasContext);

    // If there is no active context (e.g. brand new conversation):
    if (!hasContext) {
      const wrap = document.getElementById(RING_ID);
      if (wrap) {
        wrap.style.display = 'none';
        const pop = wrap.querySelector('#' + POPOVER_ID);
        const btn = wrap.querySelector('#agy-ring-btn');
        if (pop) pop.classList.remove('open');
        if (btn) btn.classList.remove('active');
      }
      const newTabCard = document.getElementById(NEW_TAB_CARD_ID);
      if (newTabCard) newTabCard.style.display = 'none';

      document.querySelectorAll('[data-tab-id="sidecar__desktop-context/context__/"]').forEach((t) => {
        t.style.display = 'none';
      });

      // If Context Usage tab in the aux pane was open and visible, switch or close:
      const activePluginTab = document.querySelector('[data-tab-id="sidecar__desktop-context/context__/"][aria-selected="true"], [data-tab-id="sidecar__desktop-context/context__/"][data-selected="true"], [data-tab-id="sidecar__desktop-context/context__/"].bg-secondary');
      if (activePluginTab) {
        const otherTabs = Array.from(document.querySelectorAll('[data-tab-id]:not([data-tab-id="sidecar__desktop-context/context__/"])'))
          .filter((t) => t.style.display !== 'none' && t.offsetParent !== null);
        if (otherTabs.length > 0) {
          otherTabs[0].click();
        } else {
          const toggleAuxBtn = document.querySelector('[data-testid="toggle-aux-sidebar"]');
          const auxSidebar = document.querySelector('[data-testid="aux-sidebar"], [class*="aux-sidebar"]');
          if (auxSidebar && toggleAuxBtn && auxSidebar.getBoundingClientRect().width > 20) {
            toggleAuxBtn.click();
          }
        }
      }
      return;
    }

    // Context is active: show the sidebar entry and input mini-ring
    ensureAuxNewTabEntry();
    const newTabCard = document.getElementById(NEW_TAB_CARD_ID);
    if (newTabCard) newTabCard.style.display = '';

    document.querySelectorAll('[data-tab-id="sidecar__desktop-context/context__/"]').forEach((t) => {
      t.style.display = '';
    });

    const target = findInputToolbar();
    if (!target || !target.container) return;

    let wrap = document.getElementById(RING_ID);
    if (wrap && wrap.dataset.v !== '2') {
      wrap.remove();
      wrap = null;
    }
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = RING_ID;
      wrap.dataset.v = '2';
      wrap.innerHTML = [
        '<button type="button" id="agy-ring-btn">',
        '  <svg width="13" height="13" viewBox="0 0 36 36" style="transform: rotate(-90deg); flex: none;">',
        '    <circle cx="18" cy="18" r="14.5" fill="none" stroke="currentColor" stroke-opacity="0.22" stroke-width="3.4"></circle>',
        '    <circle id="agy-ring-arc" cx="18" cy="18" r="14.5" fill="none" stroke="#10b981" stroke-width="3.6" stroke-dasharray="0 100" stroke-linecap="round" pathLength="100"></circle>',
        '  </svg>',
        '  <span id="agy-ring-label">--%</span>',
        '</button>',
        '<div id="' + POPOVER_ID + '"></div>'
      ].join('');

      const btn = wrap.querySelector('#agy-ring-btn');
      const pop = wrap.querySelector('#' + POPOVER_ID);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = pop.classList.toggle('open');
        btn.classList.toggle('active', isOpen);
        if (isOpen) positionPopover(btn, pop);
      });
      pop.addEventListener('click', (e) => {
        e.stopPropagation();
        const openBtn = e.target.closest('#agy-open-sidecar-btn');
        if (openBtn) {
          pop.classList.remove('open');
          btn.classList.remove('active');
          openContextSidecar();
        }
      });
      document.addEventListener('click', () => {
        pop.classList.remove('open');
        btn.classList.remove('active');
      });
      window.addEventListener('resize', () => {
        if (pop.classList.contains('open')) positionPopover(btn, pop);
      });
    }

    wrap.style.display = 'inline-flex';

    if (!target.container.contains(wrap) || (target.anchorBtn && wrap.nextElementSibling !== target.anchorBtn)) {
      if (target.mode === 'toolbar' && target.anchorBtn) {
        target.container.insertBefore(wrap, target.anchorBtn);
      } else {
        target.container.appendChild(wrap);
      }
    }

    const btn = wrap.querySelector('#agy-ring-btn');
    const arc = wrap.querySelector('#agy-ring-arc');
    const label = wrap.querySelector('#agy-ring-label');
    const pop = wrap.querySelector('#' + POPOVER_ID);

    const pct = Number(r.used_pct) || 0;
    const color = ringColor(pct);
    const dash = Math.min(100, Math.max(1, pct));
    arc.setAttribute('stroke', color);
    arc.setAttribute('stroke-dasharray', dash + ' 100');
    label.textContent = pct.toFixed(1) + '%';

    const limit = Number(r.limit_tokens) || 1048576;
    const used = Number(r.used_tokens) || 0;
    const free = Number(r.free_tokens) || Math.max(0, limit - used);
    const budget = Number(r.request_budget_tokens) || 256000;
    const tel = r.telemetry || {};
    const cur = tel.latest || {};
    const sum = tel.summary || {};

    const segs = Array.isArray(r.grid_segments) ? r.grid_segments : [];
    const barHtml = segs
      .map((t, i) => {
        if (!t || !limit) return '';
        const w = Math.max(0.8, (t / limit) * 100);
        return '<div style="width:' + w.toFixed(2) + '%;background:' + SEG_COLORS[i] + '"></div>';
      })
      .join('');

    pop.innerHTML = [
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">',
      '  <span style="font-weight:600;font-size:12px;">' + (r.model || 'Model') + '</span>',
      '  <span style="font-variant-numeric:tabular-nums;font-size:11.5px;color:var(--muted-foreground,#9aa0a6);"><strong style="color:var(--foreground,#e3e3e3);font-weight:600;">' + fmtTok(used) + '</strong> / ' + fmtTok(limit) + ' (' + pct.toFixed(1) + '%)</span>',
      '</div>',
      '<div style="height:3px;border-radius:999px;background:rgba(128,128,128,0.18);overflow:hidden;display:flex;margin-bottom:8px;">' + barHtml + '</div>',
      '<div class="agy-m-row">',
      '  <span class="agy-m-icon">' + ICONS.speed + '</span>',
      '  <span class="agy-m-label">Output speed</span>',
      '  <span class="agy-m-val">' + (cur.output_tps || 0) + ' t/s<span class="agy-m-sub">avg ' + (sum.avg_output_tps || 0) + '</span></span>',
      '</div>',
      '<div class="agy-m-row">',
      '  <span class="agy-m-icon">' + ICONS.ttft + '</span>',
      '  <span class="agy-m-label">First token (TTFT)</span>',
      '  <span class="agy-m-val">' + fmtSec(cur.ttft_ms) + '<span class="agy-m-sub">avg ' + fmtSec(sum.avg_ttft_ms) + '</span></span>',
      '</div>',
      '<div class="agy-m-row">',
      '  <span class="agy-m-icon">' + ICONS.prefill + '</span>',
      '  <span class="agy-m-label">Prefill throughput</span>',
      '  <span class="agy-m-val">' + fmtTok(cur.prefill_tps || 0) + '/s<span class="agy-m-sub">peak ' + fmtTok(sum.peak_prefill_tps || 0) + '</span></span>',
      '</div>',
      '<div class="agy-m-row">',
      '  <span class="agy-m-icon">' + ICONS.cache + '</span>',
      '  <span class="agy-m-label">Cache hit</span>',
      '  <span class="agy-m-val">' + (cur.cache_hit_pct ?? 0) + '%<span class="agy-m-sub">' + fmtTok(cur.cache_read_tokens) + ' hit</span></span>',
      '</div>',
      '<div class="agy-m-row">',
      '  <span class="agy-m-icon">' + ICONS.turn + '</span>',
      '  <span class="agy-m-label">Last output</span>',
      '  <span class="agy-m-val">' + fmtTok(cur.output_tokens) + '<span class="agy-m-sub">think ' + fmtTok(cur.thinking_tokens) + '</span></span>',
      '</div>',
      '<div class="agy-m-row">',
      '  <span class="agy-m-icon">' + ICONS.total + '</span>',
      '  <span class="agy-m-label">Session output</span>',
      '  <span class="agy-m-val">' + fmtTok(sum.sum_output_tokens) + '<span class="agy-m-sub">' + (tel.total_calls || 0) + ' turns</span></span>',
      '</div>',
      '<div class="agy-sep"></div>',
      '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted-foreground,#9aa0a6);font-variant-numeric:tabular-nums;">',
      '  <span>Free ' + fmtTok(free) + '</span>',
      '  <span>Trim budget ' + fmtTok(budget) + '</span>',
      '</div>',
      '<button type="button" id="agy-open-sidecar-btn">',
      '  <span style="display:inline-flex;align-items:center;gap:6px;"><span class="agy-m-icon">' + ICONS.panel + '</span><span>Open Context &amp; Turn Inspector</span></span>',
      '  <span class="agy-m-icon">' + ICONS.arrow + '</span>',
      '</button>'
    ].join('');

    if (pop.classList.contains('open')) {
      positionPopover(btn, pop);
    }
  };

  if (!window.__AGY_RING_OBSERVER__) {
    window.__AGY_RING_OBSERVER__ = true;
    setInterval(() => {
      if (window.__AGY_RING_RENDER__) window.__AGY_RING_RENDER__();
    }, 800);
  }

  window.__AGY_RING_RENDER__();
  return getActiveConvId();
})();
`;

function cdpCall(ws, method, params = {}) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolve(null);
      return;
    }
    const id = ++cdpMsgId;
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      resolve(null);
    }, 2000);

    function onMsg(event) {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id === id) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMsg);
          resolve(msg.result ?? null);
        }
      } catch {}
    }

    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function connectPage(page, onAllClosed) {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        resolve(null);
      }, 2000);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        const entry = { ws, pageId: page.id };
        activePages.set(page.id, entry);
        resolve(entry);
      });

      ws.addEventListener('close', () => {
        activePages.delete(page.id);
        if (activePages.size === 0 && onAllClosed) {
          onAllClosed();
        }
      });
      ws.addEventListener('error', () => activePages.delete(page.id));
    } catch {
      resolve(null);
    }
  });
}

export function startRingInjector(options = {}) {
  const isSidecarHosted = Boolean(options.sidecarHosted);
  const getReport = options.getReport || standaloneContextReport;
  const onActiveConversation = options.onActiveConversation || null;

  let ticking = false;
  let unreachableCount = 0;

  function releaseLockAndExit(reason) {
    if (isSidecarHosted) return;
    try {
      if (fs.existsSync(PID_FILE)) {
        const current = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (current === process.pid) fs.unlinkSync(PID_FILE);
      }
    } catch {}
    for (const entry of activePages.values()) {
      try {
        entry.ws.close();
      } catch {}
    }
    console.log(`[agy-input-ring] stopped (${reason})`);
    process.exit(0);
  }

  if (!isSidecarHosted) {
    try {
      if (fs.existsSync(PID_FILE)) {
        const oldPid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (oldPid && oldPid !== process.pid) {
          try {
            process.kill(oldPid, 0);
            process.exit(0);
          } catch {}
        }
      }
      fs.writeFileSync(PID_FILE, String(process.pid));
    } catch {}
    process.on('SIGINT', () => releaseLockAndExit('SIGINT'));
    process.on('SIGTERM', () => releaseLockAndExit('SIGTERM'));
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (!isSidecarHosted) {
        const running = await isAntigravityAppRunning();
        if (!running) {
          releaseLockAndExit('Antigravity process not found');
          return;
        }
      }

      const port = readDevToolsPort();
      if (!port) return;

      const pages = await listTargetPages(port);
      if (pages === null) {
        unreachableCount += 1;
        if (!isSidecarHosted && unreachableCount >= 3 && !(await isAntigravityAppRunning())) {
          releaseLockAndExit('DevTools port closed');
          return;
        }
        return;
      }
      unreachableCount = 0;

      const seenIds = new Set(pages.map((p) => p.id));
      for (const [id, entry] of activePages.entries()) {
        if (!seenIds.has(id) || entry.ws.readyState !== WebSocket.OPEN) {
          try {
            entry.ws.close();
          } catch {}
          activePages.delete(id);
        }
      }

      for (const page of pages) {
        let entry = activePages.get(page.id);
        if (!entry) {
          entry = await connectPage(page, async () => {
            if (!isSidecarHosted && !(await isAntigravityAppRunning())) {
              releaseLockAndExit('Antigravity exited');
            }
          });
        }
        if (!entry) continue;

        const evalRes = await cdpCall(entry.ws, 'Runtime.evaluate', {
          expression: `${CLIENT_UI_SCRIPT}`,
          returnByValue: true,
        });

        const convId = evalRes?.result?.value || '';
        if (convId && /^[0-9a-f-]{36}$/i.test(convId)) {
          if (onActiveConversation) onActiveConversation(convId);
          try {
            fs.writeFileSync(ACTIVE_CONV_FILE, convId);
          } catch {}

          const report = await getReport(convId);
          if (report && !report.error && Number(report.used_tokens) > 0) {
            await cdpCall(entry.ws, 'Runtime.evaluate', {
              expression: `window.__AGY_RING_DATA__ = ${JSON.stringify(report)}; if (window.__AGY_RING_RENDER__) window.__AGY_RING_RENDER__();`,
              returnByValue: false,
            });
          } else {
            await cdpCall(entry.ws, 'Runtime.evaluate', {
              expression: `window.__AGY_RING_DATA__ = ${JSON.stringify(report || { error: 'no-context' })}; if (window.__AGY_RING_RENDER__) window.__AGY_RING_RENDER__();`,
              returnByValue: false,
            });
          }
        } else {
          // No active conversation (e.g. brand new conversation screen)
          if (onActiveConversation) onActiveConversation('');
          try {
            if (fs.existsSync(ACTIVE_CONV_FILE)) fs.unlinkSync(ACTIVE_CONV_FILE);
          } catch {}

          await cdpCall(entry.ws, 'Runtime.evaluate', {
            expression: `window.__AGY_RING_DATA__ = null; if (window.__AGY_RING_RENDER__) window.__AGY_RING_RENDER__();`,
            returnByValue: false,
          });
        }
      }
    } finally {
      ticking = false;
    }
  }

  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  startRingInjector({ sidecarHosted: false });
}
