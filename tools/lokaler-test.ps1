# Startet den lokalen Image-Test in WSL (Ubuntu) – Aufruf in PowerShell, im Projektordner:
#   powershell -ExecutionPolicy Bypass -File tools\lokaler-test.ps1 [-Image C:\Pfad\dfm-signage-arm64-0.2.16.img]
# Ohne -Image wird das neueste entpackte Image (.img) im Downloads-Ordner genommen. Dauer: ca. 5 Minuten. Ergebnis: ERGEBNIS: bestanden / FEHLER gefunden.
param([string]$Image)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Image) { $Image = (Get-ChildItem "$env:USERPROFILE\Downloads" -Recurse -Filter 'dfm-signage-arm64-*.img' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
if (-not $Image) { throw 'Kein entpacktes Image (.img) gefunden. Bitte mit -Image angeben.' }
$wsl = { param($p) '/mnt/' + $p.Substring(0, 1).ToLower() + ($p.Substring(2) -replace '\\', '/') }
$run = Join-Path $env:TEMP 'dfm-lokaler-test.sh'
@"
#!/bin/bash
export DFM_REPO='$(& $wsl $repo)'
cd "`$DFM_REPO" || exit 1
sed 's/\r$//' tools/local-image-test.sh > /tmp/lit.sh      # Windows-Zeilenenden entfernen
bash /tmp/lit.sh '$(& $wsl $Image)' 2>&1 | tee /tmp/local-test.log
"@ -replace "`r`n", "`n" | Set-Content -NoNewline -Encoding ascii $run
Write-Host "Image: $Image"
wsl -d Ubuntu-24.04 -u root -- bash (& $wsl $run)
