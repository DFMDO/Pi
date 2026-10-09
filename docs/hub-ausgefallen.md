# Der Hub ist ausgefallen – was tun?

**Keine Panik.** Die Bildschirme laufen weiter: Sie haben die Termine der nächsten 14 Tage und alle Medien gespeichert. Besucher merken nichts. Es lassen sich nur keine Änderungen machen, bis der Hub wieder da ist. Ein Ersatz-Hub ist in **unter 15 Minuten** einsatzbereit.

## Was du brauchst
- Ein Ersatz-Raspberry-Pi (Pi 4/5) mit SD-Karte oder SSD, auf die das DFM-Signage-Image geflasht wurde (siehe Technikhandbuch, Kapitel „Image flashen“).
- Das **letzte Backup** (`.dfmbak`-Datei; der Hub sichert täglich automatisch auf seine eigene SD-Karte). **Lade regelmäßig eine Kopie herunter** (*Hub ersetzen → Backup jetzt herunterladen*) und lege sie auf einem anderen Rechner oder Netzlaufwerk ab. Eine automatische zweite Kopie auf USB-Stick oder Netzlaufwerk gibt es **nicht**: Der Hub darf nur auf seine Datenpartition schreiben, und USB-Sticks werden nur lesend eingebunden.
- Die **Backup-Passphrase** (steht in eurem Passwortsafe – sie wird nirgends sonst gespeichert).

## In 6 Schritten (ca. 15 Minuten)
1. **Ersatz-Hub starten** (Netzwerkkabel, Strom). Am angeschlossenen Bildschirm erscheint ein QR-Code.
2. **QR-Code mit dem Handy scannen**, Hub einrichten (Name, Admin-Konto). *Dauert etwa 5 Minuten.*
3. **Statt** den QR-Code zu benutzen, geht es schneller mit der Einrichtungsdatei: Im Menü **🛟 Hub ersetzen** erzeugst du vorab die Datei `dfm-setup.txt` (Backup-Dateiname und Passphrase, optional WLAN). Sie kommt zusammen mit der Backup-Datei auf die Boot-Partition („bootfs“) der SD-Karte des Ersatz-Hubs. Beim ersten Start stellt sich der Hub selbst aus dem Backup wieder her und löscht die Datei. *Etwa 5 Minuten.* (Eine Schaltfläche „Backup zurückspielen“ in der Oberfläche gibt es **nicht**.)
4. Der Hub übernimmt **Bildschirme, Konten, Termine, Abspiellisten, Einstellungen – auch die Schlüssel.** Die Bildschirme müssen **nicht neu verbunden** werden, weil das Zertifikat des Hubs im Backup steckt. **Nicht im Backup sind die Mediendateien** (Bilder und Videos): Sie erscheinen im neuen Hub ohne Vorschau, bis du die Originale wieder hochlädst oder per USB-Stick importierst. Die Bildschirme zeigen bis dahin ihre gespeicherten Inhalte weiter.
5. Dem Ersatz-Hub die **alte IP-Adresse** geben (DHCP-Reservierung auf die neue MAC-Adresse umstellen oder die alte Adresse zuweisen). Der Name `dfm-signage.local` findet sich selbst.
6. Unter **Live** prüfen: nach 1 bis 2 Minuten sollten alle Bildschirme „Läuft“ zeigen.

## Wenn etwas hakt
- *Bildschirme melden sich nicht:* Hat der Ersatz-Hub eine andere IP? Die Bildschirme suchen den Hub auch per Name und per mDNS, aber nicht alle Netze erlauben das. Dann die alte IP wieder zuweisen.
- *Backup passt nicht:* Passphrase genau prüfen (Groß-/Kleinschreibung). Ohne Passphrase kann ein Backup nicht gelesen werden – in diesem Fall Bildschirme neu verbinden und Medien neu hochladen.
- *Kein Backup vorhanden:* Neuer Hub, Bildschirme einzeln neu verbinden („Neuen Bildschirm verbinden“), Medien neu hochladen. Die Bildschirme zeigen bis dahin ihren gespeicherten Inhalt.

**Vorbeugen:** USV, SSD, tägliche Backups auf einen zweiten Ort kopieren, Passphrase im Passwortsafe, Ersatz-Pi mit fertigem Image im Schrank.

## Diagnosedatei auf der SD-Karte (seit 0.2.3)
Jedes Gerät schreibt alle 5 Minuten seinen Zustand in die Datei `dfm-diagnose.txt` auf der Boot-Partition der SD-Karte (Laufwerk **bootfs**, am Windows-PC lesbar). Sie zeigt: Rolle, Netzwerkadressen, offene Ports, fehlgeschlagene Dienste, Temperatur/Netzteil-Warnung und die letzten Meldungen von Hub, Bildschirm und Netzwerk. Passwörter, Schlüssel, PINs und Einrichtungs-Logs sind nicht enthalten.
So geht's: Pi ausschalten → SD-Karte in den PC → `dfm-diagnose.txt` öffnen → Inhalt (oder Foto) an die Betreuung schicken.

## Vorsorge-Assistent (seit 0.2.23)
Im Menü **🛟 Hub ersetzen** prüft der Hub, ob ein frisches Backup da ist und ob schon eine Kopie auf einem anderen Rechner liegt, erzeugt die Einrichtungsdatei für den Ersatz-Hub und druckt eine Notfallkarte mit den wichtigsten Werten (Adresse, MAC, Fingerabdruck, Schritte).

## Meldung, wenn Bildschirme ausfallen (seit 0.2.23)
Unter *Erweitert → Meldung bei Ausfall* schickt der Hub E-Mails über den Mailserver des Museums, wenn Bildschirme ausfallen. Fällt der **Hub selbst** aus, melden sich die Bildschirme nicht mehr bei ihm; dann hilft nur die Überwachung durch die IT (Statusadresse `/api/v1/status`).
