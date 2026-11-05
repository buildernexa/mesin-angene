#!/usr/bin/env bash
# language: Bash, file: scripts/build.sh
set -Eeuo pipefail

INPUT_DIR="${1:?input dir}"
WORK_DIR="${2:?work dir}"
BUILD_ID="${3:-build-$(date +%s)}"
REPO="${GH_REPO:?GH_REPO}"

LOG="$WORK_DIR/build.log"
OUT="$WORK_DIR/out"
LOGS="$WORK_DIR/logs"
PHASE=0
PHASE_LAST_LINE=0
STREAM_LAST_LINE=0
TYPE=debug
FMT=apk

mkdir -p "$WORK_DIR" "$OUT" "$LOGS"
: > "$LOG"

say()  { printf '%s\n' "$*" | tee -a "$LOG"; }
fail() { say "BUILD FAILED: $*"; gh release upload "build-$BUILD_ID" "$LOG#build.log" --clobber --repo "$REPO" 2>/dev/null || true; exit 1; }

upload_phase() {
  local next current baseline slice
  next=$((PHASE + 1))
  current=$(wc -l < "$LOG")
  baseline=$PHASE_LAST_LINE
  (( STREAM_LAST_LINE > baseline )) && baseline=$STREAM_LAST_LINE
  (( current > baseline )) || return 0
  slice="$LOGS/log-$next.txt"
  {
    printf '#NEXA-PHASE start=%s end=%s\n' "$((baseline + 1))" "$current"
    awk -v prev="$baseline" 'NR > prev' "$LOG"
  } > "$slice"
  if gh release upload "build-$BUILD_ID" "$slice#log-$next.txt" --clobber --repo "$REPO" >/dev/null 2>&1; then
    PHASE=$next
    PHASE_LAST_LINE=$current
  else
    say "[warn] unggah log tahap $next gagal; akan dicoba lagi pada tahap berikutnya"
  fi
}

[[ "$BUILD_ID" =~ ^[a-zA-Z0-9_-]{4,64}$ ]] || fail "build_id tidak valid"
META="$INPUT_DIR/$BUILD_ID.json"
test -s "$META" || fail "metadata build kosong"
TYPE=$(jq -r '.meta.type // "debug"' "$META")
FMT=$(jq -r '.meta.fmt // "apk"' "$META")
GARGS=$(jq -r '.meta.options.gradleArgs // ""' "$META")
OFFLINE=$(jq -r '.meta.options.offline // false' "$META")
CLEAN=$(jq -r '.meta.options.clean // false' "$META")
CACHE=$(jq -r '.meta.options.cache // true' "$META")
TMO=$(jq -r '.meta.options.timeoutMin // 120' "$META")
[[ "$TYPE" == "debug" || "$TYPE" == "release" ]] || fail "jenis build tidak dikenal: $TYPE"
[[ "$FMT" == "apk" || "$FMT" == "aab" ]] || fail "format keluaran tidak dikenal: $FMT"
[[ "$TMO" =~ ^[0-9]+$ ]] && (( TMO >= 1 && TMO <= 350 )) || fail "timeout per proses harus 1-350 menit"
TMO_SEC=$((TMO * 60))

if [ "${PREPARED_WORK:-false}" = "true" ]; then
  [ -s "$WORK_DIR/framework.txt" ] && [ -s "$WORK_DIR/project-path.txt" ] || fail "hasil persiapan proyek tidak ditemukan"
  PROJECT_REL_CHECK=$(cat "$WORK_DIR/project-path.txt")
  case "$PROJECT_REL_CHECK" in ""|/*|../*|*/../*|*/..) fail "jalur hasil persiapan tidak aman";; esac
  [ -d "$WORK_DIR/$PROJECT_REL_CHECK" ] || fail "folder proyek hasil persiapan tidak ditemukan"
  [ -s "$WORK_DIR/prepare.log" ] && cat "$WORK_DIR/prepare.log" | tee -a "$LOG" >/dev/null || true
  say "[progress] 10"
