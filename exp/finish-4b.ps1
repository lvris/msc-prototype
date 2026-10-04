# Runs the 4b arm to completion and writes the combined report.
# Launched detached so it survives the Claude Code session exiting.
Set-Location $PSScriptRoot\..
$env:A_MODEL = "qwen3.5:4b"
& npx tsx exp/run.ts --backend openai --model qwen3.5:4b --repeats 1 *>&1 |
  Tee-Object -FilePath exp/logs/_p4b.txt
& npx tsx exp/report.ts *>&1 | Tee-Object -FilePath exp/logs/report.txt
& npx tsx exp/report.ts --latex *>&1 | Out-File -FilePath exp/logs/report-latex.txt -Encoding utf8
"DONE $(Get-Date -Format o)" | Out-File -FilePath exp/logs/_DONE.txt -Encoding utf8
