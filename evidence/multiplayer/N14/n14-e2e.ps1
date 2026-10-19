# N14 E2E：Hibernation 接管 + ping/pong 事件回调 + close 释放连接声明（重连接管）。
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:8787'
$origin = 'https://zhengxia19.github.io'
$out = 'D:\tcodes\Neon_Blocks\evidence\multiplayer\N14\api-local.txt'
$lines = [System.Collections.Generic.List[string]]::new()
function Log($s) { $lines.Add($s); Write-Output $s }

function Http($method, $path, $body, $hdrOrigin) {
  $headers = @{}
  if ($null -ne $hdrOrigin) { $headers['origin'] = $hdrOrigin }
  $params = @{ Uri = "$base$path"; Method = $method; SkipHttpErrorCheck = $true; Headers = $headers }
  if ($null -ne $body) { $params['ContentType'] = 'application/json'; $params['Body'] = ($body | ConvertTo-Json -Compress) }
  $r = Invoke-WebRequest @params
  return @{ status = $r.StatusCode; body = ($r.Content | ConvertFrom-Json -ErrorAction SilentlyContinue) }
}

function New-Ws($url, $hdrOrigin) {
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  if ($null -ne $hdrOrigin) { $ws.Options.SetRequestHeader('Origin', $hdrOrigin) }
  $cts = [System.Threading.CancellationTokenSource]::new(6000)
  try {
    $ws.ConnectAsync([Uri]$url, $cts.Token).GetAwaiter().GetResult()
    return @{ ws = $ws; ok = $true }
  } catch {
    $ws.Dispose()
    return @{ ws = $null; ok = $false; err = ($_.Exception.InnerException ?? $_.Exception).Message }
  }
}

function Ws-PingPong($ws) {
  $cts = [System.Threading.CancellationTokenSource]::new(6000)
  $payload = [System.Text.Encoding]::UTF8.GetBytes('ping')
  $seg = [ReadOnlyMemory[byte]]$payload
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult()
  $buf = New-Object byte[] 4096
  $mem = [System.Memory[byte]]$buf
  $res = $ws.ReceiveAsync($mem, $cts.Token).GetAwaiter().GetResult()
  return [System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)
}

# 健康轮询
$h = $null
for ($i = 0; $i -lt 40; $i++) {
  $h = Http 'GET' '/api/health' $null $origin
  if ($h.status -eq 200) { break }
  Start-Sleep -Milliseconds 500
}
Log ("HEALTH=" + $h.status)
if ($h.status -ne 200) { $lines | Out-File -Encoding utf8 $out; exit 1 }

# 建房 + 加入
$c = Http 'POST' '/api/rooms' @{ nickname = 'hibhost'; capacity = 2; randomMode = 'S2'; startLevel = 3 } $origin
Log ("CREATE=" + $c.status + " code=" + $c.body.code)
$code = $c.body.code
$j = Http 'POST' "/api/rooms/$code/join" @{ nickname = 'hibguest' } $origin
Log ("JOIN=" + $j.status)

# 1) host 票据 → 连接 → ping/pong（事件回调 + 附件身份）
$t1 = Http 'POST' "/api/rooms/$code/ticket" @{ playerId = $c.body.playerId; seatToken = $c.body.seatToken } $origin
$w1 = New-Ws "ws://127.0.0.1:8787/ws/$code`?ticket=$($t1.body.ticket)" $origin
Log ("WS1_CONNECT=" + $w1.ok)
if ($w1.ok) {
  $pong = Ws-PingPong $w1.ws
  Log ("WS1_PONG=" + $pong)
}

# 2) 关闭连接 → close 事件释放声明 → 同席位新票据可再接管
if ($w1.ok) {
  $cts = [System.Threading.CancellationTokenSource]::new(4000)
  $w1.ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', $cts.Token).GetAwaiter().GetResult()
  $w1.ws.Dispose()
}
Start-Sleep -Seconds 2
$t2 = Http 'POST' "/api/rooms/$code/ticket" @{ playerId = $c.body.playerId; seatToken = $c.body.seatToken } $origin
Log ("TICKET2=" + $t2.status)
$w2 = New-Ws "ws://127.0.0.1:8787/ws/$code`?ticket=$($t2.body.ticket)" $origin
Log ("WS2_RECONNECT=" + $w2.ok)
if ($w2.ok) {
  $pong2 = Ws-PingPong $w2.ws
  Log ("WS2_PONG=" + $pong2)
  $cts2 = [System.Threading.CancellationTokenSource]::new(4000)
  $w2.ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', $cts2.Token).GetAwaiter().GetResult()
  $w2.ws.Dispose()
}

# 3) 重放旧票据 → 拒绝（单次语义仍成立）
$w3 = New-Ws "ws://127.0.0.1:8787/ws/$code`?ticket=$($t2.body.ticket)" $origin
Log ("WS3_REPLAY=" + ($w3 | ConvertTo-Json -Compress))

# 4) guest 席位接管 + ping/pong（多连接身份隔离）
$t3 = Http 'POST' "/api/rooms/$code/ticket" @{ playerId = $j.body.playerId; seatToken = $j.body.seatToken } $origin
$w4 = New-Ws "ws://127.0.0.1:8787/ws/$code`?ticket=$($t3.body.ticket)" $origin
Log ("WS4_GUEST=" + $w4.ok)
if ($w4.ok) {
  $pong3 = Ws-PingPong $w4.ws
  Log ("WS4_PONG=" + $pong3)
  $cts3 = [System.Threading.CancellationTokenSource]::new(4000)
  $w4.ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', $cts3.Token).GetAwaiter().GetResult()
  $w4.ws.Dispose()
}

$lines | Out-File -Encoding utf8 $out
