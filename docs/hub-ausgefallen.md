# Der Hub ist ausgefallen – was tun?

**Keine Panik.** Die Bildschirme laufen weiter: Sie haben die Termine der nächsten 14 Tage und alle Medien gespeichert. Besucher merken nichts. Es lassen sich nur keine Änderungen machen, bis der Hub wieder da ist. Ein Ersatz-Hub ist in **unter 15 Minuten** einsatzbereit.

## Was du brauchst
- Ein Ersatz-Raspberry-Pi (Pi 4/5) mit SD-Karte oder SSD, auf die das DFM-Signage-Image geflasht wurde (siehe Technikhandbuch, Kapitel „Image flashen“).
- Das **letzte Backup** (`.dfmbak`-Datei; der Hub sichert täglich automatisch, Kopien auf USB-Stick oder Netzlaufwerk sind ideal).
- Die **Backup-Passphrase** (steht in eurem Passwortsafe – sie wird nirgends sonst gespeichert).

## In 6 Schritten (ca. 15 Minuten)
1. **Ersatz-Hub starten** (Netzwerkkabel, Strom). Am angeschlossenen Bildschirm erscheint ein QR-Code.
2. **QR-Code mit dem Handy scannen**, Hub einrichten (Name, Admin-Konto). *Dauert etwa 5 Minuten.*
3. In der Oberfläche anmelden: **Erweitert → Sicherung → Backup zurückspielen**, Datei und Passphrase wählen. *Etwa 2 Minuten.*
4. Der Hub übernimmt **Bildschirme, Termine, Medien und Einstellungen – auch die Schlüssel.** Die Bildschirme müssen **nicht neu verbunden** werden, weil das Zertifikat des Hubs im Backup steckt.
5. Dem Ersatz-Hub die **alte IP-Adresse** geben (DHCP-Reservierung auf die neue MAC-Adresse umstellen oder die alte Adresse zuweisen). Der Name `dfm-signage.local` findet sich selbst.
6. Unter **Live** prüfen: nach 1 bis 2 Minuten sollten alle Bildschirme „Läuft“ zeigen.

## Wenn etwas hakt
- *Bildschirme melden sich nicht:* Hat der Ersatz-Hub eine andere IP? Die Bildschirme suchen den Hub auch per Name und per mDNS, aber nicht alle Netze erlauben das. Dann die alte IP wieder zuweisen.
- *Backup passt nicht:* Passphrase genau prüfen (Groß-/Kleinschreibung). Ohne Passphrase kann ein Backup nicht gelesen werden – in diesem Fall Bildschirme neu verbinden und Medien neu hochladen.
- *Kein Backup vorhanden:* Neuer Hub, Bildschirme einzeln neu verbinden („Neuen Bildschirm verbinden“), Medien neu hochladen. Die Bildschirme zeigen bis dahin ihren gespeicherten Inhalt.

**Vorbeugen:** USV, SSD, tägliche Backups auf einen zweiten Ort kopieren, Passphrase im Passwortsafe, Ersatz-Pi mit fertigem Image im Schrank.
