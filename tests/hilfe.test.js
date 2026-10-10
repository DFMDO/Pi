// Anleitung in der Oberfläche (0.2.27): Kapitel vollständig, Verweise gültig, Suche, keine Technikfehler – und Zahlen im Text passen zum Code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATEGORIES, CHAPTERS, searchChapters } from '../admin-ui/src/pages/help-content.js';
import { TASKS } from '../hub/lib/pflege.js';

const main = readFileSync(new URL('../admin-ui/src/main.js', import.meta.url), 'utf8');
const routes = [...main.matchAll(/\['(#\/[a-z-]*)', '[^']+', '[^']+', \w+/g)].map((m) => m[1]);
const helpFor = Object.fromEntries([...(/const HELP_FOR = \{([^}]*)\}/.exec(main)?.[1] ?? '').matchAll(/'(#\/[a-z-]*)': '([a-z0-9-]+)'/g)].map((m) => [m[1], m[2]]));
const strings = (c) => [c.title, c.intro, ...(c.steps ?? []), ...(c.text ?? []), ...(c.tips ?? []), ...(c.warns ?? []), ...(c.terms ?? []).flat(), ...(c.open ?? []).flat()];

test('Anleitung: jedes Kapitel hat Kennung, Thema, Titel, Kurzsatz und Inhalt; Kennungen sind eindeutig', () => {
  const cats = new Set(CATEGORIES.map((c) => c[0])); assert.equal(cats.size, CATEGORIES.length); assert.ok(CHAPTERS.length >= 40, `genug Kapitel (${CHAPTERS.length})`);
  const ids = new Set(); for (const c of CHAPTERS) {
    assert.match(c.id, /^[a-z0-9-]+$/, c.id); assert.ok(!ids.has(c.id), `doppelte Kennung ${c.id}`); ids.add(c.id); assert.ok(cats.has(c.cat), `${c.id}: unbekanntes Thema ${c.cat}`);
    assert.ok(c.icon && c.title && c.intro, `${c.id}: Symbol, Titel und Kurzsatz`); assert.ok(c.title.length <= 70 && c.intro.length <= 110, `${c.id}: Titel/Kurzsatz zu lang`);
    assert.ok((c.steps?.length ?? 0) + (c.text?.length ?? 0) + (c.terms?.length ?? 0) > 0, `${c.id}: kein Inhalt`);
  }
  for (const [k] of CATEGORIES) assert.ok(CHAPTERS.some((c) => c.cat === k), `Thema ${k} ist leer`);
});

test('Anleitung: Verweise führen zu echten Seiten, jede Seite hat ihr Kapitel (Link „Anleitung zu dieser Seite“)', () => {
  assert.ok(routes.length >= 15 && routes.includes('#/') && routes.includes('#/regeln') && routes.includes('#/einschuebe'), `Seiten aus main.js: ${routes.join(' ')}`);
  for (const c of CHAPTERS) for (const [href, label] of c.open ?? []) { assert.ok(routes.includes(href), `${c.id}: Seite ${href} gibt es nicht`); assert.ok(label.length > 3, `${c.id}: Knopftext`); }
  const ids = new Set(CHAPTERS.map((c) => c.id));
  for (const [route, id] of Object.entries(helpFor)) assert.ok(ids.has(id) && routes.includes(route), `${route} → ${id}`);
  for (const r of routes.filter((x) => x !== '#/hilfe')) assert.ok(helpFor[r], `Seite ${r} hat noch kein Kapitel in der Anleitung`);
});

test('Anleitung: nur Klartext – kein HTML, **fett** ist immer geschlossen, keine Platzhalter und keine Adressen ins Internet', () => {
  for (const c of CHAPTERS) for (const s of strings(c)) {
    assert.ok(!/[<>]/.test(s), `${c.id}: HTML-Zeichen in „${s.slice(0, 40)}“`); assert.equal((s.match(/\*\*/g) ?? []).length % 2, 0, `${c.id}: ** nicht geschlossen in „${s.slice(0, 50)}“`);
    assert.ok(!/TODO|XXX|lorem|undefined|null/i.test(s), `${c.id}: Platzhalter in „${s.slice(0, 40)}“`); assert.ok(!/https?:\/\/(?!dfm-signage\.local)/.test(s), `${c.id}: externe Adresse`);
  }
});

test('Anleitung: Suche findet nach Titel und Inhalt, mehrere Wörter müssen alle vorkommen, Treffer im Titel zuerst', () => {
  assert.equal(searchChapters('').length, CHAPTERS.length); assert.equal(searchChapters('  ').length, CHAPTERS.length); assert.equal(searchChapters('xyzxyzxyz').length, 0);
  const regen = searchChapters('Regen').map((c) => c.id); assert.ok(regen.includes('regeln') && regen.includes('begriffe'), `Regen: ${regen.join(',')}`);
  const pw = searchChapters('passwort').map((c) => c.id); assert.ok(pw.includes('benutzer') && pw.includes('p-weg'), `Passwort: ${pw.join(',')}`);
  assert.equal(searchChapters('einschub')[0].id, 'einschuebe', 'Titel-Treffer zuerst'); assert.equal(searchChapters('tor jubel')[0].id, 'jubel'); assert.ok(searchChapters('video ruckelt').some((c) => c.id === 'p-video'));
  assert.ok(searchChapters('BILD wächter').some((c) => c.id === 'gesundheit'), 'Groß-/Kleinschreibung egal'); assert.equal(searchChapters('schwarz hdmi')[0].id, 'p-schwarz');
});

test('Anleitung: Zahlen im Text passen zum Programm (Pflege-Abstände, Bild-Wächter, Einschübe)', () => {
  const pflege = CHAPTERS.find((c) => c.id === 'pflege').steps[0]; const r = TASKS.find((t) => t.id === 'reinigung'), n = TASKS.find((t) => t.id === 'netzteil'), sd = TASKS.find((t) => t.id === 'sd');
  assert.ok(pflege.includes(`Reinigung (alle ${r.months} Monate)`) && pflege.includes(`Netzteil prüfen (${n.months} Monate)`) && pflege.includes(`SD-Karte tauschen (${sd.months} Monate)`), 'Pflege-Abstände');
  const w = readFileSync(new URL('../hub/lib/waechter.js', import.meta.url), 'utf8'); assert.match(w, /STALL_MIN_MS = 15 \* 60000/); assert.ok(CHAPTERS.find((c) => c.id === 'gesundheit').steps[1].includes('15 Minuten'));
  const e = readFileSync(new URL('../hub/lib/einschuebe.js', import.meta.url), 'utf8'); assert.match(e, /minimum: 1, maximum: 240/); assert.match(e, /minimum: 3, maximum: 120/); const ch = CHAPTERS.find((c) => c.id === 'einschuebe').steps[1]; assert.ok(ch.includes('1–240 Minuten') && ch.includes('3–120 Sekunden'));
  const l = readFileSync(new URL('../hub/lib/jubel.js', import.meta.url), 'utf8'); assert.match(l, /TOR_COOLDOWN_MS = 30000/); assert.ok(CHAPTERS.find((c) => c.id === 'jubel').tips[0].includes('30 Sekunden'));
});
