# DFM Signage – Anwenderhandbuch

*Für alle, die Bildschirme im Museum bespielen – ohne Technikkenntnisse.*
Alles in diesem System läuft **ohne Internet** im Museumsnetz.

**Der kurze Weg:** SD-Karte flashen → Pi einstecken → QR-Code scannen → fertig.

---

## 1. SD-Karte vorbereiten (flashen)

Du brauchst: einen Computer, eine SD-Karte (mindestens 16 GB), die Datei `dfm-signage-arm64-<version>.img.xz` und das kostenlose Programm *Raspberry Pi Imager* (oder *balenaEtcher*).

1. Programm öffnen. ![Schritt 1](bilder/flashen-1.svg)
2. Bei „Betriebssystem“ **„Eigenes Image verwenden“** wählen und die Datei `dfm-signage-arm64-….img.xz` auswählen. ![Schritt 2](bilder/flashen-2.svg)
3. Wenn gefragt wird, ob Einstellungen angepasst werden sollen: **Nein.** Das Image braucht nichts vorab (kein WLAN, keinen Benutzer). ![Schritt 3](bilder/flashen-3.svg)
4. Schreiben lassen, am Ende die Karte entnehmen. ![Schritt 4](bilder/flashen-4.svg)

> Du kannst vorher die Echtheit prüfen: Zum Image gehören eine Prüfsumme (`.sha256`) und eine Signatur (`.sig`). Das Skript `build/verify-release.sh` zeigt „Signatur gültig“ (siehe Technikhandbuch).

## 2. Pi einstecken und mit dem Handy einrichten

Stecke die Karte in den Raspberry Pi, schließe einen Bildschirm per HDMI an und dann den Strom. Es erscheint zuerst das DFM-Logo mit „Willkommen“ – **nie** ein schwarzer Bildschirm oder Text.

### Schritt 1 – Handy verbinden
Der Bildschirm zeigt einen QR-Code, ein Netzwerk (`DFM-Setup-…`) und ein Passwort.

![Bildschirm: Schritt 1](bilder/20-bildschirm-schritt1.png)

1. Kamera-App am Handy öffnen. 2. Code scannen. 3. „Verbinden“ tippen.

### Schritt 2 – Einrichtung öffnen
Sobald das Handy verbunden ist, wechselt der Bildschirm. Meist öffnet sich die Einrichtungsseite **von selbst**. Wenn nicht: den zweiten QR-Code scannen oder `http://10.42.0.1/` im Browser öffnen. Gib die **6-stellige PIN** vom Bildschirm ein.

![Bildschirm: Schritt 2 mit PIN](bilder/21-bildschirm-schritt2.png)
![Handy: PIN](bilder/22-handy-pin.png)

### Die vier Schritte am Handy
1. **WLAN wählen** – Netzwerk antippen, Passwort eingeben (mit dem Auge-Symbol kannst du es anzeigen). *Hinweis:* Raspberry Pi 3 B (ohne Plus) und Zero 2 W können nur 2,4-GHz-WLAN. Das Gerät prüft das WLAN; dabei verliert dein Handy **kurz** die Verbindung – das ist normal und es verbindet sich von selbst wieder. Bei falschem Passwort steht dort „Das Passwort scheint falsch zu sein“, und du kannst es noch einmal versuchen.
   ![WLAN wählen](bilder/23-handy-wlan.png)
2. **Was ist dieses Gerät?** – „Hauptbildschirm-Rechner (Hub)“ gibt es **nur einmal** im Museum, er speichert alles. Alle anderen sind „Bildschirm (Player)“.
   ![Rolle](bilder/24-handy-rolle.png)
3. **Angaben** – Für den Hub: dein Name, ein langes Passwort (mindestens 12 Zeichen) und der Name des Museums. Für einen Bildschirm: ein Name (z. B. „Shop-Screen“), die Adresse des Hubs und der **Einrichtungscode** aus dem Hub.
   ![Details](bilder/25-handy-details.png)
4. **Fertig** – Das Gerät startet neu. Du kannst das Setup-WLAN verlassen. Der Hotspot ist danach aus.

