#!/usr/bin/env python3
# language: Python 3.12, file: scripts/prepare.py
import json, os, re, sys, shutil, zipfile, subprocess, base64, shlex, time, stat, xml.sax.saxutils, urllib.parse
from pathlib import Path, PurePosixPath

def log(m): print(m, flush=True)

def common_root(names):
    tops = {n.split('/')[0] for n in names if n and not n.startswith('__MACOSX')}
    if len(tops) == 1:
        t = tops.pop()
        if all(n.startswith(t + '/') or n == t for n in names if n):
            return t
    return None

def detect(root: Path) -> str:
    if (root / 'nexabuilder-build.sh').is_file(): return 'Custom script'
    if (root / 'pubspec.yaml').exists(): return 'Flutter'
    pkg = root / 'package.json'
    if pkg.exists():
        try: data = json.loads(pkg.read_text(encoding='utf-8', errors='replace'))
        except Exception: data = {}
        deps = {**data.get('dependencies', {}), **data.get('devDependencies', {})}
        if 'react-native' in deps: return 'React Native'
        if '@capacitor/core' in deps: return 'Capacitor / Ionic'
        if 'cordova' in deps: return 'Cordova'
    if (root / 'capacitor.config.ts').exists() or (root / 'capacitor.config.json').exists():
        return 'Capacitor / Ionic'
    if (root / 'config.xml').exists(): return 'Cordova'
    if (root / 'index.html').is_file(): return 'Web / HTML / PWA'
    return 'Android native (Gradle)'

def android_root(root: Path, fw: str) -> Path:
    if fw in ('Flutter', 'React Native', 'Capacitor / Ionic'): return root / 'android'
    if fw == 'Cordova': return root / 'platforms' / 'android'
    return root

def find_module(aroot: Path):
    if not aroot.exists(): return None
    for p in sorted(aroot.glob('*/build.gradle*')):
        if p.name.endswith('.kts') and p.with_suffix('').with_suffix('.gradle').exists(): continue
        try: txt = p.read_text(encoding='utf-8', errors='replace')
        except Exception: continue
        if 'com.android.application' in txt: return p.parent
    for name in ('build.gradle.kts', 'build.gradle'):
        f = aroot / name
        if f.exists():
            try: txt = f.read_text(encoding='utf-8', errors='replace')
            except Exception: continue
            if 'com.android.application' in txt: return aroot
    return None

def assign_str(text, key, value):
    pat = re.compile(rf'(\b{key}\s*(?:=\s*)?)(["\'])([^"\']*)\2')
    if pat.search(text):
        return pat.sub(lambda m: f'{m.group(1)}{m.group(2)}{value}{m.group(2)}', text, count=1)
    return text

def assign_num(text, keys, value):
    for key in keys:
        pat = re.compile(rf'(\b{key}\s*(?:=\s*)?)(\d+)')
        if pat.search(text):
            return pat.sub(lambda m: f'{m.group(1)}{value}', text, count=1)
    return text

def block_span(text, header):
    m = re.search(header, text)
    if not m: return None
    start = text.find('{', m.start())
    if start < 0: return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == '{': depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0: return (start, i)
    return None

def inject_in_block(text, header, line):
    span = block_span(text, header)
    if not span: return text
    s, e = span
    if line.strip() in text[s:e]: return text
    return text[:e] + f'\n        {line}\n' + text[e:]

