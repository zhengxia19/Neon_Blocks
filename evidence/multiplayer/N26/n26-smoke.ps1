# N26 冒烟（真实 workerd + Hibernation）：默认环订阅路由——RUNNING 后
# guest 快照只进 host 连接（remote_snapshot targetPlayerId=guest），
# host 快照只进 guest 连接；自身快照绝不回流给自己（负向排空断言）。
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8787'
$H = @{ Origin = 'https://zhengxia19.github.io' }
$ct = [Threading.CancellationToken]::None
$fail = 0

function SendText($ws, [string]$s) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($s)
  [void]$ws.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult()
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

$create = Invoke-WebRequest -Uri "$base/api/rooms" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ nickname = 'n26host'; capacity = 2; randomMode = 'S1'; startLevel = 1 } | ConvertTo-Json) -SkipHttpErrorCheck
"CREATE=$($create.StatusCode)"
$cj = $create.Content | ConvertFrom-Json
$code = $cj.code
$join = Invoke-WebRequest -Uri "$base/api/rooms/$code/join" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ nickname = 'n26guest' } | ConvertTo-Json) -SkipHttpErrorCheck
"JOIN=$($join.StatusCode)"
$jj = $join.Content | ConvertFrom-Json
$tkH = (Invoke-WebRequest -Uri "$base/api/rooms/$code/ticket" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ playerId = $cj.playerId; seatToken = $cj.seatToken } | ConvertTo-Json) -SkipHttpErrorCheck).Content | ConvertFrom-Json
$tkG = (Invoke-WebRequest -Uri "$base/api/rooms/$code/ticket" -Method POST -Headers $H -ContentType 'application/json' -Body (@{ playerId = $jj.playerId; seatToken = $jj.seatToken } | ConvertTo-Json) -SkipHttpErrorCheck).Content | ConvertFrom-Json
$h = Connect $code $tkH.ticket
$g = Connect $code $tkG.ticket

# 1) 开局：ready/ready/start → countdown → 真实 Alarm → RUNNING
SendText $g (@{ v = 1; type = 'ready'; seq = 1 } | ConvertTo-Json -Compress)
SendText $h (@{ v = 1; type = 'ready'; seq = 1 } | ConvertTo-Json -Compress)
SendText $h (@{ v = 1; type = 'start'; seq = 2 } | ConvertTo-Json -Compress)
$cdH = $false
for ($i = 0; $i -lt 6 -and -not $cdH; $i++) { $r = Recv $h; if ($r.text -match '"countdown"') { $cdH = $true } }
"COUNTDOWN_HOST=$cdH"
if (-not $cdH) { $fail = 1 }
Start-Sleep -Milliseconds 3200

# 2) guest 快照 → 只进 host（默认环：host 观察 guest）
$snap = @{ seq = 1; board = @(1..24 | ForEach-Object { '..........' }); active = $null; score = 100; lines = 1; level = 1; status = 'running' }
SendText $g (@{ v = 1; type = 'snapshot'; seq = 3; snapshot = $snap } | ConvertTo-Json -Compress)
$rsH = $null
for ($i = 0; $i -lt 8 -and $null -eq $rsH; $i++) {
  $r = Recv $h
  if ($null -ne $r.text -and $r.text -match '"remote_snapshot"' -and $r.text -match $jj.playerId) { $rsH = $r.text }
}
"RS_TO_HOST=$rsH"
if ($null -eq $rsH) { $fail = 1 }

# 3) host 快照 → 只进 guest（guest 观察 host）
SendText $h (@{ v = 1; type = 'snapshot'; seq = 3; snapshot = $snap } | ConvertTo-Json -Compress)
$rsG = $null
for ($i = 0; $i -lt 8 -and $null -eq $rsG; $i++) {
  $r = Recv $g
  if ($null -ne $r.text -and $r.text -match '"remote_snapshot"' -and $r.text -match $cj.playerId) { $rsG = $r.text }
}
"RS_TO_GUEST=$rsG"
if ($null -eq $rsG) { $fail = 1 }

# 4) 负向：guest 自身快照不回流 guest（排空 guest 队列，无 targetPlayerId=guest 的帧）
$snap2 = $snap.Clone(); $snap2.seq = 2; $snap2.score = 200
SendText $g (@{ v = 1; type = 'snapshot'; seq = 4; snapshot = $snap2 } | ConvertTo-Json -Compress)
$selfLoop = $false
for ($i = 0; $i -lt 3; $i++) {
  $r = Recv $g
  if ($null -eq $r) { break }
  if ($null -ne $r.text -and $r.text -match '"remote_snapshot"' -and $r.text -match ('targetPlayerId":"' + $jj.playerId)) { $selfLoop = $true }
}
"SELF_LOOP=$selfLoop"
if ($selfLoop) { $fail = 1 }

"SMOKE_FAIL=$fail"
if ($fail -eq 0) { 'SMOKE_EXIT=0' } else { 'SMOKE_EXIT=1' }