**Der Einrichtungsmodus endet von selbst:** nach 15 Minuten ohne Eingabe (neuer Start mit neuem Passwort und neuer PIN) und sofort nach erfolgreicher Einrichtung.

### Weitere Wege (wenn du lieber ohne Handy einrichtest)
| Weg | So geht’s |
|---|---|
| **Datei auf der SD-Karte** | Auf der Karte liegt `dfm-setup.vorlage.txt`. Umbenennen in `dfm-setup.txt`, ausfüllen, speichern. Beim Start wird sie gelesen und **gelöscht** (sie enthält Passwörter). So bereitest du viele Bildschirme auf einmal vor. |
| **Startkarte aus dem Hub** | Im Hub „Neuen Bildschirm verbinden“ → „Startkarte“. Am Handy scannen füllt WLAN, Hub und Code automatisch aus. |
| **Netzwerkkabel** | Steckt beim ersten Start ein Kabel, geht die Einrichtung auch ohne WLAN. |
| **Kamera am Pi** | Ist eine Kamera angeschlossen, kann der Pi einen WLAN-QR-Code vom Handy scannen. |
| **Ohne Bildschirm (Hub)** | Das Gerät nutzt Datei oder Kabel. Die PIN steht in `geraeteinfo.txt` (letzte 6 Zeichen der Seriennummer, aufs Gerät kleben). |

## 3. Den Hub im Browser öffnen

Öffne `https://dfm-signage.local` (oder die IP-Adresse, die dir die IT nennt).

![Anmelden](bilder/01-anmelden.png)

![Browser-Warnung sicher bestätigen](bilder/browser-warnung.svg)

**Der Browser zeigt eine Warnung – das ist normal.** Der Hub arbeitet ohne Internet und hat darum ein eigenes Sicherheitszertifikat. So gehst du sicher vor:
1. Auf der Warnseite „Erweitert“ → „Weiter zu dfm-signage.local“.
2. Vergleiche den **Fingerabdruck** (Hub-Seite: *Bildschirme → Hub-Adresse & Fingerabdruck*) mit dem Aufdruck oder der Anzeige am Hub. Stimmen alle Zeichen überein, bist du richtig. Stimmen sie nicht überein: **nicht fortfahren, IT informieren.**

Beim ersten Mal führt dich ein Assistent: Konto → Sicherheit prüfen → ersten Bildschirm verbinden → erstes Bild hochladen → ersten Termin anlegen.

## 4. Die Startseite

![Startseite](bilder/02-startseite.png)

Hier siehst du auf einen Blick:
- **Schnellstart-Karten:** Bild/Video zeigen, Text-Ankündigung, Tag planen, Bildschirm verbinden.
- **Hinweise** in Klartext, z. B. „Foyer hat gerade keine Verbindung. Der Bildschirm zeigt weiter die zuletzt geladenen Inhalte.“
- **Jeder Bildschirm** mit Status (Symbol **und** Text – nicht nur Farbe): *Läuft*, *Keine Verbindung*, *Nicht erreichbar*, dazu ein Satz („Shop-Screen: läuft, zeigt gerade ‚Sommer-Aktion‘“) und eine Vorschau.
- **Was läuft heute?**

## 5. Neuen Bildschirm verbinden

1. Schalte den neuen Bildschirm ein.
2. Klicke im Hub auf **„Neuen Bildschirm verbinden“**. Du bekommst einen **Code** (10 Minuten gültig, einmal nutzbar) und den **Fingerabdruck** des Hubs.
   ![Bildschirm verbinden](bilder/04-bildschirm-verbinden.png)
3. Gib den Code am Handy ein (oder nutze die Startkarte).
4. Im Hub erscheint „**Ist das dein Bildschirm?** Modell …, Name …“ – klicke **„Ja, das ist mein Bildschirm“**.

![Bildschirme](bilder/03-bildschirme.png)

Mit „Weitere Aktionen“ kannst du einen Bildschirm neu laden, neu starten, drehen (0°/90°/180°/270°), das WLAN ändern, eine Diagnose starten, sperren, entfernen oder auf Werkseinstellungen zurücksetzen. Jede riskante Aktion fragt vorher nach.