def validate_meta(meta):
    name = str(meta.get('name') or '').strip()
    pkg = str(meta.get('pkg') or '').strip()
    if not name or len(name) > 80 or any(ord(c) < 32 for c in name):
        raise SystemExit('Nama aplikasi kosong atau tidak valid (maksimal 80 karakter)')
    if not re.fullmatch(r'[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+', pkg):
        raise SystemExit('ID paket tidak valid. Gunakan format com.contoh.aplikasi')
    ver = str(meta.get('ver') or '1.0.0')
    if len(ver) > 40 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]*', ver):
        raise SystemExit('Versi aplikasi tidak valid')
    try:
        vcode = int(meta.get('vcode') or 1)
        min_sdk = int((meta.get('options') or {}).get('minSdk') or 24)
        target_sdk = int((meta.get('options') or {}).get('targetSdk') or 36)
    except (TypeError, ValueError):
        raise SystemExit('Kode versi / SDK harus berupa angka')
    if vcode < 1 or min_sdk < 21 or target_sdk < min_sdk or target_sdk > 36:
        raise SystemExit('Rentang kode versi / SDK tidak valid')
    if meta.get('fmt', 'apk') not in ('apk', 'aab'):
        raise SystemExit('Format keluaran harus APK atau AAB')
    if meta.get('type', 'debug') not in ('debug', 'release'):
        raise SystemExit('Jenis build tidak valid')
    if meta.get('fmt', 'apk') == 'aab' and meta.get('type', 'debug') != 'release':
        raise SystemExit('AAB hanya didukung pada mode release; pilih APK untuk build debug')
    if meta.get('options', {}).get('gradle', '8.11.1') not in ('8.7', '8.9', '8.11.1'):
        raise SystemExit('Gradle tanpa wrapper harus 8.7, 8.9, atau 8.11.1')
    if vcode > 2100000000:
        raise SystemExit('Kode versi terlalu besar (maksimal 2.100.000.000)')
    framework = meta.get('framework') or 'Auto detect'
    if framework not in ('Auto detect', 'Web / HTML / PWA', 'Android native (Gradle)', 'Flutter', 'React Native', 'Capacitor / Ionic', 'Cordova', 'Custom script'):
        raise SystemExit('Jenis proyek tidak didukung')
    options = meta.get('options') or {}
    for key in ('subdir', 'webOutputDir', 'entryFile'):
        value = str(options.get(key) or '').strip()
        if value:
            path = PurePosixPath(value.replace('\\', '/'))
            if path.is_absolute() or any(part in ('..', '') for part in path.parts):
                raise SystemExit(f'Path opsi {key} tidak aman')
    abis = options.get('abis') or []
    allowed_abis = {'armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'}
    if not isinstance(abis, list) or not set(abis).issubset(allowed_abis):
        raise SystemExit('Daftar ABI tidak valid')
    permissions = meta.get('permissions') or []
    if not isinstance(permissions, list) or len(permissions) > 100:
        raise SystemExit('Daftar permission tidak valid')
    for permission in permissions:
        if not re.fullmatch(r'[A-Za-z0-9_.]+', str(permission)):
            raise SystemExit('Nama permission tidak valid')


def safe_extract_zip(zf: zipfile.ZipFile, destination: Path):
    destination = destination.resolve()
    files = 0
    total_size = 0
    max_files = 20000
    max_total = 600 * 1024 * 1024
    max_file = 150 * 1024 * 1024
    for info in zf.infolist():
        name = info.filename.replace('\\', '/')
        rel = PurePosixPath(name)
        if rel.is_absolute() or any(part in ('..', '') for part in rel.parts):
            raise SystemExit(f'Path ZIP tidak aman: {info.filename}')
        if not rel.parts or rel.parts[0] == '__MACOSX':
            continue
        mode = (info.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode):
            raise SystemExit(f'Symlink dalam ZIP tidak diizinkan: {info.filename}')
        if info.is_dir():
            continue
        files += 1
        total_size += info.file_size
        if files > max_files or info.file_size > max_file or total_size > max_total:
            raise SystemExit('ZIP melewati batas aman: maksimal 20.000 file, 150 MB per file, 600 MB total')
        target = (destination / Path(*rel.parts)).resolve()
        if destination not in target.parents and target != destination:
            raise SystemExit(f'Path ZIP keluar dari folder proyek: {info.filename}')
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info, 'r') as src, target.open('wb') as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)


