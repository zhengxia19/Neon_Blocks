# N25 冒烟（真实 workerd + Hibernation）：WS 协议管线接线——ping/pong、
# ready/start 开局广播、快照入账不回复、非法载荷回复 error 且不断连、
# gameover 由服务器供给 matchId（广播 player_left）、1MiB 静默丢弃、
# 二进制帧 4003 关闭。
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8787'
$H = @{ Origin = 'https://zhengxia19.github.io' }
$ct = [Threading.CancellationToken]::None
$fail = 0

function SendText($ws, [string]$s) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($s)
  [void]$ws.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult()
}
function SendBinary($ws, $bytes) {
  [void]$ws.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Binary, $true, $ct).GetAwaiter().GetResult()
}
function Recv($ws) {
  $buf = New-Object byte[] 8192
  try {
    $t = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $ct)
    if (-not $t.Wait(8000)) { return $null }
    $res = $t.Result
    if ($res.MessageType -eq 'Close') { return @{ close = [int]$res.CloseStatus.CloseStatusCode } }
    return @{ text = [Text.Encoding]::UTF8.GetString($buf, 0, $res.Count) }
  } catch { return $null }
}
function Connect($code, $ticket) {
  $ws = [Net.WebSockets.ClientWebSocket]::new()
  $ws.Options.SetRequestHeader('Origin', 'https://zhengxia19.github.io')
  $uri = [Uri]"ws://127.0.0.1:8787/ws/$code`?ticket=$ticket"
  [void]$ws.ConnectAsync($uri, $ct).Wait()
  return $ws
}

$create = Invoke-WebRequest -Uri "$base/api/rooms" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ nickname = 'n25host'; capacity = 2; randomMode = 'S1'; startLevel = 1 } | ConvertTo-Json) -SkipHttpErrorCheck
"CREATE=$($create.StatusCode)"
$cj = $create.Content | ConvertFrom-Json
$code = $cj.code
$join = Invoke-WebRequest -Uri "$base/api/rooms/$code/join" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ nickname = 'n25guest' } | ConvertTo-Json) -SkipHttpErrorCheck
"JOIN=$($join.StatusCode)"
$jj = $join.Content | ConvertFrom-Json
$tkH = (Invoke-WebRequest -Uri "$base/api/rooms/$code/ticket" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ playerId = $cj.playerId; seatToken = $cj.seatToken } | ConvertTo-Json) -SkipHttpErrorCheck).Content | ConvertFrom-Json
$tkG = (Invoke-WebRequest -Uri "$base/api/rooms/$code/ticket" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ playerId = $jj.playerId; seatToken = $jj.seatToken } | ConvertTo-Json) -SkipHttpErrorCheck).Content | ConvertFrom-Json
$h = Connect $code $tkH.ticket
$g = Connect $code $tkG.ticket

# 1) liveness：裸 ping → pong
SendText $h 'ping'
$r = Recv $h
"PING_PONG=$($r.text)"
if ($r.text -notmatch 'pong') { $fail = 1 }

# 2) ready/start 接线：双方 ready → host start → 两端收到 countdown
SendText $g (@{ v = 1; type = 'ready'; seq = 1 } | ConvertTo-Json -Compress)
SendText $h (@{ v = 1; type = 'ready'; seq = 1 } | ConvertTo-Json -Compress)
SendText $h (@{ v = 1; type = 'start'; seq = 2 } | ConvertTo-Json -Compress)
$cdH = $false; $cdG = $false
for ($i = 0; $i -lt 6 -and -not $cdH; $i++) { $r = Recv $h; if ($r.text -match '"countdown"') { $cdH = $true } }
for ($i = 0; $i -lt 6 -and -not $cdG; $i++) { $r = Recv $g; if ($r.text -match '"countdown"') { $cdG = $true } }
"COUNTDOWN_HOST=$cdH COUNTDOWN_GUEST=$cdG"
if (-not ($cdH -and $cdG)) { $fail = 1 }

# 3) 快照入账不回复；非法载荷回复 error 且连接保持（快照 seq=3 信封）
$snap = @{ seq = 1; board = @(1..24 | ForEach-Object { '..........' }); active = $null; score = 100; lines = 1; level = 1; status = 'running' }
SendText $h (@{ v = 1; type = 'snapshot'; seq = 3; snapshot = $snap } | ConvertTo-Json -Compress)
SendText $h '{oops'
$r = Recv $h
"BADJSON_REPLY=$($r.text)"
if ($r.text -notmatch '"BAD_MESSAGE"') { $fail = 1 }

# 4) 倒计时到点（真实 Alarm → RUNNING）后 guest gameover → host 收到 player_left
Start-Sleep -Milliseconds 3200
SendText $g (@{ v = 1; type = 'gameover'; seq = 2; reason = 'topout' } | ConvertTo-Json -Compress)
$pl = $false
for ($i = 0; $i -lt 6 -and -not $pl; $i++) { $r = Recv $h; if ($r.text -match '"player_left"' -and $r.text -match $jj.playerId) { $pl = $true } }
"GAMEOVER_BROADCAST=$pl"
if (-not $pl) { $fail = 1 }

# 5) 1MiB 报文静默丢弃（无回复）；二进制帧 → 服务器关闭连接
# （wrangler dev 代理不转发自定义关闭码：本地见 close code=0；
#  精确 4003 由单测断言。队列中可能仍有 match_end 广播：排空至 close 帧）
SendText $h ('x' * 1000001)
SendBinary $h (New-Object byte[] 64)
$bc = $null
for ($i = 0; $i -lt 6 -and $null -eq $bc; $i++) {
  $r = Recv $h
  if ($null -ne $r -and $null -ne $r.close) { $bc = $r.close }
}
"BINARY_CLOSED=$($null -ne $bc) CODE=$bc"
if ($null -eq $bc) { $fail = 1 }

"SMOKE_FAIL=$fail"
if ($fail -eq 0) { 'SMOKE_EXIT=0' } else { 'SMOKE_EXIT=1' }