## 6. Bilder, Videos und Texte hochladen

![Medien](bilder/05-medien.png)

- **Bilder** (JPG, PNG, WebP), **Videos** (MP4, MOV, MKV) und **PDF** (jede Seite wird ein Bild). Du kannst Dateien auch hineinziehen.
- Der Hub bereitet jede Datei **automatisch** für jeden Bildschirmtyp vor („Wird für die Bildschirme vorbereitet …“). Bei langen Videos kann das einige Minuten dauern.
- Er sagt dir, wenn etwas nicht optimal ist („Das Bild ist ziemlich klein …“).
- **Text-Ankündigung:** Überschrift, Text, eine von drei DFM-Vorlagen – mit Vorschau.
  ![Text-Ankündigung](bilder/06-text-ankuendigung.png)
- **Löschen** schiebt in den **Papierkorb** (30 Tage), von dort kannst du wiederherstellen.

## 7. Abspiellisten

Eine Abspielliste ist eine Reihenfolge von Bildern, Videos und Texten – jeweils mit Dauer und Übergang (Überblenden oder harter Schnitt). Reihenfolge per Ziehen oder Pfeilen ändern. Die als **Standard** markierte Liste läuft, wenn kein Termin etwas anderes festlegt.

![Abspielliste](bilder/07-abspielliste.png)

## 8. Termine planen

Im **Kalender** (Tag / Woche / Monat) klickst du ein Feld an oder ziehst über einen Zeitraum. Dann beschreibst du den Termin in einem Satz:

> **Zeige** *[Sommer-Aktion]* **auf** *[Shop-Screen]* **am** *[Dienstag, 13.10.]* **von** *[10:00]* **bis** *[12:00]* **Uhr.**

![Kalender](bilder/08-kalender.png)

- **Wiederholung** in Alltagssprache: einmalig, jeden Tag, jede Woche (Wochentage wählen), jeden Monat – optional „bis …“.
- **Einen Tag ausfallen lassen:** Termin anklicken → „Nur diesen Tag ausfallen lassen“.
- **Vorschau:** „So sieht der Bildschirm am Dienstag um 10:00 Uhr aus.“
- **Überschneiden sich zwei Termine?** Du bekommst eine Erklärung und einen Vorschlag: Es gewinnt ① der Termin direkt für den Bildschirm (vor Gruppen-Terminen), ② der wichtigere (Wichtigkeit 1–10 unter „Erweitert“), ③ bei Gleichstand der später gestartete. Gibt es keinen Termin, läuft die Standard-Abspielliste, sonst das DFM-Standby-Bild.
- Jeder Bildschirm hat im Kalender seine **Farbe** (Legende oben).

![Termin planen](bilder/09-termin-planen.png)

**Zeitumstellung:** Termine gelten immer in deutscher Zeit (Europe/Berlin). Ein Termin um 02:30 am Umstellungstag im März (die Uhrzeit gibt es dann nicht) startet um 03:30, im Oktober beim ersten Mal 02:30.

## 9. Was passiert, wenn …?

| Situation | Was der Besucher sieht | Was du siehst |
|---|---|---|
| WLAN fällt aus | Alles läuft weiter (gespeicherte Inhalte), **keine** Fehlermeldung | Startseite: „Keine Verbindung“ |
| Der Hub ist aus | Termine laufen weiter (die nächsten 14 Tage sind auf dem Bildschirm gespeichert) | – |
| Strom weg | Nach dem Start läuft alles wieder von selbst | Kurz „Keine Verbindung“ |
| Das WLAN-Passwort wurde geändert | Weiter gespeicherte Inhalte. Nach 10 Minuten startet der Einrichtungsmodus (Hotspot) | Bildschirm → Weitere Aktionen → WLAN ändern, oder neu einrichten |
| Die Uhr des Hubs geht falsch | – | Startseite: „Die Uhr des Hubs geht falsch“ → „Uhr mit diesem Computer abgleichen“ |
| Ein Video ist zu schwer für einen schwachen Bildschirm | Das Element wird übersprungen | Hinweis in der Oberfläche |

