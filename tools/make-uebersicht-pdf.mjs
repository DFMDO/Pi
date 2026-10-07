// Erzeugt DFM-Signage-Uebersicht.pdf: Übersicht für Entscheider mit Screenshots, Stand, Sicherheit, Hardware, offenen Punkten und nächsten Schritten.
// Aufruf: node tools/make-screenshots.js && node tools/make-screenshots-extra.js && node tools/make-uebersicht-pdf.mjs
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';
const R = new URL('..', import.meta.url).pathname, B = R + 'docs/bilder/';
const EXE = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome'].find(existsSync);
const b64 = (buf) => 'data:image/png;base64,' + buf.toString('base64');
const img = async (f, maxH) => { if (!maxH) return b64(readFileSync(B + f)); const m = await sharp(B + f).metadata(); return b64(await sharp(B + f).extract({ left: 0, top: 0, width: m.width, height: Math.min(m.height, maxH) }).png().toBuffer()); };
const logo = b64(readFileSync(R + 'assets/dfm-logo.png'));
const datum = new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
let nr = 0; const sec = (t) => `<span class="nr">${++nr}</span>${t}`;
const shot = async (title, text, f, maxH) => `<section class="p"><h2>${title}</h2><p>${text}</p><img class="shot" src="${await img(f, maxH)}"></section>`;
const two = async (title, text, f1, f2) => `<section class="p"><h2>${title}</h2><p>${text}</p><div class="two"><img class="shot" src="${await img(f1)}"><img class="shot" src="${await img(f2)}"></div></section>`;
const divider = (t, s) => `<section class="p divider"><h1>${t}</h1><p>${s}</p></section>`;
const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
@page{size:A4 landscape;margin:11mm 12mm 13mm}
body{font-family:Inter,'DejaVu Sans',Arial,sans-serif;color:#1a1a1a;margin:0;font-size:10.5pt}
.p{box-sizing:border-box;page-break-after:always;height:180mm;display:flex;flex-direction:column;overflow:hidden}
.p:last-child{page-break-after:auto}
h1{font-size:28pt;margin:0 0 4mm} h2{font-size:16pt;margin:0 0 2mm;color:#c8102e} h3{font-size:12pt;margin:3mm 0 1.5mm}
p{margin:0 0 3mm;line-height:1.45} ul{margin:0 0 2mm 5mm;padding:0;line-height:1.5} li{margin-bottom:1mm}
.shot{max-width:100%;max-height:152mm;object-fit:contain;align-self:flex-start;border:1px solid #ccc;border-radius:2.5mm}
.cover{background:#1a1a1a;color:#fff;padding:16mm;border-radius:4mm;justify-content:center}
.cover img{height:40mm;align-self:flex-start;margin-bottom:8mm} .cover p{font-size:13pt;color:#ddd;max-width:200mm} .cover h1{color:#fff;font-size:32pt}
.divider{justify-content:center;border-left:4mm solid #c8102e;padding-left:10mm;height:150mm} .divider h1{color:#c8102e}
.two{display:flex;gap:5mm;align-items:flex-start} .two .shot{width:49%}
.phones{display:flex;gap:4mm;align-items:flex-start} .phones img{width:19%;border:1px solid #ccc;border-radius:2.5mm}
.cols{display:flex;gap:8mm} .cols>div{flex:1}
.box{border:1px solid #ddd;border-radius:2.5mm;padding:3mm 4mm;background:#fafafa}
.kpi{display:flex;gap:4mm;margin:2mm 0 4mm} .kpi div{flex:1;border-radius:2.5mm;background:#1a1a1a;color:#fff;padding:3mm 4mm} .kpi b{display:block;font-size:20pt;color:#fff} .kpi span{font-size:9pt;color:#ccc}
table{border-collapse:collapse;width:100%;font-size:9.5pt} td,th{border-bottom:1px solid #ddd;padding:1.5mm 2mm;text-align:left;vertical-align:top} th{background:#f0f0f0}
.ok{color:#2e7d32;font-weight:700} .warn{color:#b45309;font-weight:700} .no{color:#b00020;font-weight:700}
.small{font-size:8.5pt;color:#666} .nr{display:inline-block;background:#c8102e;color:#fff;border-radius:50%;width:7mm;height:7mm;text-align:center;line-height:7mm;font-size:10pt;margin-right:2mm}
.arch{display:flex;align-items:center;gap:4mm;margin:4mm 0} .node{border:2px solid #1a1a1a;border-radius:3mm;padding:3mm 4mm;text-align:center;min-width:40mm} .node.hub{background:#c8102e;color:#fff;border-color:#c8102e} .arrow{font-size:18pt;color:#888}
</style></head><body>

<section class="p cover"><img src="${logo}"><h1>DFM Signage</h1><p style="font-size:16pt;color:#fff">Digitale Bildschirme im Deutschen Fußballmuseum – zentral geplant, lokal betrieben</p>
<p>Übersicht für die Entscheidung: Was das System kann, wie es aussieht, wie sicher und robust es ist, was es braucht und was als Nächstes zu tun ist.</p><p>Version 0.2.1 · Stand ${datum}</p></section>

<section class="p"><h2>Zusammenfassung</h2>
<div class="kpi"><div><b>0 €</b><span>Lizenzkosten, keine Cloud, kein Abo</span></div><div><b>14 Tage</b><span>Inhalte laufen auch ohne Netz und ohne Hub weiter</span></div><div><b>~10 Min.</b><span>Einrichtung eines Bildschirms per QR-Code und Handy</span></div><div><b>129 / 129</b><span>automatische Tests bestanden</span></div></div>
<div class="cols"><div><h3>Was ist DFM Signage?</h3><p>Ein eigenes, lokales System für alle Bildschirme im Haus (Foyer, Kasse, Shop, Ausstellung, Café). Ein kleiner Rechner (Raspberry Pi) als zentraler „Hub“ verwaltet die Inhalte; an jedem Bildschirm steckt ein Raspberry Pi als „Player“. <b>Für den Anfang reicht ein einziger Pi, der Hub und Bildschirm zugleich ist.</b> Bedient wird alles über den Browser – vom PC, Tablet oder Handy.</p>
<h3>Warum?</h3><ul><li>Keine laufenden Kosten für Cloud-Dienste (wie Yodeck) und keine Abhängigkeit vom Internet.</li><li>Alle Daten bleiben im Haus (Datenschutz).</li><li>Bedienung für Menschen ohne Technikwissen, komplett auf Deutsch und im DFM-Design.</li></ul></div>
<div><h3>Stand heute</h3><ul><li><span class="ok">✔</span> Software vollständig entwickelt, inklusive aller Erweiterungswünsche.</li><li><span class="ok">✔</span> Fertiges SD-Karten-Image (Version 0.2.1) gebaut, signiert und automatisch geprüft (27 von 27 Prüfungen bestanden).</li><li><span class="ok">✔</span> 129 automatische Tests bestanden, darunter Tests im echten Browser.</li><li><span class="warn">▲</span> Noch <b>nicht auf echten Bildschirmen im Haus getestet</b>.</li></ul>
<h3>Empfehlung</h3><p class="box">Pilotbetrieb mit <b>einem Pi als Hub und Bildschirm zugleich</b> (z. B. im Foyer) plus 1–2 weiteren Bildschirmen (z. B. Kasse, Shop) für 2–4 Wochen. Dabei die Hardware-Abnahme (Seite „Nächste Schritte“) abarbeiten. Danach Entscheidung über den Ausbau.</p></div></div></section>

<section class="p"><h2>Das Wichtigste auf einen Blick</h2><div class="cols"><div><ul>
<li><b>Einfach:</b> SD-Karte beschreiben, einstecken, QR-Code mit dem Handy scannen – fertig. Keine Tastatur, keine Technikkenntnisse.</li>
<li><b>Planung wie im Kalender:</b> „Zeige [Inhalt] auf [Bildschirm] am [Tag] von [Zeit] bis [Zeit]“. Wiederholungen, Feiertage NRW eingebaut, Sondertage und Schließtage.</li>
<li><b>Entwurf und Veröffentlichen:</b> Änderungen werden erst sichtbar, wenn sie veröffentlicht werden – mit Zusammenfassung und Konfliktprüfung.</li>
<li><b>Live-Ansicht:</b> Von jedem Gerät sehen, was gerade auf jedem Bildschirm läuft – auch als Wandmonitor im Technikraum oder für Kasse/Info/Aufsicht.</li>
<li><b>Schnellaktionen und Szenen:</b> Ein Klick: „Jetzt auf allen Bildschirmen zeigen“ oder Szene „Eröffnung“ – danach automatisch zurück zum normalen Plan.</li></ul></div><div><ul>
<li><b>Inhalte:</b> Bilder, Videos, PDFs, Text-Ankündigungen, DFM-Vorlagen mit Lesbarkeitsprüfung, QR-Codes, Laufband, Uhr/Datum.</li>
<li><b>Betrieb:</b> Warnungen in Klartext („Netzteil zu schwach“), Wartungsmodus, WLAN-Empfang, Wochenbericht, Geräteliste als Excel.</li>
<li><b>Prüfung:</b> Jeder neue Bildschirm wird automatisch geprüft (Verbindung, WLAN, Uhrzeit, Netzteil, Video, Bild, Ton).</li>
<li><b>Sicher:</b> Verschlüsselt, Rollen und Rechte, unveränderbares Protokoll, keine Standardpasswörter, kein Fernzugang von außen.</li>
<li><b>Robust:</b> WLAN weg oder Hub aus? Die Bildschirme zeigen weiter ihre Inhalte. Nach Stromausfall startet alles von selbst.</li></ul></div></div>
<h3>So funktioniert es</h3><div class="arch"><div class="node">PC / Tablet / Handy<br><span class="small">Bedienung im Browser</span></div><span class="arrow">⇄</span><div class="node hub">Hub (Raspberry Pi 4/5)<br><span class="small" style="color:#fff">Inhalte, Kalender, Benutzer</span></div><span class="arrow">⇄</span><div class="node">Player je Bildschirm<br><span class="small">spielt Plan auch offline ab</span></div><span class="arrow">→</span><div class="node">Bildschirm (HDMI)</div></div>
<p class="small">Alles im Museumsnetz. Verbindungen zwischen Hub und Bildschirmen sind verschlüsselt und gegen fremde Geräte abgesichert (Zertifikats-Pinning).</p>
<div class="box"><b>Braucht es einen eigenen Hub-Rechner?</b> Nein, nicht zwingend. Ein Raspberry Pi 4/5 kann <b>Hub und Bildschirm zugleich</b> sein – das wird bei der Einrichtung am Handy einfach ausgewählt. Weitere Bildschirme kommen später dazu. Erst bei vielen Bildschirmen empfiehlt sich ein eigener Hub-Rechner im Technikraum (robuster, da die Zentrale dann nicht an einem Bildschirm hängt).</div></section>

${divider('Die Oberfläche', 'Echte Bildschirmfotos der Software. Hinweis: alle Bilder sind mit Beispieldaten erstellt.')}
${await shot('Anmeldung', 'Anmeldung im DFM-Design. Passwort vergessen? Zurücksetzen durch einen Admin oder mit einem Wiederherstellungscode – ohne E-Mail.', '01-anmelden.png')}
${await shot('Startseite mit Schnellaktionen', 'Auf einen Blick: Laufen alle Bildschirme? Welche Übersteuerung ist aktiv? Wie viele Entwürfe warten? Hinweise in Klartext, z. B. „Netzteil zu schwach“.', '30-startseite-schnellaktionen.png')}
${await shot('Live: Was läuft gerade?', 'Alle Bildschirme als Kacheln mit Vorschaubild, Status, aktuellem Inhalt, Restlaufzeit und „als Nächstes“. Offline-Bildschirme grau mit „zuletzt gesehen“. Filter nach Gruppe und Etage.', '31-live.png', 900)}
${await shot('Live: Einzelansicht', 'Großes Bild, Herkunft („Schnellaktion von admin, bis 12:39 Uhr“), die nächsten Elemente und Knöpfe für Neu laden, Testbild, Erkennen, Wartungsmodus und „Zurück zum normalen Plan“.', '32-live-einzelansicht.png')}
${await two('Wandmodus und Handy', 'Links: dauerhafter Monitor im Technikraum (eigenes Zugangs-Token, nur Lesen). Rechts: Live-Ansicht am Handy für Kasse, Info oder Aufsicht (Rolle „Anzeige“).', '45-wandmodus.png', '46-handy-live.png')}
${await shot('Szenen', 'Vorbereitete Szenen wie „Eröffnung“ oder „Schulklassen-Tag“ schalten mehrere Bildschirme mit einem Klick um – und wieder zurück.', '33-szenen.png', 600)}
${await shot('Kalender mit Entwürfen', 'Wochenansicht mit Farben je Bildschirm. Entwürfe sind gestrichelt und mit ✎ markiert und laufen erst nach dem Veröffentlichen. Aktive Übersteuerungen stehen oben.', '34-kalender-entwurf.png', 900)}
${await shot('Termin in einem Satz', '„Zeige [Inhalt] auf [Bildschirm] am [Datum] von [Zeit] bis [Zeit] Uhr“ – mit Vorschau „So sieht der Bildschirm dann aus“.', '09-termin-planen.png')}
${await shot('Feiertage und Sondertage', 'Feiertage NRW sind eingebaut (ohne Internet). Regeln wie „an Feiertagen diese Abspielliste“ oder „Bildschirme aus“; eigene Sondertage und Betriebsferien.', '35-feiertage.png')}
${await shot('Bilder & Videos', 'Medien hochladen, Text-Ankündigungen, DFM-Vorlagen, QR-Codes, Ordner-Import (z. B. aus Yodeck), Lizenz und Ablaufdatum.', '05-medien.png', 900)}
${await two('Vorlagen und QR-Codes', 'Links: DFM-Vorlagen (Tagesprogramm, Öffnungszeiten, Willkommen, Countdown …) mit automatischer Lesbarkeitsprüfung. Rechts: QR-Code lokal erzeugt, mit Gegenprobe und Warnungen.', '40-vorlage.png', '41-qr-code.png')}
${await shot('Abspielliste', 'Reihenfolge per Ziehen, Dauer und Übergang je Element; Speichern als Entwurf oder direkt veröffentlichen.', '07-abspielliste.png')}
${await shot('Bildschirme verwalten', 'Verbinden, Gruppen, Ausrichtung (mit 60-Sekunden-Rückfall), Ausschaltzeiten, Bildschirm ersetzen, Geräteliste als Excel.', '03-bildschirme.png', 900)}
${await shot('Neuen Bildschirm verbinden', 'Einmalcode und Startkarte – sicher, ohne Tastatur.', '04-bildschirm-verbinden.png')}
${await two('Bildschirm prüfen', 'Nach dem Verbinden startet automatisch die Prüfung. Fragen, die ein Mensch beantworten muss (Testbild ok?), erscheinen am Handy oder PC. Erst danach geht der Bildschirm in Betrieb.', '42-bildschirm-pruefen.png', '43-pruefung-bestanden.png')}
${await shot('Betrieb: Gesundheit', 'Warnungen in Klartext mit Handlungshinweis: Netzteil, Temperatur, SD-Karte, Speicher, WLAN. Wartungsmodus mit Erinnerung nach 24 Stunden.', '36-betrieb-gesundheit.png', 900)}
${await shot('Betrieb: WLAN-Empfang', 'Signalstufe, Verlauf, Wiederverbindungen, Aussetzer, Access Point – schlechtester Empfang zuerst. Aufstellmodus zeigt das Signal alle 2 Sekunden.', '37-wlan-empfang.png', 900)}
${await shot('Betrieb: Wochenbericht', 'Verfügbarkeit, Ausfälle, Neustarts und Warnungen je Bildschirm – zum Drucken oder als PDF.', '38-wochenbericht.png', 700)}
${await shot('Laufband und Zonen', 'Laufband-Meldungen mit Gültigkeit; Layouts mit Hauptbereich, Laufband, Uhr/Datum und Infospalte (nur auf leistungsfähigeren Geräten).', '39-laufband-zonen.png', 900)}
${await two('Am Bildschirm', 'Links: Bildschirm mit Laufband und Uhr. Rechts: „Diesen Bildschirm erkennen“ – Name, Ort und Nummer für 10 Sekunden groß.', '47-bildschirm-laufband.png', '48-bildschirm-erkennen.png')}
${await shot('Benutzer und Rollen', 'Admin (alles), Redakteur (Inhalte, Termine, Schnellaktionen), Anzeige (nur Live-Ansicht). Der letzte Admin ist geschützt. Wandmodus-Zugänge.', '44-benutzer-rollen.png', 900)}
${await shot('Erweitert', 'Backup, signierte Updates (auch gestaffelt: erst ein Test-Bildschirm, dann der Rest, mit automatischem Rückfall), Diagnose, Datenschutz-Einstellungen.', '11-erweitert.png', 820)}
${await two('Einrichtung am Bildschirm', 'Ein neuer Raspberry Pi zeigt nach dem Einschalten einen QR-Code. Die gesamte Einrichtung erfolgt anschließend mit dem Handy.', '20-bildschirm-schritt1.png', '21-bildschirm-schritt2.png')}
<section class="p"><h2>Einrichtung mit dem Handy</h2><p>PIN eingeben, WLAN wählen, Aufgabe festlegen, Namen vergeben – in wenigen Minuten erledigt.</p><div class="phones">${(await Promise.all(['22-handy-pin.png', '23-handy-wlan.png', '24-handy-rolle.png', '25-handy-details.png'].map((f) => img(f)))).map((s) => `<img src="${s}">`).join('')}</div></section>

${divider('Sicherheit, Betrieb, Kosten', 'Was das System absichert, was es braucht und wie es weitergeht.')}
<section class="p"><h2>Sicherheit und Datenschutz</h2><div class="cols"><div><h3>Sicherheit</h3><ul>
<li>Alles läuft <b>im Museumsnetz</b> – keine Cloud, keine Telemetrie, keine Verbindungen ins Internet.</li>
<li><b>Verschlüsselte</b> Verbindungen; Bildschirme akzeptieren nur „ihren“ Hub (Zertifikats-Pinning) – fremde Geräte werden abgewiesen.</li>
<li><b>Keine Standardpasswörter</b>, kein Fernzugang (SSH) – geprüft bei jedem Image-Bau.</li>
<li>Rollen und Rechte, Sperre nach Fehlversuchen, optional zweiter Faktor (Code aus App).</li>
<li><b>Unveränderbares Protokoll</b>: wer hat wann was getan.</li>
<li><b>Updates nur signiert</b> und vom Hub – nie aus dem Internet; automatischer Rückfall bei Problemen.</li></ul></div>
<div><h3>Datenschutz</h3><ul><li><b>Keine Besucherdaten</b>: keine Kameras, keine Mikrofone, keine Zählung, kein Tracking (auch QR-Codes ohne Kurzlinks).</li>
<li>Live-Vorschaubilder nur im Arbeitsspeicher, nur für angemeldete Nutzer, keine Aufzeichnung.</li>
<li>Einstellbare Aufbewahrung mit automatischer Löschung (Protokoll, Verlauf, Szenen-/Gruppennamen).</li>
<li>Datenschutzblatt liegt bei (<i>docs/datenschutz.md</i>).</li></ul>
<h3>Was passiert, wenn …</h3><table><tr><th>Situation</th><th>Besucher sehen</th></tr><tr><td>WLAN fällt aus</td><td>Inhalte laufen weiter, keine Fehlermeldung</td></tr><tr><td>Hub ist aus</td><td>Termine der nächsten 14 Tage laufen weiter</td></tr><tr><td>Stromausfall</td><td>Alles startet von selbst wieder</td></tr><tr><td>Hub defekt</td><td>Ersatz-Hub aus Backup in unter 15 Min.</td></tr></table></div></div></section>

<section class="p"><h2>Was gebraucht wird (Hardware und Netz)</h2><div class="box" style="margin-bottom:3mm"><b>Für den Anfang:</b> 1× Raspberry Pi 4 (2 GB+) oder Pi 5 als <b>Hub und Bildschirm in einem</b> – kein zusätzlicher Rechner nötig.</div><div class="cols"><div><h3>Eigener Hub (später, ab mehreren Bildschirmen)</h3><ul><li>Raspberry Pi 4 (mind. 2 GB) oder Pi 5</li><li><b>USB-SSD</b> statt SD-Karte (robuster)</li><li>Original-Netzteil, Gehäuse mit Kühlung</li><li>Empfohlen: kleine <b>USV</b> (Stromausfall-Puffer)</li><li>Netzwerkkabel, feste IP-Adresse</li></ul>
<h3>Je Bildschirm</h3><ul><li>Raspberry Pi 4/5 (Video, Zonen) oder Pi 3 / Zero 2 W (einfache Inhalte)</li><li><b>„High Endurance“-SD-Karte</b> (mind. 32 GB)</li><li><b>Original-Netzteil</b> – häufigste Fehlerquelle sind schwache Netzteile</li><li>Vorhandener Bildschirm mit HDMI</li></ul></div>
<div><h3>Netz (Aufgabe der IT)</h3><ul><li>Eigenes Signage-WLAN ohne Internet empfohlen</li><li>Pi 3 und Zero 2 W brauchen 2,4 GHz</li><li>Geräte dürfen sich im WLAN gegenseitig erreichen (keine Client-Isolation), mDNS nicht blockieren</li><li>Feste IP-Adresse für den Hub</li></ul>
<h3>Kosten</h3><p>Keine Lizenz- oder Abokosten. Es fallen nur Hardwarekosten an (Raspberry Pi, Netzteil, SD-Karte/SSD, ggf. USV). Die genauen Preise hängen vom Händler ab und sollten vor dem Pilot angefragt werden.</p>
<p class="small">Details: docs/hardware-empfehlung.md</p></div></div></section>

<section class="p"><h2>Technischer Stand – ehrlich</h2><div class="cols"><div><h3>Erledigt und nachgewiesen</h3><table>
<tr><td><span class="ok">✔</span></td><td>Alle Funktionen der Aufgabenstellung inklusive Erweiterung und Zusatzwünschen umgesetzt – auch der Betrieb mit nur einem Gerät (Hub + Bildschirm)</td></tr>
<tr><td><span class="ok">✔</span></td><td>129 automatische Tests bestanden (Hub, Player, Einrichtung, Browser-Tests, simulierte Bildschirme)</td></tr>
<tr><td><span class="ok">✔</span></td><td>SD-Karten-Image 0.2.1 gebaut, signiert, 27/27 Sicherheits- und Qualitätsprüfungen bestanden</td></tr>
<tr><td><span class="ok">✔</span></td><td>Live-Kachelansicht mit 10 Bildschirmen öffnet in 0,1 s (Ziel: unter 3 s)</td></tr>
<tr><td><span class="ok">✔</span></td><td>Bildschirm gilt nach höchstens 65 s ohne Meldung als „keine Verbindung“</td></tr>
<tr><td><span class="ok">✔</span></td><td>Anwender-, Technik- und Sicherheitshandbuch, Datenschutzblatt, Notfallanleitung „Hub ausgefallen“</td></tr></table></div>
<div><h3>Noch offen</h3><table>
<tr><td><span class="warn">▲</span></td><td><b>Test auf echten Geräten im Haus</b> (Pi 3, Zero 2 W, Pi 4, Pi 5): Videos ruckelfrei, Auslastung, WLAN, Ein-/Ausschalten der Bildschirme. Checkliste liegt vor.</td></tr>
<tr><td><span class="warn">▲</span></td><td>Test mit einer Person ohne Technikkenntnisse (Protokoll liegt vor)</td></tr>
<tr><td><span class="warn">▲</span></td><td>Test auf iPhone (Safari) und Android (Chrome) an echten Geräten</td></tr>
<tr><td><span class="no">–</span></td><td>Bewusst nicht umgesetzt: Grundriss-Ansicht je Etage, Foto im Geräteprofil, Fern-Einstellung der Auflösung (Ränder werden stattdessen per Sicherheitsrand gelöst)</td></tr></table>
<p class="small" style="margin-top:3mm">Software ist nie fehlerfrei: Die Tests decken viel ab, ersetzen aber nicht den Pilotbetrieb.</p></div></div></section>

<section class="p"><h2>Nächste Schritte</h2><table>
<tr><th style="width:8mm">#</th><th>Schritt</th><th>Wer</th><th>Aufwand (geschätzt)</th></tr>
<tr><td>1</td><td><b>Freigabe Pilotbetrieb</b> und Hardware bestellen (1 Pi 4/5 als Hub+Bildschirm, 1–2 weitere Player, Original-Netzteile, SD-Karten, ggf. USV)</td><td>Leitung</td><td>–</td></tr>
<tr><td>2</td><td>Netz vorbereiten: Signage-WLAN, feste IP für den Hub, mDNS erlauben</td><td>IT</td><td>ca. 1/2 Tag</td></tr>
<tr><td>3</td><td>Image auf SD-Karten schreiben, Hub und Bildschirme per QR-Code einrichten</td><td>IT / Technik</td><td>ca. 1–2 Std.</td></tr>
<tr><td>4</td><td>Hardware-Abnahme nach Checkliste (u. a. Video, WLAN, Strom, Ausfall-Szenarien)</td><td>Technik</td><td>ca. 1 Tag</td></tr>
<tr><td>5</td><td>Inhalte übernehmen (Ordner-Import), Redakteure einweisen, Test mit einer Person ohne Technikkenntnisse</td><td>Marketing / Redaktion</td><td>ca. 1 Tag</td></tr>
<tr><td>6</td><td>Pilotbetrieb 2–4 Wochen, Wochenbericht auswerten</td><td>alle</td><td>laufend</td></tr>
<tr><td>7</td><td>Entscheidung über Ausbau auf alle Bildschirme</td><td>Leitung</td><td>–</td></tr></table>
<h3>So kommt man an die Software</h3><p>Das fertige Image steht zum Download bereit: <b>github.com/DFMDO/Pi</b> → „Releases“ → <b>dfm-signage-arm64-0.2.1.img.xz</b>. Mit dem kostenlosen „Raspberry Pi Imager“ auf die SD-Karte schreiben („Eigenes Image verwenden“), einstecken, einschalten, QR-Code scannen.</p></section>
</body></html>`;
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await b.newPage(); await p.setContent(html, { waitUntil: 'load' });
await p.pdf({ path: R + 'DFM-Signage-Uebersicht.pdf', format: 'A4', landscape: true, printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:7pt;color:#888;width:100%;padding:0 12mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>DFM Signage · Übersicht · Version 0.2.1</span><span>Seite <span class="pageNumber"></span> von <span class="totalPages"></span></span></div>' });
await b.close(); console.log('PDF erstellt');