else
  say "[prepare] membaca dan memvalidasi proyek"
  say "[progress] 3"
  timeout --signal=TERM --kill-after=30 "$TMO_SEC" python3 scripts/prepare.py "$META" "$WORK_DIR" 2>&1 | tee -a "$LOG" || fail "prepare.py"
  say "[progress] 10"
fi
upload_phase
FW=$(cat "$WORK_DIR/framework.txt" 2>/dev/null || jq -r '.meta.framework // "Android native (Gradle)"' "$META")
PROJECT_REL=$(cat "$WORK_DIR/project-path.txt" 2>/dev/null || printf 'project')
case "$PROJECT_REL" in ""|/*|../*|*/../*|*/..) fail "jalur project-path.txt tidak aman";; esac
PROJ=$(realpath -e "$WORK_DIR/$PROJECT_REL") || fail "folder proyek hasil persiapan tidak ditemukan"
case "$PROJ/" in "$WORK_DIR/"*) ;; *) fail "folder proyek keluar dari work directory";; esac
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

[ -f "$WORK_DIR/env.sh" ] && . "$WORK_DIR/env.sh"

# Release must use a user-owned signing key. Never ship a public, predictable key.
if [ "$TYPE" = "release" ]; then
  [ -s "${KS_FILE:-}" ] || fail "release membutuhkan keystore valid; kunci sementara tidak dibuat otomatis"
  [ -n "${KS_ALIAS:-}" ] && [ -n "${KS_STORE_PASS:-}" ] && [ -n "${KS_KEY_PASS:-}" ] || fail "alias / sandi keystore tidak lengkap"
  keytool -list -keystore "$KS_FILE" -storepass "$KS_STORE_PASS" -alias "$KS_ALIAS" >/dev/null 2>&1 || fail "keystore tidak dapat dibuka atau alias tidak cocok"
fi

publish_live_chunk() {
  local current start slice
  current=$(wc -l < "$LOG")
  if (( current <= STREAM_LAST_LINE )); then return 0; fi
  start=$(( current > 500 ? current - 499 : 1 ))
  slice="$LOGS/live-live.txt"
  {
    printf '#NEXA-STREAM start=%s end=%s\n' "$start" "$current"
    tail -n 500 "$LOG"
  } > "$slice"
  if gh release upload "build-$BUILD_ID" "$slice#live-live.txt" --clobber --repo "$REPO" >/dev/null 2>&1; then
    STREAM_LAST_LINE="$current"
  else
    say "[warn] pembaruan log langsung gagal diunggah; build tetap berjalan"
  fi
}

run_to() {
  local rc=0 command_pid
  env -u GH_TOKEN timeout --signal=TERM --kill-after=30 "$TMO_SEC" "$@" 2>&1 | tee -a "$LOG" &
  command_pid=$!
  while kill -0 "$command_pid" 2>/dev/null; do
    sleep 10
    if kill -0 "$command_pid" 2>/dev/null; then publish_live_chunk; fi
  done
  wait "$command_pid" || rc=$?
  publish_live_chunk
  return "$rc"
}

CACHE_ARGS=()
[ "$CACHE" = "false" ] && CACHE_ARGS+=("--no-build-cache")

cd "$PROJ"

