# Sync notes from the Obsidian vault into the site's content/ folder.
# The source vault (DnD-Vault) is never modified - only mirrored into content/.
#
# Run from the site folder:  .\sync-content.ps1
# Then:  git add -A; git commit -m "Update notes"; git push
#
# Script is intentionally ASCII-only so Windows PowerShell 5.1 parses it
# regardless of file encoding. Cyrillic/emoji values are read from the notes.

$ErrorActionPreference = "Stop"

$VaultPath   = "D:\Agent\DnD-Vault"
$ContentPath = Join-Path $PSScriptRoot "content"
$RepoCommits = "https://github.com/DanilShekarev/dnd-wiki/commits/main/content"
$utf8NoBom   = New-Object System.Text.UTF8Encoding($false)  # UTF-8 without BOM

if (-not (Test-Path $VaultPath)) {
    throw "Vault not found: $VaultPath"
}

Write-Host "Mirroring $VaultPath -> $ContentPath ..." -ForegroundColor Cyan

# /MIR = mirror (purges stale files in content). Skip VCS/Obsidian metadata.
robocopy $VaultPath $ContentPath /MIR /XD ".git" ".obsidian" /XF ".gitattributes" /NFL /NDL /NJH /NJS /NP | Out-Null

# robocopy: exit codes 0-7 = success, >=8 = failure
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed (exit code $LASTEXITCODE)"
}

# Promote the dashboard (top-level "00 *.md") to the site homepage (index.md).
# Quartz titles index.md after the filename ("index"), so inject a `title:`
# pulled from the note's first H1. Written as UTF-8 without BOM (a BOM before
# the opening '---' would break Quartz frontmatter parsing).
$dashboard = Get-ChildItem -Path $ContentPath -File -Filter "00 *.md" | Select-Object -First 1
$indexFile = Join-Path $ContentPath "index.md"

if ($dashboard) {
    $text = [System.IO.File]::ReadAllText($dashboard.FullName)

    if ($text -notmatch "(?m)^title:") {
        $h1 = [regex]::Match($text, "(?m)^#\s+(.+?)\s*$").Groups[1].Value
        if ($h1) {
            $text = [regex]::Replace($text, "(?s)^(---\r?\n)", ('$1' + "title: $h1`r`n"), 1)
        }
    }

    [System.IO.File]::WriteAllText($indexFile, $text, $utf8NoBom)
    Remove-Item $dashboard.FullName -Force
    Write-Host ("Dashboard '{0}' -> index.md (homepage)" -f $dashboard.Name) -ForegroundColor Green
}

# Append a collapsible "history on GitHub" link to every note, pointing at that
# file's commit history. robocopy restores clean vault copies each run, so the
# link is re-appended every sync (deterministic -> no spurious git diffs).
# The Russian link text lives in footer-template.md (read as UTF-8) so this
# script stays ASCII-only and parses safely in Windows PowerShell 5.1.
$templatePath = Join-Path $PSScriptRoot "footer-template.md"
$template = [System.IO.File]::ReadAllText($templatePath, [System.Text.Encoding]::UTF8)

foreach ($note in Get-ChildItem -Path $ContentPath -Recurse -Filter *.md) {
    $rel = $note.FullName.Substring($ContentPath.Length).TrimStart('\', '/')
    $encoded = ($rel -split '[\\/]' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
    $footer = $template.Replace('__URL__', "$RepoCommits/$encoded")
    [System.IO.File]::AppendAllText($note.FullName, $footer, $utf8NoBom)
}
Write-Host "Appended GitHub history link to each note" -ForegroundColor Green

$count = (Get-ChildItem $ContentPath -Recurse -Filter *.md | Measure-Object).Count
Write-Host "Done. Markdown notes in content: $count" -ForegroundColor Green
Write-Host "Next: git add -A; git commit -m 'update'; git push" -ForegroundColor Yellow

# robocopy leaves a non-zero (but successful) code in $LASTEXITCODE; normalize.
exit 0
