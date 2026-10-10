# Hub im Docker-Container

Der **Hub** (Verwaltung, Datenbank, Medien) kann statt auf einem Raspberry Pi auch in einem **Docker-Container** auf einem Server oder PC im Museumsnetz laufen. Die **Bildschirme** bleiben Raspberry Pi mit dem normalen Image.

## Wann ist das sinnvoll?
- Es gibt schon einen Server oder eine virtuelle Maschine im Haus (stärker und schneller als ein Pi 3 B+, besonders für Video-Umwandlung).
- Der Hub soll regelmäßig von der IT gesichert werden (ein Ordner / ein Volume).

## Voraussetzungen
- Ein Rechner mit Docker (Linux empfohlen) im **selben Netz** wie die Bildschirme, mit fester Adresse (IP-Adresse oder Name).
- Zeit: Der Rechner sollte seine Uhrzeit per NTP beziehen (die Bildschirme stellen ihre Uhr nach dem Hub).

## Starten
```bash
git clone <Adresse des Repositories> dfm && cd dfm
DFM_HOST_IPS=192.168.1.20 docker compose up -d --build
docker compose logs hub          # hier steht der Einrichtungscode
```
`DFM_HOST_IPS` ist die Adresse des Docker-Rechners, unter der die Bildschirme den Hub erreichen. Sie kommt in das Zertifikat und auf die Startkarten.

## Ersteinrichtung
1. Öffne `https://<Adresse>/` im Browser (die Zertifikatswarnung ist beim ersten Mal normal – der Hub hat ein eigenes Zertifikat).
2. Der **Einrichtungscode** steht im Protokoll des Containers (`docker compose logs hub`). Gib ihn mit Name und Passwort für das erste Admin-Konto ein.
3. Danach wie gewohnt: **Bildschirme → Neuen Bildschirm verbinden**.

## Was anders ist als auf dem Pi
| | Pi-Image | Docker |
|---|---|---|
| Updates | Update-Datei (.dfmpkg) im Hub einspielen | **Neues Image bauen/ziehen** und Container neu starten; der Hub zeigt „Updates per Docker“ |
| Hub-Name `dfm-signage.local` | automatisch (mDNS) | nicht verfügbar – **IP-Adresse oder eigenen Namen** verwenden (`DFM_HOST_IPS`, `DFM_EXTRA_SANS`) |
| Uhr stellen aus der Oberfläche, WLAN wechseln, Neustart des Geräts | möglich | nicht möglich (Sache des Docker-Rechners) |
| Neustart des Hubs | Dienst startet neu | Docker startet den Container neu (`restart: unless-stopped`) |
| Hub + Bildschirm in einem | möglich | nicht möglich (der Container hat keine Anzeige) |

## Daten und Sicherung
Alles liegt im Volume `dfm-data` (`/data`): Datenbank `hub.db`, Medien, Schlüssel, Zertifikat. Sichern Sie dieses Volume (zum Beispiel `docker run --rm -v dfm_dfm-data:/d -v $PWD:/b busybox tar czf /b/dfm-daten.tgz -C /d .`). Zusätzlich gibt es wie immer die **Sicherung in der Oberfläche** (Erweitert → Sicherung).

## Wichtig
- **Zertifikat und Schlüssel im Volume nicht verlieren:** Die Bildschirme prüfen den Fingerabdruck des Hubs. Ein neuer Schlüssel bedeutet, alle Bildschirme neu zu verbinden.
- Der Hub läuft im Container als normaler Benutzer (nicht root).
- Ports: `443` (HTTPS) und `80` (nur Weiterleitung). Mit `DFM_PUBLIC_HTTPS_PORT` kann die nach außen sichtbare Portnummer angepasst werden.
- Nicht auf echter Hardware oder in einem echten Museumsnetz erprobt; die Prüfung in GitHub (Workflow „Docker“) startet den Container und prüft, dass er antwortet.
