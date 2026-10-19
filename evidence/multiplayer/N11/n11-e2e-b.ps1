# N11 本地模拟验收 B 段：冲突/错误映射/并发最后席位（join 桶 14/30）
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
$r = Post '/api/rooms/123456/join' $big $prod
$out += "N2 big-body => STATUS=$($r.status) ERR=$((($r.body | ConvertFrom-Json).error))"

# N3 缺 Origin → 403（限流器之前拦截，不计入桶）
$r = Post '/api/rooms/123456/join' '{"nickname":"x"}' $null
$out += "N3 no-origin => STATUS=$($r.status)"

# N4 并发抢最后席位：cap2 房仅房主 1 人（余 1 席），8 并发 join → 恰 1 成功
$c4 = Create 2 'racehost'
$code4 = ($c4.body | ConvertFrom-Json).code
$race = 1..8 | ForEach-Object -Parallel {
  $r = Invoke-WebRequest -Method Post -Uri ("http://127.0.0.1:8787/api/rooms/" + $using:code4 + "/join") -Headers @{Origin='https://zhengxia19.github.io'} -ContentType 'application/json' -Body ('{"nickname":"r' + "$_" + '"}') -UseBasicParsing -SkipHttpErrorCheck
  [int]$r.StatusCode
} -Throttle 8
$w = ($race | Where-Object { $_ -eq 200 }).Count
$l = ($race | Where-Object { $_ -eq 409 }).Count
$other = ($race | Where-Object { $_ -ne 200 -and $_ -ne 409 }).Count
$out += "N4 race-last-seat => 200=$w 409=$l OTHER=$other"

$out += '---'
$out | Tee-Object -Append -FilePath D:\tcodes\Neon_Blocks\evidence\multiplayer\N11\api-local.txt