def create_web_wrapper(source: Path, project: Path, meta):
    entry = str((meta.get('options') or {}).get('entryFile') or 'index.html').strip()
    if entry.startswith('/') or '..' in PurePosixPath(entry).parts:
        raise SystemExit('Entry file Web tidak valid')
    entry_path = (source / entry).resolve()
    if source.resolve() not in entry_path.parents or not entry_path.is_file():
        raise SystemExit(f'File entry Web tidak ditemukan: {entry}')
    if entry != 'index.html':
        shutil.copy2(entry_path, entry_path.parent / 'index.html')
        entry = 'index.html'

    app = project / 'app'
    assets = app / 'src' / 'main' / 'assets' / 'www'
    assets.mkdir(parents=True, exist_ok=True)
    ignored = {'.git', 'node_modules', '.gradle', 'build', 'dist', '__MACOSX'}
    def ignored_file(name):
        low = name.lower()
        return (name in ignored or name == '.DS_Store' or low == '.env' or low.startswith('.env.')
                or low.endswith(('.jks', '.keystore', '.p12', '.pfx')) or low in ('id_rsa', 'id_ed25519'))
    for child in source.iterdir():
        if ignored_file(child.name):
            continue
        target = assets / child.name
        if child.is_symlink():
            continue
        if child.is_dir():
            shutil.copytree(child, target, dirs_exist_ok=True, symlinks=True,
                            ignore=lambda directory, names: [n for n in names if ignored_file(n) or (Path(directory) / n).is_symlink()])
        elif child.is_file():
            shutil.copy2(child, target)

    pkg = meta['pkg']
    safe_label = xml.sax.saxutils.quoteattr(str(meta.get('name') or 'Android App'))
    min_sdk = int((meta.get('options') or {}).get('minSdk') or 24)
    target_sdk = int((meta.get('options') or {}).get('targetSdk') or 36)
    version_code = int(meta.get('vcode') or 1)
    version_name = xml.sax.saxutils.quoteattr(str(meta.get('ver') or '1.0.0'))

    (project / 'settings.gradle').write_text('''pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name = "NexaWebWrapper"
include ':app'
''', encoding='utf-8')
    (project / 'build.gradle').write_text("plugins { id 'com.android.application' version '8.9.0' apply false }\n", encoding='utf-8')
    (project / 'gradle.properties').write_text('''org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8
org.gradle.parallel=true
org.gradle.caching=true
android.useAndroidX=true
android.nonTransitiveRClass=true
''', encoding='utf-8')
    (app / 'build.gradle').write_text(f'''plugins {{ id 'com.android.application' }}

dependencies {{ implementation 'androidx.webkit:webkit:1.12.1' }}

android {{
    namespace '{pkg}'
    compileSdk 36
    defaultConfig {{
        applicationId '{pkg}'
        minSdk {min_sdk}
        targetSdk {target_sdk}
        versionCode {version_code}
        versionName {version_name}
    }}
}}
''', encoding='utf-8')
    java_dir = app / 'src' / 'main' / 'java' / Path(*pkg.split('.'))
    java_dir.mkdir(parents=True, exist_ok=True)
    (java_dir / 'MainActivity.java').write_text(r'''package __PACKAGE__;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.PermissionRequest;
import androidx.webkit.WebViewAssetLoader;
import android.webkit.WebResourceResponse;

public class MainActivity extends Activity {
    private static final int FILE_PICKER = 71;
    private static final int WEB_PERMISSION = 72;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private String[] pendingAndroidPermissions;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        webView = new WebView(this);
        setContentView(webView);
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this, "www"))
            .build();
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("appassets.androidplatform.net".equalsIgnoreCase(uri.getHost())) return false;
                String scheme = uri.getScheme();
                if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) { }
                    return true;
                }
                return false;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try { startActivityForResult(params.createIntent(), FILE_PICKER); }
                catch (Exception e) { fileCallback = null; callback.onReceiveValue(null); return false; }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> requestWebPermission(request));
            }
        });
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    }

    private void requestWebPermission(PermissionRequest request) {
        java.util.ArrayList<String> needed = new java.util.ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) needed.add(Manifest.permission.CAMERA);
            else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) needed.add(Manifest.permission.RECORD_AUDIO);
            else { request.deny(); return; }
        }
        if (needed.isEmpty()) { request.deny(); return; }
        java.util.ArrayList<String> missing = new java.util.ArrayList<>();
        for (String permission : needed) {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M && checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
        }
        if (missing.isEmpty()) { request.grant(request.getResources()); return; }
        if (pendingPermission != null) pendingPermission.deny();
        pendingPermission = request;
        pendingAndroidPermissions = missing.toArray(new String[0]);
        requestPermissions(pendingAndroidPermissions, WEB_PERMISSION);
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == WEB_PERMISSION && pendingPermission != null) {
            boolean granted = true;
            for (int result : results) if (result != PackageManager.PERMISSION_GRANTED) granted = false;
            if (granted) pendingPermission.grant(pendingPermission.getResources()); else pendingPermission.deny();
            pendingPermission = null;
            pendingAndroidPermissions = null;
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_PICKER && fileCallback != null) {
            Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            fileCallback.onReceiveValue(result);
            fileCallback = null;
        }
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (pendingPermission != null) { pendingPermission.deny(); pendingPermission = null; }
        if (webView != null) { webView.stopLoading(); webView.destroy(); webView = null; }
        super.onDestroy();
    }
}
'''.replace('__PACKAGE__', pkg), encoding='utf-8')
    (app / 'src' / 'main' / 'AndroidManifest.xml').write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.microphone" android:required="false" />
    <application android:label={safe_label} android:allowBackup="false" android:usesCleartextTraffic="false" android:theme="@android:style/Theme.Material.Light.NoActionBar">
        <activity android:name=".{ 'MainActivity' }" android:exported="true" android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
