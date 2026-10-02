param([string]$NodeExecutable = '')

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$installRoot = if ($env:VIETDUB_INSTALL_ROOT) { $env:VIETDUB_INSTALL_ROOT } else { 'E:\VietDub-AI' }
$cacheRoot = Join-Path $installRoot 'cache'

if ([System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($installRoot)) -ne 'E:\') {
    throw 'VietDub model, cache and temporary files must remain on drive E:.'
}

$cachePaths = @{
    HF_HOME = Join-Path $cacheRoot 'huggingface'
    HUGGINGFACE_HUB_CACHE = Join-Path $cacheRoot 'huggingface\hub'
    PIP_CACHE_DIR = Join-Path $cacheRoot 'pip'
    TORCH_HOME = Join-Path $cacheRoot 'torch'
    XDG_CACHE_HOME = Join-Path $cacheRoot 'xdg'
    PYTHONPYCACHEPREFIX = Join-Path $cacheRoot 'pycache'
    TEMP = Join-Path $cacheRoot 'temp'
    TMP = Join-Path $cacheRoot 'temp'
}
foreach ($name in $cachePaths.Keys) {
    $value = $cachePaths[$name]
    New-Item -ItemType Directory -Path $value -Force | Out-Null
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
# Ba worker chạy song song; số luồng suy luận của từng worker đặt qua --threads trong .env.
# Giữ pool OpenMP/MKL nhỏ để tổng số luồng không vượt số nhân CPU (tranh chấp CPU làm STT chậm hơn thời gian thực).
$env:OMP_NUM_THREADS = '2'
$env:MKL_NUM_THREADS = '2'

if (-not $NodeExecutable) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $NodeExecutable = $nodeCommand.Source }
}
if (-not $NodeExecutable -or -not (Test-Path -LiteralPath $NodeExecutable)) {
    throw 'Không tìm thấy Node.js; truyền đường dẫn Node 24.18.0 qua -NodeExecutable.'
}

Push-Location $repositoryRoot
try {
    & $NodeExecutable 'packages/backend/dist/server.js'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