## 10. WLAN ändern, Gerät zurücksetzen
- **Im Hub:** Bildschirme → *Weitere Aktionen* → **WLAN ändern**. Das neue WLAN wird erst übernommen, wenn die Verbindung getestet wurde. Klappt es nicht, bleibt der Bildschirm im alten WLAN, und du bekommst einen Hinweis in „Betrieb“.
- **Am Gerät ohne Tastatur:** Lege auf der SD-Karte eine **leere Datei `dfm-reset-wifi`** ab *oder* schalte das Gerät **5× kurz hintereinander aus und wieder ein** (jeweils bevor der Bildschirm 2 Minuten lief) *oder* einen **Taster am GPIO 3 für 3 Sekunden** halten. Alle drei Wege starten nur den Einrichtungsmodus und löschen keine Inhalte. Danach startet der Einrichtungsmodus „Nur WLAN ändern“ – Rolle und Daten bleiben erhalten.
- **Werksreset:** Bildschirme → *Auf Werkseinstellungen zurücksetzen* (löscht alle Daten des Geräts, danach muss es neu eingerichtet werden).

## 11. Hilfe in der Oberfläche
Überall gibt es **(?)-Hilfen**, die Rubrik **Hilfe** mit häufigen Fragen und den Rundgang **„Zeig mir, wie das geht“** (alles ohne Internet).

![Hilfe](bilder/10-hilfe.png)

## 12. Für Admins
- **Benutzer & Rollen:** Admin (alles), Redakteur (Inhalte, Termine, Schnellaktionen), Anzeige (nur die Live-Ansicht – für Kasse, Info, Aufsicht). Der letzte Admin kann nicht gelöscht oder herabgestuft werden. Passwort vergessen? Ein Admin setzt es zurück (Benutzer → Passwort zurücksetzen) oder du nutzt einen Wiederherstellungscode. Passwort mindestens 12 Zeichen; optional zusätzliche Sicherheit mit Code aus einer App.
- **Protokoll:** Wer hat wann was getan (nicht veränderbar), Sicherheitsereignisse getrennt filterbar, Export als CSV.
- **Erweitert:** Backup (Passphrase gut aufbewahren – sie wird nirgends gespeichert!), Updates (nur signierte Dateien), Diagnose, Zeitfenster für den Medien-Abgleich.
  ![Erweitert](bilder/11-erweitert.png)

## 13. Wenn etwas nicht klappt
| Problem | Lösung |
|---|---|
| Kein QR-Code am Bildschirm | HDMI-Kabel/Stecker prüfen, 2 Minuten warten. Beim Pi Zero 2 W dauert der Start länger. |
| Handy verbindet sich nicht mit `DFM-Setup-…` | Passwort vom Bildschirm genau abtippen (kleine/große Buchstaben). Notfalls Gerät aus- und einschalten (neues Passwort). |
| Seite öffnet sich nicht von selbst | `http://10.42.0.1/` im Browser eingeben. |
| „Das Passwort scheint falsch zu sein“ | WLAN-Passwort prüfen; Pi 3 B/Zero 2 W brauchen 2,4 GHz. |
| `dfm-signage.local` wird nicht gefunden | Manche Android-Browser kennen `.local` nicht → die IP-Adresse nutzen (Bildschirme → Hub-Adresse). |
| Bildschirm zeigt „Einen Moment bitte“ | Die Uhr ist noch nicht gestellt. Im Hub „Uhr abgleichen“ klicken. |
| Bildschirm läuft nicht mehr | Strom und WLAN prüfen; im Hub „Mit dem Hub neu verbinden“ oder „Neu starten“. |
| Alles schiefgegangen | Bildschirm auf Werkseinstellungen zurücksetzen und neu einrichten; Inhalte liegen im Hub. |


---

# Zusatzfunktionen

