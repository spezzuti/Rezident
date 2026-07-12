# Build the bundled Tailscale (tsnet) helper for Windows amd64.
# Output: <repo>/bin/tailscale-helper.exe  — where paths.resource_dir() finds it in
# dev, and where Rezident.spec bundles it from for the frozen build.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here '..\..')).Path
$outDir = Join-Path $repo 'bin'
$out = Join-Path $outDir 'tailscale-helper.exe'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Push-Location $here
try {
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    go build -trimpath -ldflags '-s -w' -o $out .
    Write-Output "built $out"
    Write-Output ("size: {0:N1} MB" -f ((Get-Item $out).Length / 1MB))
} finally {
    Pop-Location
}
