# N11 本地模拟验收 A 段：容量 2–6 逐一（join 桶 20/30）
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

# P1 容量 2：加入 1 人成功、第 3 人满员拒绝
$c1 = Create 2 'h1'
$code1 = ($c1.body | ConvertFrom-Json).code
$j1 = Post "/api/rooms/$code1/join" '{"nickname":"guest1"}' $prod
$j2 = Post "/api/rooms/$code1/join" '{"nickname":"guest2"}' $prod
$out += "P1 cap2 join1 => STATUS=$($j1.status) BODY=$($j1.body)"
$out += "P1 cap2 join2(full) => STATUS=$($j2.status) ERR=$((($j2.body | ConvertFrom-Json).error))"

# P2 容量 3..6 逐一：加入 capacity-1 人全 200，再加 1 人 409
foreach ($cap in 3..6) {
  $c = Create $cap ("hcap$cap")
  $code = ($c.body | ConvertFrom-Json).code
  $statuses = @()
  for ($i = 1; $i -lt $cap; $i++) {
    $j = Post "/api/rooms/$code/join" ('{"nickname":"g' + $cap + 'x' + $i + '"}') $prod
    $statuses += $j.status
  }
  $overflow = Post "/api/rooms/$code/join" ('{"nickname":"over' + $cap + '"}') $prod
  $out += "P2 cap$cap joins=[$($statuses -join ',')] overflow => STATUS=$($overflow.status) ERR=$((($overflow.body | ConvertFrom-Json).error))"
}

$out | Tee-Object -FilePath D:\tcodes\Neon_Blocks\evidence\multiplayer\N11\api-local.txt
