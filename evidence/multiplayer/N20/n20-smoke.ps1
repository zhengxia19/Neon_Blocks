# N20 冒烟：断线重连（旧 socket 关闭 → 原令牌换票 → 新连接接管）与席位存续。
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

function Connect-Seat([string]$playerId, [string]$seatToken) {
  $tk = Invoke-WebRequest -Uri "$base/api/rooms/$code/ticket" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ playerId = $playerId; seatToken = $seatToken } | ConvertTo-Json) -SkipHttpErrorCheck
  if ($tk.StatusCode -ne 200) { return @{ ok = $false; step = "TICKET=$($tk.StatusCode)" } }
  $tj = $tk.Content | ConvertFrom-Json
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  $ws.Options.SetRequestHeader('Origin', 'https://zhengxia19.github.io')
  $uri = [Uri]"ws://127.0.0.1:8787/ws/$code`?ticket=$($tj.ticket)"
  $ct = [Threading.CancellationToken]::None
  try {
    $ws.ConnectAsync($uri, $ct).Wait()
    $bytes = [Text.Encoding]::UTF8.GetBytes('ping')
    $ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult()
    $buf = New-Object byte[] 4096
    $res = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $ct).Result
    return @{ ok = ($ws.State -eq 'Open'); pong = [Text.Encoding]::UTF8.GetString($buf, 0, $res.Count); ws = $ws }
  } catch {
    return @{ ok = $false; step = "WS_ERR=$($_.Exception.Message)" }
  }
}

# 1) host 首连
$s1 = Connect-Seat $cj.playerId $cj.seatToken
"HOST_CONNECT=$($s1.ok) PONG=$($s1.pong)"
# 2) host 断线（主动关闭 → 服务端 webSocketClose 标记断线）
$ct0 = [Threading.CancellationToken]::None
#    （miniflare 下关闭握手不回包属已知表象，异常吞掉即可）
try { $s1.ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', $ct0).Wait() } catch { "HOST_CLOSE_NOTE=$($_.Exception.InnerException.Message)" }
"HOST_CLOSED"
Start-Sleep -Milliseconds 500
# 3) 原令牌换票重连（席位存续、不新增玩家）
$s2 = Connect-Seat $cj.playerId $cj.seatToken
"HOST_RECONNECT=$($s2.ok) PONG=$($s2.pong)"
if (-not $s2.ok) { "RECONNECT_FAIL_STEP=$($s2.step)" }
# 4) guest 席位不受影响（席位数不变）
$s3 = Connect-Seat $jj.playerId $jj.seatToken
"GUEST_CONNECT=$($s3.ok) PONG=$($s3.pong)"
# 5) 反向：错误 seatToken 换票 401
$bad = Invoke-WebRequest -Uri "$base/api/rooms/$code/ticket" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ playerId = $cj.playerId; seatToken = ('x' * 64) } | ConvertTo-Json) -SkipHttpErrorCheck
"TICKET_BAD=$($bad.StatusCode)"
# 6) 反向：陌生 playerId 换票 4xx
$unk = Invoke-WebRequest -Uri "$base/api/rooms/$code/ticket" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ playerId = 'p_nosuchseat'; seatToken = ('y' * 64) } | ConvertTo-Json) -SkipHttpErrorCheck
"TICKET_UNKNOWN=$($unk.StatusCode)"
'DONE'
