# Datenschutzblatt – DFM Signage

Stand: Version 0.2 (Erweiterung). Dieses Blatt beschreibt, **welche Daten wo liegen, wer Zugriff hat und wie lange sie aufbewahrt werden.** Das System läuft vollständig im Museumsnetz: keine Cloud, keine Telemetrie, keine Verbindung ins Internet.

## Besucherdaten
**Es werden keine personenbezogenen Daten von Besuchern erhoben.** Es gibt keine Kameras, keine Mikrofone, keine Besucherzählung, keine Aufnahmen. QR-Codes sind einfache Bilder – es gibt keine Kurzlinks und kein Tracking.

## Welche Daten es gibt
| Daten | Wo | Wer hat Zugriff | Aufbewahrung |
|---|---|---|---|
| Konten (Name, Passwort-Hash argon2id, Rolle, optional 2. Faktor) | Hub (`/data/hub/hub.db`) | Admins (Name/Rolle), niemand (Passwort) | bis zum Löschen des Kontos |
| Audit-Protokoll (wer, wann, was, IP-Adresse im Museumsnetz) | Hub, unveränderbar und verkettet | Admins | einstellbar, Standard **365 Tage** (mindestens 30), danach automatische Löschung mit Ankerhash |
| Medien (Bilder, Videos, Texte) | Hub und Player-Cache | Redakteure/Admins (Vorschau auch Rolle Anzeige) | bis zum Löschen; Papierkorb 30 Tage |
| Termine, Szenen, Übersteuerungen (mit Namen der auslösenden Person und Szenen-/Gruppennamen) | Hub | Redakteure/Admins | Übersteuerungen/Szenen-Verlauf einstellbar, Standard **30 Tage** nach Ablauf |
| Versionsverlauf der Termine/Listen | Hub | Redakteure/Admins | 90 Tage |
| Geräteverlauf (Ausfälle, Neustarts, WLAN-Signal) | Hub | Admins/Redakteure | einstellbar, Standard 90 Tage (Ausfälle 180) |
| Prüfprotokolle der Inbetriebnahme | Hub | Admins/Redakteure | dauerhaft (Geräteakte) |
| **Screenshots der Live-Ansicht** | **nur Arbeitsspeicher des Hubs** | angemeldete Nutzer mit Live-Recht | nie gespeichert; ersetzt durch das nächste Bild; 60 s ohne Betrachter = keine neuen Bilder. Nur ein Admin kann bewusst „Bild speichern“ auslösen |
| Geräte-Token, WLAN-Zugang | Gerät/Hub, verschlüsselt bzw. nur als Hash | – | bis zum Sperren/Entfernen |

## Hinweise zu Screenshots (Live-Ansicht)
Ein Screenshot zeigt, was der Bildschirm gerade zeigt. Das können Inhalte sein, die nur der Player kennt (z. B. Gruppennamen auf einer Willkommens-Folie, Sperrhinweise). Deshalb:
- Bilder sind nur für **angemeldete** Nutzer abrufbar (kein öffentlicher Link); mit eingeschränkter Gruppenzugehörigkeit sieht man nur Bildschirme der eigenen Gruppen.
- Der Transport läuft verschlüsselt (WSS mit Zertifikats-Pinning).
- Aufrufe der Bildansicht werden nicht einzeln protokolliert; **Aktionen** daraus (Neu laden, Übersteuern) schon.
- **Gruppennamen** (z. B. „Klasse 7b“) nicht als Klarnamen von Kindern verwenden.

## Automatische Löschung
Der Hub prüft täglich und löscht abgelaufene Übersteuerungen/Szenenverläufe, alte Sondertage und Laufbänder, WLAN- und Ausfallverlauf sowie alte Protokolleinträge. Die Fristen stehen unter *Erweitert → Betrieb, Veröffentlichen und Datenschutz*. Das Protokoll wird mit einem Ankerhash gekürzt, damit die Kette weiter prüfbar bleibt.

## Stromausfall
Alle Geräte starten selbstständig. Player warten geduldig auf den Hub (ohne Fehlermeldungen über den Inhalten) und zeigen bis dahin ihre gespeicherten Inhalte. Für den Hub wird eine **USV** empfohlen (siehe [`hardware-empfehlung.md`](hardware-empfehlung.md)).

## Wiedergabe-Nachweis, Ausfall-Mails, Bildschirm teilen (seit 0.2.23)
- **Wiedergabe-Nachweis:** Gespeichert werden nur Zähler je Tag, Bildschirm und Medium (Anzahl, Sekunden, Medienname). Es gibt **keine** Besucherdaten und keine Personenbezüge. Aufbewahrung 400 Tage, danach automatische Löschung. Konten mit Gruppen-Beschränkung sehen nur ihre Bildschirme.
- **Ausfall-Mails:** Gespeichert werden Mailserver, Absender und Empfänger-Adressen (Personenbezug möglich: bitte Funktionsadressen wie it@… nutzen) sowie das Passwort **verschlüsselt**. Die Mails enthalten Bildschirmnamen und Zeiten, sonst nichts.
- **Bildschirm teilen:** Die Bilder werden nur durchgereicht und **nicht gespeichert**. Im Protokoll stehen Name, Zeit und Bildschirme der Übertragung. Wer teilt, entscheidet selbst, was auf dem PC sichtbar ist: Bitte keine Fenster mit vertraulichen Inhalten (E-Mails, Personaldaten) teilen. Auf den Bildschirmen im Besucherbereich sieht das jeder.

## Live-Spiel, Regeln, Prognose (seit 0.2.24)
- Es entstehen **keine Besucherdaten**. Gespeichert werden Spielstände (Nummer des letzten gemeldeten Tors, 14 Tage), Regeln (Name, Bedingungen, Inhalt, Ersteller als Konto-Nummer) und der freie Speicherplatz der Geräte im Messwerte-Verlauf (14 Tage).
- Die Live-App fragt nur Liga und Spieltag bei api.openligadb.de ab, der Kalender wird von der eigenen Adresse gelesen. Es werden keine personenbezogenen Daten gesendet.
