@echo off
setlocal

set BLENDER="C:\Program Files\Blender Foundation\Blender 5.1\blender.exe"
set SCRIPTDIR=%~dp0
set REF=%SCRIPTDIR%refs\brunette.glb
set TARGET=C:\Users\sebas\Downloads\stylized+character+3d+model (1).glb
set ADDON=%SCRIPTDIR%refs\talkinghead-addon.py
set OUTPUT=%SCRIPTDIR%..\..\web\public\custom_avatar.glb
REM Retopologized Tripo export (50k tris): no decimation needed
set DECIMATE=1.0
REM manglara.glb faces +X; TalkingHead needs glTF +Z (Blender -Y)
set TARGET_YAW=-90
REM Stylized big-head character: extra scale so her eyes hit the reference
REM eye height (1.634) instead of matching total heights. See transfer_rig.py.
set SCALE_MULT=1.135

if not exist %BLENDER% (
    echo Blender not found at %BLENDER%
    exit /b 1
)

echo Starting Blender headless rig transfer...
echo   Ref: %REF%
echo   Target: %TARGET%
echo   Output: %OUTPUT%
echo   Decimate: %DECIMATE%

%BLENDER% -b -noaudio -P "%SCRIPTDIR%transfer_rig.py" -- --ref "%REF%" --target "%TARGET%" --output "%OUTPUT%" --addon "%ADDON%" --decimate-ratio %DECIMATE% --target-yaw %TARGET_YAW% --scale-mult %SCALE_MULT%

if %ERRORLEVEL% neq 0 (
    echo Pipeline FAILED
    exit /b 1
)

echo Pipeline completed.
echo Output: %OUTPUT%
endlocal