case "$FW" in
  "Web / HTML / PWA")
    SOURCE_REL=$(cat "$WORK_DIR/source-path.txt" 2>/dev/null || printf 'source')
    case "$SOURCE_REL" in ""|/*|../*|*/../*|*/..) fail "jalur sumber Web tidak aman";; esac
    WEB_SRC=$(realpath -e "$WORK_DIR/$SOURCE_REL") || fail "folder sumber Web tidak ditemukan"
    case "$WEB_SRC/" in "$WORK_DIR/"*) ;; *) fail "folder sumber Web keluar dari work directory";; esac
    WEB_ASSETS="$PROJ/app/src/main/assets/www"
    WEB_OUTPUT_DIR=$(jq -r '.meta.options.webOutputDir // ""' "$META")
    if [ -s "$WEB_SRC/package.json" ] && jq -e '.scripts.build' "$WEB_SRC/package.json" >/dev/null 2>&1; then
      cd "$WEB_SRC"
      say "[progress] 14"
      if [ -f package-lock.json ]; then run_to npm ci --no-audit --no-fund || fail "npm ci";
      else run_to npm install --no-audit --no-fund || fail "npm install"; fi
      DEPS=$(jq -c '((.dependencies // {}) + (.devDependencies // {}))' package.json)
      if jq -e 'has("vite")' <<<"$DEPS" >/dev/null; then
        run_to npm run build -- --base=./ || fail "web build (vite)"
      elif jq -e 'has("react-scripts")' <<<"$DEPS" >/dev/null; then
        PUBLIC_URL=. run_to npm run build || fail "web build (react-scripts)"
      elif jq -e 'has("@angular/cli")' <<<"$DEPS" >/dev/null; then
        run_to npm run build -- --base-href ./ || fail "web build (angular)"
      else
        run_to npm run build || fail "web build"
      fi
      say "[progress] 30"
      if [ -n "$WEB_OUTPUT_DIR" ]; then
        case "/$WEB_OUTPUT_DIR/" in *"/../"*|"//"*) fail "webOutputDir harus berupa folder relatif yang aman";; esac
        WEB_OUTPUT=$(realpath -m "$WEB_SRC/$WEB_OUTPUT_DIR")
        case "$WEB_OUTPUT/" in "$WEB_SRC/"*) ;; *) fail "webOutputDir keluar dari folder sumber";; esac
        [ -d "$WEB_OUTPUT" ] || fail "folder webOutputDir tidak ditemukan: $WEB_OUTPUT_DIR"
      else
        WEB_OUTPUT=""
        for candidate in dist build out www; do
          if [ -d "$WEB_SRC/$candidate" ] && find "$WEB_SRC/$candidate" -maxdepth 4 -type f -name index.html -print -quit | grep -q .; then WEB_OUTPUT="$WEB_SRC/$candidate"; break; fi
        done
        if [ -z "$WEB_OUTPUT" ] && [ -d "$WEB_SRC/dist" ]; then
          nested_index=$(find "$WEB_SRC/dist" -mindepth 2 -maxdepth 5 -type f -name index.html -print -quit)
          [ -n "$nested_index" ] && WEB_OUTPUT=$(dirname "$nested_index")
        fi
        [ -n "$WEB_OUTPUT" ] || fail "hasil web build tidak ditemukan. Atur opsi webOutputDir ke folder yang berisi index.html."
      fi
      [ -s "$WEB_OUTPUT/index.html" ] || fail "web output tidak memiliki index.html: $WEB_OUTPUT"
      find "$WEB_ASSETS" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      cp -a "$WEB_OUTPUT/." "$WEB_ASSETS/"
      cd "$PROJ"
      say "[web] aset hasil build disalin ke wrapper Android"
      upload_phase
    else
      [ -s "$WEB_ASSETS/index.html" ] || fail "index.html Web tidak ditemukan"
      say "[web] proyek statis; melewati instalasi Node"
    fi
    if [ -f ./gradlew ]; then G=(bash ./gradlew); else G=(gradle); fi
    TASK="assembleDebug"; [ "$TYPE" = "release" ] && TASK="assembleRelease"
    [ "$FMT" = "aab" ] && { [ "$TYPE" = "release" ] && TASK="bundleRelease" || TASK="bundleDebug"; }
    ARGS=(--no-daemon --stacktrace --console=plain)
    [ "$OFFLINE" = "true" ] && ARGS+=(--offline)
    ARGS+=("${CACHE_ARGS[@]}")
    say "[progress] 36"
    say "[build] membangun wrapper Android untuk proyek Web"
    run_to "${G[@]}" "$TASK" "${ARGS[@]}" || fail "gradle web wrapper $TASK"
    ;;

  Flutter)
    say "[progress] 14"
    run_to flutter pub get || fail "flutter pub get"
    say "[progress] 28"
    upload_phase
    say "[progress] 34"
    if [ "$FMT" = "aab" ]; then
      [ "$TYPE" = "release" ] || fail "AAB hanya tersedia untuk mode release"
      run_to flutter build appbundle --release || fail "appbundle"
    elif [ "$TYPE" = "release" ]; then
      run_to flutter build apk --release || fail "apk release"
    else
      run_to flutter build apk --debug || fail "apk debug"
    fi
    ;;

  "React Native"|"Capacitor / Ionic"|"Cordova")
    say "[progress] 14"
    if [ -f package-lock.json ]; then run_to npm ci --no-audit --no-fund || fail "npm ci"
    else run_to npm install --no-audit --no-fund || fail "npm install"; fi
    say "[progress] 28"
    upload_phase
    if [ "$FW" = "Capacitor / Ionic" ]; then
      if [ ! -d android ]; then run_to npx --yes cap add android || fail "capacitor add android"; fi
      run_to npx --yes cap sync android || fail "cap sync"
      python3 "$SCRIPT_DIR/patch_native.py" "$META" "$WORK_DIR" 2>&1 | tee -a "$LOG" || fail "patch capacitor Android project"
      cd android
    elif [ "$FW" = "Cordova" ]; then
      if [ ! -d platforms/android ]; then run_to npx --yes cordova platform add android --no-save || fail "cordova add android platform"; fi
      run_to npx --yes cordova prepare android || fail "cordova prepare"
      python3 "$SCRIPT_DIR/patch_native.py" "$META" "$WORK_DIR" 2>&1 | tee -a "$LOG" || fail "patch cordova Android project"
      cd platforms/android
    else
      if [ ! -d android ] && jq -e '((.dependencies // {}) + (.devDependencies // {})) | has("expo")' package.json >/dev/null 2>&1; then
        run_to npx --yes expo prebuild --platform android --no-install || fail "expo prebuild"
        python3 "$SCRIPT_DIR/patch_native.py" "$META" "$WORK_DIR" 2>&1 | tee -a "$LOG" || fail "patch Expo Android project"
      fi
      [ -d android ] || fail "React Native project tidak memiliki android/. Proyek Expo dikelola perlu konfigurasi Expo yang valid; proyek bare harus menyertakan folder android."
      cd android
    fi

    if [ -f ./gradlew ]; then G=(bash ./gradlew); else G=(gradle); fi
    if [ "$CLEAN" = "true" ]; then run_to "${G[@]}" clean --no-daemon || fail "gradle clean"; fi
    TASK="assembleDebug"; [ "$TYPE" = "release" ] && TASK="assembleRelease"
    [ "$FMT" = "aab" ] && { [ "$TYPE" = "release" ] && TASK="bundleRelease" || TASK="bundleDebug"; }
    ARGS=(--no-daemon --stacktrace --console=plain)
    [ "$OFFLINE" = "true" ] && ARGS+=(--offline)
    ARGS+=("${CACHE_ARGS[@]}")
    GARGS_FILE="$WORK_DIR/gradle-args.txt"
    GARGS_ARR=()
    if [ -n "$GARGS" ]; then
      python3 -c 'import shlex,sys; print("\n".join(shlex.split(sys.argv[1])))' "$GARGS" > "$GARGS_FILE" || fail "argumen Gradle tidak valid"
      mapfile -t GARGS_ARR < "$GARGS_FILE"
    fi
    say "[progress] 36"
    say "[build] menjalankan $TASK"
    run_to "${G[@]}" "$TASK" "${ARGS[@]}" "${GARGS_ARR[@]}" || fail "gradle $TASK"
    ;;

  "Custom script")
    SCRIPT="$PROJ/nexabuilder-build.sh"
    [ -s "$SCRIPT" ] || fail "framework Custom script dipilih tetapi nexabuilder-build.sh tidak ditemukan di root subfolder proyek"
    CUSTOM_OUT="$WORK_DIR/custom-output"
    mkdir -p "$CUSTOM_OUT"
    export NEXABUILDER_PROJECT_DIR="$PROJ"
    export NEXABUILDER_OUTPUT_DIR="$CUSTOM_OUT"
    export NEXABUILDER_FORMAT="$FMT"
    export NEXABUILDER_BUILD_TYPE="$TYPE"
    export NEXABUILDER_APP_ID="$(jq -r '.meta.pkg' "$META")"
    export NEXABUILDER_APP_NAME="$(jq -r '.meta.name' "$META")"
    export NEXABUILDER_VERSION_NAME="$(jq -r '.meta.ver // "1.0.0"' "$META")"
    export NEXABUILDER_VERSION_CODE="$(jq -r '.meta.vcode // 1' "$META")"
    export NEXABUILDER_MIN_SDK="$(jq -r '.meta.options.minSdk // 24' "$META")"
    export NEXABUILDER_TARGET_SDK="$(jq -r '.meta.options.targetSdk // 36' "$META")"
    say "[custom] menjalankan adapter proyek nexabuilder-build.sh"
    say "[custom] format=$FMT type=$TYPE package=$NEXABUILDER_APP_ID"
    run_to bash "$SCRIPT" || fail "custom project build script"
    ;;

  *)
    if [ -f ./gradlew ]; then G=(bash ./gradlew); else G=(gradle); fi
    if [ "$CLEAN" = "true" ]; then run_to "${G[@]}" clean --no-daemon || fail "gradle clean"; fi
    TASK="assembleDebug"; [ "$TYPE" = "release" ] && TASK="assembleRelease"
    [ "$FMT" = "aab" ] && { [ "$TYPE" = "release" ] && TASK="bundleRelease" || TASK="bundleDebug"; }
    ARGS=(--no-daemon --stacktrace --console=plain)
    [ "$OFFLINE" = "true" ] && ARGS+=(--offline)
    ARGS+=("${CACHE_ARGS[@]}")
    GARGS_FILE="$WORK_DIR/gradle-args.txt"
    GARGS_ARR=()
    if [ -n "$GARGS" ]; then
      python3 -c 'import shlex,sys; print("\n".join(shlex.split(sys.argv[1])))' "$GARGS" > "$GARGS_FILE" || fail "argumen Gradle tidak valid"
      mapfile -t GARGS_ARR < "$GARGS_FILE"
    fi
    say "[progress] 36"
    say "[build] menjalankan $TASK"
    run_to "${G[@]}" "$TASK" "${ARGS[@]}" "${GARGS_ARR[@]}" || fail "gradle $TASK"
    ;;
