@echo off
if "%~1"=="" (
  node --experimental-transform-types --disable-warning=ExperimentalWarning "%~dp0src\cli.ts" fixture browser assist
  pause
  exit /b
)
node --experimental-transform-types --disable-warning=ExperimentalWarning "%~dp0src\cli.ts" %*
exit /b %errorlevel%
