$ErrorActionPreference = "Stop"

Write-Host "Installing project dependencies..."
npm ci

Write-Host "Building Mori Windows installer..."
npm run windows:build

$installerDirectory = Join-Path $PSScriptRoot "..\src-tauri\target\release\bundle\nsis"
Write-Host "Build complete. Installer directory: $installerDirectory"
