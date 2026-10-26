param([switch]$NoBuild)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskMysqlExe='C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe'
$taskMysqlConfig=Join-Path $taskRoot 'data\mysql\my.ini'
if(-not (Get-NetTCPConnection -State Listen -LocalPort 3307 -ErrorAction SilentlyContinue)) {
  if(-not (Test-Path -LiteralPath $taskMysqlConfig)) { throw 'Project MySQL configuration missing. Use Docker Compose or configure DATABASE_URL.' }
  Start-Process -FilePath $taskMysqlExe -ArgumentList "--defaults-file=`"$taskMysqlConfig`"" -WindowStyle Hidden
  $taskReady=$false
  for($taskAttempt=0;$taskAttempt -lt 30;$taskAttempt++){if(Get-NetTCPConnection -State Listen -LocalPort 3307 -ErrorAction SilentlyContinue){$taskReady=$true;break};Start-Sleep -Seconds 1}
  if(-not $taskReady){throw 'Dedicated MySQL did not start; inspect data/mysql/mysql.log.'}
}
if(-not (Get-NetTCPConnection -State Listen -LocalPort 6380 -ErrorAction SilentlyContinue)) {
  $taskDrive=$taskRoot.Substring(0,1).ToLower()
  $taskRedisConfig='/mnt/'+$taskDrive+($taskRoot.Substring(2) -replace '\\','/')+'/data/redis/redis.conf'
  & wsl -d Ubuntu -u root -- redis-server $taskRedisConfig
  if($LASTEXITCODE -ne 0){throw 'Project Redis could not start in WSL Ubuntu.'}
}
if(-not $NoBuild){ & pnpm build; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE} }
& pnpm start
exit $LASTEXITCODE
