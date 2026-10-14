#!/usr/bin/env python3
"""Locally rehearse switching between two downloaded GitHub Pages artifacts.

This only unpacks static artifacts into a temporary directory and serves them
on loopback. It does not call GitHub deployment APIs or contact application
backends. The artifacts must be the extracted `artifact.tar` from Pages runs.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse


ROOT = pathlib.Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    raise RuntimeError(message)


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def unpack_artifact(archive: pathlib.Path, destination: pathlib.Path) -> dict:
    entries = {}
    total_bytes = 0
    with tarfile.open(archive, "r:*") as bundle:
        for member in bundle.getmembers():
            relative = pathlib.PurePosixPath(member.name)
            if relative.is_absolute() or ".." in relative.parts or not (member.isfile() or member.isdir()):
                fail("Pages artifact contains an unsafe path or non-regular entry")
            target = destination.joinpath(*[part for part in relative.parts if part not in ("", ".")])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not relative.parts:
                fail("Pages artifact contains an invalid file path")
            target.parent.mkdir(parents=True, exist_ok=True)
            extracted = bundle.extractfile(member)
            if extracted is None:
                fail("Pages artifact could not be read")
            with extracted, target.open("wb") as output:
                shutil.copyfileobj(extracted, output)
            entries[relative.as_posix().removeprefix("./")] = member.size
            total_bytes += member.size
    for required in ("index.html", "admin/index.html"):
        if required not in entries:
            fail(f"Pages artifact is missing {required}")
    js_files = [p for p in destination.rglob("*.js") if p.is_file()]
    if not js_files:
        fail("Pages artifact contains no JavaScript chunks")
    contains_rpc_client = False
    for path in js_files:
        if b"/rest/v1/rpc/ular_api" in path.read_bytes():
            contains_rpc_client = True
            break
    if not contains_rpc_client:
        fail("Pages artifact does not contain the expected Supabase RPC client")
    return {"files": len(entries), "bytes": total_bytes, "index_sha256": sha256_file(destination / "index.html"), "admin_sha256": sha256_file(destination / "admin/index.html")}


def reserve_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def fetch(port: int, path: str) -> tuple[int, bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        conn.request("GET", path)
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


def wait_server(proc: subprocess.Popen, port: int, path: str) -> None:
    for _ in range(50):
        if proc.poll() is not None:
            fail("local static preview exited before it was ready")
        try:
            status, _ = fetch(port, path)
            if status == 200:
                return
        except OSError:
            pass
        time.sleep(0.1)
    fail("local static preview did not become ready")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--current", required=True, type=pathlib.Path, help="tar artifact for the current successful Pages deployment")
    parser.add_argument("--previous", required=True, type=pathlib.Path, help="tar artifact for the immediately previous successful Pages deployment")
    parser.add_argument("--base-path", default="/ular-tangga", help="GitHub Pages repository path, such as /ular-tangga")
    args = parser.parse_args()
    if not re.fullmatch(r"/[A-Za-z0-9._-]+", args.base_path):
        fail("base path must be one canonical GitHub Pages project segment")
    segment = args.base_path[1:]
    if segment in (".", ".."):
        fail("base path must be one canonical GitHub Pages project segment")
    base = "/" + segment
    current = args.current.resolve()
    previous = args.previous.resolve()
    for artifact in (current, previous):
        if not artifact.is_file():
            fail("Pages artifact tar file is missing")

    with tempfile.TemporaryDirectory(prefix="ular-pages-rollback-") as temporary:
        stage = pathlib.Path(temporary)
        current_dir = stage / "current" / segment
        previous_dir = stage / "previous" / segment
        current_dir.mkdir(parents=True)
        previous_dir.mkdir(parents=True)
        current_info = unpack_artifact(current, current_dir)
        previous_info = unpack_artifact(previous, previous_dir)
        active_link = stage / "active"
        link_tmp = stage / "active-next"
        port = reserve_port()
        env = os.environ.copy()
        env["PORT"] = str(port)
        active_link.symlink_to(stage / "current", target_is_directory=True)
        log = tempfile.TemporaryFile()
        proc = subprocess.Popen(["node", str(ROOT / "scripts/static-preview.mjs"), str(active_link)], cwd=ROOT, env=env, stdout=log, stderr=log)

        def activate(name: str, expected: dict) -> dict:
            if link_tmp.exists() or link_tmp.is_symlink():
                link_tmp.unlink()
            link_tmp.symlink_to(stage / name, target_is_directory=True)
            os.replace(link_tmp, active_link)
            results = {}
            for route, fingerprint_key in ((base + "/", "index_sha256"), (base + "/admin/", "admin_sha256")):
                status, body = fetch(port, route)
                digest = hashlib.sha256(body).hexdigest()
                if status != 200 or digest != expected[fingerprint_key]:
                    fail("local artifact switch did not serve the selected page")
                results[route] = {"status": status, "sha256": digest}
            return results

        try:
            wait_server(proc, port, base + "/")
            observed = {
                "current_initial": activate("current", current_info),
                "previous_rollback": activate("previous", previous_info),
                "current_recovery": activate("current", current_info),
            }
            print(json.dumps({
                "result": "passed",
                "scope": "local loopback static preview; no public deployment or backend writes",
                "base_path": base,
                "current_artifact_sha256": sha256_file(current),
                "previous_artifact_sha256": sha256_file(previous),
                "current": current_info,
                "previous": previous_info,
                "switches": observed,
                "both_artifacts_use_supabase_rpc": True,
            }, sort_keys=True))
        finally:
            try:
                if proc.poll() is None:
                    proc.terminate()
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
            finally:
                log.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Pages artifact rollback rehearsal failed: {error}", file=sys.stderr)
        sys.exit(1)
