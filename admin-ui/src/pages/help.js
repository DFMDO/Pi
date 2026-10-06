import { h, $ } from '../ui.js';
const FAQ = [
  ['Wie verbinde ich einen neuen Bildschirm?', 'Klicke auf „Neuen Bildschirm verbinden“. Du bekommst einen Code. Schalte den Bildschirm ein, scanne den QR-Code auf dem Bildschirm mit dem Handy und gib dort den Code ein. Danach bestätigst du hier mit „Ja, das ist mein Bildschirm“.'],
  ['Wie lege ich einen Termin an?', 'Öffne den Kalender und klicke auf „Neuer Termin“ – oder ziehe direkt im Kalender über den gewünschten Zeitraum. Wähle Inhalt, Bildschirm, Datum und Uhrzeit. Mit „Vorschau ansehen“ siehst du vorher, wie es aussieht.'],
  ['Was bedeutet „Wichtigkeit“?', 'Überschneiden sich zwei Termine, gewinnt der wichtigere. Sind beide gleich wichtig, gewinnt der später gestartete. Ein Termin direkt für einen Bildschirm schlägt einen Termin für eine Gruppe.'],
  ['Was passiert, wenn das WLAN ausfällt?', 'Der Bildschirm läuft einfach weiter und zeigt die zuletzt geladenen Inhalte – auch über Stunden und Tage. Besucher bemerken nichts. Hier auf der Startseite siehst du den Ausfall sofort.'],
  ['Warum zeigt mein Browser eine Warnung?', 'Der Hub nutzt ein eigenes Sicherheitszertifikat, weil er im Museumsnetz ohne Internet läuft. Vergleiche den Fingerabdruck (Bildschirme → Hub-Adresse & Fingerabdruck) mit dem Aufdruck oder der Anzeige am Hub. Stimmt er überein, kannst du die Warnung einmalig bestätigen.'],
  ['Ich habe etwas versehentlich gelöscht.', 'Gelöschte Medien, Listen und Termine liegen 30 Tage im Papierkorb (unter „Bilder & Videos“). Dort kannst du sie wiederherstellen.'],
  ['Das WLAN-Passwort hat sich geändert.', 'Wähle beim Bildschirm „Weitere Aktionen → WLAN ändern“. Hat der Bildschirm das WLAN schon verloren, startet er nach 10 Minuten den Einrichtungsmodus: Scanne dann den QR-Code auf dem Bildschirm. Ohne Bildschirmzugriff hilft die Datei „dfm-reset-wifi“ auf der SD-Karte.'],
  ['Ein Video wird nicht abgespielt.', 'Videos werden automatisch für jeden Bildschirmtyp umgewandelt. Das kann bei langen Videos einige Minuten dauern – achte auf „Wird für die Bildschirme vorbereitet“. Schwache Bildschirme (Lite) zeigen keine Webseiten.'],
];
export async function helpPage() {
  return h('div', {}, h('h1', {}, 'Hilfe & häufige Fragen'), h('p', { class: 'lead' }, 'Alles hier funktioniert ohne Internet.'), h('p', {}, h('button', { class: 'btn big', onclick: startTour }, '▶ Zeig mir, wie das geht')),
    ...FAQ.map(([q, a]) => h('details', { class: 'card', style: 'margin:8px 0' }, h('summary', { style: 'font-weight:700;min-height:44px;cursor:pointer' }, q), h('p', {}, a))),
    h('h2', {}, 'Begriffe einfach erklärt'), h('dl', {}, ...[['Hub', 'Der Hauptrechner. Er speichert alle Inhalte und Termine.'], ['Bildschirm (Player)', 'Ein Bildschirm mit Raspberry Pi, der Inhalte zeigt.'], ['Abspielliste', 'Eine Reihenfolge von Bildern und Videos.'], ['Letzte Meldung', 'Wann sich der Bildschirm zuletzt beim Hub gemeldet hat.'], ['Bildschirm verbinden', 'Einen neuen Bildschirm sicher mit dem Hub koppeln.']].flatMap(([a, b]) => [h('dt', { style: 'font-weight:700;margin-top:8px' }, a), h('dd', { style: 'margin:0 0 4px 0' }, b)])));
}
/** Rundgang: hebt nacheinander Bereiche hervor und erklärt sie */
export function startTour() {
  const steps = [['[data-tour="#/"]', 'Auf der Startseite siehst du alle Bildschirme und ob alles läuft.'], ['[data-tour="#/medien"]', 'Hier lädst du Bilder und Videos hoch und erstellst Text-Ankündigungen.'], ['[data-tour="#/listen"]', 'Hier legst du fest, in welcher Reihenfolge Inhalte gezeigt werden.'], ['[data-tour="#/kalender"]', 'Im Kalender planst du, was wann auf welchem Bildschirm läuft.'], ['[data-tour="#/bildschirme"]', 'Hier verwaltest du die Bildschirme und verbindest neue.']];
  let i = 0, hl = null; const veil = h('div', { class: 'tour' }), box = h('div', { class: 'tourbox', role: 'dialog', 'aria-label': 'Rundgang' });
  const end = () => { hl?.classList.remove('tourhl'); veil.remove(); box.remove(); };
  const show = () => { hl?.classList.remove('tourhl'); const [sel, text] = steps[i]; hl = $(sel); hl?.classList.add('tourhl');
    box.replaceChildren(h('p', {}, h('b', {}, `Schritt ${i + 1} von ${steps.length}`)), h('p', {}, text), h('div', { class: 'row' }, h('button', { class: 'btn sec', onclick: end }, 'Beenden'), h('span', { class: 'sp' }), i ? h('button', { class: 'btn sec', onclick: () => { i--; show(); } }, 'Zurück') : null, h('button', { class: 'btn', onclick: () => { if (++i >= steps.length) end(); else show(); } }, i === steps.length - 1 ? 'Fertig' : 'Weiter'))); box.querySelector('.btn:last-child')?.focus(); };
  document.body.append(veil, box); show();
}
