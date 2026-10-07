# Übergabe: DFM Signage auf den eigenen Computer umziehen

Stand: 7. Oktober 2026 · Version 0.2.2 · Zweig `claude/hallo-ip4164` im Repository **DFMDO/Pi** auf GitHub.

Alles, was in der bisherigen (Cloud-)Sitzung entstanden ist, liegt vollständig auf GitHub. Es geht nichts verloren. Diese Anleitung erklärt, wie Sie auf Ihrem eigenen Computer weiterarbeiten.

---

## 1. Was Sie brauchen
- Einen Windows- oder Mac-Computer (Linux ist **nicht** nötig).
- Ihr GitHub-Konto mit Zugriff auf `DFMDO/Pi`.
- Die **Claude Desktop-App** (claude.ai/download) – darin ist Claude Code enthalten.
- **Git** (Windows: git-scm.com, bei der Installation alles auf Standard lassen; Mac: ist meist schon da).
- Optional, nur wenn Claude lokal Tests laufen lassen soll: **Node.js 22** (nodejs.org, Version 22 „LTS“).

## 2. Projekt auf den Computer holen
1. Ein Terminal öffnen (Windows: „Eingabeaufforderung“ oder „PowerShell“; Mac: „Terminal“).
2. In einen Ordner wechseln, in dem das Projekt liegen soll, z. B. Dokumente:
   ```
   cd Documents
   ```
3. Projekt herunterladen und auf den Arbeitszweig wechseln:
   ```
   git clone https://github.com/DFMDO/Pi.git
   cd Pi
   git checkout claude/hallo-ip4164
   ```
   (Beim ersten Mal fragt Git eventuell nach der GitHub-Anmeldung – im Browser bestätigen.)

## 3. Claude lokal starten
**Variante A – Desktop-App (am einfachsten):**
1. Claude Desktop öffnen → „Code“.
2. Den Ordner `Pi` (aus Schritt 2) als Projektordner wählen.
3. Eine neue Sitzung beginnen, zum Beispiel mit:
   > Lies CLAUDE.md und docs/UEBERGABE.md. Wir machen beim DFM-Signage-Projekt weiter.

**Variante B – Terminal (auch vom Handy aus steuerbar):**
```
cd Documents/Pi
claude remote-control
```
Die Sitzung erscheint dann auch in der Claude-App auf dem Handy.

Die neue Sitzung kennt den alten Chatverlauf **nicht**. Sie liest aber automatisch die Datei `CLAUDE.md` im Projekt – dort steht das Wichtigste (Projekt, Ihre Hardware, Regeln, Stand). Für mehr Details auf diese Übergabe und `docs/abschlussbericht.md` verweisen.

## 4. Was Sie weiterhin in GitHub machen (ohne Linux)
- **Image bauen:** GitHub → `DFMDO/Pi` → „Actions“ → „Image bauen“ → „Run workflow“ → Zweig `claude/hallo-ip4164`, Version z. B. `v0.2.3` → starten. Dauer ca. 35–40 Minuten.
- **Image herunterladen:** GitHub → `DFMDO/Pi` → „Releases“ → Datei `dfm-signage-arm64-<version>.img.xz`.
- **Auf SD-Karte schreiben:** Raspberry Pi Imager → „Betriebssystem“ → ganz unten „Eigenes Image verwenden“ → Datei wählen → SD-Karte → Schreiben.

## 5. Aktueller Stand
| Thema | Stand |
|---|---|
| Software | vollständig: Grundfunktionen, Erweiterung Z.1–Z.15, optionale Teil-E-Punkte |
| Automatische Tests | 136 von 136 bestanden |
| Image | 0.2.0 veröffentlicht (**nicht verwenden**, hat einen Einrichtungsfehler); **0.2.2 wurde gestartet** – unter „Actions“ prüfen, ob es grün durchgelaufen ist |
| Auf echten Pis getestet | **noch nicht** – das ist der nächste Schritt |
| Übersicht für die Leitung | `DFM-Signage-Uebersicht.pdf` im Projektordner (33 Seiten) |