esac
upload_phase

say "[progress] 82"
say "[collect] mengumpulkan outputs"
mapfile -d '' -t PACKAGE_FILES < <(find "$PROJ" -type f \( -name '*.apk' -o -name '*.aab' \) -path '*/outputs/*' -print0 2>/dev/null | sort -z -V)
if [ -d "$WORK_DIR/custom-output" ]; then
  while IFS= read -r -d '' candidate; do PACKAGE_FILES+=("$candidate"); done < <(find "$WORK_DIR/custom-output" -type f \( -name '*.apk' -o -name '*.aab' \) -print0 | sort -z -V)
fi
EXPECTED_EXT="$FMT"
EXPECTED_COUNT=0
for package in "${PACKAGE_FILES[@]}"; do
  ext_lower="${package##*.}"
  [[ "${ext_lower,,}" == "$EXPECTED_EXT" ]] && EXPECTED_COUNT=$((EXPECTED_COUNT + 1))
done
[ "$EXPECTED_COUNT" -gt 0 ] || fail "tidak ada paket .$EXPECTED_EXT yang sesuai dengan format yang dipilih"
# Put a universal APK first when Gradle generated ABI splits.
if [ "$FMT" = "apk" ]; then
  UNIVERSAL=()
  OTHERS=()
  for f in "${PACKAGE_FILES[@]}"; do
    if [[ "$(basename "$f")" == *universal* ]]; then UNIVERSAL+=("$f"); else OTHERS+=("$f"); fi
  done
  PACKAGE_FILES=("${UNIVERSAL[@]}" "${OTHERS[@]}")
