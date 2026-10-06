# Codec- und Format-Entscheidung je Pi-Modell

> **Status:** Aus Datenblättern und Erfahrungswerten abgeleitet; **auf echter Hardware noch nicht gemessen**. Die Tabelle ist die Grundlage der Medienvarianten (`hub/lib/variants.js`, `PROFILE_SPEC`). Messprotokoll: `docs/hardware-checkliste.md` Abschnitt „Video-Wiedergabe“.

| Modell | Profil | Video-Decoder (Hardware) | Variante (Hub erzeugt) | Begründung |
|---|---|---|---|---|
| Pi Zero 2 W | Lite | H.264 bis 1080p30 (V4L2 M2M/DRM-PRIME, 512 MB RAM!) | 720p, H.264 **Baseline**, ≤ 2 Mbit/s, 30 fps, ohne Ton; Bilder ≤ 1280 px | mpv direkt auf DRM/KMS ohne Browser; Baseline vermeidet B-Frames und spart Decoder-Puffer |
| Pi 3 B Rev 1.2 / 3 B+ | Standard | H.264 bis 1080p30 | 1080p30, H.264 **High** L4.1, ≤ 6 Mbit/s | Chromium-Kiosk; 1080p60 überfordert den Decoder |
| Pi 4 / 400 | Pro | H.264 bis 1080p60, HEVC bis 4Kp60 | 1080p bis 60 fps, H.264 High L4.2, ≤ 15 Mbit/s | H.264 ist überall abspielbar; 4K nur bei Bedarf als HEVC (nach Test) |
| Pi 5 / 500 | Pro | **kein H.264-Hardwaredecoder**, nur HEVC | wie Pi 4: 1080p60 H.264 (Software-Decode) | 4 Kerne A76 schaffen 1080p60 H.264 per Software; HEVC-Hardware-Decode im Chromium unter Linux ist unzuverlässig → H.264 als sicherer Standard, HEVC nur als dokumentierte Option |

## Offene Messpunkte (vor Freigabe pro Modell)
1. Pi 3: Läuft 1080p30 H.264 in **Chromium** wirklich hardwarebeschleunigt (Bildrate, CPU-Last, Temperatur)? Falls nein → Standard-Variante auf 720p30 senken **oder** den Standard-Renderer auf mpv umstellen (Lite-Renderer ist vorhanden, nur Text/Widgets fehlen).
2. Pi 5: CPU-Last bei 1080p60 H.264 (Software) und Temperatur ohne Lüfter; HEVC-Variante testweise.
3. Zero 2 W: Speicherbudget Agent + mpv (Ziel < 150 MB) und Dauerbetrieb 24 h.

## Warum nicht „einfach alles in HEVC“?
Pi 3 und Zero 2 W können HEVC nicht dekodieren; Ein Format für alle wäre also nur H.264. Pi 5 wird dadurch nicht schlechter bedient als nötig, solange 1080p genügt.
