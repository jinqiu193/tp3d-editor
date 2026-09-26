@echo off
chcp 65001 >nul
setlocal

rem 切换到脚本所在目录
cd /d "%~dp0"

rem 查找 python 解释器
where python >nul 2>nul
if %errorlevel% neq 0 (
    where py >nul 2>nul
    if %errorlevel% neq 0 (
        echo [错误] 未找到 Python，请先安装 Python 3 并加入 PATH。
        pause
        exit /b 1
    )
    set "PY=py"
) else (
    set "PY=python"
)

set "PORT=8137"
set "URL=http://127.0.0.1:%PORT%"

rem 检查端口是否已被占用（已有实例在跑则直接打开浏览器）
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>nul
if %errorlevel% equ 0 (
    echo 服务器已在运行，直接打开浏览器...
    start "" "%URL%"
    exit /b 0
)

echo 正在启动 TP3D 户型编辑器...
echo 地址: %URL%
echo 关闭此窗口即可停止服务器。

rem 后台启动服务器
start "TP3D-Server" /min "%PY%" "%~dp0_serve.py" %PORT%

rem 等待端口就绪（最多 10 秒）
set /a tries=0
:wait
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>nul
if %errorlevel% equ 0 goto open
set /a tries+=1
if %tries% lss 10 goto wait

echo [警告] 服务器未能在 10 秒内就绪，请检查 _serve.py 是否正常。

:open
start "" "%URL%"
endlocal