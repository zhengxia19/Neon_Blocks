# N10 本地模拟验收：POST /api/rooms 合法组合 + 4xx/413/429/403 门槛
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8787'
$prod = 'https://zhengxia19.github.io'
$out = @()
function Create($body, $origin) {
  $headers = @{ Origin = $origin }
  $r = Invoke-WebRequest -Method Post -Uri "$base/api/rooms" -Headers $headers -ContentType 'application/json' -Body $body -UseBasicParsing -SkipHttpErrorCheck
  return @{ status = $r.StatusCode; body = $r.Content }
}

Start-Sleep -Seconds 12

# P1 合法创建（正式 Origin）
$p1 = Create '{"nickname":"host1","capacity":4,"randomMode":"S1","startLevel":1}' $prod
$out += "P1 create => STATUS=$($p1.status) BODY=$($p1.body)"

# P2 合法组合：容量 2..6、模式 S1/S2/S3+seed、等级 1/5/10
$combos = @(
  '{"nickname":"h2","capacity":2,"randomMode":"S2","startLevel":10}',
  '{"nickname":"h3","capacity":3,"randomMode":"S3","startLevel":5,"customSeed":"seed42"}',
  '{"nickname":"h4","capacity":5,"randomMode":"S1","startLevel":1}',
  '{"nickname":"h5","capacity":6,"randomMode":"S2","startLevel":7}',
  '{"nickname":"h6","capacity":4,"randomMode":"S3","startLevel":3,"customSeed":"Ab9"}'
)
$codes = @()
foreach ($c in $combos) {
  $r = Create $c $prod
  $code = ($r.body | ConvertFrom-Json).code
  $codes += $code
  $tok = ($r.body | ConvertFrom-Json).seatToken
  $tokOk = if ($tok -match '^[A-Za-z0-9_-]{32,128}$') { 'TOKEN-OK' } else { 'TOKEN-BAD' }
  $out += "P2 combo => STATUS=$($r.status) CODE=$code $tokOk"
}
$out += "P2 unique-codes => $(($codes + (($p1.body | ConvertFrom-Json).code) | Sort-Object -Unique).Count)/6"

# P3 未知字段丢弃
$p3 = Create '{"nickname":"h7","capacity":2,"randomMode":"S1","startLevel":1,"evilField":"xxxx"}' $prod
$out += "P3 polluted => STATUS=$($p3.status) HAS-EVIL=$($p3.body -match 'evilField')"

# N1 非法参数 → 400 精确错误码
foreach ($bad in @(
  '{"nickname":"中文","capacity":4,"randomMode":"S1","startLevel":1}',
  '{"nickname":"ok","capacity":7,"randomMode":"S1","startLevel":1}',
  '{"nickname":"ok","capacity":4,"randomMode":"S3","startLevel":1}',
  '{"nickname":"ok","capacity":4,"randomMode":"S1","startLevel":11}',
  '{not json'
)) {
  $r = Create $bad $prod
  $out += "N1 bad => STATUS=$($r.status) BODY=$($r.body)"
}

# N2 超大请求体（>4096 字节）→ 413
$big = '{"nickname":"' + ('a' * 5000) + '","capacity":4,"randomMode":"S1","startLevel":1}'
$r = Create $big $prod
$out += "N2 big-body => STATUS=$($r.status) BODY=$($r.body)"

# N3 缺 Origin → 403
$r = Invoke-WebRequest -Method Post -Uri "$base/api/rooms" -ContentType 'application/json' -Body '{"nickname":"x","capacity":2,"randomMode":"S1","startLevel":1}' -UseBasicParsing -SkipHttpErrorCheck
$out += "N3 no-origin => STATUS=$($r.StatusCode) BODY=$($r.Content)"

# N4 突发 40 连发（门槛 vars=30/min，同 IP）→ 应出现 429
$burst = 1..40 | ForEach-Object -Parallel {
  $r = Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:8787/api/rooms' -Headers @{Origin='https://zhengxia19.github.io'} -ContentType 'application/json' -Body ('{"nickname":"b' + "$_" + '","capacity":2,"randomMode":"S1","startLevel":1}') -UseBasicParsing -SkipHttpErrorCheck
  [int]$r.StatusCode
} -Throttle 20
$ok429 = ($burst | Where-Object { $_ -eq 429 }).Count
$ok201 = ($burst | Where-Object { $_ -eq 201 }).Count
$out += "N4 burst-40 => 201=$ok201 429=$ok429 OTHER=$(($burst | Where-Object { $_ -ne 429 -and $_ -ne 201 }).Count)"

$out += '---'
$out | Tee-Object -FilePath D:\tcodes\Neon_Blocks\evidence\multiplayer\N10\api-local.txt