## 14. Live: Was läuft gerade?
Im Menü **Live** siehst du alle Bildschirme als Kacheln (1 bis 4 Spalten, auf dem Handy eine). Jede Kachel zeigt Name, Ort, Ampel, das aktuelle Bild, den Namen des Inhalts, „läuft noch 0:23 Min“ und „als Nächstes: … um … Uhr“.
- **Klick auf die Kachel** öffnet die Einzelansicht: großes Bild, **Herkunft** („Termin …“, „Standard-Abspielliste“, „Schnellaktion von Max, bis 15:30“), die nächsten 5 Elemente und Schnellaktionen für genau diesen Bildschirm. Dort gibt es auch **Erkennen**, **Neu laden**, **Testbild** und **Wartungsmodus**.
- **Lesezeichen:** `https://dfm-signage.local/#/live/<Bildschirm>` öffnet direkt einen Bildschirm.
- **Vorschau-Stufen:** Immer sichtbar ist der *Status* (was läuft, wie lange noch). Ein echtes Bild (klein, alle 30 s bzw. 5 s in der Einzelansicht) gibt es nur, solange jemand zuschaut – 60 Sekunden nach dem Schließen hört das auf. Bei schwachen Geräten (Lite), hoher Temperatur oder knappem Speicher bleibt es beim Status („Vorschau vereinfacht, damit der Bildschirm flüssig bleibt“). Bilder liegen nur im Arbeitsspeicher des Hubs; es gibt keine Aufzeichnung. Nur Admins können bewusst ein Bild speichern.
- **Warnhinweise** stehen in Klartext an der Kachel („Offline seit 12 Minuten, zeigt den zwischengespeicherten Inhalt“, „Laut Plan sollte jetzt ‚Eröffnung‘ laufen, der Bildschirm zeigt aber ‚Standard‘“). Offline-Bildschirme erscheinen grau mit „zuletzt gesehen vor …“.
- **Wandmodus** (Monitor im Technikraum): Admins erzeugen unter *Benutzer → Wandmodus* ein Zugangs-Token, das nur die Live-Ansicht erlaubt. Auf dem Monitor `https://dfm-signage.local/#/wand` öffnen, Token einmal eingeben – die Ansicht bleibt dauerhaft offen.
- **Rolle „Anzeige“:** Nur-Lesen-Zugang für Personal. Pro Konto lassen sich die sichtbaren Bildschirmgruppen einschränken (Benutzer → Rolle ändern).

![Live-Ansicht](bilder/12-live.png)

## 15. Schnellaktionen und Szenen
Auf der **Startseite**: *Jetzt auf allen Bildschirmen zeigen* oder *Auf einem Bildschirm zeigen* – für 30 Minuten, 1 oder 2 Stunden oder bis Tagesende. Danach springt der Bildschirm automatisch zum normalen Plan zurück. „Alle Bildschirme“ übersteuert alle Termine und Szenen und fragt vorher nach.
- **Szenen** (Menü *Szenen*) legen für mehrere Bildschirme oder Gruppen fest, was läuft – z. B. „Eröffnung“, „Schulklassen-Tag“. Starten und beenden mit einem Klick.
- Jede Übersteuerung steht mit Ablaufzeit auf der Startseite und im Live-Bereich, im Protokoll (wer, wann, bis wann) und hat den Knopf **Zurück zum normalen Plan**.
- Übersteuerungen wirken auch bei Bildschirmen, die den Hub gerade nicht erreichen, sobald sie wieder verbunden sind – solange die Zeit nicht abgelaufen ist.
- Schnellaktionen sind sofortige Handlungen und laufen **nicht** über den Entwurfsmodus.

