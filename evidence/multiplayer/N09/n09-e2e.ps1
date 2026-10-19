# N09 本地模拟验收：并发分配 + 释放复用代际隔离 + 反例
$ErrorActionPreference = 'Stop'
$out = @()
function PostJson($uri, $headers) {
  $r = Invoke-WebRequest -Method Post -Uri $uri -Headers $headers -UseBasicParsing -SkipHttpErrorCheck
  return @{ status = $r.StatusCode; body = $r.Content }
}
function Batch($n) {
  1..$n | ForEach-Object -Throttle 20 -Parallel {
    $r = Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:8787/api/__create' -UseBasicParsing -SkipHttpErrorCheck
    if ($r.StatusCode -ne 200) { return "STATUS=$($r.StatusCode)" }
    ($r.Content | ConvertFrom-Json).code
  } | ForEach-Object { $_ }
}

Start-Sleep -Seconds 12

# P1 首次创建
$p1 = PostJson 'http://127.0.0.1:8787/api/__create' @{}
$out += "P1 create => STATUS=$($p1.status) BODY=$($p1.body)"

# P2 并发 50
$b50 = Batch 50
$u50 = ($b50 | Sort-Object -Unique)
$out += "P2 concurrent-50 => COUNT=$($b50.Count) UNIQUE=$($u50.Count) NON200=$(($b50 | Where-Object { $_ -like 'STATUS=*' }).Count)"

# P3 并发 100（与 P2 合并校验全局唯一）
$b100 = Batch 100
$all = @($b50) + @($b100)
$allUnique = ($all | Sort-Object -Unique)
$out += "P3 concurrent-100 => COUNT=$($b100.Count) UNIQUE=$(($b100 | Sort-Object -Unique).Count) ALL150_UNIQUE=$($allUnique.Count) NON200=$(($all | Where-Object { $_ -like 'STATUS=*' }).Count)"

# P4 释放并复用原码：旧代际凭据失效，新代际有效
$x = (($p1.body | ConvertFrom-Json).code)
$rel = PostJson "http://127.0.0.1:8787/api/__release/$x" @{}
$out += "P4a release-$x => STATUS=$($rel.status) BODY=$($rel.body)"
$cl = PostJson "http://127.0.0.1:8787/api/__claim/$x" @{}
$out += "P4b reclaim-$x => STATUS=$($cl.status) BODY=$($cl.body)"
$v1 = PostJson "http://127.0.0.1:8787/api/__verify/$x/1" @{}
$out += "P4c verify-old-gen1-$x => STATUS=$($v1.status) BODY=$($v1.body)"
$v2 = PostJson "http://127.0.0.1:8787/api/__verify/$x/2" @{}
$out += "P4d verify-new-gen2-$x => STATUS=$($v2.status) BODY=$($v2.body)"

# N1 非法码
$n1 = PostJson 'http://127.0.0.1:8787/api/__claim/099999' @{}
$out += "N1 claim-099999 => STATUS=$($n1.status) BODY=$($n1.body)"

# N2 非法 Origin
$n2 = PostJson 'http://127.0.0.1:8787/api/__create' @{ Origin = 'https://evil.example' }
$out += "N2 create-evil-origin => STATUS=$($n2.status) BODY=$($n2.body)"

# N3 已占用码重复 claim：claimed=false 且代际不变
$n3 = PostJson "http://127.0.0.1:8787/api/__claim/$x" @{}
$out += "N3 double-claim-$x => STATUS=$($n3.status) BODY=$($n3.body)"

# N4 错误方法（GET __create）→ 404
$n4 = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/__create' -UseBasicParsing -SkipHttpErrorCheck
$n4s = if ($null -ne $n4.StatusCode) { $n4.StatusCode } else { 'NONE' }
$out += "N4 get-create => STATUS=$n4s BODY=$($n4.Content)"

$out += '---'
$out | Tee-Object -FilePath D:\tcodes\Neon_Blocks\evidence\multiplayer\N09\concurrency-local.txt
