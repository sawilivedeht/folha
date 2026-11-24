#!/usr/bin/env bash
# Sobe o emulador "folha-teste" (headless), instala o APK debug e abre o app.
# Uso: scripts/android-emulator.sh [caminho-do-apk]
set -euo pipefail

SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
ADB="$SDK/platform-tools/adb"
APK="${1:-$(dirname "$0")/../android/app/build/outputs/apk/debug/app-debug.apk}"
AVD="${AVD:-folha-teste}"
LOG="${TMPDIR:-/tmp}/folha-emulador.log"

if ! "$ADB" devices | grep -q '^emulator-'; then
  echo "Subindo o emulador $AVD (log em $LOG)..."
  nohup "$SDK/emulator/emulator" -avd "$AVD" -no-window -no-audio -no-boot-anim \
    -no-snapshot -gpu swiftshader_indirect >"$LOG" 2>&1 &
fi

"$ADB" wait-for-device
echo "Esperando sys.boot_completed..."
until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
"$ADB" shell input keyevent KEYCODE_WAKEUP || true
"$ADB" shell wm dismiss-keyguard || true

echo "Instalando $APK..."
"$ADB" install -r "$APK"
"$ADB" shell am start -n app.folha.leitor/.MainActivity
echo "Pronto."