## 16. Entwurf und Veröffentlichen
Neue Termine, Abspiellisten und Szenen starten als **Entwurf**. Entwürfe siehst du im Kalender gestrichelt und mit **✎** (nie nur über die Farbe); sie laufen aber **nie** auf einem Bildschirm und erscheinen nicht in der Live-Ansicht.
- **Veröffentlichen** zeigt eine Zusammenfassung („Ab sofort zeigt ‚Shop-Screen‘ am Samstag von 10:00 bis 12:00 Uhr ‚Sommer-Aktion‘.“) und prüft Konflikte und fehlende Medien.
- Änderungen an etwas Veröffentlichtem entstehen als **Entwurfsversion**. Die veröffentlichte Fassung läuft weiter, bis du die neue veröffentlichst – oder den Entwurf verwirfst.
- Startseite: „3 Entwürfe warten auf Veröffentlichung“. Entwürfe älter als 30 Tage werden angemahnt, nicht gelöscht.
- **Frühere Stände** (90 Tage) lassen sich im Termin über „Frühere Stände“ als Entwurf wiederherstellen.
- Admins können unter *Erweitert* festlegen, dass Redakteure nur Entwürfe anlegen dürfen.
- **Duplizieren:** *Kalender → Woche kopieren / Vorlage* kopiert eine ganze Woche in eine andere und speichert **Wochenvorlagen** – immer zunächst als Entwürfe.

## 17. Betrieb: Gesundheit, Wartung, Empfang
Menü **Betrieb**:
- **Gesundheit:** Netzteil zu schwach, Temperatur, SD-Karte, freier Speicher, WLAN – jeweils als Satz in Klartext („Netzteil zu schwach bei ‚Foyer‘. Bitte das Original-Netzteil verwenden“).
- **Profil & Verlauf:** Standort, Etage, Seriennummer, Einbaudatum, Notizen, Link zur Anleitung; Verfügbarkeit (30 Tage) und Ausfallliste.
- **Wartungsmodus:** Der Bildschirm zeigt ein neutrales Bild, Warnungen sind stumm. Vergessen? Nach 24 Stunden erscheint eine Erinnerung.
- **WLAN-Empfang:** Liste mit Signalstufe („Sehr gut / Gut / Schwach / Zu schwach“), Verlauf (24 Stunden / 7 Tage), Wiederverbindungen, Aussetzer, Access Point (Name, Kanal, Band), schlechtester Empfang zuerst. Das ist eine **Übersicht aus den Meldungen der Bildschirme, keine Funkmessung.** Der **Aufstellmodus** zeigt das Signal alle 2 Sekunden (15 Minuten lang) – zum Verschieben des Bildschirms.
- **Wochenbericht:** Ausfälle, Warnungen, Speicherstand – drucken oder als PDF speichern. Die Geräteliste gibt es als Excel/CSV (Bildschirme → *Liste als Excel/CSV*) für die Inventarisierung.
- Ein **nächtlicher Neustart** (Standard 03:30 Uhr) hält die Bildschirme frisch; einstellbar unter *Erweitert*.

![Betrieb](bilder/13-betrieb.png)

## 18. Bildschirm ersetzen
Bildschirme → **Bildschirm ersetzen**. Neuen Pi einschalten, wie gewohnt mit Code/Startkarte verbinden, in der Liste bestätigen und dabei wählen, welchen alten Bildschirm er ersetzt. Name, Gruppe, Termine und Einstellungen wandern zum neuen Gerät, der alte wird gesperrt (Token ungültig). Einstellungen (Ausrichtung, Ausschaltzeiten, Layout) lassen sich außerdem über *Weitere Aktionen → Einstellungen auf andere kopieren* verteilen.

## 19. Vorlagen und Lesbarkeit
*Bilder & Videos → Vorlage verwenden*: Tagesprogramm, Öffnungszeiten, Führungen, Willkommen für Gruppen, Hinweis/Sperrung, Danke, Countdown, Uhr/Datum. Du füllst nur Felder aus. Der Hub prüft **immer** die Lesbarkeit auf der Auflösung des Ziel-Bildschirms: „Der Text ist für 3 m Abstand zu klein“, „Es ist zu viel Text“, „Der Kontrast ist zu schwach“. Countdown und Datum werden jede Nacht neu berechnet. Eigene Vorlagen und Layoutänderungen sind Admins vorbehalten.

