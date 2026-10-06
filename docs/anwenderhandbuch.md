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
1. **WLAN wählen** – Netzwerk antippen, Passwort eingeben (mit dem Auge-Symbol kannst du es anzeigen). *Hinweis:* Raspberry Pi 3 und Zero 2 W können nur 2,4-GHz-WLAN. Das Gerät prüft das WLAN; dabei verliert dein Handy **kurz** die Verbindung – das ist normal und es verbindet sich von selbst wieder. Bei falschem Passwort steht dort „Das Passwort scheint falsch zu sein“, und du kannst es noch einmal versuchen.
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
- **Im Hub:** Bildschirme → *Weitere Aktionen* → **WLAN ändern**.
- **Am Gerät ohne Tastatur:** Lege auf der SD-Karte eine **leere Datei `dfm-reset-wifi`** ab *oder* schalte das Gerät **5× nacheinander aus und wieder ein** (jeweils nach höchstens 30 Sekunden). Danach startet der Einrichtungsmodus „Nur WLAN ändern“ – Rolle und Daten bleiben erhalten.
- **Werksreset:** Bildschirme → *Auf Werkseinstellungen zurücksetzen* (löscht alle Daten des Geräts, danach muss es neu eingerichtet werden).

## 11. Hilfe in der Oberfläche
Überall gibt es **(?)-Hilfen**, die Rubrik **Hilfe** mit häufigen Fragen und den Rundgang **„Zeig mir, wie das geht“** (alles ohne Internet).

![Hilfe](bilder/10-hilfe.png)

## 12. Für Admins
- **Benutzer & Rollen:** Admin (alles), Redakteur (Inhalte und Termine), Betrachter (nur ansehen). Passwort mindestens 12 Zeichen; optional zusätzliche Sicherheit mit Code aus einer App.
- **Protokoll:** Wer hat wann was getan (nicht veränderbar), Sicherheitsereignisse getrennt filterbar, Export als CSV.
- **Erweitert:** Backup (Passphrase gut aufbewahren – sie wird nirgends gespeichert!), Updates (nur signierte Dateien), Diagnose, Zeitfenster für den Medien-Abgleich.
  ![Erweitert](bilder/11-erweitert.png)

## 13. Wenn etwas nicht klappt
| Problem | Lösung |
|---|---|
| Kein QR-Code am Bildschirm | HDMI-Kabel/Stecker prüfen, 2 Minuten warten. Beim Pi Zero 2 W dauert der Start länger. |
| Handy verbindet sich nicht mit `DFM-Setup-…` | Passwort vom Bildschirm genau abtippen (kleine/große Buchstaben). Notfalls Gerät aus- und einschalten (neues Passwort). |
| Seite öffnet sich nicht von selbst | `http://10.42.0.1/` im Browser eingeben. |
| „Das Passwort scheint falsch zu sein“ | WLAN-Passwort prüfen; Pi 3/Zero 2 W brauchen 2,4 GHz. |
| `dfm-signage.local` wird nicht gefunden | Manche Android-Browser kennen `.local` nicht → die IP-Adresse nutzen (Bildschirme → Hub-Adresse). |
| Bildschirm zeigt „Einen Moment bitte“ | Die Uhr ist noch nicht gestellt. Im Hub „Uhr abgleichen“ klicken. |
| Bildschirm läuft nicht mehr | Strom und WLAN prüfen; im Hub „Mit dem Hub neu verbinden“ oder „Neu starten“. |
| Alles schiefgegangen | Bildschirm auf Werkseinstellungen zurücksetzen und neu einrichten; Inhalte liegen im Hub. |
