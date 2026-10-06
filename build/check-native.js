// Prüft, dass alle nativen Module (.node) für linux/arm64 gebaut sind (ELF e_machine = 0xB7), bevor sie ins Image kommen.
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
function* walk(d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory() && !e.isSymbolicLink()) yield* walk(p); else if (e.isFile() && p.endsWith('.node')) yield p; } }
const machine = (f) => { const b = Buffer.alloc(20), fd = openSync(f, 'r'); readSync(fd, b, 0, 20, 0); closeSync(fd); return b.subarray(0, 4).toString('latin1') === '\x7fELF' ? b.readUInt16LE(18) : null; };
const root = process.argv[2]; let bad = 0, n = 0;
for (const f of walk(root)) { const m = machine(f); n++; if (m !== 0xb7) { bad++; console.error(`Falsche Architektur (e_machine=${m?.toString(16)}): ${f}`); } }
console.log(`${n} native Module geprüft, ${bad} mit falscher Architektur`); process.exit(bad || !n ? 1 : 0);