## 20. QR-Code
*Bilder & Videos → QR-Code erstellen*: Adresse, WLAN-Zugang, Kontakt oder Text, mit Überschrift und Kurztext. Der Code entsteht **lokal** im Hub (keine Kurzlinks, kein Tracking), die Adresse steht zusätzlich im Klartext darunter. Der Hub liest den Code zur Gegenprobe selbst wieder aus und warnt bei Abweichung, bei zu kleinen Punkten und beim Betrachtungsabstand. Erlaubt sind nur `http://` und `https://` – `javascript:`, `file:` & Co. werden abgelehnt. Zeigt die Adresse ins interne Netz, warnt der Hub: Besucher erreichen nur öffentliche Adressen. Admins können die erlaubten Adressen für Redakteure einschränken.

## 21. Feiertage, Schließtage, Sondertage
*Kalender → Feiertage & Sondertage*. Die Feiertage Nordrhein-Westfalens sind eingebaut (ohne Internet). Du legst eine Regel für alle Feiertage fest („diese Abspielliste statt der normalen“ oder „Bildschirme aus“) und trägst eigene Tage oder Betriebsferien ein. Ein **aktiver Termin schlägt** einen Sondertag; ein Sondertag **ersetzt** die Standard-Abspielliste. Die Terminvorschau zeigt Sondertage mit an.

## 22. Laufband und Zonen
*Betrieb → Laufband & Zonen*. Layouts mit 2 bis 4 Zonen (Hauptbereich, Laufband, Uhr/Datum, Infospalte) gibt es auf Standard- und Pro-Geräten. **Lite-Geräte zeigen immer den Inhalt im Vollbild.** Laufband-Meldungen haben „gültig von/bis“.

## 23. Bildschirm erkennen, Testbild, Prüfung
- **Erkennen** (Weitere Aktionen): 10 Sekunden lang Name, Ort und Gerätenummer sehr groß.
- **Testbild:** Farben, Raster, Auflösung, Pfeil „OBEN“ (läuft 2 Minuten oder bis zum Beenden).
- **Ausrichtung ändern** hat einen **Rückfall**: ohne Bestätigung innerhalb von 60 Sekunden stellt der Bildschirm die alte Einstellung wieder her.
- **Bildschirm prüfen** (nach dem Verbinden automatisch, jederzeit unter *Betrieb*): Verbindung, WLAN, Uhrzeit, Netzteil/Temperatur/Speicher, Videotest, Bildtest (Ja/Nein-Frage, während der Bildschirm das Testbild zeigt), Ton (falls vorhanden), Synchronisation. Jeder Punkt hat ✔ / ▲ / ✖ mit Handlungshinweis. Das **Protokoll** ist druckbar und bleibt im Geräteprofil. Ein neuer Bildschirm zeigt nur das Standby-Bild, bis die Prüfung bestanden ist oder ein Admin sie bewusst überspringt (wird protokolliert).

## 24. Ordner importieren (Massenimport)
*Bilder & Videos → Ordner importieren*: Ordner von USB-Stick oder Netzwerkfreigabe (z. B. aus Yodeck) einlesen. Du siehst vorab eine **Vorschau** mit Duplikaterkennung, Namensvorschlägen und Hinweisen je Gerätetyp – **nichts wird übernommen, bevor du bestätigst.** Der Hub liest nur Ordner unter `/media` und `/mnt`; die IT bindet Stick oder Freigabe dort ein.

## 25. Datenschutz und Aufbewahrung
Siehe [`datenschutz.md`](datenschutz.md). Unter *Erweitert → Betrieb, Veröffentlichen und Datenschutz* stellst du ein, wie lange Verlaufsdaten und das Protokoll aufbewahrt werden; Altes wird automatisch gelöscht.

## 26. Hochkant und Seitenverhältnisse
*Bildschirme → Bearbeiten → Hochkant und Seitenverhältnis*: Wähle **Einpassen** (ganzes Bild, evtl. schwarze Ränder) oder **Füllen** (füllt alles, der Rand wird abgeschnitten) und einen **Sicherheitsrand** gegen Overscan. Du siehst sofort „So sieht es auf Hochkant aus“ als Vorschau und bekommst Warnungen in Klartext, z. B. „Beim Füllen werden etwa 68 % des Bildes abgeschnitten“ oder „Das Bild füllt nur etwa 32 % des Bildschirms“. Die Ausrichtung selbst stellst du unter *Weitere Aktionen → Ausrichtung* ein (mit 60-Sekunden-Rückfall).

