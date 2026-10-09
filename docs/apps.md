# Apps: Wetter, Öffnungszeiten, Veranstaltungen, Nachrichten, Fußball

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

## Voraussetzungen
- Der **Hub** braucht für Wetter, Fußball, Nachrichten und Kalender Zugang zum Internet bzw. zum Kalenderserver (DNS und HTTPS ausgehend). Das prüft „Betrieb → Verbindung“.
- Das Image muss mindestens Version 0.2.19 sein (DNS-Korrektur).

## Kalender (Tagesprogramm)
Unterstützt: Termine mit Zeitzone, UTC, ganztägig, Wiederholungen (täglich, wöchentlich mit Wochentagen, monatlich, jährlich, mit Intervall, COUNT und UNTIL), Ausnahmen (EXDATE), verschobene Einzeltermine, abgesagte Termine (werden nicht gezeigt). Nicht unterstützt: BYSETPOS, RDATE. Die Adresse ist geheim: Redakteure sehen sie nicht.

## Grenzen
- Eine Folie fasst etwa 8 Zeilen. Längere Listen werden verkleinert (kompakt) bzw. gekürzt („… und 3 weitere“).
- Datenquellen Dritter (DWD/Bright Sky, OpenLigaDB) können ausfallen oder ihre Bedingungen ändern; dann bleibt die letzte Folie stehen und die App zeigt „Fehler“ mit Erklärung. Nutzungsbedingungen vor dem Dauerbetrieb prüfen.
