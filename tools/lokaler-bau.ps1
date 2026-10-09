# Lokaler Schnellbau eines flashbaren Images (Minuten statt 35 Minuten GitHub-Bau) und anschließender Start-Test.
#   powershell -ExecutionPolicy Bypass -File tools\lokaler-bau.ps1 [-Basis C:\...\dfm-signage-arm64-0.2.16.img] [-Ausgabe C:\...\datei.img] [-OhneTest]
# Basis = ein fertig gebautes, entpacktes Image von GitHub (Standard: das neueste in Downloads). Der aktuelle Code aus diesem Ordner wird darübergelegt.
# Grenze: neue Pakete, Partitionsgrößen und cmdline.txt brauchen weiterhin einen Bau auf GitHub.
param([string]$Basis, [string]$Ausgabe, [switch]$OhneTest)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Basis) { $Basis = (Get-ChildItem "$env:USERPROFILE\Downloads" -Recurse -Filter 'dfm-signage-arm64-*.img' -File | Where-Object { $_.Name -notlike '*-lokal*' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
if (-not $Basis) { throw 'Kein entpacktes Basis-Image (.img) gefunden. Bitte mit -Basis angeben.' }
$ver = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
if (-not $Ausgabe) { $Ausgabe = Join-Path "$env:USERPROFILE\Downloads" "dfm-signage-arm64-$ver-lokal.img" }
$wsl = { param($p) '/mnt/' + $p.Substring(0, 1).ToLower() + ($p.Substring(2) -replace '\\', '/') }
$run = Join-Path $env:TEMP 'dfm-lokaler-bau.sh'
@"
#!/bin/bash
export DFM_REPO='$(& $wsl $repo)'
cd "`$DFM_REPO" || exit 1
sed 's/\r$//' tools/local-image-export.sh > /tmp/lie.sh
bash /tmp/lie.sh '$(& $wsl $Basis)' '$(& $wsl $Ausgabe)' 2>&1 | tee /tmp/local-export.log
"@ -replace "`r`n", "`n" | ForEach-Object { $skript = $_; for ($v = 0; $v -lt 8; $v++) { try { Set-Content -NoNewline -Encoding ascii -Path $run -Value $skript -ErrorAction Stop; break } catch { Start-Sleep -Seconds 2 } } } # WSL gibt die Datei nach einem früheren Lauf manchmal verzögert frei: mehrmals versuchen
Write-Host "Basis: $Basis`nAusgabe: $Ausgabe`nVersion im Code: $ver"
wsl -d Ubuntu-24.04 -u root -- bash (& $wsl $run)
if (-not (Test-Path $Ausgabe)) { throw 'Das Image wurde nicht erzeugt (siehe Meldungen oben).' }
if (-not $OhneTest) { & (Join-Path $PSScriptRoot 'lokaler-test.ps1') -Image $Ausgabe -Fresh }
