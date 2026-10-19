# N17 冒烟回归：Alarm 面与构造器重建下既有 HTTP+WS 面不受影响。
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8787'
$H = @{ Origin = 'https://zhengxia19.github.io' }

$health = Invoke-WebRequest -Uri "$base/api/health" -SkipHttpErrorCheck
"HEALTH=$($health.StatusCode)"

$create = Invoke-WebRequest -Uri "$base/api/rooms" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ nickname = 'smhost'; capacity = 3; randomMode = 'S1'; startLevel = 1 } | ConvertTo-Json) -SkipHttpErrorCheck
"CREATE=$($create.StatusCode)"
$cj = $create.Content | ConvertFrom-Json
$code = $cj.code
"CODE=$code"

$join = Invoke-WebRequest -Uri "$base/api/rooms/$code/join" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ nickname = 'smguest' } | ConvertTo-Json) -SkipHttpErrorCheck
"JOIN=$($join.StatusCode)"
$jj = $join.Content | ConvertFrom-Json

# WS 回归（N14 语义）：host 票据 → 连接 → ping/pong
$tk = Invoke-WebRequest -Uri "$base/api/rooms/$code/ticket" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ playerId = $cj.playerId; seatToken = $cj.seatToken } | ConvertTo-Json) -SkipHttpErrorCheck
"TICKET=$($tk.StatusCode)"
$tj = $tk.Content | ConvertFrom-Json

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.Options.SetRequestHeader('Origin', 'https://zhengxia19.github.io')
$uri = [Uri]"ws://127.0.0.1:8787/ws/$code`?ticket=$($tj.ticket)"
$ct = [Threading.CancellationToken]::None
try {
  $ws.ConnectAsync($uri, $ct).Wait()
  "WS_CONNECT=$($ws.State -eq 'Open')"
  $bytes = [Text.Encoding]::UTF8.GetBytes('ping')
  $seg = [ArraySegment[byte]]::new($bytes)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult()
  $buf = New-Object byte[] 4096
  $res = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $ct).Result
  "WS_PONG=$([Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))"
  $ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', $ct).Wait()
} catch {
  "WS_ERR=$($_.Exception.Message)"
}

# 反向：错误 seatToken 换票 401
$bad = Invoke-WebRequest -Uri "$base/api/rooms/$code/ticket" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ playerId = $cj.playerId; seatToken = ('x' * 64) } | ConvertTo-Json) -SkipHttpErrorCheck
"TICKET_BAD=$($bad.StatusCode) $($bad.Content)"

# 状态机无 HTTP 面（N16 协议承载）：确认未知路径 404
$np = Invoke-WebRequest -Uri "$base/api/rooms/$code/start" -Method POST -Headers $H -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck
"NO_STATE_ROUTE=$($np.StatusCode)"
'DONE'
