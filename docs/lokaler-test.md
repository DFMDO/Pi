# Lokaler Image-Test (ohne Raspberry Pi, ohne GitHub-Bau)

Ziel: Fehler wie „Hub startet nicht“ in **Minuten auf dem eigenen PC** finden, statt 35 Minuten auf den GitHub-Bau zu warten.

## Einmalig einrichten (Windows 11)
1. PowerShell **als Administrator** öffnen und ausführen: `wsl --install -d Ubuntu-24.04`, danach den PC **neu starten**.
2. Ubuntu startet und fragt nach Benutzername/Passwort (frei wählbar).
3. In Ubuntu einmalig: `sudo apt-get update && sudo apt-get install -y qemu-user-static binfmt-support systemd-container xz-utils util-linux rsync curl`
4. Systemd in WSL aktivieren (falls nicht schon an): `sudo sh -c 'printf "[boot]\nsystemd=true\n" > /etc/wsl.conf'`, dann in PowerShell `wsl --shutdown` und Ubuntu neu öffnen.

## Test starten
Das Image (`.img` oder `.img.xz`) liegt z. B. unter `C:\Users\<Name>\Downloads`. In Ubuntu (Windows-Laufwerk C: heißt dort `/mnt/c`):
```
cd /mnt/c/Users/<Name>/Desktop/Tyrone/KI/Pi
sudo tools/local-image-test.sh /mnt/c/Users/<Name>/Downloads/dfm-signage-arm64-0.2.6.img.xz
```
Das Skript legt den **aktuellen Code dieses Ordners** über das Image, stellt die Einrichtung nach, startet das System mit systemd und prüft Hub und Agent. Es dauert 3–6 Minuten (arm64 wird emuliert) und räumt danach auf. Ergebnis: `ERGEBNIS: bestanden` oder `FEHLER gefunden` mit den letzten Meldungen. Die Diagnosedatei liegt danach unter `/var/tmp/dfm-local-test/dfm-diagnose.txt`.

Nach einer Code-Änderung einfach erneut starten – ein neuer Image-Bau ist nicht nötig. (`npm run build:ui` vorher, wenn die Oberfläche geändert wurde.) Mit `--fresh` als zweitem Parameter wird das Image neu kopiert.

## Was geprüft wird – und was nicht
- Geprüft: Start der Dienste mit den **echten Dienst-Einheiten** (gleiche Sandbox-Regeln und Benutzer wie auf dem Pi), Rechte auf `/data/hub`, Hub-Antwort über HTTPS, Agent-Seite, Neustart-Schleifen.
- Nicht prüfbar: Bildschirm (cage/Chromium), WLAN, GPU, Hardware, Temperatur. Das bleibt der Test am Pi (Diagnosedatei `dfm-diagnose.txt` auf der SD-Karte).
- Stand: Das Skript wurde noch nicht ausgeführt (WSL fehlte auf dem Entwicklungs-PC); erste Läufe können Anpassungen am Skript nötig machen.