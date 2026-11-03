#!/usr/bin/env node
/*
 * Agent House Jiaqi — local server (zero dependencies)
 *
 * Reads your coding-agent session logs on this machine and serves a live
 * pixel-art dashboard at http://localhost:4321
 *
 *   Claude Code : ~/.claude/projects/<project>/<session>.jsonl
 *   Codex CLI   : ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   GitHub PRs  : `gh pr list` (optional, needs the GitHub CLI logged in)
 *   Team        : optional — teammates share a private GitHub Gist (see README)
 *
 * Without a team gist nothing leaves your computer. Run:  node server.js
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile, exec } = require('child_process');

const ROOT = __dirname;
const HOME = os.homedir();
const expand = (p) => (p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

function readJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

const DEFAULTS = {
  port: 4321,
  owner: 'JIAQI',
  lookbackHours: 48,          // sessions older than this are ignored entirely
  idleAfterMinutes: 10,       // no activity for this long -> idle (campfire)
  graveyardAfterMinutes: 60,  // no activity for this long -> graveyard
  waitingAfterSeconds: 20,    // agent replied and stopped -> waiting for you
  sources: {
    claude: '~/.claude/projects',
    codex: '~/.codex/sessions',
    cursor: '~/.cursor/projects',
  },
  repos: [],                  // e.g. ["owner/repo"]; empty = auto-detect from agent folders
  autoDetectRepos: true,
  prRefreshSeconds: 60,
  visitorsDir: 'visitors',    // agents that can't leave local logs (e.g. Claude on claude.ai) drop a status JSON here
  openBrowser: true,
  team: {
    gistId: '',               // YOUR secret gist (you write your agents into it); empty = solo mode
    friends: [],              // your friends' gist IDs (you only read these)
    shareTasks: false,        // also share task text + last action (off = only names, rides and speed)
    syncSeconds: 30,
  },
  live: {
    enabled: false,           // publish a snapshot for the GitHub Pages live page (creates a secret gist on first run)
    pageUrl: 'https://trista1208.github.io/agent_amusement_park/',
  },
};
const cfg = Object.assign({}, DEFAULTS, readJSON(path.join(ROOT, 'config.json')) || {});
cfg.sources = Object.assign({}, DEFAULTS.sources, cfg.sources || {});
cfg.team = Object.assign({}, DEFAULTS.team, cfg.team || {});
cfg.live = Object.assign({}, DEFAULTS.live, cfg.live || {});
if (cfg.live.enabled && cfg.live.shareTasks !== false) cfg.team.shareTasks = true;   // the live page shows task text
const ME = String(cfg.owner || os.userInfo().username).toUpperCase();
if (process.env.CODEX_SESSIONS) cfg.sources.codex = process.env.CODEX_SESSIONS;
if (process.env.CLAUDE_PROJECTS) cfg.sources.claude = process.env.CLAUDE_PROJECTS;
if (process.env.CURSOR_PROJECTS) cfg.sources.cursor = process.env.CURSOR_PROJECTS;
if (process.env.LOOKBACK_HOURS) cfg.lookbackHours = Number(process.env.LOOKBACK_HOURS);
const PORT = Number(process.env.PORT || cfg.port);

/* ------------------------------------------------------------------ names */
const ADJ = ['Azure','Black','Blue','Brown','Calm','Cobalt','Copper','Cream','Crimson','Gentle','Golden','Green','Hazy','Indigo','Ivory','Jade','Lilac','Magenta','Maroon','Pearl','Pink','Plum','Proud','Quiet','Red','Rose','Ruby','Rustic','Sandy','Scarlet','Silent','Silver','Sunny','Tan','Teal','Topaz','Violet','White','Windy','Yellow'];
const NOUN = ['Compass','Wolf','Dune','Lake','Cat','Lotus','Island','Bass','Basin','Frog','Peak','Stork','Cave','Owl','Castle','Hare','Crane','Panther','Lantern','Dog','Mouse','Valley','Canyon','Sparrow','Anchor','Forest','Maple','Shore','Grove','Lark','Elm','Beacon','Condor','Pike','Orchid','Cedar','Trout','Mountain','Falcon','Fortress','Knoll','Horizon'];
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function nameFor(id) { const h = hash(id); return ADJ[h % ADJ.length] + NOUN[(h >>> 8) % NOUN.length]; }

/* ------------------------------------------------------------- file walk */
async function walk(dir, out, minMtime, depth = 0) {
  if (depth > 6) return;
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, minMtime, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try { const st = await fsp.stat(p); if (st.mtimeMs >= minMtime) out.push({ file: p, mtime: st.mtimeMs, size: st.size }); } catch {}
    }
  }
}

const parseCache = new Map(); // file -> {mtime,size,result}

async function readLines(file, size) {
  const HEAD = 96 * 1024, TAIL = 384 * 1024;
  const fh = await fsp.open(file, 'r');
  try {
    if (size <= HEAD + TAIL) {
      const buf = Buffer.alloc(size); await fh.read(buf, 0, size, 0);
      return buf.toString('utf8').split('\n');
    }
    const h = Buffer.alloc(HEAD); await fh.read(h, 0, HEAD, 0);
    const t = Buffer.alloc(TAIL); await fh.read(t, 0, TAIL, size - TAIL);
    const hl = h.toString('utf8').split('\n'); hl.pop();
    const tl = t.toString('utf8').split('\n'); tl.shift();
    return hl.concat(tl);
  } finally { await fh.close(); }
}

