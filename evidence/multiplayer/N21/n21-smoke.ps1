# N21 冒烟：全员意外断开 → 空置起点（席位数据存续）→ 原令牌重连恢复；
# 反向：错误令牌换票 401。30 分钟到期清理由假时钟单测覆盖（冒烟不等待 TTL）。
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

# 1) host/guest 首连
$s1 = Connect-Seat $cj.playerId $cj.seatToken
"HOST_CONNECT=$($s1.ok) PONG=$($s1.pong)"
$s2 = Connect-Seat $jj.playerId $jj.seatToken
"GUEST_CONNECT=$($s2.ok) PONG=$($s2.pong)"
# 2) 全员意外断开（最后连接关闭 → 空置起点记录；30 分钟 TTL 内席位数据存续）
$ct0 = [Threading.CancellationToken]::None
try { $s1.ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', $ct0).Wait() } catch { "HOST_CLOSE_NOTE=$($_.Exception.InnerException.Message)" }
try { $s2.ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', $ct0).Wait() } catch { "GUEST_CLOSE_NOTE=$($_.Exception.InnerException.Message)" }
"ALL_CLOSED"
Start-Sleep -Milliseconds 1500
# 3) 空置期内原令牌换票重连（业务记录仍在 → 票据签发成功、连接恢复）
$s3 = Connect-Seat $cj.playerId $cj.seatToken
"HOST_RECONNECT_AFTER_IDLE=$($s3.ok) PONG=$($s3.pong)"
if (-not $s3.ok) { "RECONNECT_FAIL_STEP=$($s3.step)" }
$s4 = Connect-Seat $jj.playerId $jj.seatToken
"GUEST_RECONNECT_AFTER_IDLE=$($s4.ok) PONG=$($s4.pong)"
# 4) 反向：错误 seatToken 换票 401（席位核验仍严格）
$bad = Invoke-WebRequest -Uri "$base/api/rooms/$code/ticket" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ playerId = $cj.playerId; seatToken = ('x' * 64) } | ConvertTo-Json) -SkipHttpErrorCheck
"TICKET_BAD=$($bad.StatusCode)"
'DONE'
