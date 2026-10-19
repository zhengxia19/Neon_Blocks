# N22 冒烟：正常好友访问不误拒（create/join/WS 首路全通）；高频创建被限流
# （429 + retry-after）；限流桶相互独立（创建桶耗尽不影响 join）；试码冷却
# （对不存在房间的高频 join 达预算后 429）。本地 dev 全部请求共享 'no-cf' IP 桶。
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8787'
$H = @{ Origin = 'https://zhengxia19.github.io' }
$fail = 0

$health = Invoke-WebRequest -Uri "$base/api/health" -SkipHttpErrorCheck
"HEALTH=$($health.StatusCode)"

$create = Invoke-WebRequest -Uri "$base/api/rooms" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ nickname = 'smhost'; capacity = 3; randomMode = 'S1'; startLevel = 1 } | ConvertTo-Json) -SkipHttpErrorCheck
"CREATE=$($create.StatusCode)"
$cj = $create.Content | ConvertFrom-Json
$code = $cj.code

$join = Invoke-WebRequest -Uri "$base/api/rooms/$code/join" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ nickname = 'smguest' } | ConvertTo-Json) -SkipHttpErrorCheck
"JOIN=$($join.StatusCode)"

# 正常 WS 路径不误拒：host 换票 → 连接 → ping/pong
$tk = Invoke-WebRequest -Uri "$base/api/rooms/$code/ticket" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ playerId = $cj.playerId; seatToken = $cj.seatToken } | ConvertTo-Json) -SkipHttpErrorCheck
$wsOk = $false
if ($tk.StatusCode -eq 200) {
  $tj = $tk.Content | ConvertFrom-Json
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  $ws.Options.SetRequestHeader('Origin', 'https://zhengxia19.github.io')
  $uri = [Uri]"ws://127.0.0.1:8787/ws/$code`?ticket=$($tj.ticket)"
  $ct = [Threading.CancellationToken]::None
  try {
    [void]$ws.ConnectAsync($uri, $ct).Wait()
    $bytes = [Text.Encoding]::UTF8.GetBytes('ping')
    [void]$ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult()
    $buf = New-Object byte[] 4096
    $res = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $ct).Result
    $wsOk = ($ws.State -eq 'Open')
    "WS_OPEN=$wsOk PONG=$([Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))"
  } catch { "WS_ERR=$($_.Exception.Message)" }
  try { [void]$ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', $ct).Wait() } catch {}
} else { "TICKET=$($tk.StatusCode)"; $fail = 1 }

# 1) 高频创建：本 IP 已用 1 次，限额 30 → 再 34 次应得 29×201 + 5×429
$ok201 = 0; $n429 = 0; $ra = ''
for ($i = 0; $i -lt 34; $i++) {
  $r = Invoke-WebRequest -Uri "$base/api/rooms" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ nickname = 'burst'; capacity = 4; randomMode = 'S1'; startLevel = 1 } | ConvertTo-Json) -SkipHttpErrorCheck
  if ($r.StatusCode -eq 201) { $ok201++ } elseif ($r.StatusCode -eq 429) { $n429++; if ($ra -eq '') { $ra = ($r.Headers['Retry-After'] | Select-Object -First 1) } }
}
"CREATE_BURST_201=$ok201 N429=$n429 RETRY_AFTER=$ra"
if ($ok201 -ne 29 -or $n429 -ne 5 -or -not ($ra -match '^\d+$' -and [int]$ra -ge 1)) { $fail = 1 }

# 2) 桶独立：创建桶耗尽后，既有房间 join 仍 200
$join2 = Invoke-WebRequest -Uri "$base/api/rooms/$code/join" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ nickname = 'smguest2' } | ConvertTo-Json) -SkipHttpErrorCheck
"JOIN_AFTER_CREATE_LIMIT=$($join2.StatusCode)"
if ($join2.StatusCode -ne 200) { $fail = 1 }

# 3) 试码冷却：对不存在房间连续 join 24 次（预算 20）→ 20×404 后 429
$n404 = 0; $p429 = 0; $pra = ''
for ($i = 0; $i -lt 24; $i++) {
  $probeCode = '210{0:d3}' -f $i
  $r = Invoke-WebRequest -Uri "$base/api/rooms/$probeCode/join" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ nickname = 'prober' } | ConvertTo-Json) -SkipHttpErrorCheck
  if ($r.StatusCode -eq 404) { $n404++ } elseif ($r.StatusCode -eq 429) { $p429++; if ($pra -eq '') { $pra = ($r.Headers['Retry-After'] | Select-Object -First 1) } }
}
"PROBE_BURST_404=$n404 N429=$p429 RETRY_AFTER=$pra"
if ($n404 -ne 20 -or $p429 -ne 4 -or -not ($pra -match '^\d+$' -and [int]$pra -ge 1)) { $fail = 1 }

"SMOKE_FAIL=$fail"
if ($fail -eq 0) { 'SMOKE_EXIT=0' } else { 'SMOKE_EXIT=1' }