function safe(line) { if (!line || line[0] !== '{') return null; try { return JSON.parse(line); } catch { return null; } }
// Codex prepends "# Files mentioned by the user" blocks; keep only the actual request
const cleanAsk = (s) => { s = String(s || ''); const m = /##\s*My request for Codex:?\s*([\s\S]*)$/i.exec(s); if (m) return m[1]; if (/^#\s*(Files|Context)/i.test(s)) { const parts = s.split(/\n#{1,3}\s/); return parts[parts.length - 1]; } return s; };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const NOISE = /^(<command-|<local-command|<system-reminder|Caveat:|<environment_context|<user_instructions|# AGENTS\.md|<user_action|\[Request interrupted)/;

/* ------------------------------------------------------- claude code log */
function parseClaude(lines, fallbackId) {
  const meta = { id: fallbackId, source: 'claude' };
  const ev = [];
  let sidechainOnly = true;
  for (const line of lines) {
    const o = safe(line); if (!o) continue;
    if (o.cwd) meta.cwd = o.cwd;
    if (o.gitBranch) meta.branch = o.gitBranch;
    if (o.sessionId) meta.id = o.sessionId;
    if (o.type === 'summary' && o.summary) meta.summary = o.summary;
    if (!o.isSidechain && (o.type === 'user' || o.type === 'assistant')) sidechainOnly = false;
    const t = Date.parse(o.timestamp) || 0;
    const c = o.message && o.message.content;
    if (o.type === 'user') {
      if (typeof c === 'string') { if (!NOISE.test(c.trim())) ev.push({ t, k: 'user', text: c }); }
      else if (Array.isArray(c)) for (const it of c) {
        if (it.type === 'text' && it.text && !NOISE.test(it.text.trim())) ev.push({ t, k: 'user', text: it.text });
        else if (it.type === 'tool_result') ev.push({ t, k: 'result', err: !!it.is_error });
      }
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      for (const it of c) {
        if (it.type === 'text' && it.text && it.text.trim()) ev.push({ t, k: 'say', text: it.text });
        else if (it.type === 'tool_use') {
          const i = it.input || {};
          ev.push({ t, k: 'tool', name: it.name, cmd: i.command || '', file: i.file_path || i.notebook_path || i.path || '', desc: i.description || i.pattern || i.query || i.prompt || i.url || '' });
        }
      }
    }
  }
  meta.sidechain = sidechainOnly;
  return { meta, ev };
}

/* ------------------------------------------------------------- codex log
 * Handles both the Codex CLI and the Codex desktop app:
 *  - response_item function_call / custom_tool_call  (the model's actions)
 *  - event_msg item_completed CommandExecution / FileChange / McpToolCall …
 *  - event_msg task_started / task_complete           (is a turn running?)  */
const fromFileUrl = (u) => String(u || '').replace(/^file:\/\//, '');
function shellCmd(c) {
  if (Array.isArray(c)) { const i = c.findIndex((x) => x === '-lc' || x === '-c'); return i >= 0 ? c.slice(i + 1).join(' ') : c.join(' '); }
  return String(c || '');
}
function parseCodex(lines, fallbackId) {
  const meta = { id: fallbackId, source: 'codex', running: false };
  const ev = [], itemTools = [];
  const seenText = new Set();
  let modelTools = 0, lastStart = 0, lastDone = 0;
  const EXT = /\[external_agent_tool_call:\s*(\w+)\]([\s\S]*?)(?:\[\/external_agent_tool_call\]|$)/g;
  const extTools = (t, text) => {
    let m; EXT.lastIndex = 0;
    while ((m = EXT.exec(text))) {
      const kind = m[1], body = m[2] || '';
      const cmd = (/command:\s*([^\n]+)/.exec(body) || [])[1] || '';
      const p = (/"(?:path|target_file|target_directory)"\s*:\s*"([^"]+)"/.exec(body) || [])[1] || '';
      const d = (/description:\s*([^\n]+)/.exec(body) || [])[1] || '';
      const name = /Shell|Terminal/i.test(kind) ? 'Bash' : /StrReplace|Write|Edit|Delete/i.test(kind) ? 'Edit' : /Read/i.test(kind) ? 'Read' : /Glob|Grep|Search/i.test(kind) ? 'Grep' : /Web/i.test(kind) ? 'Web' : kind;
      itemTools.push({ t, k: 'tool', name, cmd: cmd || d, file: p, desc: d || p });
    }
    return String(text).replace(EXT, '').trim();
  };
  const say = (t, k, text) => {
    if (k === 'say' && text && text.includes('[external_agent_tool_call')) text = extTools(t, text); const key = k + '|' + String(text).slice(0, 200); if (!text || seenText.has(key)) return; seenText.add(key); ev.push({ t, k, text }); };
  for (const line of lines) {
    const o = safe(line); if (!o) continue;
    const p = o.payload || {};
    const t = Date.parse(o.timestamp) || 0;
    if (o.type === 'session_meta') {
      meta.id = p.id || p.session_id || meta.id; meta.cwd = p.cwd || meta.cwd; meta.originator = p.originator;
      if (p.git && p.git.branch) meta.branch = p.git.branch;
    } else if (o.type === 'turn_context' && p.cwd) meta.cwd = p.cwd;
    else if (o.type === 'event_msg') {
      if (p.type === 'user_message' && p.message && !NOISE.test(p.message.trim())) say(t, 'user', cleanAsk(p.message));
      else if (p.type === 'agent_message' && p.message) say(t, 'say', p.message);
      else if (p.type === 'task_started') { lastStart = t; ev.push({ t, k: 'start' }); }
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') { lastDone = t; ev.push({ t, k: 'done' }); }
      else if (p.type === 'item_completed' && p.item) {
        const it = p.item;
        if (it.type === 'UserMessage') { const txt = (it.content || []).map((c) => c.text || '').join(' ').trim(); if (txt && !NOISE.test(txt) && !/^<external_links>/.test(txt)) say(t, 'user', cleanAsk(txt)); }
        else if (it.type === 'AgentMessage') { const txt = (it.content || []).map((c) => c.text || '').join(' ').trim(); if (txt) say(t, 'say', txt); }
        else if (it.type === 'CommandExecution') { itemTools.push({ t, k: 'tool', name: 'Bash', cmd: shellCmd(it.command), file: '', desc: '' }); if (it.cwd && !meta.cwd) meta.cwd = fromFileUrl(it.cwd); if (typeof it.exit_code === 'number' && it.exit_code !== 0) itemTools.push({ t, k: 'result', err: true }); }
        else if (it.type === 'FileChange') for (const f of Object.keys(it.changes || {})) ev.push({ t, k: 'tool', name: 'Edit', cmd: '', file: f, desc: '', fileOnly: true });
        else if (it.type === 'McpToolCall') itemTools.push({ t, k: 'tool', name: 'mcp', cmd: '', file: '', desc: [it.server, it.tool].filter(Boolean).join('.') });
        else if (it.type === 'Extension') itemTools.push({ t, k: 'tool', name: 'Web', cmd: '', file: '', desc: it.query || it.kind || '' });
        else if (it.type === 'ImageView') itemTools.push({ t, k: 'tool', name: 'Read', cmd: '', file: fromFileUrl(it.path), desc: '' });
      }
    } else if (o.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        modelTools++;
        let args = {}; try { args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.arguments || p.action || {}); } catch {}
        let name = p.name || 'shell', cmd = '', file = '', desc = '';
        if (name === 'apply_patch' || (typeof p.input === 'string' && /\*\*\* (Update|Add) File:/.test(p.input))) {
          const m = /\*\*\* (?:Update|Add) File: (.+)/.exec(p.input || args.input || ''); name = 'Edit'; file = m ? m[1].trim() : '';
        } else if (/^(shell|exec_command|local_shell)$/.test(name) || p.type === 'local_shell_call') { name = 'Bash'; cmd = shellCmd(args.command || args.cmd || (p.action && p.action.command)); }
        else if (name === 'exec' || name === 'js') {
          const code = String(p.input || args.code || args.input || '');
          desc = code.slice(0, 600); name = 'Script';
          const pm = /\*\*\* (?:Update|Add) File: (.+)/.exec(code); if (pm) { name = 'Edit'; file = pm[1].trim(); }
        }
        else if (name === 'view_image') { name = 'Read'; file = args.path || ''; }
        else desc = name;
        ev.push({ t, k: 'tool', name, cmd, file, desc });
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '');
        ev.push({ t, k: 'result', err: /"exit_code":\s*[1-9]|Exit code: [1-9]|Process exited with code [1-9]/.test(out) });
      }
    }
  }
  // Sessions imported into the desktop app only carry item_completed tools.
  if (!modelTools) ev.push(...itemTools);
  ev.sort((a, b) => a.t - b.t);
  meta.running = lastStart > lastDone;
  meta.turnDone = lastDone > 0 && lastDone >= lastStart;
  return { meta, ev };
}

