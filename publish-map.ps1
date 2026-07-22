# Publish freshly baked map tiles to the site.
#
# Flow: bake tiles from map-editor into quartz\static\map (the export dialog's
# "tiles for wiki" button writes here), then run this script to commit and push
# just the map data. The Pages deploy workflow does the rest.
#
# Run from the site folder:  .\publish-map.ps1
#
# Script is intentionally ASCII-only so Windows PowerShell 5.1 parses it
# regardless of file encoding.

$ErrorActionPreference = "Stop"

$MapPath = Join-Path $PSScriptRoot "quartz\static\map"

if (-not (Test-Path (Join-Path $MapPath "map.json"))) {
    throw "No baked map found at $MapPath - bake tiles from map-editor first"
}

$manifest = Get-Content (Join-Path $MapPath "map.json") -Raw | ConvertFrom-Json
$version = $manifest.version

Push-Location $PSScriptRoot
try {
    git add "quartz/static/map"
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Map data unchanged - nothing to publish"
    } else {
        git commit -m "map: rebake $version"
        if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
        git push
        if ($LASTEXITCODE -ne 0) { throw "git push failed" }
        Write-Host "Map $version published"
    }
} finally {
    Pop-Location
}