## 27. Gestaffeltes Update
*Erweitert → Gestaffeltes Update*: Das Update (Datei oben einspielen) geht zuerst auf einen **Test-Bildschirm**. Läuft er nach der Beobachtungszeit (Standard 5 Minuten) stabil, folgen die übrigen Bildschirme in **Gruppen** (Standard 2). Schlägt etwas fehl – der Befehl scheitert, der Bildschirm meldet sich nach 15 Minuten nicht wieder –, geht **automatisch jeder schon aktualisierte Bildschirm zur vorherigen Version zurück**. Du kannst jederzeit abbrechen. Alles steht im Protokoll.

## 28. Lizenz und Ablaufdatum bei Medien
*Bilder & Videos → Umbenennen & Lizenz*: Urheber, Lizenz und **Gültig bis**. **14 Tage vorher** erscheint eine Warnung auf der Startseite. Nach dem Ablaufdatum wird das Medium **automatisch nicht mehr gezeigt** – auch auf Bildschirmen, die den Hub gerade nicht erreichen (das Datum steht im Plan des Bildschirms). Die Datei bleibt in der Bibliothek.

## 29. Simulator-Player (für Techniker)
`node tools/simulator.js --hub https://dfm-signage.local --code ABCD-1234 --count 5 --profile standard` startet virtuelle Bildschirme, die sich wie echte anmelden (Code, Fingerabdruck, WSS), den Plan abspielen und in **Live** erscheinen. Jeder Simulator muss im Hub bestätigt werden. Er dient dem Testen von Pairing, Zeitplan, Live-Ansicht und Konflikten ohne echte Pis (siehe `tests/simulator.test.js`). *Er läuft nicht im Browser:* Ein Browser kann beim WebSocket keinen Anmelde-Header senden, und ein zusätzlicher Anmeldeweg würde die Sicherheit des Hubs schwächen.


## 30. Ein Gerät für alles: Hub und Bildschirm in einem
Für den Anfang oder kleine Anlagen braucht es **keinen eigenen Hub-Rechner**. Wähle bei der Einrichtung am Handy unter „Was ist dieses Gerät?“ die Option **„Hub und Bildschirm in einem“**. Du legst wie beim Hub ein Admin-Konto an und gibst dem Bildschirm einen Namen (z. B. „Foyer“).
- Das Gerät speichert alle Inhalte und Termine **und** zeigt selbst Inhalte an. Es erscheint in der Oberfläche als normaler Bildschirm (Hinweis „gleichzeitig der Hub“).
- Weitere Bildschirme verbindest du später ganz normal („Neuen Bildschirm verbinden“).
- Empfohlen ab **Raspberry Pi 4 (2 GB) oder Pi 5**. Auf schwächeren Geräten warnt die Einrichtung.
- Bitte dieses Gerät **nicht** sperren oder entfernen – es ist zugleich die Zentrale. Wird es ausgeschaltet, laufen die anderen Bildschirme mit ihren gespeicherten Inhalten weiter.
- Wächst die Anlage, kann später ein eigener Hub-Rechner dazukommen: Backup auf den neuen Hub zurückspielen, das Kombi-Gerät danach als normalen Bildschirm neu einrichten.


## 31. Videos: am besten Full-HD-MP4
Videos im Format **MP4 (H.264), höchstens Full HD (1920×1080) und 25 oder 30 Bilder pro Sekunde** übernimmt der Hub in wenigen Sekunden – er verpackt sie nur um, ohne sie neu zu berechnen. Das ist besonders wichtig, wenn der Hub ein Raspberry Pi 3 B+ ist. Andere Videos (4K, HEVC/H.265, 50/60 Bilder pro Sekunde, sehr hohe Datenrate) werden neu berechnet; das kann auf einem Pi 3 B+ ein Vielfaches der Videolänge dauern. Die Oberfläche weist darauf hin. Der Ton wird nicht übernommen (die Bildschirme spielen stumm).