### Neu in 0.2.1/0.2.2 (seit der ersten Version)
- **Hub und Bildschirm in einem Gerät** (bei der Handy-Einrichtung wählbar).
- **Fehlerbehebung:** Die Handy-Einrichtung legte Zugangsdateien so ab, dass Bildschirm und Hub sie nicht lesen konnten. Behoben ab 0.2.1.
- **Videos ohne Neuberechnung:** Full-HD-MP4 (H.264) werden in Sekunden übernommen.
- **Volle Leistung des Pi:** keine künstlichen Speichergrenzen, zusätzlicher komprimierter Speicher (zram), alle Prozessorkerne; bei Speichermangel hat die Anzeige Vorrang.
- **Flüssige Wiedergabe:** Hardware-Beschleunigung, reservierter Video-Speicher, voller Prozessortakt, Video-Decoder werden sofort freigegeben, je Bildschirm „Video-optimierte“ Wiedergabe wählbar.

## 6. Geplanter Test mit Ihren Raspberry Pi 3 B+
| # | Gerät | Einrichtung | Prüfen |
|---|---|---|---|
| 1 | Pi 3 B+ an einem **Bild**-Bildschirm | „Hub und Bildschirm in einem“ | Einrichtung klappt? Oberfläche flüssig? Bilder erscheinen? |
| 2 | Pi 3 B+ am **Video**-Bildschirm | „Bildschirm (Player)“, Code vom Hub | 4-Min.-Video einmal mit Wiedergabe „Automatisch“, einmal „Video-optimiert“ – ruckelt es? |
| 3 | weitere Pi 3 B+ | „Bildschirm (Player)“ | verbinden sich? zeigen dasselbe? |
| 4 | – | Video hochladen | Wie lange bis es auf dem Video-Bildschirm läuft? (Ziel: wenige Sekunden + Übertragung) |
| 5 | – | Strom vom Hub-Pi trennen | laufen die anderen weiter? kommt der Hub von selbst wieder? |
| 6 | – | **Betrieb → Gesundheit** | Temperatur, freier Speicher, Warnungen (z. B. „Netzteil zu schwach“) – Screenshot aufheben |

Tipps: Original-Netzteile (5,1 V / 2,5 A), High-Endurance-SD-Karte (64 GB am Hub), Videos als Full-HD-MP4.

## 7. Offene Punkte / mögliche nächste Aufgaben
- **Nach dem Test:** Ergebnisse an Claude geben; gezielte Anpassungen (z. B. Wiedergabe-Einstellungen, Speicher, Sparbetrieb für den Pi 3 B+).
- **Temperatur:** Der Pi 3 B+ drosselt ab 60 °C leicht. Falls die Geräte regelmäßig darüber liegen: Grenze auf 70 °C anheben (`temp_soft_limit=70`, offizielle Einstellung).
- **Hub-Gerät schützen:** Die Oberfläche verhindert noch nicht, dass das Gerät „Hub und Bildschirm“ gesperrt/entfernt wird – könnte ergänzt werden.
- **Nicht umgesetzt:** Grundriss-Ansicht je Etage, Foto im Geräteprofil, Fern-Einstellung der Auflösung, Aufstellmodus groß auf dem Bildschirm selbst.
- **Hardware-Abnahme:** Checkliste `docs/hardware-checkliste.md` (E1–E12) auf echten Geräten abarbeiten.

## 8. Wichtige Dateien
| Datei | Inhalt |
|---|---|
| `CLAUDE.md` | Projektwissen für Claude (wird automatisch gelesen) |
| `docs/anwenderhandbuch.md` | Bedienung, Kapitel 1–32 |
| `docs/technikhandbuch.md` | Technik, Image-Bau, Dienste |
| `docs/abschlussbericht.md` | Stand, Messwerte, Abweichungen |
| `docs/hardware-checkliste.md` | Prüfschritte auf echten Geräten |
| `docs/hub-ausgefallen.md` | Notfallanleitung |
| `DFM-Signage-Uebersicht.pdf` | Übersicht für die Leitung |