/* ------------------------------------------------------------ cursor log
 * ~/.cursor/projects/<Users-me-Desktop-proj>/agent-transcripts/<id>/<id>.jsonl
 * Lines: {role:'user'|'assistant', message:{content:[text|tool_use]}} and {type:'turn_ended'}.
 * No per-line timestamps, so timing comes from the file's mtime and growth.  */
function parseCursor(lines, fallbackId, mtime) {
  const meta = { id: 'cursor-' + fallbackId, source: 'cursor', running: false, turnDone: false };
  const ev = [];
  let started = 0;
  for (const line of lines) {
    const o = safe(line); if (!o) continue;
    if (o.type === 'turn_ended') { meta.turnDone = true; meta.running = false; ev.push({ t: 0, k: 'done' }); continue; }
    const c = o.message && o.message.content; if (!Array.isArray(c)) continue;
    if (o.role === 'user') {
      meta.turnDone = false; meta.running = true;
      for (const it of c) if (it.type === 'text' && it.text) {
        const ts = /<timestamp>([^<]+)<\/timestamp>/.exec(it.text);
        if (ts && !started) { const d = Date.parse(ts[1].replace(/^\w+,\s*/, '').replace(/\s*\(UTC([+-]\d+)\)/, ' GMT$1')); if (d) started = d; }
        const q = /<user_query>([\s\S]*?)<\/user_query>/.exec(it.text);
        const txt = (q ? q[1] : it.text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')).trim();
        if (txt) ev.push({ t: 0, k: 'user', text: txt });
      }
    } else if (o.role === 'assistant') {
      for (const it of c) {
        if (it.type === 'text' && it.text && it.text.trim()) ev.push({ t: 0, k: 'say', text: it.text });
        else if (it.type === 'tool_use') {
          const i = it.input || {}, n = it.name || 'tool';
          const name = /Shell|Terminal/i.test(n) ? 'Bash' : /StrReplace|Write|Edit|Delete|ApplyPatch/i.test(n) ? 'Edit' : /Read/i.test(n) ? 'Read' : /Glob|Grep|Search|SemanticSearch/i.test(n) ? 'Grep' : /Web/i.test(n) ? 'Web' : /Task|Agent/i.test(n) ? 'Task' : n;
          ev.push({ t: 0, k: 'tool', name, cmd: i.command || '', file: i.path || i.target_file || i.file_path || '', desc: i.description || i.pattern || i.glob_pattern || i.query || i.search_term || n });
        }
      }
    }
  }
  // timestamps: everything since the last question happened "recently" (mtime), the rest at the start
  const lastUser = ev.map((e) => e.k).lastIndexOf('user');
  started = started || mtime;
  ev.forEach((e, i) => { e.t = i >= lastUser ? mtime : started; });
  if (ev.length) ev[0].t = started;
  return { meta, ev };
}
// "Users-jiaqiyu-Desktop-my-proj" -> /Users/jiaqiyu/Desktop/my-proj (checks which dashes are slashes)
const cursorDirCache = new Map();
function cursorCwd(dirName) {
  if (cursorDirCache.has(dirName)) return cursorDirCache.get(dirName);
  const parts = dirName.split('-'); let found = '';
  const dfs = (i, cur) => {
    if (found) return;
    if (i === parts.length) { if (fs.existsSync(cur)) found = cur; return; }
    if (cur && !fs.existsSync(cur)) return;
    for (let j = i + 1; j <= parts.length && !found; j++) for (const sep of ['-', ' ', '_']) { dfs(j, cur + '/' + parts.slice(i, j).join(sep)); if (found || j === i + 1) break; }
  };
  try { dfs(0, ''); } catch {}
  cursorDirCache.set(dirName, found);
  return found;
}
async function findCursorTranscripts(root, minMtime) {
  const out = [];
  let projects = [];
  try { projects = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const td = path.join(root, p.name, 'agent-transcripts');
    let ids = []; try { ids = await fsp.readdir(td, { withFileTypes: true }); } catch { continue; }
    for (const d of ids) {
      if (!d.isDirectory()) continue;
      const f = path.join(td, d.name, d.name + '.jsonl');
      try { const st = await fsp.stat(f); if (st.mtimeMs >= minMtime) out.push({ file: f, mtime: st.mtimeMs, size: st.size, src: 'cursor', projectDir: p.name }); } catch {}
    }
  }
  return out;
}
const growth = new Map(); // file -> [{at, tools}]  (pace for logs without timestamps)
function paceFromGrowth(file, tools, now) {
  const h = growth.get(file) || [];
  if (!h.length || h[h.length - 1].tools !== tools) h.push({ at: now, tools });
  while (h.length > 1 && now - h[0].at > 5 * 60 * 1000) h.shift();
  growth.set(file, h);
  return h.length > 1 ? tools - h[0].tools : 0;
}

/* Codex keeps a thread title per session id in ~/.codex/session_index.jsonl */
let titleCache = { at: 0, map: new Map() };
function codexTitles() {
  if (Date.now() - titleCache.at < 30000) return titleCache.map;
  titleCache.at = Date.now();
  const f = path.join(path.dirname(expand(cfg.sources.codex || '~/.codex/sessions')), 'session_index.jsonl');
  try {
    const map = new Map();
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) { const o = safe(l); if (o && o.id && o.thread_name) map.set(o.id, o.thread_name); }
    titleCache.map = map;
  } catch {}
  return titleCache.map;
}

