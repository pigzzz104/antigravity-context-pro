// Sidecar backend for the Context Usage panel & Input Box Context Ring.
//
// Forked from https://github.com/dimitr-io/antigravity-desktop-context (MIT License)
// Enhanced with:
// - Cross-platform active conversation tracking (so pinned tabs never break)
// - Native hosting of the Input Box Context Ring & Telemetry Popover injector
// - DeepSeek Harness-style per-turn call telemetry & tool token inspection

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { ACTIVE_CONV_FILE, startRingInjector } from './inject-ring.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'context_report.py');
const GEMINI_DIR = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
const CONVERSATIONS = join(GEMINI_DIR, 'antigravity', 'conversations');
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(HERE, '.data');
const CATALOG_PATH = join(DATA_DIR, 'model-catalog.json');
const CATALOG_TTL_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let latestActiveConvId = '';
let latestActiveConvAt = 0;

const app = new SidecarApp();

// --- python -------------------------------------------------------------------

const PYTHON_CANDIDATES = process.platform === 'win32'
  ? [['python', []], ['py', ['-3']], ['python3', []]]
  : [['python3', []], ['python', []]];
let python = null;

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
  });
}

async function findPython() {
  if (python) return python;
  for (const [cmd, pre] of PYTHON_CANDIDATES) {
    try {
      const out = await run(cmd, [...pre, '--version'], 5000);
      if (/^Python 3\./.test(out.trim())) {
        python = { cmd, pre };
        return python;
      }
    } catch { /* try the next candidate */ }
  }
  throw new Error('Python 3 not found. Install it from python.org and restart Antigravity.');
}

// --- live model catalog -------------------------------------------------------

let catalogFetchedAt = 0;

function lsRequest(method, body) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) return Promise.reject(new Error('no language server address'));
  const base = new URL(addr.startsWith('http') ? addr : `http://${addr}`);
  const data = JSON.stringify(body);
  const transport = base.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: base.hostname,
      port: base.port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 5000,
      rejectUnauthorized: false,
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method}: HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function refreshCatalog() {
  if (Date.now() - catalogFetchedAt < CATALOG_TTL_MS && existsSync(CATALOG_PATH)) return;
  catalogFetchedAt = Date.now();
  try {
    const resp = await lsRequest('GetAvailableModels', { metadata: { ideName: 'antigravity', extensionName: 'antigravity' } });
    const models = resp?.response?.models || resp?.models || {};
    const catalog = {};
    for (const [id, m] of Object.entries(models)) {
      const maxTokens = Number(m?.maxTokens) || 0;
      if (maxTokens > 0) catalog[id] = { maxTokens, displayName: m.displayName || '' };
    }
    if (Object.keys(catalog).length) {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(CATALOG_PATH, JSON.stringify(catalog));
    }
  } catch (err) {
    console.error('[context] model catalog unavailable, using built-in limits:', err.message);
  }
}

// --- report -------------------------------------------------------------------

const cache = new Map(); // conversationId -> { key, report }

function workspacePath(uri) {
  if (!uri || !uri.startsWith('file:')) return '';
  let p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

function fileStamp(path) {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
}

function resolveConversationId(requestedId) {
  // If an explicit conversationId was passed:
  if (UUID.test(requestedId || '')) {
    return requestedId;
  }

  // If requestedId is explicitly empty string, it means no conversation is open
  if (requestedId === '') {
    return '';
  }

  // Only fallback to latestActiveConvId if requestedId was undefined/null
  // AND latestActiveConvId is valid, recent (< 60s), and exists on disk
  if (
    latestActiveConvId &&
    Date.now() - latestActiveConvAt < 60000 &&
    UUID.test(latestActiveConvId) &&
    existsSync(join(CONVERSATIONS, `${latestActiveConvId}.db`))
  ) {
    return latestActiveConvId;
  }

  try {
    if (existsSync(ACTIVE_CONV_FILE)) {
      const st = statSync(ACTIVE_CONV_FILE);
      if (Date.now() - st.mtimeMs < 60000) {
        const activeId = readFileSync(ACTIVE_CONV_FILE, 'utf8').trim();
        if (UUID.test(activeId) && existsSync(join(CONVERSATIONS, `${activeId}.db`))) {
          return activeId;
        }
      }
    }
  } catch {}

  // Do not guess the newest DB file when no conversation is active
  return '';
}

async function report(requestedConversationId, workspaceUri) {
  const conversationId = resolveConversationId(requestedConversationId);
  if (!UUID.test(conversationId || '')) {
    return { error: 'no-conversation' };
  }
  const db = join(CONVERSATIONS, `${conversationId}.db`);
  if (!existsSync(db)) {
    return { error: 'no-database' };
  }
  await refreshCatalog();
  const workspace = workspacePath(workspaceUri);
  const key = [fileStamp(db), fileStamp(`${db}-wal`), workspace, fileStamp(CATALOG_PATH)].join('|');
  const cached = cache.get(conversationId);
  if (cached && cached.key === key) return cached.report;

  const { cmd, pre } = await findPython();
  const args = [...pre, SCRIPT, '--db', db, '--json'];
  if (existsSync(CATALOG_PATH)) args.push('--model-catalog', CATALOG_PATH);
  if (workspace) args.push('--workspace', workspace);
  const out = await run(cmd, args);
  const result = { ...JSON.parse(out), updatedAt: new Date().toISOString() };
  cache.set(conversationId, { key, report: result });
  return result;
}

app.page('/', () => new Response(readFileSync(join(HERE, 'index.html'), 'utf8'), { contentType: 'text/html' }));

app.api('/api/report', async (data) => {
  try {
    return await report(data.conversationId, data.workspace);
  } catch (err) {
    return { error: 'failed', message: err.message };
  }
}, 'GET');

app.run();
refreshCatalog();

startRingInjector({
  sidecarHosted: true,
  onActiveConversation: (id) => {
    latestActiveConvId = id || '';
    latestActiveConvAt = Date.now();
  },
  getReport: (id) => (id ? report(id, '') : null),
});
