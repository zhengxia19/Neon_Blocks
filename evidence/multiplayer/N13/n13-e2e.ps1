# N13 E2E：票据换发 + WS 握手（单次/重放/席位占用/Origin 必检）。
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:8787'
$origin = 'https://zhengxia19.github.io'
$out = 'D:\tcodes\Neon_Blocks\evidence\multiplayer\N13\api-local.txt'
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

function Try-Ws($url, $hdrOrigin) {
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  if ($null -ne $hdrOrigin) { $ws.Options.SetRequestHeader('Origin', $hdrOrigin) }
  $cts = [System.Threading.CancellationTokenSource]::new(6000)
  try {
    $ws.ConnectAsync([Uri]$url, $cts.Token).GetAwaiter().GetResult()
    $state = $ws.State.ToString()
    $ws.Dispose()
    return @{ ok = $true; state = $state }
  } catch {
    $ws.Dispose()
    return @{ ok = $false; err = ($_.Exception.InnerException ?? $_.Exception).Message }
  }
}

# 健康轮询
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  $h = Http 'GET' '/api/health' $null $origin
  if ($h.status -eq 200) { $ok = $true; break }
  Start-Sleep -Milliseconds 500
}
Log ("HEALTH=" + $h.status)
if (-not $ok) { $lines | Out-File -Encoding utf8 $out; exit 1 }

# 1) 建房 + 加入
$c = Http 'POST' '/api/rooms' @{ nickname = 'e2ehost'; capacity = 2; randomMode = 'S1'; startLevel = 1 } $origin
Log ("CREATE=" + $c.status + " code=" + $c.body.code)
$code = $c.body.code
$j = Http 'POST' "/api/rooms/$code/join" @{ nickname = 'e2eguest' } $origin
Log ("JOIN=" + $j.status + " pid2=" + $j.body.playerId)

# 2) 正向：host 票据 → WS 连接成功
$t1 = Http 'POST' "/api/rooms/$code/ticket" @{ playerId = $c.body.playerId; seatToken = $c.body.seatToken } $origin
Log ("TICKET1=" + $t1.status + " ticketLen=" + ($t1.body.ticket | Out-String).Trim().Length)
$ws1 = Try-Ws "ws://127.0.0.1:8787/ws/$code`?ticket=$($t1.body.ticket)" $origin
Log ("WS1=" + ($ws1 | ConvertTo-Json -Compress))

# 3) 重放同一票据 → 拒绝
$ws2 = Try-Ws "ws://127.0.0.1:8787/ws/$code`?ticket=$($t1.body.ticket)" $origin
Log ("WS2_REPLAY=" + ($ws2 | ConvertTo-Json -Compress))

# 4) 同席位再签票据 → SEAT_TAKEN 拒绝（连接声明仍占用）
$t2 = Http 'POST' "/api/rooms/$code/ticket" @{ playerId = $c.body.playerId; seatToken = $c.body.seatToken } $origin
$ws3 = Try-Ws "ws://127.0.0.1:8787/ws/$code`?ticket=$($t2.body.ticket)" $origin
Log ("WS3_SEATTAKEN=" + ($ws3 | ConvertTo-Json -Compress))

# 5) 另一席位（guest）连接成功
$t3 = Http 'POST' "/api/rooms/$code/ticket" @{ playerId = $j.body.playerId; seatToken = $j.body.seatToken } $origin
$ws4 = Try-Ws "ws://127.0.0.1:8787/ws/$code`?ticket=$($t3.body.ticket)" $origin
Log ("WS4_GUEST=" + ($ws4 | ConvertTo-Json -Compress))

# 6) 未知票据 → 拒绝
$ws5 = Try-Ws "ws://127.0.0.1:8787/ws/$code`?ticket=$('a' * 32)" $origin
Log ("WS5_UNKNOWN=" + ($ws5 | ConvertTo-Json -Compress))

# 7) 缺 Origin → 拒绝
$ws6 = Try-Ws "ws://127.0.0.1:8787/ws/$code`?ticket=$('b' * 32)" $null
Log ("WS6_NOORIGIN=" + ($ws6 | ConvertTo-Json -Compress))

# 8) HTTP 反向：错误 seatToken → 401；不存在房间 → 404
$bad = Http 'POST' "/api/rooms/$code/ticket" @{ playerId = $c.body.playerId; seatToken = ('z' * 64) } $origin
Log ("TICKET_BADTOKEN=" + $bad.status + " err=" + $bad.body.error)
$nf = Http 'POST' '/api/rooms/999999/ticket' @{ playerId = $c.body.playerId; seatToken = $c.body.seatToken } $origin
Log ("TICKET_NOTFOUND=" + $nf.status + " err=" + $nf.body.error)

$lines | Out-File -Encoding utf8 $out
