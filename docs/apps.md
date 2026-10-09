# Apps: Wetter, Öffnungszeiten, Veranstaltungen, Nachrichten, Fußball, Live-Spiel, Nächster Programmpunkt

Seit Version 0.2.21 gibt es in der Verwaltung den Menüpunkt **Apps**. Der Hub holt die Daten und pflegt je App **eine Textfolie** („App: Wetter“ usw., Ordner „Apps“ unter „Bilder & Videos“). Du legst diese Folie wie jede andere in eine Abspielliste. Die Bildschirme zeigen nur die fertige Folie – sie brauchen kein Internet und laufen weiter, wenn der Abruf einmal ausfällt (die letzte Folie bleibt stehen).

**Alle Apps sind standardmäßig aus.** Nur ein Admin schaltet sie ein. Der Hub ruft nur die genannten Adressen ab (Zeitlimit 10 s, Größenlimit, keine Adressen auf den Hub selbst), und nur wenn sich der Inhalt ändert, wird die Folie neu erzeugt.

| App | Quelle | Aktualisierung | Einstellungen |
|---|---|---|---|
| ⛅ Wetter | Deutscher Wetterdienst über api.brightsky.dev | 30 Min. | Ort, Koordinaten (Voreinstellung Dortmund) |
| 🕘 Datum & Öffnungszeiten | keine (lokal) | 10 Min., täglich neu | Öffnungszeiten je Wochentag, geschlossene Tage, letzter Einlass |
| 📅 Tagesprogramm | eure Kalender-Adresse (iCal/.ics) | 15 Min., täglich neu | Adresse, Überschrift, Filter nach Ort, Höchstzahl |
| 📜 An diesem Tag | keine (lokal) | 30 Min., täglich neu | Eure Liste „TT.MM.JJJJ Text“ (Beispiele sind enthalten, bitte prüfen); ist heute nichts eingetragen, erscheint der nächste Eintrag |
| 📰 Nachrichten | RSS-/Atom-Adresse eurer Wahl | 15 Min. | Adresse, Überschrift, Anzahl |
| ⚽ Fußball-Spieltag | api.openligadb.de | 10 Min. | Liga (Bundesliga, 2. Liga, 3. Liga, DFB-Pokal), Verein mit ★ |
| 🏟️ Live-Spiel & Tor-Jubel (0.2.24) | api.openligadb.de | rund um das Spiel jede Minute, bis 3 Std. vorher alle 5 Min., sonst 15 Min. | Liga, Verein, Tor-Jubel an/aus, Sekunden (5–60), Bereich (alle oder eine Gruppe) |
| ⏱️ Nächster Programmpunkt (0.2.24) | eure Kalender-Adresse (leer = die des Tagesprogramms) | jede Minute neu gerechnet, Kalender höchstens alle 5 Min. geholt | Überschrift, Räume (je Raum eine Folie), Anzahl |

## Live-Spiel, Tor-Jubel und Regeln (0.2.24)
- **Zustand statt nur Text:** Jede App kann neben der Folie ein kleines Ergebnis speichern (Tabelle `apps`, Spalte `state_json`): das Wetter (Temperatur, Regen jetzt/in 3 Stunden) und das Spiel (Anstoß, Stand, Tore mit „wer hat getroffen“). Daraus werten die **Regeln** (`hub/lib/rules.js`) und der **Tor-Jubel** (`hub/lib/jubel.js`) aus.
- **Tor-Jubel:** Beim ersten Sehen eines Spiels gilt der Stand als bekannt (kein Jubel für alte Tore). Ein Tor zählt, wenn seine Nummer höher ist als die zuletzt gemeldete **und** der Stand des Lieblingsvereins gestiegen ist (auch Eigentore des Gegners). Sperrzeit 30 s je Spiel; kein Jubel bei Notfall-Meldung, beim Teilen eines Bildschirms oder wenn das Spiel beendet ist. Der Jubel ist eine **kurze Übersteuerung der Art „tor“** mit einer einzigen, vorab geladenen Folie (Einstellung `live.torMediaId`, Vorlage `tor`).
- **Mehrere Folien:** Apps wie „Nächster Programmpunkt“ legen je Schlüssel (Raum) eine eigene Folie an (Tabelle `app_slides`, Name „App: <Titel> – <Raum>“). Entfernte Einträge werden auf „nicht mehr eingerichtet“ gesetzt, nicht gelöscht (sie können in Listen stehen).
- **Abrufabstand dynamisch:** `dynamicInterval` (Live-Spiel) – nach einem Fehler wird nach höchstens 5 Minuten erneut versucht.
- Schlägt die Folgeaktion nach einem erfolgreichen Abruf fehl (Jubel/Regeln), erscheint das als Fehlermeldung an der App; die Folie selbst wird trotzdem aktualisiert.

## Voraussetzungen
- Der **Hub** braucht für Wetter, Fußball, Nachrichten und Kalender Zugang zum Internet bzw. zum Kalenderserver (DNS und HTTPS ausgehend). Das prüft „Betrieb → Verbindung“.
- Das Image muss mindestens Version 0.2.19 sein (DNS-Korrektur).

## Kalender (Tagesprogramm)
Unterstützt: Termine mit Zeitzone, UTC, ganztägig, Wiederholungen (täglich, wöchentlich mit Wochentagen, monatlich, jährlich, mit Intervall, COUNT und UNTIL), Ausnahmen (EXDATE), verschobene Einzeltermine, abgesagte Termine (werden nicht gezeigt). Nicht unterstützt: BYSETPOS, RDATE. Die Adresse ist geheim: Redakteure sehen sie nicht.

## Grenzen
- Eine Folie fasst etwa 8 Zeilen. Längere Listen werden verkleinert (kompakt) bzw. gekürzt („… und 3 weitere“).
- **OpenLigaDB** wird von Fans gepflegt: Tore erscheinen dort oft erst nach 1–2 Minuten, die Spielminute liefert die Quelle nicht (sie wird aus der Anstoßzeit geschätzt, Halbzeit ca. Minute 46–62). Der Tor-Jubel ist daher **nicht in Echtzeit**.
- Datenquellen Dritter (DWD/Bright Sky, OpenLigaDB) können ausfallen oder ihre Bedingungen ändern; dann bleibt die letzte Folie stehen und die App zeigt „Fehler“ mit Erklärung. Nutzungsbedingungen vor dem Dauerbetrieb prüfen.
