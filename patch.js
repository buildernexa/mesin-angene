// language: JavaScript (ES2022), file: patch.js
(function () {
  'use strict';

  window.addEventListener('error', function(e) { if (typeof toast === 'function') toast('Kesalahan antarmuka: ' + (e.message || 'unknown')); });
  window.addEventListener('unhandledrejection', function(e) { if (typeof toast === 'function') toast('Operasi gagal: ' + (e.reason?.message || String(e.reason || 'unknown'))); });

  const qs = (s) => document.querySelector(s);
  const qsa = (s) => [...document.querySelectorAll(s)];
  const $ = qs, $$ = qsa;

  const fetchWithTimeout = async (url, options = {}, timeout = 60000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('Jaringan Timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const stor = {
    get(k) {
      try {
        if (k === 'gh_pat') return sessionStorage.getItem(k) || '';
        return localStorage.getItem(k) || sessionStorage.getItem(k) || '';
      } catch (_) { return ''; }
    },
    set(k, v) {
      try {
        if (k === 'gh_pat') { sessionStorage.setItem(k, v); localStorage.removeItem(k); }
        else localStorage.setItem(k, v);
      } catch (_) { try { sessionStorage.setItem(k, v); } catch (_) {} }
    },
  };

  let CREDS = {
    owner: stor.get('gh_owner'),
    repo: stor.get('gh_repo') || 'apk-runner',
    pat: stor.get('gh_pat'),
  };

  if (!CREDS.owner) {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (m) CREDS.owner = m[1];
    const p = location.pathname.split('/').filter(Boolean)[0];
    if (p && !stor.get('gh_repo')) CREDS.repo = p;
  }

  const GH = 'https://api.github.com';
  const repoBase = () => `/repos/${CREDS.owner}/${CREDS.repo}`;
  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const ghFetch = async (path, opts = {}, retries = 3) => {
    if (!CREDS.pat) throw new Error('PAT kosong');
    for (let i = 0; i < retries; i++) {
      try {
        const r = await fetchWithTimeout(GH + path, {
          ...opts,
          headers: { Authorization: `Bearer ${CREDS.pat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.method ? {} : { 'Cache-Control': 'no-cache' }), ...(opts.headers || {}) },
        }, 60000); 
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          let msg = `GitHub ${r.status}`;
          try { const j = JSON.parse(body); if (j.message) msg += `: ${j.message}`; } catch (_) {}
          const e = new Error(msg); e.status = r.status;
          if (r.status >= 500) { await new Promise(res => setTimeout(res, 2000 * (i + 1))); continue; }
          throw e;
        }
        if (r.status === 204) return null;
        const payload = await r.text();
        if (!payload) return null;
        try { return JSON.parse(payload); } catch (_) { throw new Error(`Respons GitHub bukan JSON: ${payload.slice(0, 120)}`); }
      } catch (e) {
        if (e.status && e.status < 500) throw e;
        if (i === retries - 1) throw e;
        await new Promise(res => setTimeout(res, 1500 * (i + 1)));
      }
    }
  };

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const ensureCredsModal = () => {
    if (document.getElementById('ghCredsModal')) { document.getElementById('ghCredsModal').hidden = false; return; }
    const d = document.createElement('div');
    d.id = 'ghCredsModal'; d.className = 'modal';
    d.innerHTML = `
      <div class="card" style="width:min(92vw,480px);margin:0">
        <div class="ct">Kredensial GitHub</div>
        <p class="hint" style="margin:0 0 14px">Buat fine-grained PAT dengan scope <b>Contents: RW</b>, <b>Actions: RW</b>, <b>Secrets: RW</b>.</p>
        <div class="fl"><input id="ghOwner" placeholder=" " autocomplete="off"><label for="ghOwner">Owner</label></div>
        <div class="fl"><input id="ghRepo" placeholder=" " autocomplete="off"><label for="ghRepo">Repo</label></div>
        <div class="fl"><input id="ghPat" type="password" placeholder=" " autocomplete="off"><label for="ghPat">PAT</label></div>
        <p class="hint" id="ghCheckMsg" style="margin:4px 0 0;min-height:16px"></p>
        <div style="display:flex;gap:10px;margin-top:18px;"><button type="button" class="btn lime" id="ghSave">Simpan</button><button type="button" class="btn alt" id="ghCancel">Batal</button></div>
      </div>`;
    document.body.appendChild(d);
    d.querySelector('#ghSave').onclick = async () => {
      const owner = d.querySelector('#ghOwner').value.trim(), repo = d.querySelector('#ghRepo').value.trim(), pat = d.querySelector('#ghPat').value.trim();
      const msg = d.querySelector('#ghCheckMsg'), save = d.querySelector('#ghSave');
      if (!owner || !repo || !pat) { msg.textContent = 'Owner, repo, dan PAT wajib diisi.'; msg.style.color = '#c0392b'; return; }
      save.disabled = true; save.textContent = 'Memeriksa…'; msg.textContent = 'Menguji akses ke repositori…'; msg.style.color = '';
      const prevCreds = CREDS;
      try {
        CREDS = { owner, repo, pat };
        const repoInfo = await ghFetch(repoBase());
        if (!repoInfo.permissions || repoInfo.permissions.push !== true) throw new Error('PAT tidak punya akses tulis (push) ke repo ini.');
        await ghFetch(`${repoBase()}/actions/workflows/build.yml`).catch(() => { throw new Error('Workflow .github/workflows/build.yml tidak ditemukan di repo ini. Pastikan sudah di-push dan Actions diaktifkan.'); });
        stor.set('gh_owner', owner); stor.set('gh_repo', repo); stor.set('gh_pat', pat);
        d.hidden = true; updateConn(); pollFailCount = 0; pollOnce();
      } catch (e) {
        CREDS = prevCreds;
        msg.textContent = e.status === 401 ? 'PAT tidak valid atau sudah kedaluwarsa.' : e.status === 404 ? 'Repo tidak ditemukan — cek ejaan owner/repo, atau PAT belum diberi akses ke repo ini.' : (e.message || 'Gagal memeriksa kredensial.');
        msg.style.color = '#c0392b';
      } finally { save.disabled = false; save.textContent = 'Simpan'; }
    };
    d.querySelector('#ghCancel').onclick = () => d.hidden = true;
    d.querySelector('#ghOwner').value = CREDS.owner || ''; d.querySelector('#ghRepo').value = CREDS.repo; d.querySelector('#ghPat').value = CREDS.pat || '';
    d.hidden = false;
  };

  const updateConn = () => {
    const c = qs('#conn'); if (c) c.textContent = CREDS.owner && CREDS.repo ? `github.com/${CREDS.owner}/${CREDS.repo}` : 'Kredensial belum diisi';
  };

  const confirmInApp = (title, message, actionLabel = 'Lanjutkan') => new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const card = document.createElement('div'); card.className = 'card';
    const heading = document.createElement('div'); heading.className = 'ct'; heading.textContent = title;
    const body = document.createElement('p'); body.className = 'hint'; body.style.cssText = 'margin:0;color:#333;font-size:13px'; body.textContent = message;
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const cancel = document.createElement('button'); cancel.className = 'btn alt'; cancel.type = 'button'; cancel.textContent = 'Kembali';
    const accept = document.createElement('button'); accept.className = 'btn'; accept.type = 'button'; accept.textContent = actionLabel;
    const done = value => { modal.remove(); resolve(value); };
    cancel.addEventListener('click', () => done(false));
    accept.addEventListener('click', () => done(true));
    modal.addEventListener('click', e => { if (e.target === modal) done(false); });
    actions.append(cancel, accept); card.append(heading, body, actions); modal.append(card); document.body.append(modal);
    accept.focus();
  });

  const cleanedSecretIds = new Set();
  const runForBuild = (runs, id) => (runs || []).find(r =>
    r.display_title === `Build ${id}` || r.name === `Build ${id}` || r.head_branch === `nexabuild/${id}`
  ) || null;

  let lastGoodBuilds = [];
  API.list = async () => {
    if (!CREDS.owner || !CREDS.pat) return [];
    // Releases are the source of truth; a transient network blip here must not wipe
    // the dashboard. Only a *real* GitHub response (4xx/5xx) is allowed to surface as
    // an error — a raw network failure falls back to the last known-good list instead.
    let rel;
    try {
      rel = await ghFetch(`${repoBase()}/releases?per_page=100`);
    } catch (e) {
      if (e && typeof e.status === 'number') throw e; // real GitHub error: owner/repo wrong, PAT revoked, etc.
      return lastGoodBuilds; // network-layer failure only: keep showing what we already had
    }
    const runData = await ghFetch(`${repoBase()}/actions/runs?per_page=100&event=workflow_dispatch`).catch(() => ({ workflow_runs: [] }));
    const runs = runData.workflow_runs || [];
    const out = (rel || []).filter(r => (r.tag_name || '').startsWith('build-')).map(r => {
      const id = r.tag_name.slice(6);
      let meta = {};
      try { meta = JSON.parse(r.body || '{}'); } catch (_) {}
      const m = meta.meta || {};
      const run = runForBuild(runs, id);
      const assets = r.assets || [];
      const wantedExt = String(m.fmt || 'apk').toLowerCase() === 'aab' ? /\.aab$/i : /\.apk$/i;
      const hasPackage = assets.some(a => wantedExt.test(a.name) && Number(a.size) > 0);
      let st = 'run', pct = 3;
      if (run) {
        if (run.status === 'completed') {
          const completedAt = Date.parse(run.completed_at || run.updated_at || run.created_at || 0) || Date.now();
          const awaitingAsset = run.conclusion === 'success' && !hasPackage && (Date.now() - completedAt) < 60000;
          st = run.conclusion === 'success' && hasPackage ? 'ok' : awaitingAsset ? 'run' : 'bad';
          pct = st === 'ok' ? 100 : awaitingAsset ? 96 : Math.max(0, Number(run.progress || 0));
          if (st !== 'run' && !cleanedSecretIds.has(id)) { cleanedSecretIds.add(id); deleteBuildSecrets(id).catch(() => null); }
        } else {
          st = 'run';
          pct = run.status === 'in_progress' ? 12 : 3;
        }
      } else {
        // No matched workflow run means no verified completion; never infer success from a release tag alone.
        st = 'run'; pct = 3;
      }
      return {
        id, name: m.name || r.name || `build-${id}`, pkg: m.pkg || '', ver: m.ver || '',
        type: m.type || 'debug', fmt: m.fmt || 'apk', st,
        t: new Date(run?.created_at || r.published_at || r.created_at).getTime(), pct,
        runId: run?.id || null
      };
    });
    lastGoodBuilds = out;
    return out;
  };

  API.machine = async () => {
    const runs = await ghFetch(`${repoBase()}/actions/runs?per_page=100&event=workflow_dispatch`);
    const items = runs.workflow_runs || [];
    const running = items.filter(r => r.status === 'in_progress').length;
    const queued = items.filter(r => ['queued', 'waiting', 'requested'].includes(r.status)).length;
    return { runner: 'GitHub Actions / ubuntu-latest', queue: queued, running };
  };

  API.artifact = (b) => b && b.id && CREDS.owner
    ? `https://github.com/${CREDS.owner}/${CREDS.repo}/releases/tag/build-${encodeURIComponent(b.id)}`
    : null;

  const secretName = (id, suffix) => `NEXABUILD_${String(id).toUpperCase()}_${suffix}`;
  const secretNames = id => ['KS_B64','KS_ALIAS','KS_STORE_PASS','KS_KEY_PASS','GIT_TOKEN','ENV_TEXT'].map(s => secretName(id, s));
  const base64File = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Gagal membaca berkas keystore'));
    reader.readAsDataURL(file);
  });

  const uploadReleaseAsset = (release, file, assetName, onProgress) => new Promise((resolve, reject) => {
    if (!release?.id || !file) return reject(new Error('Data unggahan source tidak lengkap'));
    const uploadBase = String(release.upload_url || `https://uploads.github.com/repos/${CREDS.owner}/${CREDS.repo}/releases/${release.id}/assets`)
      .replace(/\{\?name,label\}$/, '');
    const url = `${uploadBase}?name=${encodeURIComponent(assetName)}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${CREDS.pat}`);
    xhr.setRequestHeader('Accept', 'application/vnd.github+json');
    xhr.setRequestHeader('Content-Type', file.type || 'application/zip');
    xhr.setRequestHeader('X-GitHub-Api-Version', '2022-11-28');
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && typeof onProgress === 'function') {
        onProgress({ loaded: event.loaded, total: event.total, pct: Math.min(100, Math.round(event.loaded / event.total * 100)) });
      }
    };
    xhr.onerror = () => reject(new Error('Unggahan source terputus. Periksa jaringan dan izin Contents pada PAT.'));
    xhr.onabort = () => reject(new Error('Unggahan source dibatalkan'));
    xhr.onload = () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300 && payload.id) resolve(payload);
      else reject(new Error(payload.message ? `GitHub ${xhr.status}: ${payload.message}` : `GitHub gagal menerima asset (HTTP ${xhr.status})`));
    };
    xhr.send(file);
  });

  const deleteReleaseById = async release => {
    if (!release?.id) return;
    await ghFetch(`${repoBase()}/releases/${release.id}`, { method: 'DELETE' }).catch(() => null);
    if (release.tag_name) await ghFetch(`${repoBase()}/git/refs/tags/${encodeURIComponent(release.tag_name)}`, { method: 'DELETE' }).catch(() => null);
  };

  const saveBuildSecrets = async (id, values) => {
    const entries = Object.entries(values).filter(([, value]) => value !== null && value !== undefined && String(value).length > 0);
    if (!entries.length) return;
    if (!window.sodium) throw new Error('Komponen enkripsi rahasia belum termuat. Periksa koneksi, lalu muat ulang dashboard.');
    await window.sodium.ready;
    const publicKey = await ghFetch(`${repoBase()}/actions/secrets/public-key`);
    const key = window.sodium.from_base64(publicKey.key, window.sodium.base64_variants.ORIGINAL);
    for (const [suffix, value] of entries) {
      if (String(value).length > 48000) throw new Error(`Nilai rahasia ${suffix} melebihi batas GitHub 48 KB`);
      const cipher = window.sodium.crypto_box_seal(window.sodium.from_string(String(value)), key);
      const encrypted = window.sodium.to_base64(cipher, window.sodium.base64_variants.ORIGINAL);
      await ghFetch(`${repoBase()}/actions/secrets/${secretName(id, suffix)}`, {
        method: 'PUT', body: JSON.stringify({ encrypted_value: encrypted, key_id: publicKey.key_id })
      });
    }
  };

  const deleteBuildSecrets = async id => {
    if (!CREDS.pat || !id) return;
    await Promise.all(secretNames(id).map(name => ghFetch(`${repoBase()}/actions/secrets/${name}`, { method: 'DELETE' }).catch(() => null)));
  };

  const deleteBuildBranch = async id => {
    await ghFetch(`${repoBase()}/git/refs/heads/nexabuild/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
  };
  API.remove = async id => {
    await deleteBuildSecrets(id);
    const release = await ghFetch(`${repoBase()}/releases/tags/build-${encodeURIComponent(id)}`).catch(() => null);
    if (release?.id) await ghFetch(`${repoBase()}/releases/${release.id}`, { method: 'DELETE' }).catch(() => null);
    await ghFetch(`${repoBase()}/git/refs/tags/build-${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    await deleteBuildBranch(id);
  };
  API.removeAll = async () => {
    const releases = await ghFetch(`${repoBase()}/releases?per_page=100`);
    for (const release of (releases || []).filter(r => (r.tag_name || '').startsWith('build-'))) {
      const id = release.tag_name.slice(6);
      await deleteBuildSecrets(id);
      await ghFetch(`${repoBase()}/releases/${release.id}`, { method: 'DELETE' }).catch(() => null);
      await ghFetch(`${repoBase()}/git/refs/tags/${encodeURIComponent(release.tag_name)}`, { method: 'DELETE' }).catch(() => null);
      await deleteBuildBranch(id);
    }
  };

  API.cancel = async (b) => {
    if (!b || !b.id) return;
    const runs = await ghFetch(`${repoBase()}/actions/runs?per_page=100&event=workflow_dispatch`);
    const run = runForBuild(runs.workflow_runs, b.id);
    if (run && run.status !== 'completed') await ghFetch(`${repoBase()}/actions/runs/${run.id}/cancel`, { method: 'POST' }).catch(() => {});
  };

  API.startBuild = async (p, f, onProgress = () => {}) => {
    if (!CREDS.owner || !CREDS.repo || !CREDS.pat) throw new Error('Isi kredensial GitHub terlebih dahulu');
    if (!/^[A-Za-z0-9-]{1,39}$/.test(CREDS.owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(CREDS.repo)) throw new Error('Owner atau nama repositori GitHub tidak valid');
    const id = genId();
    const repo = await ghFetch(repoBase());
    const branch = repo.default_branch || 'main';
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock')) throw new Error('Nama branch default tidak valid');
    if (repo.archived) throw new Error('Repositori build sedang diarsipkan');
    if (repo.visibility !== 'private' && (f.zip || f.keystore || f.gservices || p.git?.token || p.env)) {
      const confirmed = await confirmInApp('Repositori GitHub publik', 'Source ZIP, metadata proyek, dan konfigurasi build dapat terlihat oleh siapa saja. Gunakan repositori privat sebelum melanjutkan. Build dihentikan secara default untuk melindungi source dan rahasia.', 'Saya paham, lanjutkan');
      if (!confirmed) throw new Error('Build dihentikan agar source dan konfigurasi tidak dipublikasikan.');
    }
    if (f.zip && f.zip.size >= 2 * 1024 * 1024 * 1024) throw new Error('ZIP harus kurang dari 2 GiB per file sesuai batas GitHub Release Assets. Untuk source lebih besar, gunakan repositori Git atau pecah arsipnya.');
    if (f.icon && (f.icon.size > 5 * 1024 * 1024 || !/image\/png/i.test(f.icon.type))) throw new Error('Ikon harus PNG dan maksimal 5 MB');
    if (f.gservices && f.gservices.size > 2 * 1024 * 1024) throw new Error('google-services.json maksimal 2 MB');
    if (f.keystore && f.keystore.size > 32 * 1024) throw new Error('Keystore harus maksimal 32 KB karena disimpan sebagai GitHub Actions Secret terenkripsi.');
    if (!Number.isInteger(Number(p.options?.timeoutMin || 120)) || Number(p.options?.timeoutMin || 120) < 1 || Number(p.options?.timeoutMin || 120) > 350) throw new Error('Batas waktu per proses harus 1–350 menit. Total job GitHub-hosted tetap dibatasi 6 jam.');
    if (p.git?.url) {
      let parsed;
      try { parsed = new URL(p.git.url); } catch (_) { throw new Error('URL Git tidak valid'); }
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(parsed.pathname)) throw new Error('Gunakan URL repositori github.com HTTPS tanpa username, password, query, atau token. Token dimasukkan pada kolom terpisah.');
      const branchName = p.git.branch || 'main';
      if (!/^[A-Za-z0-9._/-]+$/.test(branchName) || branchName.startsWith('-') || branchName.includes('..') || branchName.includes('//') || branchName.endsWith('/') || branchName.endsWith('.lock')) throw new Error('Nama branch Git tidak valid');
    }

    const secrets = {
      KS_B64: f.keystore ? await base64File(f.keystore) : '',
      KS_ALIAS: p.keystore?.alias || '',
      KS_STORE_PASS: p.keystore?.password || '',
      KS_KEY_PASS: p.keystore?.keyPassword || p.keystore?.password || '',
      GIT_TOKEN: p.git?.token || '',
      ENV_TEXT: p.env || ''
    };
    let buildBranch = '';
    let branchCreated = false;
    let sourceRelease = null;
    try {
      await saveBuildSecrets(id, secrets);

      const safeMeta = {
        ...p,
        env: '', notify: null,
        git: p.git ? { url: p.git.url, branch: p.git.branch || 'main', token: '' } : null,
        keystore: p.keystore ? { alias: p.keystore.alias || '' } : null
      };
      let zipStoredAsGitBlob = false;
      if (f.zip) {
        try {
          sourceRelease = await ghFetch(`${repoBase()}/releases`, {
          method: 'POST',
          body: JSON.stringify({
            tag_name: `build-${id}`, target_commitish: branch,
            name: `Build ${id}`, body: JSON.stringify({ meta: safeMeta, source_type: 'release-asset' }),
            draft: false, prerelease: false
          })
        });
        onProgress?.({ phase: 'source-upload-start', id, name: f.zip.name, loaded: 0, total: f.zip.size, pct: 0 });
        await uploadReleaseAsset(sourceRelease, f.zip, 'source.zip', progress => {
          onProgress?.({ phase: 'source-upload', id, name: f.zip.name, ...progress });
        });
          onProgress({ phase: 'source-upload-done', id, name: f.zip.name, loaded: f.zip.size, total: f.zip.size, pct: 100 });
        } catch (uploadError) {
          if (sourceRelease) await deleteReleaseById(sourceRelease).catch(() => null);
          sourceRelease = null;
          if (f.zip.size > 45 * 1024 * 1024) throw new Error(`Upload Release asset gagal dan ZIP terlalu besar untuk fallback Git Data API: ${uploadError.message}`);
          zipStoredAsGitBlob = true;
          onProgress({ phase: 'source-upload-fallback', id, name: f.zip.name, loaded: 0, total: f.zip.size, pct: 0, message: uploadError.message });
        }
      }

      const treeEntries = [];

      async function addBlobToTree(path, file) {
        if (!file) return;
        const b64 = await fileToBase64(file);
        const blobRes = await ghFetch(`${repoBase()}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: b64, encoding: 'base64' }) });
        treeEntries.push({ path, mode: '100644', type: 'blob', sha: blobRes.sha });
      }

      if (zipStoredAsGitBlob) await addBlobToTree(`input/${id}.zip`, f.zip);
      if (f.icon) await addBlobToTree(`input/${id}.icon.png`, f.icon);
      if (f.gservices) await addBlobToTree(`input/${id}.gservices.json`, f.gservices);

      const metaDoc = {
        id,
        meta: safeMeta,
        source: f.zip ? (sourceRelease ? { type: 'release-asset', name: 'source.zip' } : { type: 'zip', path: `input/${id}.zip` }) : { type: 'git', url: p.git.url, branch: p.git.branch || 'main' },
        icon: f.icon ? { path: `input/${id}.icon.png` } : null,
        keystore: p.keystore ? { enabled: true } : null,
        gservices: f.gservices ? { path: `input/${id}.gservices.json` } : null
      };
      const metaBlob = await ghFetch(`${repoBase()}/git/blobs`, {
        method: 'POST', body: JSON.stringify({ content: JSON.stringify(metaDoc), encoding: 'utf-8' })
      });
      treeEntries.push({ path: `input/${id}.json`, mode: '100644', type: 'blob', sha: metaBlob.sha });

      // Isolate each upload on its own temporary branch. The default branch is never
      // advanced by browser uploads, so concurrent builds/cleanup jobs cannot race.
      const defaultRef = await ghFetch(`${repoBase()}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      const parentSha = defaultRef.object.sha;
      const parentCommit = await ghFetch(`${repoBase()}/git/commits/${parentSha}`);
      const inputTree = await ghFetch(`${repoBase()}/git/trees`, {
        method: 'POST', body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: treeEntries })
      });
      const inputCommit = await ghFetch(`${repoBase()}/git/commits`, {
        method: 'POST', body: JSON.stringify({ message: `NexaBuilder build input ${id}`, tree: inputTree.sha, parents: [parentSha] })
      });
      buildBranch = `nexabuild/${id}`;
      await ghFetch(`${repoBase()}/git/refs`, {
        method: 'POST', body: JSON.stringify({ ref: `refs/heads/${buildBranch}`, sha: inputCommit.sha })
      });
      branchCreated = true;

      await ghFetch(`${repoBase()}/actions/workflows/build.yml/dispatches`, {
        method: 'POST', body: JSON.stringify({ ref: buildBranch, inputs: { build_id: id, timeout_minutes: String(p.options?.timeoutMin || 120), gradle_version: p.options?.gradle || '8.11.1' } })
      });
      return { id };
    } catch (error) {
      if (branchCreated && buildBranch) {
        await ghFetch(`${repoBase()}/git/refs/heads/${buildBranch.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' }).catch(() => null);
      }
      await deleteBuildSecrets(id).catch(() => null);
      if (sourceRelease) await deleteReleaseById(sourceRelease);
      throw error;
    }
  };

  // --- FUNGSI DOWNLOAD BARU (Bypass 404 & Private Repo) ---
  dl = async function (b) {
    if (!b || !b.id) { toast('Data build tidak valid'); return; }
    try {
      const rel = await ghFetch(`${repoBase()}/releases/tags/build-${encodeURIComponent(b.id)}`);
      const assets = rel?.assets || [];
      const wantedExt = String(b.fmt || 'apk').toLowerCase() === 'aab' ? /\.aab$/i : /\.apk$/i;
      const asset = assets.find(a => wantedExt.test(a.name) && Number(a.size) > 0);
      if (!asset) throw new Error('Paket belum tersedia. Pastikan status build sudah Berhasil.');
      const res = await fetchWithTimeout(`https://api.github.com/repos/${CREDS.owner}/${CREDS.repo}/releases/assets/${asset.id}`, {
        headers: { Authorization: `Bearer ${CREDS.pat}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' }
      }, 180000);
      if (!res.ok) throw new Error(`Unduhan gagal (HTTP ${res.status})`);
      const blob = await res.blob();
      if (!blob.size) throw new Error('File hasil build kosong');
      const url = window.URL.createObjectURL(new Blob([blob], { type: asset.name.toLowerCase().endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url; a.download = asset.name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => window.URL.revokeObjectURL(url), 60000);
      toast(asset.name.endsWith('.apk') ? 'APK diunduh. Buka file dari notifikasi/Unduhan Android untuk memasang.' : 'AAB diunduh. AAB tidak dapat dipasang langsung; gunakan APK.');
    } catch (e) { toast(e.message || 'Unduhan gagal'); }
  };

  const fetchAssetText = async asset => {
    if (!asset?.id) return null;
    const response = await fetchWithTimeout(`https://api.github.com/repos/${CREDS.owner}/${CREDS.repo}/releases/assets/${asset.id}`, {
      headers: { Authorization: `Bearer ${CREDS.pat}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' },
      cache: 'no-store'
    }, 20000);
    if (!response.ok) return null;
    const text = (await response.text()).replace(/\r/g, '');
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };

  const fetchFinalLog = async buildId => {
    try {
      const release = await ghFetch(`${repoBase()}/releases/tags/build-${encodeURIComponent(buildId)}`).catch(() => null);
      const asset = (release?.assets || []).find(item => item.name === 'build.log');
      return asset ? await fetchAssetText(asset) : null;
    } catch (_) { return null; }
  };

  API.live = (b, on) => {
    if (!CREDS.pat) return false;
    let stop = false;
    let runId = null;
    let lastPhase = 0;
    const streamState = {
      setup: { assetId: null, line: 0 },
      toolchain: { assetId: null, line: 0 },
      prep: { assetId: null, line: 0 },
      live: { assetId: null, line: 0 }
    };
    let polls = 0;
    let tickTimer = null;
    let lastRunStatus = '';
    let lastActiveStep = '';
    let verifyMisses = 0;
    const seenGradleTasks = new Set();
    const classOf = line => /\b(error|failed|exception|FAILURE|FAILED)\b/i.test(line) ? 'e' :
      /\b(warn|warning)\b/i.test(line) ? 'w' :
      /\b(BUILD SUCCESSFUL|sukses|selesai|\[done\])\b/i.test(line) ? 'o' :
      /^\[(prepare|deps|build|collect|verify|upload|done|gh|poll|setup|toolchain|prep|web|custom)\]/.test(line) ? 'm' : '';
    const emitLog = line => {
      on({ type: 'log', text: line, c: classOf(line) });
      const explicit = String(line).match(/\[progress\]\s*(\d{1,3})/i);
      if (explicit) on({ type: 'progress', pct: Math.min(96, Number(explicit[1])) });
      const task = String(line).match(/^> Task (:[^\s]+)/);
      if (task && !seenGradleTasks.has(task[1])) {
        seenGradleTasks.add(task[1]);
        on({ type: 'tasks', count: seenGradleTasks.size, name: task[1] });
      }
      const lower = String(line).toLowerCase();
      if (/^\[prep\]/.test(line) || lower.includes('mengunduh source asset')) on({ type: 'explain', title: 'Menyiapkan source proyek', body: 'Worker sedang mengambil arsip/repository, memeriksa struktur file, mengekstrak source, dan mendeteksi framework.' });
      else if (/^\[setup\]/.test(line)) on({ type: 'explain', title: 'Menyiapkan runner', body: 'GitHub Actions sedang memasang utilitas dasar yang dibutuhkan mesin build.' });
      else if (/^\[toolchain\]/.test(line)) on({ type: 'explain', title: 'Memeriksa toolchain', body: 'Mesin sedang melaporkan versi Java, Gradle, Android SDK, Node/npm, dan Flutter yang benar-benar tersedia pada runner.' });
      else if (/^\[prepare\]/.test(line) || lower.includes('framework=')) on({ type: 'explain', title: 'Menganalisis proyek', body: 'Mesin sedang membaca konfigurasi, direktori aplikasi, versi, permission, ikon, dan dependensi.' });
      else if (/npm (ci|install)|flutter pub get|git clone/.test(lower)) on({ type: 'explain', title: 'Memasang dependensi', body: 'Package manager sedang mengunduh library yang diperlukan oleh proyek. Waktu bergantung pada ukuran dan jaringan.' });
      else if (/^> task /.test(lower) || /\bgradle\b|\bflutter build\b/.test(lower)) on({ type: 'explain', title: 'Mengompilasi aplikasi', body: 'Compiler sedang mengubah source menjadi komponen Android. Baris tugas di terminal berasal dari proses compiler.' });
      else if (/^\[collect\]/.test(line)) on({ type: 'explain', title: 'Mengumpulkan hasil', body: 'Worker sedang mencari APK/AAB yang dihasilkan dan menyalinnya ke folder hasil.' });
      else if (/^\[verify\]/.test(line)) on({ type: 'explain', title: 'Memeriksa paket', body: 'Worker memeriksa arsip, tanda tangan, dan alignment sebelum file dinyatakan layak diunduh.' });
      else if (/^\[upload\]/.test(line)) on({ type: 'explain', title: 'Mengunggah hasil', body: 'Paket yang lolos pemeriksaan sedang dikirim ke GitHub Release agar dapat diunduh dari dashboard.' });
      else if (/^\[done\]/.test(line)) on({ type: 'explain', title: 'Build selesai', body: 'Workflow selesai dan paket sudah tersedia di Release. Dashboard akan memverifikasi file sebelum menampilkan 100%.' });
    };
    const downloadNewChunks = async release => {
      const assets = release?.assets || [];
      const indexed = new Map(assets.map(asset => [asset.name, asset]));

      const emitBuildRange = (lines, pattern, source) => {
        if (!lines?.length) return;
        const range = pattern.exec(lines[0]);
        if (!range) {
          // Compatibility with older releases that did not include line ranges.
          for (const line of lines) emitLog(line);
          return;
        }
        const startLine = Number(range[1]);
        const endLine = Number(range[2]);
        const state = streamState.live; // phase and live feeds describe the same build.log
        const expectedLine = state.line + 1;
        if (startLine > expectedLine) {
          emitLog(`[stream] ${startLine - expectedLine} baris ${source} terlewat saat dashboard tidak memantau; log akhir menyimpan seluruh keluaran`);
        }
        const skip = Math.max(0, expectedLine - startLine);
        for (const line of lines.slice(1 + skip)) emitLog(line);
        state.line = Math.max(state.line, endLine);
      };

      // Setup and preparation have separate logs. The build phase and rolling
      // live asset share one line cursor so the same stdout is never printed twice.
      for (const prefix of ['setup', 'toolchain', 'prep']) {
        const asset = indexed.get(`${prefix}-live.txt`);
        const state = streamState[prefix];
        if (!asset?.id || String(asset.id) === String(state.assetId)) continue;
        const lines = await fetchAssetText(asset);
        if (!lines?.length) continue;
        const match = /^#NEXA-STREAM start=(\d+) end=(\d+)$/.exec(lines[0]);
        if (match) {
          const startLine = Number(match[1]);
          const expectedLine = state.line + 1;
          if (startLine > expectedLine) emitLog(`[stream] ${startLine - expectedLine} baris ${prefix} terlewat; log final tersedia untuk audit`);
          for (const line of lines.slice(1 + Math.max(0, expectedLine - startLine))) emitLog(line);
          state.line = Math.max(state.line, Number(match[2]));
        } else {
          for (const line of lines) emitLog(line);
          state.line += lines.length;
        }
        state.assetId = asset.id;
      }

      const liveAsset = indexed.get('live-live.txt');
      if (liveAsset?.id && String(liveAsset.id) !== String(streamState.live.assetId)) {
        const lines = await fetchAssetText(liveAsset);
        emitBuildRange(lines, /^#NEXA-STREAM start=(\d+) end=(\d+)$/, 'live');
        streamState.live.assetId = liveAsset.id;
      }

      // Phase snapshots are short checkpoints. Their explicit line ranges share
      // the live cursor, preventing duplicates when an interval upload races a phase.
      const phaseNumbers = [...indexed.keys()]
        .map(name => /^log-(\d+)\.txt$/.exec(name))
        .filter(Boolean).map(match => Number(match[1]))
        .filter(n => n > lastPhase).sort((a, b) => a - b);
      for (const n of phaseNumbers) {
        const lines = await fetchAssetText(indexed.get(`log-${n}.txt`));
        if (!lines) break;
        emitBuildRange(lines, /^#NEXA-PHASE start=(\d+) end=(\d+)$/, `phase ${n}`);
        lastPhase = n;
      }
    };

    const tick = async () => {
      if (stop) return;
      polls++;
      try {
        if (!runId) {
          const runs = await ghFetch(`${repoBase()}/actions/runs?per_page=100&event=workflow_dispatch`);
          const candidate = runForBuild(runs.workflow_runs, b.id);
          if (candidate) { runId = candidate.id; emitLog(`[gh] runner #${runId} ditemukan`); if (candidate.html_url) emitLog(`[gh] log workflow: ${candidate.html_url}`); }
          else if (polls === 1) emitLog('[gh] menunggu runner GitHub Actions…');
          else if (polls % 20 === 0) emitLog('[poll] belum masuk daftar runner; tetap memantau antrean GitHub');
        }

        if (runId) {
          const [run, jobs, release] = await Promise.all([
            ghFetch(`${repoBase()}/actions/runs/${runId}`),
            ghFetch(`${repoBase()}/actions/runs/${runId}/jobs`).catch(() => ({ jobs: [] })),
            ghFetch(`${repoBase()}/releases/tags/build-${encodeURIComponent(b.id)}`).catch(() => null)
          ]);
          if (run.status !== lastRunStatus) {
            lastRunStatus = run.status;
            emitLog(`[gh] status workflow: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ''}`);
          }
          const job = (jobs.jobs || [])[0];
          if (job) {
            const steps = job.steps || [];
            const completed = steps.filter(step => step.status === 'completed').length;
            const total = Math.max(1, steps.length);
            const buildStep = steps.find(step => step.name === 'Build and verify');
            let pct = Math.min(25, Math.round((completed / total) * 25));
            if (buildStep?.status === 'in_progress') pct = Math.max(pct, 30);
            if (buildStep?.status === 'completed') pct = Math.max(pct, 82);
            if (run.status === 'in_progress') pct = Math.max(pct, 3);
            on({ type: 'progress', pct });
            const failedStep = steps.findIndex(step => step.conclusion === 'failure');
            const activeStep = steps.findIndex(step => step.status === 'in_progress');
            const phaseStep = failedStep >= 0 ? failedStep : activeStep >= 0 ? activeStep : completed;
            on({ type: 'step', n: Math.max(0, Math.min(4, Math.floor((phaseStep / total) * 5))) });
            const active = activeStep >= 0 ? steps[activeStep] : null;
            if (active) {
              const friendly = {
                'Validate job and read metadata': ['Memvalidasi konfigurasi', 'Worker sedang memeriksa identitas aplikasi, format paket, dan opsi toolchain.'],
                'Create build release': ['Menyiapkan penyimpanan hasil', 'GitHub Release dibuat sebagai tempat menyimpan log dan file keluaran build.'],
                'Prepare release signing key': ['Menyiapkan tanda tangan', 'Kunci rilis diproses di runner. Nilai rahasia tidak ditampilkan di terminal.'],
                'Install helpers': ['Menyiapkan runner', 'Runner memasang utilitas yang dibutuhkan untuk ekstraksi, validasi, dan proses build.'],
                'Report active toolchain': ['Memeriksa toolchain', 'Terminal menampilkan versi aktual Java, Gradle, Android SDK, Node/npm, dan Flutter yang terpasang pada runner.'],
                'Prepare project source': ['Menyiapkan source proyek', 'Worker mengunduh source, memeriksa arsip, mendeteksi framework, dan menyiapkan project Android.'],
                'Build and verify': ['Mengompilasi dan memeriksa paket', 'Compiler sedang membuat APK/AAB. Terminal menampilkan tugas build nyata; setelah itu worker memeriksa file.'],
                'Upload final result log': ['Menyimpan log akhir', 'Worker mengunggah catatan final untuk audit dan riwayat build.'],
                'Delete isolated build branch': ['Membersihkan file sementara', 'Branch input sementara dihapus setelah worker selesai.']
              }[active.name] || [active.name, 'GitHub Actions sedang menjalankan langkah ini.'];
              on({ type: 'explain', title: friendly[0], body: friendly[1] });
            }
            if (failedStep >= 0) emitLog(`[gh] langkah gagal: ${steps[failedStep].name}`);
            if (active && active.name !== lastActiveStep) {
              lastActiveStep = active.name;
              emitLog(`[gh] ${active.name}: berjalan`);
            }
          }

          await downloadNewChunks(release);

          if (run.status === 'completed') {
            const wantedExt = String(b.fmt || 'apk').toLowerCase() === 'aab' ? /\.aab$/i : /\.apk$/i;
            const packageAsset = (release?.assets || []).find(asset => wantedExt.test(asset.name) && Number(asset.size) > 0);
            if (run.conclusion === 'success' && !packageAsset && verifyMisses < 11) {
              verifyMisses++;
              emitLog(`[verify] workflow sukses; menunggu GitHub menampilkan asset keluaran (${verifyMisses}/11)`);
              on({ type: 'explain', title: 'Memastikan file hasil tersedia', body: 'GitHub sudah menyelesaikan workflow. Dashboard sedang memeriksa ulang daftar Release asset agar tidak salah menyatakan gagal saat file masih dipublikasikan.' });
              tickTimer = setTimeout(tick, 5000);
              return;
            }
            const success = run.conclusion === 'success' && Boolean(packageAsset);
            if (!success) {
              const full = await fetchFinalLog(b.id);
              if (full) for (const line of full) emitLog(line);
              if (run.conclusion === 'success' && !packageAsset) emitLog('[verify] asset APK/AAB yang diminta tidak muncul setelah pemeriksaan ulang; build tidak dianggap berhasil');
              else emitLog(`[verify] hasil workflow: ${run.conclusion || 'tanpa kesimpulan'}`);
            }
            on({ type: 'status', st: success ? 'ok' : 'bad' });
            await deleteBuildSecrets(b.id).catch(() => null);
            stop = true;
            return;
          }
        }
      } catch (error) {
        if (polls === 1 || polls % 5 === 0) emitLog(`[poll] ${error.message || 'gagal membaca status GitHub'}`);
      }
      if (!stop) tickTimer = setTimeout(tick, 5000);
    };
    tick();
    b._es = { close: () => { stop = true; if (tickTimer) clearTimeout(tickTimer); } };
    return true;
  };

  onEvt = function (e) {
    if (!e || !e.type) return;
    if (e.type === 'log') addLog(e.text == null ? '' : String(e.text), e.c);
    if (e.type === 'explain') { const t = qs('#buildExplainTitle'); const b = qs('#buildExplain'); if (t) t.textContent = e.title || 'Proses build'; if (b) b.textContent = e.body || ''; }
    if (e.type === 'tasks') { const t = qs('#taskCount'); if (t) t.textContent = `${Number(e.count) || 0} aktivitas Gradle terdeteksi · terakhir ${e.name || ''}`; }
    if (e.type === 'step') drawSteps(Math.max(0, Math.min(4, Number(e.n) || 0)));
    if (e.type === 'progress') {
      const terminalState = qs('#terminalState'); if (terminalState) terminalState.textContent = 'BUILDING';
      const incoming = Math.max(0, Math.min(96, Number(e.pct) || 0));
      const p = Math.max(incoming, typeof cur !== 'undefined' && cur ? Number(cur.pct) || 0 : 0);
      if (typeof cur !== 'undefined' && cur) cur.pct = p;
      const bar = qs('#liveBar'); if (bar) bar.style.width = p + '%';
      const pctLabel = qs('#livePct'); if (pctLabel) pctLabel.textContent = p + '%';
    }
    if (e.type === 'status') {
      if (typeof cur === 'undefined' || !cur) return;
      cur.st = e.st;
      cur.pct = e.st === 'ok' ? 100 : (cur.pct || 0);
      const terminalState = qs('#terminalState'); if (terminalState) terminalState.textContent = e.st === 'ok' ? 'SUCCESS' : 'FAILED';
      if (typeof notifyDone === 'function') notifyDone(e.st);
      const sb = qs('#startBtn'); if (sb) { sb.disabled = false; const aab = qs('#fmtSeg button.on')?.dataset.v === 'aab'; const release = qs('#typeSeg button.on')?.dataset.v === 'release'; sb.textContent = aab ? 'Mulai build AAB' : release ? 'Mulai build Release APK' : 'Mulai build APK'; }
      const cb = qs('#cancelBtn'); if (cb) { cb.hidden = true; cb.disabled = false; }
      const pb = qs('#pb'); if (pb) pb.classList.remove('on');
      if (e.st === 'ok') {
        drawSteps(5);
        const bar = qs('#liveBar'); if (bar) bar.style.width = '100%';
        const pctLabel = qs('#livePct'); if (pctLabel) pctLabel.textContent = '100%';
        const guide = qs('#installGuide');
        if (guide) {
          guide.classList.add('on');
          guide.textContent = String(cur.fmt || 'apk').toLowerCase() === 'aab'
            ? 'AAB berhasil dibuat dan diperiksa. AAB bukan berkas yang dapat dipasang langsung; gunakan Google Play Console atau bundletool untuk menghasilkan APK.'
            : 'APK berhasil dibuat dan diverifikasi. Unduh, lalu buka berkas dari notifikasi atau folder Unduhan Android. Konfirmasi izin pemasangan untuk browser/pengelola berkas bila diminta.';
        }
        const dlb = qs('#dlBtn'); if (dlb) { dlb.hidden = false; dlb.textContent = String(cur.fmt || 'apk').toLowerCase() === 'aab' ? 'Unduh AAB' : 'Unduh APK untuk pasang'; }
        if (typeof toast === 'function') toast('Build selesai');
      } else {
        drawSteps(2, true);
        if (typeof toast === 'function') toast('Build gagal atau dibatalkan');
      }
      if (cur._es) { try { cur._es.close(); } catch (_) {} cur._es = null; }
      const dlb = qs('#dlBtn'); if (dlb) dlb.hidden = e.st !== 'ok';
      if (typeof renderAll === 'function') renderAll();
    }
  };

  renderAll = function () {
    const arr = typeof builds !== 'undefined' && Array.isArray(builds) ? builds : [];
    const n = (s) => arr.filter(b => b.st === s).length;
    const set = (id, v) => { const el = qs(id); if (el) el.textContent = v; };
    set('#sTot', arr.length); set('#sOk', n('ok')); set('#sBad', n('bad')); set('#sQ', n('run'));
    const card = (b) => '<div class="item"><span><b>' + esc(String(b.name || 'Tanpa nama')) + '</b><small>' + esc(String(b.ver || '?')) + ' · ' + ago(b.t || Date.now()) + '</small></span>' + sp(b.st || 'bad', b.pct) + '</div>';
    const recent = arr.slice(0, 4).map(card).join('') || '<div class="empty">Belum ada build.</div>';
    const r1 = qs('#recent'); if (r1) r1.innerHTML = recent;
    const r2 = qs('#recent2'); if (r2) r2.innerHTML = recent;

    const q = (qs('#q') ? qs('#q').value : '').toLowerCase();
    const f = qs('#fil') ? qs('#fil').value : '';
    const rows = arr.filter(b => {
      if (f && b.st !== f) return false;
      if (!q) return true;
      return (String(b.name || '') + String(b.pkg || '')).toLowerCase().includes(q);
    });
    const rowsEl = qs('#rows');
    if (rowsEl) {
      rowsEl.innerHTML = rows.map(b => {
        const id = esc(String(b.id));
        return '<div class="rw"><div><b>' + esc(String(b.name || 'Tanpa nama')) + '</b><small class="mono">' + esc(String(b.pkg || '')) + '</small></div>' +
          '<div class="mt">' + esc(String(b.ver || '?')) + ' · ' + esc(String(b.type || '?')) + ' · ' + String(b.fmt || 'apk').toUpperCase() + ' · ' + ago(b.t || Date.now()) + '</div>' +
          '<div class="ac">' + sp(b.st || 'bad', b.pct) + (b.st === 'ok' ? '<button class="btn mini" data-dl="' + id + '">Unduh</button>' : '') +
          '<button class="btn mini alt" data-rb="' + id + '">Ulangi</button><button class="btn mini alt" data-rm="' + id + '">Hapus</button></div></div>';
      }).join('') || '<div class="empty">Tidak ada build yang cocok.</div>';
    }
    const run = n('run') > 0;
    const ms = qs('#mSt'); if (ms) ms.className = 'sp ' + (run ? 'run' : '');
    const mt = qs('#mTxt');
    if (mt) mt.textContent = !CREDS.pat ? 'PAT belum diisi' : !CREDS.owner ? 'Owner belum diisi' : run ? 'Sedang membangun' : 'GitHub siap';
    updateConn();
  };

  // Identity-first input: generate a valid default Android application ID, but keep it editable.
  const appNameInput = qs('#appName');
  const packageInput = qs('#pkg');
  let packageWasEdited = false;
  const packageSlug = value => {
    let slug = String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '').replace(/^[^a-z]+/, '').slice(0, 28);
    if (!slug) slug = 'myapp';
    if (!/^[a-z]/.test(slug)) slug = `app${slug}`;
    return slug;
  };
  if (packageInput) {
    packageInput.addEventListener('input', () => { packageWasEdited = true; });
    if (!packageInput.value.trim()) packageInput.value = 'com.nexabuilder.myapp';
  }
  if (appNameInput && packageInput) appNameInput.addEventListener('input', () => {
    if (!packageWasEdited) packageInput.value = `com.nexabuilder.${packageSlug(appNameInput.value)}`;
  });

  const zipDrop = qs('#drop');
  const zipInput = qs('#zipIn');
  if (zipDrop && zipInput) {
    ['dragenter', 'dragover'].forEach(type => zipDrop.addEventListener(type, event => { event.preventDefault(); zipDrop.classList.add('has'); }));
    ['dragleave', 'drop'].forEach(type => zipDrop.addEventListener(type, event => { event.preventDefault(); if (type === 'drop') {
      const file = event.dataTransfer?.files?.[0];
      if (file && /\.zip$/i.test(file.name)) {
        const transfer = new DataTransfer(); transfer.items.add(file); zipInput.files = transfer.files;
        zipInput.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (file) toast('Pilih berkas ZIP proyek.');
    } zipDrop.classList.remove('has'); }));
  }
  const fmtButtons = qsa('#fmtSeg button');
  const typeButtons = qsa('#typeSeg button');
  const activateSegment = (buttons, value) => buttons.forEach(button => button.classList.toggle('on', button.dataset.v === value));
  const updateBuildMode = () => {
    let isRelease = qs('#typeSeg button.on')?.dataset.v === 'release';
    let isAab = qs('#fmtSeg button.on')?.dataset.v === 'aab';
    if (isAab && !isRelease) {
      activateSegment(typeButtons, 'release');
      if (typeof type !== 'undefined') type = 'release';
      isRelease = true;
    }
    const signing = qs('#signCard'); if (signing) signing.hidden = !isRelease;
    const start = qs('#startBtn'); if (start) start.textContent = isAab ? 'Mulai build AAB' : isRelease ? 'Mulai build Release APK' : 'Mulai build APK';
    if (isRelease || isAab) { const advanced = qs('#advancedSettings'); if (advanced) advanced.open = true; }
  };
  fmtButtons.forEach(button => button.addEventListener('click', () => setTimeout(updateBuildMode, 0)));
  typeButtons.forEach(button => button.addEventListener('click', () => {
    if (button.dataset.v === 'debug' && qs('#fmtSeg button.on')?.dataset.v === 'aab') {
      activateSegment(fmtButtons, 'apk');
      if (typeof fmt !== 'undefined') fmt = 'apk';
    }
    setTimeout(updateBuildMode, 0);
  }));
  updateBuildMode();

  const cancelButton = qs('#cancelBtn');
  if (cancelButton) cancelButton.onclick = async () => {
    if (!cur || cur.st !== 'run') return;
    cancelButton.disabled = true;
    try {
      await API.cancel(cur);
      if (typeof toast === 'function') toast('Pembatalan dikirim ke GitHub Actions. Menunggu worker berhenti…');
    } catch (error) {
      if (typeof toast === 'function') toast(error.message || 'Permintaan pembatalan gagal');
      cancelButton.disabled = false;
    }
  };

  const startBtn = qs('#startBtn');
  if (startBtn) startBtn.onclick = async () => {
    const originalText = startBtn.textContent;
    try {
      if (!CREDS.pat) { ensureCredsModal(); return; }
      
      const name = qs('#appName')?.value.trim();
      const pkg = qs('#pkg')?.value.trim();
      
      if (!name) { if (typeof toast === 'function') toast('Isi nama aplikasi dulu'); qs('#appName')?.focus(); return; }
      if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg || '')) { if (typeof toast === 'function') toast('ID paket harus seperti com.contoh.app'); qs('#pkg')?.focus(); return; }
      
      const srcEl = qs('#srcSeg button.on');
      const src = srcEl ? srcEl.dataset.v : 'zip';
      if (src === 'zip' && !(qs('#zipIn')?.files?.length)) { if (typeof toast === 'function') toast('Pilih berkas ZIP proyek'); return; }
      if (src === 'git' && !qs('#gitUrl')?.value.trim()) { if (typeof toast === 'function') toast('Isi URL repositori'); return; }
      
      const vc = Number(qs('#vCode')?.value);
      if (!Number.isInteger(vc) || vc < 1) { if (typeof toast === 'function') toast('Kode versi harus bilangan bulat ≥ 1'); return; }
      
      if (!qsa('#arch .chip.on').length) { if (typeof toast === 'function') toast('Pilih minimal satu arsitektur'); return; }
      
      const typeEl = qs('#typeSeg button.on');
      const type = typeEl ? typeEl.dataset.v : 'debug';
      const fmtEl = qs('#fmtSeg button.on');
      const fmt = fmtEl ? fmtEl.dataset.v : 'apk';
      
      const ks = qs('#ksIn') || qsa('#signCard input[type=file]')[0];
      if (type === 'release' && (!ks || !ks.files[0])) { if (typeof toast === 'function') toast('Pilih berkas keystore untuk build release'); return; }

      const opts = {
        ...Object.fromEntries(qsa("[data-opt]").map(e => [e.dataset.opt, e.checked])),
        abis: qsa("#arch .chip.on").map(c => c.textContent),
        minSdk: +(qs("#minSdk")?.value) || 24,
        targetSdk: +(qs("#tgtSdk")?.value) || 36,
        jdk: (qs("#jdk")?.value) || '17',
        gradle: (qs("#grd")?.value) || '8.11.1',
        timeoutMin: +(qs("#tmo")?.value) || 120,
        subdir: (qs("#sub")?.value) || '',
        outputName: (qs("#outn")?.value) || '',
        webOutputDir: (qs("#webOut")?.value) || '',
        gradleArgs: (qs("#gargs")?.value) || ''
      };

      const permissions = typeof permList === 'function' ? permList() : [...document.querySelectorAll('#perms [data-pk].on')].map(el => 'android.permission.' + el.dataset.pk);
      const features = { orientation: qs('#ori')?.value || 'auto', ...Object.fromEntries(qsa('[data-feat]').map(e => [e.dataset.feat, e.checked])) };

      startBtn.disabled = true;
      startBtn.textContent = 'Mengirim source…';
      const terminalState = qs('#terminalState'); if (terminalState) terminalState.textContent = 'SOURCE';
      const logEl = qs('#log'); if (logEl) logEl.innerHTML = '';
      if (typeof logBuf !== 'undefined' && Array.isArray(logBuf)) logBuf.length = 0;
      const taskCount = qs('#taskCount'); if (taskCount) taskCount.textContent = 'Menunggu aktivitas compiler';
      const explainTitle = qs('#buildExplainTitle'); if (explainTitle) explainTitle.textContent = 'Mengirim source proyek';
      const explainBody = qs('#buildExplain'); if (explainBody) explainBody.textContent = 'Arsip dikirim ke GitHub Release menggunakan unggahan langsung. Setelah itu GitHub Actions mulai menjalankan worker.';
      const uploadBar = qs('#liveBar'); if (uploadBar) uploadBar.style.width = '0%';
      const uploadPct = qs('#livePct'); if (uploadPct) uploadPct.textContent = '0%';
      if (typeof addLog === 'function') addLog('[upload] menyiapkan source proyek dan konfigurasi build', 'o');
      let lastUploadMilestone = -1;
      const r = await API.startBuild({
        name, pkg, type, fmt,
        ver: qs('#vName')?.value || '1.0.0',
        vcode: vc,
        framework: qs('#framework')?.value || 'Android native (Gradle)',
        env: qs('#env')?.value || '',
        git: src === 'git' ? { url: qs('#gitUrl').value, branch: qs('#gitBr').value, token: qs('#gitTok').value } : null,
        keystore: type === 'release' ? { alias: qs('#alias')?.value || '', password: qs('#ksPw')?.value || '', keyPassword: qs('#ksKeyPw')?.value || qs('#ksPw')?.value || '' } : null,
        permissions, features, options: opts,
      }, {
        zip: src === 'zip' ? qs('#zipIn').files[0] : null,
        icon: (qs('#iconIn') || qsa('input[accept="image/png"]')[0])?.files?.[0] || null,
        keystore: type === 'release' && ks ? ks.files[0] : null,
        gservices: qs('#gsv')?.files?.[0] || null,
      }, event => {
        if (!event) return;
        if (event.phase === 'source-upload-start') {
          if (typeof addLog === 'function') addLog(`[upload] mulai mengirim ${event.name || 'source.zip'} (${(Number(event.total || 0) / 1048576).toFixed(1)} MB) ke GitHub Release`, 'm');
        } else if (event.phase === 'source-upload') {
          const pct = Math.max(0, Math.min(99, Number(event.pct) || 0));
          if (uploadBar) uploadBar.style.width = pct + '%';
          if (uploadPct) uploadPct.textContent = `UPLOAD ${pct}%`;
          if (terminalState) terminalState.textContent = `UPLOAD ${pct}%`;
          const milestone = Math.floor(pct / 10);
          if (milestone > lastUploadMilestone && typeof addLog === 'function') {
            lastUploadMilestone = milestone;
            addLog(`[upload] source terkirim ${pct}% (${(Number(event.loaded || 0) / 1048576).toFixed(1)} / ${(Number(event.total || 0) / 1048576).toFixed(1)} MB)`, 'm');
          }
        } else if (event.phase === 'source-upload-fallback') {
          if (typeof addLog === 'function') addLog('[warn] upload asset gagal; ZIP kecil dialihkan ke Git Data API', 'w');
          if (typeof toast === 'function') toast('Menggunakan jalur unggah cadangan untuk ZIP kecil');
        } else if (event.phase === 'source-upload-done') {
          if (typeof addLog === 'function') addLog('[upload] source berhasil disimpan sebagai Release asset', 'o');
          if (uploadBar) uploadBar.style.width = '100%';
          if (uploadPct) uploadPct.textContent = 'SOURCE OK';
        }
      });

      if (typeof cur !== 'undefined') cur = { id: r.id, name, pkg, ver: qs('#vName')?.value, type, fmt, st: 'run', t: Date.now(), pct: 0 };
      startBtn.textContent = 'Build sedang berjalan…';
      const queuedState = qs('#terminalState'); if (queuedState) queuedState.textContent = 'QUEUED';
      if (typeof builds !== 'undefined') builds.unshift(cur);
      if (typeof renderAll === 'function') renderAll();
      if (typeof keepAwake === 'function') keepAwake(true);

      const dlb = qs('#dlBtn'); if (dlb) dlb.hidden = true;
        const guide = qs('#installGuide'); if (guide) guide.classList.remove('on');
      const cb = qs('#cancelBtn'); if (cb) cb.hidden = false;
      const bar = qs('#liveBar'); if (bar) bar.style.width = '0';
      const queuedPct = qs('#livePct'); if (queuedPct) queuedPct.textContent = '0%';
      const pb = qs('#pb'); if (pb) pb.classList.add('on');
      const lt = qs('#liveTitle'); if (lt) lt.textContent = 'Membangun ' + name;
      
      if (typeof drawSteps === 'function') drawSteps(0);
      if (typeof addLog === 'function') { addLog(`[gh] memicu workflow...`, 'o'); addLog(`[gh] build_id=${r.id}`, 'm'); }
      if (logEl) logEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

      if (API.live(cur, onEvt)) return;
      
    } catch (e) {
      console.error(e);
      const terminalState = qs('#terminalState'); if (terminalState) terminalState.textContent = 'FAILED';
      if (typeof addLog === 'function') addLog(`[error] ${e.message || 'Gagal mulai build'}`, 'e');
      if (typeof toast === 'function') toast(e.message || 'Gagal mulai build');
      else alert(e.message || 'Gagal mulai build');
      startBtn.disabled = false;
      startBtn.textContent = originalText;
    }
  };

  document.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      e.preventDefault(); e.stopPropagation();
      const target = typeof builds !== 'undefined' ? builds.find(b => String(b.id) === rm.dataset.rm) : null;
      if (target?.st === 'run') { if (typeof toast === 'function') toast('Batalkan build yang berjalan sebelum menghapusnya.'); return; }
      try { await API.remove(rm.dataset.rm); } catch (error) { if (typeof toast === 'function') toast(error.message || 'Riwayat gagal dihapus'); return; }
      if (typeof builds !== 'undefined') builds = builds.filter(b => String(b.id) !== rm.dataset.rm);
      if (typeof renderAll === 'function') renderAll();
      return;
    }
    const clr = e.target.closest('#clr');
    if (clr) {
      const armed = clr.dataset.armed === '1';
      if (!armed) { clr.dataset.armed = '1'; if (typeof toast === 'function') toast('Tekan sekali lagi untuk hapus semua'); setTimeout(() => delete clr.dataset.armed, 3000); return; }
      delete clr.dataset.armed;
      if (typeof builds !== 'undefined' && builds.some(b => b.st === 'run')) { if (typeof toast === 'function') toast('Batalkan build aktif sebelum menghapus semua riwayat.'); return; }
      try { await API.removeAll(); } catch (error) { if (typeof toast === 'function') toast(error.message || 'Riwayat gagal dibersihkan'); return; }
      if (typeof builds !== 'undefined') builds = [];
      if (typeof renderAll === 'function') renderAll();
    }
  }, true);

  async function pollOnce() {
    if (!CREDS.pat || !CREDS.owner) return;
    try {
      const arr = await API.list();
      if (typeof builds !== 'undefined') {
        builds = arr;
        // Keep the currently monitored object attached to the freshly loaded history.
        if (typeof cur !== 'undefined' && cur) {
          const index = builds.findIndex(b => String(b.id) === String(cur.id));
          if (index >= 0) {
            const latest = builds[index];
            const stream = cur._es;
            Object.assign(cur, latest);
            if (stream) cur._es = stream;
            builds[index] = cur;
            if (cur.st !== 'run' && typeof onEvt === 'function') onEvt({ type: 'status', st: cur.st });
          }
        }

        // A page refresh must not orphan a running GitHub Actions job. Resume polling
        // from its existing release/log assets instead of leaving a frozen 12% card.
        if ((!cur || cur.st !== 'run') && typeof onEvt === 'function') {
          const active = builds.find(b => b.st === 'run');
          if (active) {
            cur = active;
            const start = qs('#startBtn'); if (start) { start.disabled = true; start.textContent = 'Build sedang berjalan…'; }
            const cancel = qs('#cancelBtn'); if (cancel) { cancel.hidden = false; cancel.disabled = false; }
            const progress = qs('#pb'); if (progress) progress.classList.add('on');
            const title = qs('#liveTitle'); if (title) title.textContent = 'Melanjutkan build ' + (cur.name || cur.id);
            const state = qs('#terminalState'); if (state) state.textContent = 'QUEUED';
            const bar = qs('#liveBar'); if (bar) bar.style.width = `${Math.min(96, Number(cur.pct) || 3)}%`;
            const pct = qs('#livePct'); if (pct) pct.textContent = `${Math.min(96, Number(cur.pct) || 3)}%`;
            if (typeof addLog === 'function') addLog(`[gh] melanjutkan pemantauan build ${cur.id}`, 'm');
            API.live(cur, onEvt);
          }
        }
      }
      if (typeof renderAll === 'function') renderAll();
      pollFailCount = 0;
    } catch (e) {
      pollFailCount++;
      const mt = qs('#mTxt');
      const isNetwork = !(e && typeof e.status === 'number');
      if (mt) mt.textContent = isNetwork
        ? (pollFailCount > 1 ? 'Menyambung ulang ke GitHub…' : 'Mesin siap')
        : `GitHub: ${e.message}`;
      // A raw network failure (device switched network, brief signal loss) is retried
      // quickly instead of waiting the full 30s cycle, so the badge recovers on its own.
      if (isNetwork && pollFailCount <= 4) {
        clearTimeout(pollRetryTimer);
        pollRetryTimer = setTimeout(pollOnce, Math.min(3000 * pollFailCount, 12000));
      }
    }
  }
  let pollFailCount = 0, pollRetryTimer = null;
  async function pollMachine() {
    if (!CREDS.pat) return;
    try {
      const m = await API.machine();
      const runner = qs('#runnerT'); if (runner) runner.textContent = m.runner;
      const queue = qs('#queueT'); if (queue) queue.textContent = String(m.queue);
      const running = qs('#runningT'); if (running) running.textContent = String(m.running);
      const info = qs('#mInfo'); if (info) info.textContent = 'Angka antrean dan eksekusi dibaca langsung dari GitHub Actions.';
    } catch (_) {}
  }

  const jdkEl = qs('#jdk');
  if (jdkEl) { [...jdkEl.options].forEach(o => { if (o.value === '11') o.disabled = true; }); if (!jdkEl.value) jdkEl.value = '17'; }
  const grdEl = qs('#grd');
  if (grdEl) { if (!grdEl.value) grdEl.value = '8.7'; }
  if (qs('#tmo')) { if (!qs('#tmo').value) qs('#tmo').value = '120'; qs('#tmo').min = '1'; qs('#tmo').max = '350'; }
  if (qs('#vCode')) qs('#vCode').min = '1';

  const reconnectBtn = qs('#reconnectBtn');
  if (reconnectBtn) reconnectBtn.addEventListener('click', ensureCredsModal);

  if (!CREDS.owner || !CREDS.pat) setTimeout(ensureCredsModal, 400);

  updateConn();
  pollOnce();
  pollMachine();
  setInterval(pollOnce, 30000);
  setInterval(pollMachine, 60000);

  setInterval(() => {
    const l = qs('#log');
    if (l && l.childElementCount > 4000) { while (l.childElementCount > 3000) l.firstElementChild.remove(); }
    if (typeof logBuf !== 'undefined' && Array.isArray(logBuf) && logBuf.length > 6000) logBuf.splice(0, logBuf.length - 6000);
  }, 5000);

  if (typeof renderAll === 'function') renderAll();
})();
