# N11 本地模拟验收：POST /api/rooms/<码>/join 容量/昵称/并发最后席位
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8787'
$prod = 'https://zhengxia19.github.io'
$out = @()
function Post($path, $body, $origin) {
  $headers = @{}
  if ($null -ne $origin) { $headers['Origin'] = $origin }
  $r = Invoke-WebRequest -Method Post -Uri "$base$path" -Headers $headers -ContentType 'application/json' -Body $body -UseBasicParsing -SkipHttpErrorCheck
  return @{ status = $r.StatusCode; body = $r.Content }
}
function Create($cap, $nick) {
  (Post '/api/rooms' ('{"nickname":"' + $nick + '","capacity":' + $cap + ',"randomMode":"S1","startLevel":1}') $prod)
}

Start-Sleep -Seconds 12

# P1 容量 2：加入 1 人成功、第 3 人满员拒绝
$c1 = Create 2 'h1'
$code1 = ($c1.body | ConvertFrom-Json).code
$j1 = Post "/api/rooms/$code1/join" '{"nickname":"guest1"}' $prod
$j2 = Post "/api/rooms/$code1/join" '{"nickname":"guest2"}' $prod
$out += "P1 cap2 join1 => STATUS=$($j1.status) BODY=$($j1.body)"
$out += "P1 cap2 join2(full) => STATUS=$($j2.status) BODY=$($j2.body)"

# P2 容量 3..6 逐一：加入 capacity-1 人全 200，再加 1 人 409
foreach ($cap in 3..6) {
  $c = Create $cap ("h$cap")
  $code = ($c.body | ConvertFrom-Json).code
  $statuses = @()
  for ($i = 1; $i -lt $cap; $i++) {
    $j = Post "/api/rooms/$code/join" ('{"nickname":"g' + $cap + '_' + $i + '"}') $prod
    $statuses += $j.StatusCode
  }
  $overflow = Post "/api/rooms/$code/join" ('{"nickname":"over' + $cap + '"}') $prod
  $out += "P2 cap$cap joins=[$($statuses -join ',')] overflow => STATUS=$($overflow.status) ERR=$((($overflow.body | ConvertFrom-Json).error))"
}

# P3 昵称大小写不敏感冲突
$c3 = Create 3 'ABc'
$code3 = ($c3.body | ConvertFrom-Json).code
$j = Post "/api/rooms/$code3/join" '{"nickname":"abc"}' $prod
$out += "P3 name-taken => STATUS=$($j.status) ERR=$((($j.body | ConvertFrom-Json).error))"

# P4 未占用房间码加入 → 404
$j = Post '/api/rooms/100001/join' '{"nickname":"lonely"}' $prod
$out += "P4 unclaimed-code => STATUS=$($j.status) ERR=$((($j.body | ConvertFrom-Json).error))"

# N1 非法码/昵称/JSON → 400
foreach ($probe in @(
  @('/api/rooms/099999/join', '{"nickname":"g"}'),
  @('/api/rooms/123456/join', '{"nickname":"中文"}'),
  @('/api/rooms/123456/join', '{oops')
)) {
  $r = Post $probe[0] $probe[1] $prod
  $out += "N1 bad => STATUS=$($r.status) ERR=$((($r.body | ConvertFrom-Json).error))"
}

# N2 超大 body → 413
$big = '{"nickname":"' + ('g' * 5000) + '"}'
$r = Post "/api/rooms/$code1/join" $big $prod
$out += "N2 big-body => STATUS=$($r.status) ERR=$((($r.body | ConvertFrom-Json).error))"

# N3 缺 Origin → 403
$r = Post "/api/rooms/$code1/join" '{"nickname":"x"}' $null
$out += "N3 no-origin => STATUS=$($r.StatusCode)"

# N4 并发抢最后席位：cap2 房已 1 人，8 并发 join → 恰 1 成功
$c4 = Create 2 'racehost'
$code4 = ($c4.body | ConvertFrom-Json).code
$race = 1..8 | ForEach-Object -Parallel {
  $r = Invoke-WebRequest -Method Post -Uri ("http://127.0.0.1:8787/api/rooms/" + $using:code4 + "/join") -Headers @{Origin='https://zhengxia19.github.io'} -ContentType 'application/json' -Body ('{"nickname":"r' + "$_" + '"}') -UseBasicParsing -SkipHttpErrorCheck
  [int]$r.StatusCode
} -Throttle 8
$w = ($race | Where-Object { $_ -eq 200 }).Count
$l = ($race | Where-Object { $_ -eq 409 }).Count
$out += "N4 race-last-seat => 200=$w 409=$l OTHER=$(($race | Where-Object { $_ -ne 200 -and $_ -ne 409 }).Count)"

$out += '---'
$out | Tee-Object -FilePath D:\tcodes\Neon_Blocks\evidence\multiplayer\N11\api-local.txt
