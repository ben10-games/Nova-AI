# Opens the Nova window (or, with -Background, just starts Nova) without a console window.
# Used by the Nova shortcuts (desktop, Start menu, startup) and by "Nova Setup (Windows).bat".
param([switch]$Background, [switch]$Uninstall)
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path $node)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('Nova needs Node.js. Double-click "Nova Setup (Windows).bat" in the Nova folder to install it.', 'Nova AI') | Out-Null
  exit 1
}
$arguments = @('"' + (Join-Path $root 'setup\nova-app.mjs') + '"')
if ($Background) { $arguments += '--background' }
if ($Uninstall) { $arguments += '--uninstall' }
Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden
