#!/usr/bin/env python3
"""Apply NexaBuilder metadata to a platform generated during the build."""
import json
import sys
from pathlib import Path

from prepare import android_root, apply_icon, find_module, patch_gradle, patch_manifest, safe_base_path


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit('usage: patch_native.py META_PATH WORK_DIR')
    meta_path = Path(sys.argv[1]).resolve()
    work = Path(sys.argv[2]).resolve()
    job = json.loads(meta_path.read_text(encoding='utf-8'))
    fw = (work / 'framework.txt').read_text(encoding='utf-8').strip()
    rel = (work / 'project-path.txt').read_text(encoding='utf-8').strip()
    project = (work / rel).resolve()
    if work not in project.parents or not project.is_dir():
        raise SystemExit('project-path.txt keluar dari work directory')
    root = android_root(project, fw)
    module = find_module(root)
    if module is None:
        raise SystemExit(f'modul Android tidak ditemukan setelah platform generation: {root}')
    patch_gradle(module, job['meta'], root, project)
    patch_manifest(module, job['meta'])
    apply_icon(module, job, meta_path.parent)
    gs = (job.get('gservices') or {}).get('path')
    if gs:
        source = safe_base_path(meta_path.parent, gs, 'google-services.json')
        if source.is_file():
            (module / 'google-services.json').write_bytes(source.read_bytes())
    print(f'[prepare] konfigurasi Android diterapkan ke {module}', flush=True)


if __name__ == '__main__':
    main()
