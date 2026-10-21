$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendProcess = $null

if ($null -eq (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "Bun is required but was not found. Install it from https://bun.sh/ or run: powershell -c `"irm bun.sh/install.ps1 | iex`""
}

function Stop-Backend {
    if ($null -ne $backendProcess -and -not $backendProcess.HasExited) {
        Write-Host "Stopping backend..."
        Stop-Process -Id $backendProcess.Id -Force
    }
}

try {
    Write-Host "Starting backend..."
    $backendProcess = Start-Process `
        -FilePath "bun" `
        -ArgumentList "run", "dev" `
        -WorkingDirectory (Join-Path $rootDir "backend") `
        -NoNewWindow `
        -PassThru

    Write-Host "Waiting for backend at http://localhost:3001..."
    $backendReady = $false

    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1

        if ($backendProcess.HasExited) {
            throw "Backend stopped before it became ready."
        }

        try {
            Invoke-WebRequest `
                -Uri "http://localhost:3001/api/ping" `
                -UseBasicParsing `
                -TimeoutSec 2 | Out-Null
            $backendReady = $true
            break
        } catch {
            # The backend may still be starting.
        }
    }

    if (-not $backendReady) {
        throw "Backend did not become ready within 30 seconds."
    }

    Write-Host "Starting frontend..."
    Push-Location (Join-Path $rootDir "frontend")
    try {
        & bun run dev
    } finally {
        Pop-Location
    }
} finally {
    Stop-Backend
}