fi
idx=0
for f in "${PACKAGE_FILES[@]}"; do
  base=$(basename "$f")
  ext="${f##*.}"
  if [ -n "${OUT_NAME:-}" ]; then
    if [ "$idx" -eq 0 ]; then dst="$OUT_NAME"; else dst="${OUT_NAME%.*}-$idx.${ext}"; fi
    case "$dst" in *."$ext") ;; *) dst="$dst.$ext" ;; esac
  else
    dst="$base"
  fi
  cp -v "$f" "$OUT/$dst" | tee -a "$LOG"
  idx=$((idx + 1))
done

find "$PROJ" -type f -name 'mapping.txt' -print0 2>/dev/null \
  | while IFS= read -r -d '' f; do cp -v "$f" "$OUT/mapping.txt" | tee -a "$LOG"; done

cp -f "$LOG" "$OUT/build.log" 2>/dev/null || true
COUNT=$(find "$OUT" -maxdepth 1 -type f \( -name '*.apk' -o -name '*.aab' \) | wc -l)
[ "$COUNT" -gt 0 ] || fail "tidak ada APK/AAB di outputs"

say "[progress] 90"
say "[verify] memeriksa integritas paket keluaran"
for f in "$OUT"/*.apk; do
  [ -f "$f" ] || continue
  [ -s "$f" ] || fail "APK kosong: $(basename "$f")"
  unzip -t "$f" >/dev/null 2>&1 || fail "arsip APK rusak: $(basename "$f")"
  APKSIGNER="$(find "${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/usr/local/lib/android/sdk}}/build-tools" -type f -name apksigner 2>/dev/null | sort -V | tail -n 1)"
  ZIPALIGN="$(find "${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/usr/local/lib/android/sdk}}/build-tools" -type f -name zipalign 2>/dev/null | sort -V | tail -n 1)"
  [ -x "$APKSIGNER" ] || fail "apksigner tidak ditemukan di Android SDK runner"
  [ -x "$ZIPALIGN" ] || fail "zipalign tidak ditemukan di Android SDK runner"
  "$APKSIGNER" verify --verbose "$f" >> "$LOG" 2>&1 || fail "tanda tangan APK tidak valid: $(basename "$f")"
  "$ZIPALIGN" -c -v 4 "$f" >> "$LOG" 2>&1 || fail "alignment APK tidak valid: $(basename "$f")"
done
for f in "$OUT"/*.aab; do
  [ -f "$f" ] || continue
  [ -s "$f" ] || fail "AAB kosong: $(basename "$f")"
  unzip -t "$f" >/dev/null 2>&1 || fail "arsip AAB rusak: $(basename "$f")"
  VERIFY_LOG="$LOGS/jarsigner-$(basename "$f").txt"
  if ! jarsigner -verify -verbose -certs "$f" > "$VERIFY_LOG" 2>&1; then
    cat "$VERIFY_LOG" >> "$LOG"
    fail "verifikasi tanda tangan AAB gagal: $(basename "$f")"
  fi
  cat "$VERIFY_LOG" >> "$LOG"
  grep -qi 'jar verified' "$VERIFY_LOG" || fail "AAB tidak memiliki tanda tangan yang dapat diverifikasi: $(basename "$f")"
  if grep -qi 'jar is unsigned' "$VERIFY_LOG"; then fail "AAB tidak ditandatangani: $(basename "$f")"; fi
done
upload_phase

say "[progress] 96"
say "[upload] mengunggah $COUNT paket ke release build-$BUILD_ID"
n=0
while IFS= read -r -d '' f; do
  n=$((n + 1)); ext="${f##*.}"
  if [ "$n" -eq 1 ]; then name="app.$ext"; else name="app-$n.$ext"; fi
  gh release upload "build-$BUILD_ID" "$f#$name" --clobber --repo "$REPO"
done < <(find "$OUT" -maxdepth 1 -type f \( -name '*.apk' -o -name '*.aab' \) -print0)

say "[done] sukses — $COUNT paket lolos pemeriksaan dan diunggah ke release build-$BUILD_ID"
publish_live_chunk
# Publish the complete log only after the terminal success line has been written.
gh release upload "build-$BUILD_ID" "$LOG#build.log" --clobber --repo "$REPO" || true
[ -f "$OUT/mapping.txt" ] && gh release upload "build-$BUILD_ID" "$OUT/mapping.txt#mapping.txt" --clobber --repo "$REPO" || true
