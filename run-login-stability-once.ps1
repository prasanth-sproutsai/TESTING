param(
  [string]$RepoPath = "c:\Users\prasa\SOFTWARE_TESTING\TESTING"
)

# Ensure we run from the repo root so `dotenv.config()` loads the correct `.env`.
Set-Location $RepoPath

# Run exactly one login attempt (the JS script exits immediately when this is <= 0).
$env:DURATION_HOURS = "0"

node login-stability-check.js

