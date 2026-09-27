# DEBUG ONLY: runs the asked-for suites LOOPS times, reporting each pass.
$n = if ($env:LOOPS) { [int]$env:LOOPS } else { 5 }
for ($i = 1; $i -le $n; $i++) {
  Write-Output "=== LOOP $i of $n"
  node scripts/gate.mjs --only $env:SUITES
}
exit 0
