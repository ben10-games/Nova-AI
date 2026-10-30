#!/usr/bin/env python3
"""Builds the downloads for a GitHub release, one per system, from the committed project (git HEAD):
  dist/Syntaz-for-Mac.zip      Syntaz Setup.app (no Windows files)
  dist/Syntaz-for-Windows.zip  Syntaz Setup (Windows).bat (no Mac app)
  dist/Syntaz-for-Linux.zip    for `node setup/nova-app.mjs`
  dist/Syntaz-Lite.html        Syntaz Lite: chat in one file, nothing to install
  dist/Nova-for-*.zip          the same ZIPs under the old names: Syntaz used to be "Nova AI", and older
                               installs look for these names when they check for updates
Each unzips to a "Syntaz AI" folder. The names never change, so the Syntaz window's Update button and the
README link (releases/latest/download/...) always find the newest one.
Run from the project folder: python3 scripts/make-release.py [--out DIR]"""
import io
import json
import shutil
import os
import stat
import subprocess
import sys
import tarfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOP = "Syntaz AI"
EVERYWHERE = ("test/",)  # not needed to run Syntaz
ONLY_WINDOWS = ("Syntaz Setup (Windows).bat", "setup/windows/")
ONLY_MAC = ("Syntaz Setup.app/",)
TARGETS = {
    "Syntaz-for-Mac.zip": EVERYWHERE + ONLY_WINDOWS,
    "Syntaz-for-Windows.zip": EVERYWHERE + ONLY_MAC,
    "Syntaz-for-Linux.zip": EVERYWHERE + ONLY_WINDOWS + ONLY_MAC,
}


def excluded(name, prefixes):
    return any(name == p or name.startswith(p) for p in prefixes)


def main():
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else os.path.join(ROOT, "dist")
    os.makedirs(out, exist_ok=True)
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if dirty:
        print("Note: only committed changes are included (uncommitted changes exist).")
    # git archive applies .gitattributes (CRLF for Windows files) and keeps executable bits.
    tar_bytes = subprocess.run(["git", "archive", "--format=tar", "HEAD"], cwd=ROOT, capture_output=True, check=True).stdout
    members = []
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tar:
        for m in tar.getmembers():
            if m.isfile():
                members.append((m.name, m.mode, tar.extractfile(m).read()))
    version = json.loads(next(d for n, _, d in members if n == "package.json"))["version"]
    for zip_name, skip in TARGETS.items():
        path = os.path.join(out, zip_name)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for name, mode, data in members:
                if excluded(name, skip):
                    continue
                info = zipfile.ZipInfo(f"{TOP}/{name}", date_time=(2026, 1, 1, 0, 0, 0))
                info.create_system = 3  # Unix: keeps the executable bit (Mac app launcher)
                info.external_attr = (stat.S_IFREG | (mode & 0o777)) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, data)
        print(f"{zip_name}: {os.path.getsize(path) // 1024} KB")
    # Older installs (from before the rename to Syntaz) look for the old names: same files, old names.
    for zip_name in TARGETS:
        shutil.copyfile(os.path.join(out, zip_name), os.path.join(out, zip_name.replace("Syntaz-", "Nova-")))
    # Syntaz Lite on its own: one file, nothing to install.
    lite = next(d for n, _, d in members if n == "lite/Syntaz Lite.html")
    with open(os.path.join(out, "Syntaz-Lite.html"), "wb") as f:
        f.write(lite)
    print(f"Syntaz-Lite.html: {len(lite) // 1024} KB")
    print(f"Version {version}. Upload these as a GitHub release tagged v{version}.")


if __name__ == "__main__":
    main()
