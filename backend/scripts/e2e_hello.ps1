# Phase 1 E2E: create the hello task, poll to terminal status, check artifacts.
$ErrorActionPreference = 'Stop'
$token = (Get-Content "$PSScriptRoot\..\.env") -replace 'AGENTOS_TOKEN=', ''
$h = @{ Authorization = "Bearer $token" }
$base = 'http://127.0.0.1:8734'

$body = @{
    title          = 'smoke: hello agentos'
    prompt         = 'Create a file named hello.txt containing exactly the text: hello agentos'
    verify_command = 'grep -q "hello agentos" hello.txt'
} | ConvertTo-Json

$task = Invoke-RestMethod -Method Post -Uri "$base/api/tasks" -Headers $h -ContentType 'application/json' -Body $body
$id = $task.id
Write-Output "created $id"

foreach ($i in 1..60) {
    Start-Sleep -Seconds 3
    $t = Invoke-RestMethod -Uri "$base/api/tasks/$id" -Headers $h
    Write-Output "[$i] $($t.status) cost=$($t.total_cost_usd) tok=$($t.input_tokens)/$($t.output_tokens)"
    if ($t.status -in @('done', 'failed', 'cancelled')) { break }
}
if ($t.error) { Write-Output "error: $($t.error)" }
if ($t.result_summary) { Write-Output "summary: $($t.result_summary)" }

$file = "$PSScriptRoot\..\..\data\scratch\hello.txt"
if (Test-Path $file) { Write-Output ("file content: " + (Get-Content $file)) }
else { Write-Output 'file MISSING' }

$events = Invoke-RestMethod -Uri "$base/api/tasks/$id/events" -Headers $h
Write-Output ("event types: " + (($events | ForEach-Object { $_.type }) -join ', '))
