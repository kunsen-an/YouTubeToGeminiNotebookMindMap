$ErrorActionPreference = "Stop"

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }

if (-not $nodePath) {
  $runtimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes"
  if (Test-Path -LiteralPath $runtimeRoot) {
    $nodePath = Get-ChildItem -LiteralPath $runtimeRoot -Recurse -Filter "node.exe" -File |
      Where-Object { $_.FullName -like "*\dependencies\node\bin\node.exe" } |
      Select-Object -First 1 -ExpandProperty FullName
  }
}

if (-not $nodePath) {
  throw "Node.js was not found. Install Node.js and run the tests again."
}

$testFile = Join-Path $PSScriptRoot "tests\extension.test.js"
& $nodePath --test $testFile
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
