# Hardware-Abnahme (Checkliste für echte Geräte)

Diese Punkte lassen sich **nicht** ohne Raspberry Pi prüfen. Bitte je Modell abhaken: **Pi 3 B / 3 B+**, **Pi Zero 2 W**, **Pi 4**, **Pi 5**.
Bei Abweichungen: Ergebnis in die Spalte „Bemerkung“ und mir/dem Entwickler melden. Messskript: `tools/diagnose.sh`.

## A. Image und Start
| Nr | Prüfung | Soll | Pi 3 | Zero 2 W | Pi 4 | Pi 5 |
|---|---|---|---|---|---|---|
| A1 | Frisch geflasht (nur Imager „Eigenes Image“, **ohne** Vorkonfiguration) starten | Splash mit DFM-Logo, nie Konsolentext, nie schwarz | ☐ | ☐ | ☐ | ☐ |
| A2 | Zeit Einschalten → QR-Code sichtbar | **< 90 s** (Pi 3) | ___ s | ___ s | ___ s | ___ s |
| A3 | Dateisystem erweitert (`df -h /data` über SSH-freie Prüfung: Admin → Erweitert → Diagnose „Speicher frei“) | ganze Karte | ☐ | ☐ | ☐ | ☐ |
| A4 | Zwei Karten, gleiche Hardware: Hostname, Hotspot-Passwort, Hub-Fingerabdruck verschieden | verschieden | ☐ | ☐ | ☐ | ☐ |
| A5 | Stromausfall während der Einrichtung (Stecker ziehen) | Neustart → wieder Einrichtungsmodus | ☐ | ☐ | ☐ | ☐ |
| A6 | Stromausfall im Betrieb (10× nacheinander) | Dateisystem unbeschädigt, Anzeige läuft wieder | ☐ | ☐ | ☐ | ☐ |

## B. Einrichtung per Handy (iPhone **und** Android)
| Nr | Prüfung | Soll |
|---|---|---|
| B1 | Kamera-App scannt WLAN-QR, „Verbinden“ | Handy ist im Setup-WLAN |
| B2 | Captive Portal öffnet sich von selbst (iOS: kleines Fenster; Android: Hinweis „Anmelden“) | Einrichtungsseite erscheint |
| B3 | Falls nicht: zweiter QR / `http://10.42.0.1/` | funktioniert |
| B4 | Falsche PIN 5× | neue PIN am Bildschirm |
| B5 | **AP→Client-Wechsel** beim WLAN-Test (Pi 3 / Zero 2 W: Hotspot muss kurz aus): Handy verbindet sich danach selbst wieder mit dem Setup-WLAN, Seite zeigt Ergebnis | Ergebnis sichtbar (iOS und Android getrennt prüfen!) |
| B6 | Falsches WLAN-Passwort | „Das Passwort scheint falsch zu sein.“, Modus bleibt aktiv |
| B7 | Hub komplett einrichten, danach Player | beide laufen, Hotspot danach **nicht mehr** sichtbar |
| B8 | 15 Minuten nichts tun | neuer Hotspot-Name bleibt, **neues Passwort + neue PIN** |
| B9 | Konfigurationsdatei `dfm-setup.txt` auf der SD-Karte | Datei danach gelöscht, Gerät eingerichtet |
| B10 | Startkarte (QR aus dem Hub) | Felder automatisch gefüllt, Fingerabdruck übernommen |
| B11 | Netzwerkkabel statt WLAN | Einrichtung über LAN möglich |
| B12 | Reset: Datei `dfm-reset-wifi` / 5× Strom aus-ein | Einrichtungsmodus „Nur WLAN ändern“ |
| B13 | Headless-Hub (kein HDMI): PIN = letzte 6 Zeichen der Seriennummer | Einrichtung klappt |

## C. Betrieb
| Nr | Prüfung | Soll |
|---|---|---|
| C1 | Admin-UI im Browser (Windows, macOS, iPad) unter `https://dfm-signage.local` | Warnung, Fingerabdruck stimmt, Bedienung ok |
| C2 | Android-Chrome löst `.local` auf? | Sonst IP-Adresse aus der Oberfläche nutzen |
| C3 | Player aus dem WLAN nehmen (Router aus, 30 min) | Anzeige läuft weiter, kein Fehler sichtbar; im Hub „Keine Verbindung“ |
| C4 | Hub aus (Strom), Player 24 h beobachten | läuft, Termine wechseln pünktlich |
| C5 | **WLAN-Energiesparen aus**: `iw dev wlan0 get power_save` (Diagnose-Seite) | `off` |
| C6 | Umschalten am Terminende | sekundengenau, kein Flackern, kein schwarzer Frame |
| C7 | Sommer-/Winterzeit-Termine 02:30 (Hub-Uhr auf 28.03./25.10. stellen) | siehe Zeitplan-Tests |
| C8 | Bildschirm aus/an (HDMI-CEC, Pi 4/5 zusätzlich `wlr-randr`) | funktioniert oder klare Meldung |
| C9 | Screenshot-Befehl (Pi 3/4/5: `grim`, Lite: mpv) | Vorschau im Hub |
| C10 | Ausrichtung 0/90/180/270 | Inhalt gedreht |
| C11 | Update-Paket einspielen (Hub + Player), Rollback | läuft; ungültige Signatur abgelehnt |
| C12 | Backup erstellen, auf **zweitem Pi** wiederherstellen | gleicher Fingerabdruck, Player verbinden ohne Neu-Pairing |

## D. Video-Wiedergabe (Messwerte)
Je Modell 10 Minuten Testvideo (`tools/diagnose.sh --testvideo`), Werte eintragen:
| Messwert | Pi 3 | Zero 2 W | Pi 4 | Pi 5 |
|---|---|---|---|---|
| Profil (Lite/Standard/Pro) | | | | |
| Ausgelassene Bilder (%) | | | | |
| CPU-Last (%) | | | | |
| Temperatur max (°C) | | | | |
| RAM Player gesamt (MB) | Ziel < 400 | Ziel < 150 | | |
| RAM Hub-Dienste (MB) | Ziel < 150 | – | | |
| WLAN-Durchsatz Download (MB/s) | | | | |
| Startzeit bis QR/Anzeige (s) | < 90 | | | |

## E. Phasen-Messwerte auf dem schwächsten Gerät (Zero 2 W)
RAM, CPU, WLAN-Durchsatz, Startzeit nach jeder größeren Änderung mit `tools/diagnose.sh` erfassen und in `docs/messwerte.md` eintragen.

## Erweiterung (Version 0.2) – zusätzliche Abnahme auf Hardware
| # | Prüfung | Soll | Pi 3 | Zero 2 W | Pi 4 | Pi 5 |
|---|---|---|---|---|---|---|
| E1 | Live-Ansicht Einzelansicht offen, Videotest 15 min | keine zusätzlichen verlorenen Bilder gegenüber ohne Live-Ansicht (Messung mit `mpv`/Diagnose) | ☐ | ☐ (Stufe 1) | ☐ | ☐ |
| E2 | Hub (Pi 4): 10 Kacheln offen, `top` über 10 min | < 25 % CPU im Mittel, Seite öffnet < 3 s | – | – | ☐ | ☐ |
| E3 | Zonen-Layout (Laufband + Uhr) 30 min mit Video | RAM-Budget des Profils nicht überschritten (`free -m`), Bilder flüssig | ☐ | n. v. | ☐ | ☐ |
| E4 | Inbetriebnahme-Test durchlaufen; absichtlich schwaches Netzteil / falsche Uhrzeit / blockierter Hub | Fehler werden erkannt, Hinweise verständlich | ☐ | ☐ | ☐ | ☐ |
| E5 | Aufstellmodus: Signal ändert sich in < 3 s sichtbar, Video ohne Aussetzer | ✔ | ☐ | ☐ | ☐ | ☐ |
| E6 | Fern-Ausrichtung ohne Bestätigung | nach 60 s alte Ausrichtung | ☐ | ☐ | ☐ | ☐ |
| E7 | WLAN ändern mit falschem Passwort | Bildschirm bleibt im alten WLAN, Hinweis im Hub | ☐ | ☐ | ☐ | ☐ |
| E8 | GPIO-3-Taster 3 s | Einrichtungsmodus, Inhalte bleiben | ☐ | ☐ | ☐ | ☐ |
| E9 | 5× kurz Strom aus/ein | Einrichtungsmodus | ☐ | ☐ | ☐ | ☐ |
| E10 | QR-Code (WLAN + Adresse) mit iPhone/Android aus 2 m scannen | wird gelesen | ☐ | ☐ | ☐ | ☐ |
| E11 | Nächtlicher Neustart 03:30 | Bildschirm nach < 2 min wieder da | ☐ | ☐ | ☐ | ☐ |
| E12 | iOS Safari / Android Chrome: Live, Startseite, Kalender | Schrift ≥ 16 px, nichts läuft über | ☐ | – | – | – |

## Version 0.2.22 – Alltagshilfen auf dem Pi prüfen
| # | Prüfung | Soll | Pi 3 B+ (Hub) |
|---|---|---|---|
| E13 | USB-Stick (FAT32 mit Fotos und einer PDF) am Hub einstecken | Startseite zeigt „USB-Stick erkannt“ innerhalb weniger Sekunden; Vorschau zeigt Dateien; PDF wird seitenweise Bilder; Stick abziehen: Hinweis verschwindet. Stecken am **Bildschirm-Pi**: nichts passiert | ☐ |
| E14 | Auf dem Hub: `findmnt -o TARGET,PROPAGATION /` und `journalctl -u 'dfm-usb@*'` | Wurzel „shared“; Meldung „unter /media/usb eingebunden (nur lesen)“; Hub-Dienst sieht den später eingesteckten Stick (Sichtprobe in der Oberfläche) | ☐ |
| E15 | exFAT- und NTFS-Stick | werden gelesen (falls nicht: Meldung im Journal „lässt sich nicht einbinden“, kein fehlgeschlagener Dienst) | ☐ |
| E16 | Foto vom Handy (iPhone und Android) zeigen | Foto erscheint auf dem gewählten Bildschirm in < 1 min, danach Rückkehr zum Plan | ☐ |