''', encoding='utf-8')


def compute_autoversion(proj: Path) -> int:
    try:
        out = subprocess.check_output(['git', 'rev-list', '--count', 'HEAD'],
                                      cwd=proj, stderr=subprocess.DEVNULL).decode().strip()
        n = int(out)
        if n > 0: return n
    except Exception: pass
    return int(time.time())

def patch_gradle(mod: Path, meta, aroot: Path, proj: Path):
    f = mod / 'build.gradle.kts'
    kts = True
    if not f.exists():
        f = mod / 'build.gradle'
        kts = False
    if not f.exists(): raise SystemExit(f'build.gradle tidak ditemukan di {mod}')
    text = f.read_text(encoding='utf-8', errors='replace')
    opts = meta.get('options') or {}
    pkg = meta['pkg']
    vcode = int(meta.get('vcode') or 1)
    if opts.get('autoVersion'): vcode = compute_autoversion(proj)
    text = assign_str(text, 'applicationId', pkg)
    text = assign_str(text, 'versionName', str(meta.get('ver') or '1.0.0'))
    text = assign_num(text, ['versionCode'], vcode)
    text = assign_num(text, ['minSdk', 'minSdkVersion'], int(opts.get('minSdk') or 24))
    target_sdk = int(opts.get('targetSdk') or 36)
    text = assign_num(text, ['targetSdk', 'targetSdkVersion'], target_sdk)

    android_span = block_span(text, r'android\s*\{')
    if android_span:
        a_start, a_end = android_span
        android_body = text[a_start:a_end]
        if not re.search(r'\bnamespace\s*(?:=|\s)\s*[^\s{]+', android_body):
            line = f'namespace = "{pkg}"' if kts else f"namespace '{pkg}'"
            text = text[:a_end] + f'\n        {line}\n' + text[a_end:]
    else:
        line = f'    namespace = "{pkg}"' if kts else f"    namespace '{pkg}'"
        text += '\nandroid {\n' + line + '\n}\n'

    # Android 16/API 36 requires compileSdk 36. Upgrade a literal lower value,
    # preserve a higher value, and add the field when a standard android block lacks it.
    compile_match = re.search(r'(\bcompileSdk(?:Version)?\s*(?:=\s*)?)(\d+)', text)
    if compile_match:
        if int(compile_match.group(2)) < target_sdk:
            text = text[:compile_match.start(2)] + str(target_sdk) + text[compile_match.end(2):]
    elif not re.search(r'\bcompileSdk(?:Version)?\b', text):
        compile_line = f'compileSdk = {target_sdk}' if kts else f'compileSdk {target_sdk}'
        text = inject_in_block(text, r'android\s*\{', compile_line)
    else:
        log('compileSdk memakai ekspresi/Version Catalog; nilai tidak diubah otomatis, pastikan minimal sama dengan targetSdk.')

    default_span = block_span(text, r'defaultConfig\s*\{')
    if default_span:
        d_start, d_end = default_span
        body = text[d_start:d_end]
        missing = []
        if not re.search(r'\bapplicationId\s*(?:=|\s)\s*["\']', body):
            missing.append(f'applicationId = "{pkg}"' if kts else f"applicationId '{pkg}'")
        if not re.search(r'\bminSdk(?:Version)?\s*(?:=|\s)\s*\d+', body):
            missing.append(f'minSdk = {int(opts.get("minSdk") or 24)}' if kts else f'minSdk {int(opts.get("minSdk") or 24)}')
        if not re.search(r'\btargetSdk(?:Version)?\s*(?:=|\s)\s*\d+', body):
            missing.append(f'targetSdk = {int(opts.get("targetSdk") or 36)}' if kts else f'targetSdk {int(opts.get("targetSdk") or 36)}')
        if not re.search(r'\bversionCode\s*(?:=|\s)\s*\d+', body):
            missing.append(f'versionCode = {vcode}' if kts else f'versionCode {vcode}')
        if not re.search(r'\bversionName\s*(?:=|\s)\s*["\']', body):
            vname = str(meta.get('ver') or '1.0.0').replace('\\', '\\\\').replace('"', '\\"')
            missing.append(f'versionName = "{vname}"' if kts else f"versionName '{vname}'")
        if missing:
            text = text[:d_end] + '\n        ' + '\n        '.join(missing) + '\n' + text[d_end:]
    else:
        default_lines = [
            f'applicationId = "{pkg}"' if kts else f"applicationId '{pkg}'",
            f'minSdk = {int(opts.get("minSdk") or 24)}' if kts else f'minSdk {int(opts.get("minSdk") or 24)}',
            f'targetSdk = {int(opts.get("targetSdk") or 36)}' if kts else f'targetSdk {int(opts.get("targetSdk") or 36)}',
            f'versionCode = {vcode}' if kts else f'versionCode {vcode}',
            f'versionName = "{str(meta.get("ver") or "1.0.0")}"' if kts else f"versionName '{str(meta.get('ver') or '1.0.0')}'",
        ]
        text = inject_in_block(text, r'android\s*\{', 'defaultConfig { ' + '; '.join(default_lines) + ' }')

    abis = opts.get('abis') or []
    if abis:
        allowed = {'armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'}
        if not set(abis).issubset(allowed): raise SystemExit('Daftar ABI tidak valid')
        quoted = ', '.join(f'"{a}"' for a in abis)
        line = f'ndk {{ abiFilters += listOf({quoted}) }}' if kts else f'ndk {{ abiFilters {quoted} }}'
        text = inject_in_block(text, r'defaultConfig\s*\{', line)

    if opts.get('split') and abis:
        quoted = ', '.join(f'"{a}"' for a in abis)
        if kts:
            sb = ('splits {\n            abi {\n'
                  '                isEnable = true\n                reset()\n'
                  f'                include({quoted})\n'
                  '                isUniversalApk = true\n            }\n        }')
        else:
            sb = ('splits {\n            abi {\n'
                  '                enable true\n                reset()\n'
                  f'                include {quoted}\n'
                  '                universalApk true\n            }\n        }')
        span = block_span(text, r'android\s*\{')
        if span:
            s, e = span
            if 'splits' not in text[s:e]: text = text[:e] + '\n        ' + sb + '\n' + text[e:]

    minify = bool(opts.get('r8'))
    if kts:
        if re.search(r'isMinifyEnabled\s*=', text):
            text = re.sub(r'isMinifyEnabled\s*=\s*\w+', f'isMinifyEnabled = {str(minify).lower()}', text)
        else:
            text = inject_in_block(text, r'release\s*\{', f'isMinifyEnabled = {str(minify).lower()}')
    else:
        if re.search(r'minifyEnabled\s+\w+', text):
            text = re.sub(r'minifyEnabled\s+\w+', f'minifyEnabled {str(minify).lower()}', text)
        else:
            text = inject_in_block(text, r'release\s*\{', f'minifyEnabled {str(minify).lower()}')

    if opts.get('debuggable'):
        line = 'isDebuggable = true' if kts else 'debuggable true'
        text = inject_in_block(text, r'release\s*\{', line)

    if meta.get('keystore') and meta.get('type') == 'release':
        sign = aroot / 'sign.gradle'
        sign.write_text('''android {
    signingConfigs {
        release {
            storeFile file(System.getenv("KS_FILE"))
            storePassword System.getenv("KS_STORE_PASS")
            keyAlias System.getenv("KS_ALIAS")
            keyPassword System.getenv("KS_KEY_PASS")
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
''', encoding='utf-8')
        if "sign.gradle" not in text:
            text += "\napply(from = rootProject.file(\"sign.gradle\"))\n" if kts else "\napply from: rootProject.file('sign.gradle')\n"

    f.write_text(text, encoding='utf-8')


def set_attr(tag: str, key: str, value: str) -> str:
    if re.search(rf'\b{re.escape(key)}\s*=', tag):
        return re.sub(rf'\b{re.escape(key)}\s*=\s*"[^"]*"', f'{key}="{value}"', tag)
    pos = tag.rfind('>')
    if pos < 0: return tag + f' {key}="{value}"'
    return tag[:pos].rstrip() + f' {key}="{value}"' + tag[pos:]


def patch_manifest(mod: Path, meta):
    mf = mod / 'src' / 'main' / 'AndroidManifest.xml'
    if not mf.exists(): return
    text = mf.read_text(encoding='utf-8', errors='replace')
    have = set(re.findall(r'<uses-permission(?:-sdk-\d+)?[^>]*android:name="([^"]+)"', text))
    add = []
    for permission in (meta.get('permissions') or []):
        permission = str(permission).strip()
        if not re.fullmatch(r'[A-Za-z0-9_.]+', permission):
            raise SystemExit(f'Nama permission tidak valid: {permission[:80]}')
        if permission not in have: add.append(permission)
    if add:
        block = ''.join(f'    <uses-permission android:name="{p}" />\n' for p in add)
        if re.search(r'<application\b', text): text = re.sub(r'(<application\b)', block + r'\1', text, count=1)
        else: text = text.replace('</manifest>', block + '</manifest>')

    feats = meta.get('features') or {}
    attrs = {}
    if feats.get('cleartext'): attrs['android:usesCleartextTraffic'] = 'true'
    if feats.get('hwAccel') is False: attrs['android:hardwareAccelerated'] = 'false'
    if feats.get('backup') is False: attrs['android:allowBackup'] = 'false'
    if (meta.get('options') or {}).get('debuggable'): attrs['android:debuggable'] = 'true'
    app_match = re.search(r'<application\b[^>]*>', text)
    if app_match:
        tag = app_match.group(0)
        for key, value in attrs.items(): tag = set_attr(tag, key, value)
        text = text[:app_match.start()] + tag + text[app_match.end():]

    components = re.compile(r'<(activity|activity-alias)\b[^>]*>[\s\S]*?</\1\s*>', re.I)
    matches = list(components.finditer(text))
    target = next((m for m in matches if re.search(r'android\.intent\.action\.MAIN', m.group(0)) and re.search(r'android\.intent\.category\.LAUNCHER', m.group(0))), None)
    if target is None and matches: target = matches[0]
    if target:
        component = target.group(0)
        start_tag = re.search(r'<(?:activity|activity-alias)\b[^>]*>', component, re.I)
        if start_tag:
            tag = start_tag.group(0)
            ori = feats.get('orientation')
            if ori in ('portrait', 'landscape'): tag = set_attr(tag, 'android:screenOrientation', ori)
            if feats.get('keepScreenOn'): tag = set_attr(tag, 'android:keepScreenOn', 'true')
            if feats.get('fullscreen'): tag = set_attr(tag, 'android:theme', '@android:style/Theme.NoTitleBar.Fullscreen')
            local_start = target.start() + start_tag.start()
            local_end = target.start() + start_tag.end()
            text = text[:local_start] + tag + text[local_end:]

    component_pattern = re.compile(r'<(activity|activity-alias|service|receiver|provider)\b[^>]*>[\s\S]*?</\1\s*>', re.I)
    for match in reversed(list(component_pattern.finditer(text))):
        block = match.group(0)
        if not re.search(r'<intent-filter\b', block, re.I): continue
        tag_match = re.match(r'<[^>]+>', block)
        if not tag_match: continue
        tag = tag_match.group(0)
        if re.search(r'\bandroid:exported\s*=', tag): continue
        kind_match = re.match(r'<([A-Za-z-]+)', tag)
        kind = kind_match.group(1).lower() if kind_match else ''
        # Activity intent-filters commonly implement deep links/share entry points;
        # preserve that behavior. Other component types default to non-exported.
        exported = 'true' if kind in ('activity', 'activity-alias') else 'false'
        tag = set_attr(tag, 'android:exported', exported)
        text = text[:match.start()] + tag + block[tag_match.end():] + text[match.end():]

    mf.write_text(text, encoding='utf-8')

def safe_base_path(base: Path, relative: str, label: str) -> Path:
    base = base.resolve()
    rel = PurePosixPath(str(relative).replace('\\', '/'))
    if rel.is_absolute() or not rel.parts or any(part in ('..', '') for part in rel.parts):
        raise SystemExit(f'Path {label} tidak aman')
    # Dashboard metadata uses repository-relative paths such as input/<id>.zip.
    # The metadata itself is already inside input/, so avoid resolving input/input/<id>.zip.
    if rel.parts[0] == base.name:
        candidate = base.parent / Path(*rel.parts)
    else:
        candidate = base / Path(*rel.parts)
    resolved = candidate.resolve()
    if base not in resolved.parents:
        raise SystemExit(f'Path {label} keluar dari folder input')
    return resolved


def apply_icon(mod: Path, job, base: Path):
    icon = (job.get('icon') or {}).get('path')
    if not icon: return
    src = safe_base_path(base, icon, 'ikon')
    if not src.is_file(): return
    res = mod / 'src' / 'main' / 'res'
    for d in ('mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'):
        t = res / d; t.mkdir(parents=True, exist_ok=True)
        for name in ('ic_launcher.png', 'ic_launcher_round.png'):
            shutil.copyfile(src, t / name)

def sanitize_outname(name: str) -> str:
    base = os.path.basename(name or '').strip()
    base = re.sub(r'[^\w.\-]+', '_', base)
    return base[:64]

def write_env(work: Path, job, base: Path):
    lines = []
    ks = job.get('keystore')
    if ks and ks.get('path'):
        kp = (base / ks['path']).resolve()
        if kp.exists():
            dst = work / 'keystore.jks'
            shutil.copyfile(kp, dst)
            lines += [
                f'export KS_FILE={shlex.quote(str(dst))}',
                f'export KS_ALIAS={shlex.quote(ks.get("alias") or "")}',
                f'export KS_STORE_PASS={shlex.quote(ks.get("storePassword") or "")}',
                f'export KS_KEY_PASS={shlex.quote(ks.get("keyPassword") or "")}',
            ]
    raw = (os.environ.get('NEXA_ENV_TEXT') or job.get('meta', {}).get('env') or '').strip()
    reserved = {
        'PATH', 'HOME', 'PWD', 'OLDPWD', 'BASH_ENV', 'ENV', 'IFS', 'SHELLOPTS', 'BASHOPTS',
        'GH_TOKEN', 'GH_REPO', 'BUILD_ID', 'INPUT_DIR', 'WORK_DIR', 'PREPARED_WORK', 'META',
        'TYPE', 'FMT', 'GARGS', 'OFFLINE', 'CLEAN', 'CACHE', 'TMO', 'TMO_SEC', 'LOG', 'OUT',
        'LOGS', 'PROJ', 'PROJECT_REL', 'FW', 'SCRIPT_DIR', 'KS_FILE', 'KS_ALIAS',
        'KS_STORE_PASS', 'KS_KEY_PASS', 'OUT_NAME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT',
        'JAVA_HOME', 'NEXA_GIT_TOKEN', 'NEXA_ENV_TEXT', 'NEXABUILDER_PROJECT_DIR',
        'NEXABUILDER_OUTPUT_DIR', 'NEXABUILDER_FORMAT', 'NEXABUILDER_BUILD_TYPE',
        'NEXABUILDER_APP_ID', 'NEXABUILDER_APP_NAME', 'NEXABUILDER_VERSION_NAME',
        'NEXABUILDER_VERSION_CODE', 'NEXABUILDER_MIN_SDK', 'NEXABUILDER_TARGET_SDK',
    }
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k, v = line.split('=', 1); k = k.strip()
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k) or k in reserved or k.startswith('LD_'):
            continue
        lines.append(f'export {k}={shlex.quote(v.strip().strip(chr(34)).strip(chr(39)))}')
    outn = sanitize_outname((job.get('meta', {}).get('options') or {}).get('outputName') or '')
    if outn: lines.append(f'export OUT_NAME={shlex.quote(outn)}')
    (work / 'env.sh').write_text('\n'.join(lines) + '\n', encoding='utf-8')

def main():
    meta_path = Path(sys.argv[1]).resolve()
    work = Path(sys.argv[2]).resolve()
    base = meta_path.parent
    job = json.loads(meta_path.read_text(encoding='utf-8'))
    if work.exists(): shutil.rmtree(work)
    work.mkdir(parents=True)
    validate_meta(job.get('meta') or {})

    source_proj = work / 'source'
    source_proj.mkdir(parents=True, exist_ok=True)
    proj = source_proj
    src = job['source']
    if src.get('type') == 'git':
        url = str(src.get('url') or '').strip(); branch = str(src.get('branch') or 'main').strip()
        try: parsed_url = urllib.parse.urlsplit(url)
        except ValueError: parsed_url = None
        if (not parsed_url or parsed_url.scheme != 'https' or parsed_url.hostname != 'github.com'
                or parsed_url.username or parsed_url.password or parsed_url.query or parsed_url.fragment
                or not re.fullmatch(r'/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?/?', parsed_url.path or '')
                or any(c in url for c in '\r\n\t')):
            raise SystemExit('URL Git harus repositori HTTPS github.com tanpa kredensial/query')
        if (not re.fullmatch(r'[A-Za-z0-9._/-]+', branch) or branch.startswith('-') or '..' in branch
                or '//' in branch or branch.endswith('/') or branch.endswith('.lock')):
            raise SystemExit('Nama branch Git tidak valid')
        cmd = ['git', 'clone', '--depth', '1', '--branch', branch, url, str(proj)]
        git_token = os.environ.get('NEXA_GIT_TOKEN') or ''
        child_env = os.environ.copy()
        child_env['GIT_TERMINAL_PROMPT'] = '0'
        if git_token:
            auth = base64.b64encode(f'x-access-token:{git_token}'.encode()).decode()
            # Keep credentials out of the process argument list (`ps`).
            child_env.update({
                'GIT_CONFIG_COUNT': '1',
                'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader',
                'GIT_CONFIG_VALUE_0': f'Authorization: Basic {auth}',
            })
        log(f'git clone {url} ({branch})')
        subprocess.run(cmd, check=True, env=child_env)
    else:
        source_type = src.get('type')
        if source_type == 'zip':
            if not src.get('path'):
                raise SystemExit('Path source ZIP tidak ditemukan di metadata')
            lp = safe_base_path(base, src['path'], 'source ZIP')
        elif source_type == 'release-asset':
            # Large uploads are stored as a Release asset, not a Git blob. This avoids
            # the smaller Git Data API payload ceiling while keeping the repository private.
            asset_name = str(src.get('name') or 'source.zip')
            if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}\.zip', asset_name, re.I):
                raise SystemExit('Nama source Release tidak valid')
            repo = os.environ.get('GH_REPO', '').strip()
            build_id = str(job.get('id') or os.environ.get('BUILD_ID') or '')
            if not repo or not re.fullmatch(r'[A-Za-z0-9_-]{4,64}', build_id):
                raise SystemExit('Identitas repositori / build tidak tersedia untuk mengambil source Release')
            incoming = work / 'incoming'
            incoming.mkdir(parents=True, exist_ok=True)
            log(f'mengunduh source asset {asset_name} dari release build-{build_id}')
            subprocess.run([
                'gh', 'release', 'download', f'build-{build_id}',
                '--pattern', asset_name, '--dir', str(incoming), '--repo', repo
            ], check=True)
            lp = incoming / asset_name
        else:
            raise SystemExit('Sumber proyek harus ZIP, Release asset, atau Git')
        if not lp.is_file(): raise SystemExit('source.zip tidak ditemukan')
        with zipfile.ZipFile(lp) as zf:
            members = [item for item in zf.infolist() if not item.is_dir() and not item.filename.startswith('__MACOSX/')]
            expanded_bytes = sum(item.file_size for item in members)
            root = common_root(zf.namelist())
            log(f'ZIP valid: {len(members)} file, {expanded_bytes / (1024 * 1024):.1f} MiB setelah ekstraksi')
            log('Ekstraksi source dimulai; memeriksa path, symlink, jumlah file, dan ukuran hasil')
            # Extraction checks path traversal, symlinks, count, and expanded size.
            safe_extract_zip(zf, proj)
            log(f'Ekstraksi source selesai: {len(members)} file diproses')
        if root:
            inner = proj / root
            if inner.is_dir():
                for child in inner.iterdir(): shutil.move(str(child), str(proj / child.name))
                inner.rmdir()

    sub = str((job.get('meta', {}).get('options') or {}).get('subdir') or '').strip().replace('\\', '/')
    if sub:
        selected = (proj / sub).resolve()
        if proj.resolve() not in selected.parents or not selected.is_dir(): raise SystemExit(f'subfolder proyek tidak ada atau keluar dari folder sumber: {sub}')
        proj = selected
        log(f'subfolder proyek dipilih: {sub}')
    source_rel = proj.relative_to(work).as_posix()
    (work / 'source-path.txt').write_text(source_rel + '\n', encoding='utf-8')

    fw = job.get('meta', {}).get('framework') or detect(proj)
    if fw == 'Auto detect': fw = detect(proj)
    (work / 'framework.txt').write_text(fw + '\n', encoding='utf-8')
    if fw == 'Web / HTML / PWA':
        web_source = proj
        proj = work / 'project'
        create_web_wrapper(web_source, proj, job['meta'])
        (work / 'project-path.txt').write_text('project\n', encoding='utf-8')
    else:
        (work / 'project-path.txt').write_text(str(proj.relative_to(work)) + '\n', encoding='utf-8')

    aroot = android_root(proj, fw)
    mod = find_module(aroot)
    package_json = proj / 'package.json'
    has_expo = False
    if package_json.is_file():
        try:
            package_data = json.loads(package_json.read_text(encoding='utf-8', errors='replace'))
            dependencies = {**package_data.get('dependencies', {}), **package_data.get('devDependencies', {})}
            has_expo = 'expo' in dependencies
        except Exception:
            pass
    defer_native = fw in ('Capacitor / Ionic', 'Cordova') or (fw == 'React Native' and has_expo and not (proj / 'android').is_dir())
    if mod is None and not defer_native and fw != 'Custom script':
        raise SystemExit(f'modul Android (com.android.application) tidak ditemukan di {aroot}. Pastikan proyek menyertakan folder Android atau pilih framework yang sesuai.')
    if mod is not None:
        patch_gradle(mod, job['meta'], aroot, proj)
        patch_manifest(mod, job['meta'])
        apply_icon(mod, job, base)
        gs = (job.get('gservices') or {}).get('path')
        if gs:
            gp = safe_base_path(base, gs, 'google-services.json')
            if gp.is_file(): shutil.copyfile(gp, mod / 'google-services.json')
        log(f'android_root={aroot} module={mod}')
    elif defer_native:
        (work / 'deferred-native.txt').write_text(fw + '\n', encoding='utf-8')
        log(f'{fw}: Android platform dibuat pada tahap build; native config akan diterapkan sesudah sync/prebuild')

    write_env(work, job, base)
    log(f'framework={fw} project={proj}')
    if fw == 'Web / HTML / PWA': log('web_entry=https://appassets.androidplatform.net/assets/index.html')

if __name__ == '__main__':
    main()