/* -------------------------------------------------------- classification */
function action(e) {
  if (!e) return '';
  if (e.k === 'tool') {
    const n = e.name || 'tool';
    if (/^(Bash|shell)$/i.test(n)) return '$ ' + clip(e.cmd, 70);
    if (/Edit|Write|apply_patch/i.test(n)) return '✎ ' + (e.file ? path.basename(e.file) : n);
    if (/Read/.test(n)) return '📖 ' + (e.file ? path.basename(e.file) : 'reading');
    if (/Grep|Glob|Search/.test(n)) return '🔎 ' + clip(e.desc, 50);
    if (/Web/.test(n)) return '🌐 ' + clip(e.desc, 50);
    if (/Task|Agent/.test(n)) return '🤖 ' + clip(e.desc || 'sub-agent', 50);
    if (n === 'Script') {   // Codex desktop wraps tool calls in a small JS script
      const m = /exec_command\(\{\s*cmd:\s*(["'`])([\s\S]*?)\1/.exec(e.desc) || /exec_command\(\{\s*cmd:\s*(["'`])([\s\S]*)/.exec(e.desc);
      if (m) return '$ ' + clip(m[2].replace(/\\n/g, ' '), 66);
      const t = /tools\.([\w]+)/.exec(e.desc);
      if (t) return ({ web__run: '🌐 searching the web', view_image: '🖼 looking at an image', apply_patch: '✎ editing files' })[t[1]] || '⚙ ' + t[1].replace(/^mcp__/, '').replace(/__/g, '.');
      return '⚡ ' + clip(e.desc, 60);
    }
    if (n === 'mcp') return '🔌 ' + clip(e.desc, 50);
    if (/Todo/.test(n)) return '📝 updating plan';
    return '⚙ ' + n;
  }
  if (e.k === 'say') return '💬 ' + clip(e.text, 70);
  if (e.k === 'user') return '🗣 ' + clip(e.text, 70);
  return '';
}

function classify(meta, ev, mtime, now) {
  const lastT = Math.max(mtime, ev.length ? ev[ev.length - 1].t : 0);
  const age = (now - lastT) / 1000;
  const users = ev.filter((e) => e.k === 'user');
  const tools = ev.filter((e) => e.k === 'tool' && !e.fileOnly);
  const last = [...ev].reverse().find((e) => e.k !== 'result' && e.k !== 'start' && e.k !== 'done');
  const lastEv = [...ev].reverse().find((e) => e.k !== 'start' && e.k !== 'done');
  let status, zone;
  const turnState = (meta.source === 'codex' || meta.source === 'cursor') && (meta.running || meta.turnDone);
  if (age > cfg.graveyardAfterMinutes * 60) { status = 'dead'; zone = 'graveyard'; }
  else if (age > cfg.idleAfterMinutes * 60) { status = 'idle'; zone = 'idle'; }
  else if (turnState && meta.turnDone) { status = 'waiting'; zone = 'waiting'; }       // Codex finished its turn -> your move
  else if (!turnState && last && last.k === 'say' && age > cfg.waitingAfterSeconds) { status = 'waiting'; zone = 'waiting'; }
  else if (lastEv && lastEv.k === 'tool' && age > 180) { status = 'waiting'; zone = 'waiting'; }
  else if (meta.source === 'cursor' && age > 120) { status = 'waiting'; zone = 'waiting'; }  // transcript stopped growing // probably a permission prompt
  else {
    status = 'working';
    const lastUserIdx = ev.map((e) => e.k).lastIndexOf('user');
    const recent = ev.slice(Math.max(0, lastUserIdx)).filter((e) => e.k === 'tool').slice(-8);
    const cmds = recent.map((e) => e.cmd || '').join('\n');
    const edits = recent.some((e) => /Edit|Write|apply_patch/i.test(e.name));
    const errs = ev.slice(-12).filter((e) => e.k === 'result' && e.err).length;
    const lastUser = users.length ? users[users.length - 1].text : '';
    if (/gh pr merge|git merge\b|git rebase|git cherry-pick|git push/.test(cmds)) zone = 'merging';
    else if (/gh pr (review|diff|view|checks|comment)|gh api .*pulls|git diff|git show|git log/.test(cmds) && !edits) zone = 'reviewing';
    else if (/\breview\b/i.test(lastUser) && !edits) zone = 'reviewing';
    else if (users.length <= 1 && tools.length < 4) zone = 'newtask';
    else if (errs >= 2 || /\b(bug|fix|error|broken|crash|fail(?:s|ing|ed)?|traceback|exception)\b/i.test(lastUser) || /\b(pytest|jest|vitest|mocha|go test|cargo test|npm (run )?test)\b/.test(cmds)) zone = 'fixing';
    else zone = 'building';
  }
  return { status, zone, lastT };
}

/* --------------------------------------------------------- build agents */
async function scanAgents() {
  const now = Date.now();
  const minMtime = now - cfg.lookbackHours * 3600 * 1000;
  const files = [];
  const roots = [];
  if (cfg.sources.claude) roots.push(['claude', expand(cfg.sources.claude)]);
  if (cfg.sources.codex) roots.push(['codex', expand(cfg.sources.codex)]);
  for (const [src, dir] of roots) { const out = []; await walk(dir, out, minMtime); out.forEach((f) => (f.src = src)); files.push(...out); }
  if (cfg.sources.cursor) files.push(...await findCursorTranscripts(expand(cfg.sources.cursor), minMtime));

  const agents = [];
  const now5 = now - 5 * 60 * 1000;
  for (const f of files) {
    let parsed;
    const c = parseCache.get(f.file);
    if (c && c.mtime === f.mtime && c.size === f.size) parsed = c.result;
    else {
      try {
        const lines = await readLines(f.file, f.size);
        const id = path.basename(f.file, '.jsonl');
        parsed = f.src === 'claude' ? parseClaude(lines, id) : f.src === 'cursor' ? parseCursor(lines, id, f.mtime) : parseCodex(lines, id);
        if (f.src === 'cursor') parsed.meta.cwd = cursorCwd(f.projectDir);
      } catch { continue; }
      parseCache.set(f.file, { mtime: f.mtime, size: f.size, result: parsed });
    }
    const { meta, ev } = parsed;
    if (meta.sidechain && f.src === 'claude' && /agent-/.test(path.basename(f.file))) continue; // sub-agent transcripts
    if (!ev.length) continue;
    const { status, zone, lastT } = classify(meta, ev, f.mtime, now);
    const users = ev.filter((e) => e.k === 'user');
    const tools = ev.filter((e) => e.k === 'tool' && !e.fileOnly);
    const lastAct = [...ev].reverse().find((e) => e.k === 'tool' || e.k === 'say');
    const edited = [];
    for (let i = ev.length - 1; i >= 0 && edited.length < 8; i--) {
      const e = ev[i];
      if (e.k === 'tool' && e.file && /Edit|Write|apply_patch|MultiEdit/i.test(e.name) && !edited.find((x) => x.file === e.file)) edited.push({ file: e.file, t: e.t });
    }
    const project = meta.cwd ? path.basename(meta.cwd) : f.src === 'cursor' ? f.projectDir.replace(/^Users-[^-]+-(Desktop-|Documents-|Downloads-)?/, '') : (f.src === 'claude' ? path.basename(path.dirname(f.file)).replace(/^-+/, '').split('-').pop() : 'unknown');
    agents.push({
      id: meta.id || f.file,
      name: nameFor(meta.id || f.file),
      owner: ME, mine: true,
      source: f.src,
      project,
      cwd: meta.cwd || '',
      branch: meta.branch || '',
      status, zone,
      task: clip(meta.summary || (f.src === 'codex' && codexTitles().get(meta.id)) || (users[0] && users[0].text) || '', 220),
      lastUser: clip(users.length ? users[users.length - 1].text : '', 220),
      lastAction: action(lastAct),
      startedAt: ev[0].t || f.mtime,
      lastAt: lastT,
      toolCount: tools.length,
      pace: f.src === 'cursor' ? paceFromGrowth(f.file, tools.length, now) : tools.filter((e) => e.t >= now5).length, // actions in the last 5 minutes -> ride speed
      level: Math.max(1, Math.floor(Math.log2(tools.length + 1))),
      edited,
      recent: ev.filter((e) => e.k === 'tool' || e.k === 'say' || e.k === 'user').slice(-14).map((e) => ({ t: e.t, k: e.k, text: action(e) })),
      chat: ev.filter((e) => e.k === 'user' || e.k === 'say').slice(-6).map((e) => ({ t: e.t, k: e.k, text: clip(e.text, 240) })),
      prs: [],
    });
  }
  agents.push(...readVisitors(now));
  agents.sort((a, b) => b.lastAt - a.lastAt);
  return agents;
}

/* --------------------------------------------------------------- visitors
 * Any agent can show up by writing  visitors/<id>.json :
 *   { "name": "Claude", "source": "claude-cloud", "project": "agent-park",
 *     "status": "working" | "waiting" | "done", "zone": "building|fixing|reviewing|merging|newtask",
 *     "task": "...", "lastAction": "...", "pace": 10, "updatedAt": <ms or ISO> }
 * It ages exactly like a local session: quiet 10 min -> idle, 60 min -> haunted house. */
function readVisitors(now) {
  const dir = path.resolve(ROOT, expand(cfg.visitorsDir || 'visitors'));
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const v = readJSON(path.join(dir, n)); if (!v) continue;
    const lastAt = typeof v.updatedAt === 'number' ? v.updatedAt : Date.parse(v.updatedAt) || fs.statSync(path.join(dir, n)).mtimeMs;
    const age = (now - lastAt) / 1000;
    let status = v.status === 'done' ? 'waiting' : (v.status || 'working'), zone = v.zone || 'building';
    if (age > cfg.graveyardAfterMinutes * 60) { status = 'dead'; zone = 'graveyard'; }
    else if (age > cfg.idleAfterMinutes * 60) { status = 'idle'; zone = 'idle'; }
    else if (status === 'waiting') zone = 'waiting';
    else if (status === 'working' && age > 300) { status = 'waiting'; zone = 'waiting'; } // no heartbeat for 5 min
    const id = 'visitor:' + n.replace(/\.json$/, '');
    out.push({
      id, name: clip(v.name || nameFor(id), 24), owner: ME, mine: true, source: v.source || 'visitor',
      project: clip(v.project || 'visitor', 24), cwd: '', branch: v.branch || '', status, zone,
      task: clip(v.task || '', 220), lastUser: clip(v.task || '', 220), lastAction: clip(v.lastAction || '', 90),
      startedAt: typeof v.startedAt === 'number' ? v.startedAt : Date.parse(v.startedAt) || lastAt,
      lastAt, toolCount: Number(v.toolCount) || 0, pace: status === 'working' ? Math.max(0, Number(v.pace) || 0) : 0,
      level: Math.max(1, Math.floor(Math.log2((Number(v.toolCount) || 0) + 1))), edited: [],
      recent: Array.isArray(v.recent) ? v.recent.slice(-10).map((r) => ({ t: Date.parse(r.t) || r.t || lastAt, k: 'tool', text: clip(r.text || r, 90) })) : [],
      chat: v.message ? [{ t: lastAt, k: 'say', text: clip(v.message, 240) }] : [], prs: [],
    });
  }
  return out;
}

/* ----------------------------------------------------------------- PRs */
let prCache = { at: 0, prs: [], error: null };
function run(cmd, args, cwd) {
  return new Promise((res) => execFile(cmd, args, { cwd, timeout: 15000, maxBuffer: 4 << 20 }, (err, out) => res(err ? null : out)));
}
async function refreshPRs(agents) {
  if (Date.now() - prCache.at < cfg.prRefreshSeconds * 1000) return prCache;
  prCache.at = Date.now();
  const targets = [];
  for (const r of cfg.repos || []) targets.push({ repo: r });
  if (cfg.autoDetectRepos) {
    const cwds = [...new Set(agents.filter((a) => a.status !== 'dead' && a.cwd).map((a) => a.cwd))].slice(0, 8);
    for (const cwd of cwds) if (fs.existsSync(path.join(cwd, '.git')) || fs.existsSync(cwd)) targets.push({ cwd });
  }
  const fields = 'number,title,url,isDraft,reviewDecision,mergeable,statusCheckRollup,headRefName,updatedAt,author';
  const seen = new Map();
  let anyOk = false;
  for (const tg of targets) {
    const args = ['pr', 'list', '--state', 'open', '--limit', '25', '--json', fields];
    if (tg.repo) args.push('-R', tg.repo);
    const out = await run('gh', args, tg.cwd || ROOT);
    if (!out) continue;
    anyOk = true;
    let list; try { list = JSON.parse(out); } catch { continue; }
    for (const p of list) {
      if (seen.has(p.url)) continue;
      const roll = p.statusCheckRollup || [];
      let ci = null;
      if (roll.length) {
        const st = roll.map((r) => (r.conclusion || r.state || r.status || '').toUpperCase());
        ci = st.some((s) => /FAIL|ERROR|CANCEL|TIMED/.test(s)) ? 'fail' : st.some((s) => /PENDING|QUEUED|IN_PROGRESS|EXPECTED|^$/.test(s)) ? 'pending' : 'pass';
      }
      seen.set(p.url, {
        number: p.number, title: p.title, url: p.url, draft: p.isDraft, branch: p.headRefName,
        review: p.reviewDecision || 'REVIEW_REQUIRED', conflict: p.mergeable === 'CONFLICTING', ci,
        updatedAt: Date.parse(p.updatedAt) || 0, author: p.author && p.author.login,
        repo: (/github\.com\/([^/]+\/[^/]+)\//.exec(p.url) || [])[1] || '',
      });
    }
  }
  prCache.prs = [...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  prCache.error = targets.length && !anyOk ? 'gh unavailable or not logged in' : null;
  return prCache;
}

/* ------------------------------------------------------------- team sync
 * Everyone on the team points their config at the same private gist.
 * Each Agent House writes <OWNER>.json into it and reads everybody else's.
 * GitHub (via your logged-in `gh`) is the only thing in the middle.        */
let team = { at: 0, members: [], error: null, pushedAt: 0 };
function ghJSON(args, input) {
  return new Promise((res) => {
    const p = execFile('gh', args, { timeout: 20000, maxBuffer: 16 << 20 }, (err, out, errOut) => {
      if (err) return res({ error: String(errOut || err.message).trim().split('\n')[0] });
      try { res({ data: out ? JSON.parse(out) : null }); } catch { res({ data: null }); }
    });
    if (input != null) { p.stdin.write(input); p.stdin.end(); }
  });
}
function publicAgent(a) {
  const keep = { id: a.id, name: a.name, source: a.source, project: a.project, branch: a.branch, status: a.status, zone: a.zone,
    startedAt: a.startedAt, lastAt: a.lastAt, toolCount: a.toolCount, pace: a.pace, level: a.level, prs: a.prs };
  if (cfg.team.shareTasks) Object.assign(keep, { task: a.task, lastUser: a.lastUser, lastAction: a.lastAction, recent: (a.recent || []).slice(-8), chat: (a.chat || []).slice(-3) });
  return keep;
}
let creatingGist = null;
async function ensureLiveGist() {
  if (!cfg.live.enabled || cfg.team.gistId) return;
  if (creatingGist) return creatingGist;
  creatingGist = (async () => {
    const tmp = path.join(os.tmpdir(), 'agent-park-README.md');
    fs.writeFileSync(tmp, `Live snapshot for Agent Amusement Park (${cfg.live.pageUrl}). Written by node server.js every ${cfg.team.syncSeconds}s.\n`);
    const out = await run('gh', ['gist', 'create', '-d', 'Agent Amusement Park live snapshot', tmp], ROOT);
    const m = /gist\.github\.com\/[^/\s]+\/([0-9a-f]+)/.exec(out || '');
    if (!m) { team.error = 'could not create the live gist — is the GitHub CLI installed and logged in? (brew install gh; gh auth login)'; creatingGist = null; return; }
    cfg.team.gistId = m[1];
    const file = path.join(ROOT, 'config.json'), cur = readJSON(file) || {};
    cur.team = Object.assign({}, cur.team || {}, { gistId: m[1] });
    fs.writeFileSync(file, JSON.stringify(cur, null, 2));
    console.log(`\n  📡  Live page: ${cfg.live.pageUrl}?gist=${m[1]}\n      (gist id saved to config.json)\n`);
  })();
  return creatingGist;
}
async function syncTeam(agents, prs) {
  await ensureLiveGist();
  const id = cfg.team.gistId;
  const friends = (cfg.team.friends || []).filter(Boolean);
  if (!id && !friends.length) return team;
  if (Date.now() - team.at < cfg.team.syncSeconds * 1000) return team;
  team.at = Date.now();
  const cutoff = Date.now() - 12 * 3600 * 1000;
  const mine = {
    owner: ME, updatedAt: Date.now(), app: 'agent-house',
    agents: agents.filter((a) => a.status !== 'dead' || a.lastAt > cutoff).slice(0, 60).map(publicAgent),
    prs: prs.slice(0, 30).map(({ number, title, url, draft, ci, review, conflict, branch, repo, updatedAt }) => ({ number, title, url, draft, ci, review, conflict, branch, repo, updatedAt })),
  };
  const errors = [];
  if (id) {
    const body = JSON.stringify({ files: { [ME + '.json']: { content: JSON.stringify(mine) } } });
    const put = await ghJSON(['api', '-X', 'PATCH', `/gists/${id}`, '--input', '-'], body);
    if (put.error) errors.push('share: ' + put.error); else team.pushedAt = Date.now();
  }
  const members = [];
  for (const fid of friends) {
    const got = await ghJSON(['api', `/gists/${fid}`]);
    if (got.error || !got.data) { errors.push('friend ' + fid.slice(0, 6) + ': ' + (got.error || 'unreachable')); continue; }
  for (const [fname, f] of Object.entries(got.data.files || {})) {
    if (!fname.endsWith('.json') || fname === ME + '.json') continue;
    let d = null;
    if (f.truncated && f.raw_url) { const r = await ghJSON(['api', f.raw_url]); d = r.data; }
    else { try { d = JSON.parse(f.content); } catch {} }
    if (!d || d.app !== 'agent-house' || !Array.isArray(d.agents)) continue;
    members.push(d);
  }
  }
  team.members = members;
  team.error = errors.length ? errors.join(' · ') : null;
  return team;
}
function mergeTeam(agents, prList) {
  const owners = [ME];
  for (const m of team.members) {
    const owner = String(m.owner || '?').toUpperCase().slice(0, 12);
    owners.push(owner);
    const stale = Date.now() - (m.updatedAt || 0) > 15 * 60 * 1000; // their house is offline
    for (const a of m.agents) {
      const b = Object.assign({ task: '', lastUser: '', lastAction: '', recent: [], chat: [], edited: [], cwd: '', prs: [] }, a);
      b.id = owner + ':' + a.id; b.owner = owner; b.mine = false;
      if (stale && b.status !== 'dead') { b.status = 'idle'; b.zone = 'idle'; }
      agents.push(b);
    }
    for (const p of m.prs || []) {
      let q = prList.find((x) => x.url === p.url);
      if (!q) { q = { ...p, agents: [] }; prList.push(q); }
    }
    for (const a of m.agents) if (a.status !== 'dead' && a.branch) for (const p of prList) if (p.branch === a.branch && (a.prs || []).includes(p.number)) { const gid = owner + ':' + a.id; if (!p.agents.includes(gid)) p.agents.push(gid); }
  }
  prList.sort((a, b) => b.updatedAt - a.updatedAt);
  return owners;
}

/* ---------------------------------------------------------------- state */
async function state() {
  const agents = await scanAgents();
  const { prs, error } = await refreshPRs(agents);
  const prList = prs.map((p) => ({ ...p, agents: [] }));
  for (const a of agents) {
    if (!a.branch || a.status === 'dead') continue;
    for (const p of prList) if (p.branch === a.branch) { p.agents.push(a.id); a.prs.push(p.number); }
  }
  await syncTeam(agents, prList);
  const owners = mergeTeam(agents, prList);
  // file locks: files touched by >0 live agents in the last 30 min
  const files = new Map();
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const a of agents) {
    if (a.status === 'dead') continue;
    for (const e of a.edited || []) if (e.t >= cutoff) {
      const f = files.get(e.file) || { file: e.file, agents: [], t: 0 };
      if (!f.agents.includes(a.id)) f.agents.push(a.id);
      f.t = Math.max(f.t, e.t); files.set(e.file, f);
    }
  }
  const chat = [];
  for (const a of agents) for (const m of a.chat || []) chat.push({ t: m.t, agent: a.id, dir: m.k === 'user' ? 'in' : 'out', text: m.text });
  chat.sort((x, y) => y.t - x.t);
  return {
    mode: 'live', owner: ME, owners, now: Date.now(),
    live: cfg.live.enabled ? { pageUrl: cfg.team.gistId ? `${cfg.live.pageUrl}?gist=${cfg.team.gistId}` : '', pushedAt: team.pushedAt } : null,
    team: { enabled: !!(cfg.team.gistId || (cfg.team.friends || []).length), error: team.error, members: team.members.map((m) => ({ owner: m.owner, updatedAt: m.updatedAt })), pushedAt: team.pushedAt },
    agents, prs: prList, prError: error,
    files: [...files.values()].sort((a, b) => b.agents.length - a.agents.length || b.t - a.t),
    chat: chat.slice(0, 60),
    sources: Object.fromEntries(Object.entries(cfg.sources).map(([k, v]) => [k, v ? fs.existsSync(expand(v)) : false])),
  };
}

/* --------------------------------------------------------------- server */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/state') {
    try {
      const s = await state();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(s));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
    return;
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.join(ROOT, path.normalize(file));
  if (!full.startsWith(ROOT) || /server\.js|config\.json/.test(file)) { res.writeHead(404); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(full)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type + '; charset=utf-8' });
    res.end(buf);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const u = `http://localhost:${PORT}`;
    console.log(`\n  🎡  The park is already running at ${u} — opening it.\n      (To restart it: close the other Terminal window, or run  lsof -ti :${PORT} | xargs kill)\n`);
    if (!process.env.NO_OPEN) exec(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} ${u}`);
    process.exit(0);
  }
  throw e;
});
if (require.main !== module) { module.exports = { parseCodex, parseClaude, parseCursor, cursorCwd, classify, readLines, action, cfg }; } else server.listen(PORT, '127.0.0.1', () => {
  const u = `http://localhost:${PORT}`;
  console.log(`\n  🏡  Agent Amusement Park is open at ${u}\n`);
  for (const [k, v] of Object.entries(cfg.sources)) console.log(`      ${k.padEnd(7)} ${expand(v)} ${fs.existsSync(expand(v)) ? '✓' : '(not found)'}`);
  console.log(`      team    ${cfg.team.gistId || (cfg.team.friends || []).length ? `sharing as ${ME}${cfg.team.gistId ? ' → gist ' + cfg.team.gistId : ''} · ${(cfg.team.friends || []).length} friend(s)` : 'solo (see README → Play with friends)'}`);
  console.log('');
  if (cfg.openBrowser && !process.env.NO_OPEN) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${opener} ${u}`);
  }
});
