param(
  [string]$RepoPath = "c:\Users\prasa\SOFTWARE_TESTING\TESTING"
)

# Run from repo root so dotenv loads .env from the correct folder.
Set-Location $RepoPath

# Script performs a single login POST and exits (no env flags required).
node login-stability-check.js
