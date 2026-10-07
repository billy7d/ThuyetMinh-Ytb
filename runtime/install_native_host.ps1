# Cài (hoặc gỡ) native messaging host để nút "Bật backend" trong popup extension chạy được backend VietDub trên máy này.
#   powershell -ExecutionPolicy Bypass -File runtime/install_native_host.ps1            # cài / cập nhật
#   powershell -ExecutionPolicy Bypass -File runtime/install_native_host.ps1 -Uninstall # gỡ
# Không cần quyền quản trị: chỉ ghi vào HKCU (Chrome, Edge) và thư mục E:\VietDub-AI\native-host.
# Chỉ extension có ID trong -ExtensionId (mặc định: ID cố định tính từ trường "key" của manifest.chrome.json) và add-on Firefox có ID
# trong manifest.firefox.json (vietdub-ai@vietdub.local) mới gọi được host.
param(
    [switch]$Uninstall,
    [string[]]$ExtensionId = @(),
    [string]$NodeExecutable = ''
)

$ErrorActionPreference = 'Stop'

$HostName = 'com.vietdub.backend_launcher'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$installRoot = if ($env:VIETDUB_INSTALL_ROOT) { $env:VIETDUB_INSTALL_ROOT } else { 'E:\VietDub-AI' }
$hostDir = Join-Path $installRoot 'native-host'
$chromiumKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)
$firefoxKey = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
$TaskName = 'VietDub AI Backend'
$registryKeys = $chromiumKeys + @($firefoxKey)

if ($Uninstall) {
    foreach ($key in $registryKeys) { if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force -Confirm:$false } }
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    if (Test-Path $hostDir) { Remove-Item -Path $hostDir -Recurse -Force -Confirm:$false }
    Write-Host 'Đã gỡ native messaging host VietDub.'
    exit 0
}

if ([System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($installRoot)) -ne 'E:\') {
    throw 'VietDub model, cache and temporary files must remain on drive E:.'
}
if (-not $NodeExecutable) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $NodeExecutable = $nodeCommand.Source }
}
if (-not $NodeExecutable -or -not (Test-Path -LiteralPath $NodeExecutable)) {
    throw 'Không tìm thấy Node.js; truyền đường dẫn qua -NodeExecutable.'
}
$hostScript = Join-Path $PSScriptRoot 'native-host\host.mjs'
$startScript = Join-Path $PSScriptRoot 'start_backend.ps1'
foreach ($required in @($hostScript, $startScript)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Thiếu tệp: $required" }
}

if ($ExtensionId.Count -eq 0) {
    $ExtensionId = @(& $NodeExecutable (Join-Path $PSScriptRoot 'native-host\extension-id.mjs'))
}
foreach ($id in $ExtensionId) {
    if ($id -notmatch '^[a-p]{32}$') { throw "ID extension không hợp lệ: $id" }
}
$origins = @($ExtensionId | ForEach-Object { "chrome-extension://$_/" })
$firefoxManifestPath = Join-Path $repositoryRoot 'packages\extension\manifest.firefox.json'
$firefoxId = (Get-Content -Raw -Encoding UTF8 $firefoxManifestPath | ConvertFrom-Json).browser_specific_settings.gecko.id
if (-not $firefoxId) { throw "Không đọc được ID add-on Firefox từ $firefoxManifestPath" }

New-Item -ItemType Directory -Path $hostDir -Force | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

$config = [ordered]@{
    repoRoot       = $repositoryRoot
    startScript    = $startScript
    nodeExecutable = $NodeExecutable
    healthUrl      = 'http://127.0.0.1:8080/health'
    stateDir       = $hostDir
    logPath        = (Join-Path $installRoot 'logs\backend.log')
    taskName       = $TaskName
    allowedOrigins = @($origins) + @($firefoxId)
}
$configPath = Join-Path $hostDir 'config.json'
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), $utf8)

# Tác vụ theo yêu cầu (không có trigger, chỉ chạy khi host gọi `schtasks /run`), chạy bằng quyền người dùng hiện tại, không cần quản trị.
# Dùng Task Scheduler vì Firefox giết mọi tiến trình con của host khi host thoát; tiến trình do Task Scheduler tạo thì không bị.
$backendLog = Join-Path $installRoot 'logs\backend.log'
$taskArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -NodeExecutable `"$NodeExecutable`" -LogFile `"$backendLog`""
$taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArguments -WorkingDirectory $repositoryRoot
$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$taskPrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Settings $taskSettings -Principal $taskPrincipal -Description 'VietDub AI: chạy backend local khi bấm nút trong popup extension' -Force | Out-Null

# Chrome trên Windows chạy host qua tệp .bat/.exe; .bat đặt đường dẫn cấu hình rồi gọi Node (không in gì ra stdout).
$batPath = Join-Path $hostDir 'vietdub-host.bat'
$bat = "@echo off`r`nset `"VIETDUB_HOST_CONFIG=$configPath`"`r`n`"$NodeExecutable`" `"$hostScript`" %*`r`n"
[System.IO.File]::WriteAllText($batPath, $bat, [System.Text.Encoding]::ASCII)

$manifest = [ordered]@{
    name            = $HostName
    description     = 'VietDub AI: bật backend local khi người dùng bấm nút trong popup'
    path            = $batPath
    type            = 'stdio'
    allowed_origins = $origins
}
$manifestPath = Join-Path $hostDir "$HostName.json"
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), $utf8)

# Firefox dùng allowed_extensions (ID add-on) thay cho allowed_origins, nên cần manifest riêng.
$firefoxManifest = [ordered]@{
    name               = $HostName
    description        = $manifest.description
    path               = $batPath
    type               = 'stdio'
    allowed_extensions = @($firefoxId)
}
$firefoxManifestFile = Join-Path $hostDir "$HostName.firefox.json"
[System.IO.File]::WriteAllText($firefoxManifestFile, ($firefoxManifest | ConvertTo-Json), $utf8)

foreach ($key in $chromiumKeys) {
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
}
New-Item -Path $firefoxKey -Force | Out-Null
Set-ItemProperty -Path $firefoxKey -Name '(default)' -Value $firefoxManifestFile

Write-Host "Đã cài native messaging host '$HostName'."
Write-Host "  Extension Chrome/Edge được phép: $($ExtensionId -join ', ')"
Write-Host "  Add-on Firefox được phép: $firefoxId"
Write-Host "  Node: $NodeExecutable"
Write-Host "  Tác vụ nền: $TaskName (log: $backendLog)"
Write-Host "  Cấu hình: $configPath"
Write-Host 'Mở lại popup VietDub trong Chrome/Firefox: khi backend chưa chạy sẽ có nút "Bật backend".'
