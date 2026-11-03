// node selftest.js [file.jsonl ...] — shows how the park reads real Codex/Claude session files
const fs = require('fs'), path = require('path');
const S = require('./server.js');
(async () => {
  for (const f of process.argv.slice(2)) {
    const st = fs.statSync(f);
    const lines = await S.readLines(f, st.size);
    const isCodex = lines.slice(0, 5).some((l) => l.includes('"session_meta"'));
    const { meta, ev } = (isCodex ? S.parseCodex : S.parseClaude)(lines, path.basename(f, '.jsonl'));
    const last = ev.length ? ev[ev.length - 1].t : st.mtimeMs;
    const tools = ev.filter((e) => e.k === 'tool' && !e.fileOnly);
    const atEnd = S.classify(meta, ev, last, last + 5000);          // as if it were 5 s after the last event
    const later = S.classify(meta, ev, last, last + 15 * 60000);    // 15 min later
    console.log(`\n${path.basename(f)}\n  source=${meta.source} cwd=${meta.cwd} running=${meta.running}`);
    console.log(`  users=${ev.filter((e) => e.k === 'user').length} replies=${ev.filter((e) => e.k === 'say').length} tools=${tools.length} edits=${ev.filter((e) => e.fileOnly || /Edit/.test(e.name || '')).length}`);
    console.log(`  5s after last event -> ${atEnd.status}/${atEnd.zone}   15min later -> ${later.status}/${later.zone}`);
    console.log('  last actions:', tools.slice(-4).map(S.action));
  }
})();
