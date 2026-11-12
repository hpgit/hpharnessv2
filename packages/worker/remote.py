"""Deploy a content-addressed worker and forward JSONL over existing OpenSSH config."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys


def ssh_command(host, argv):
    if not re.fullmatch(r"[A-Za-z0-9_.@-]+", host) or host.startswith("-"):
        raise ValueError("Invalid SSH alias")
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, shlex.join(argv)]


def prepare(host, root, container=None, python="python3"):
    source = Path(__file__).with_name("hph_worker.py").read_bytes()
    revision = hashlib.sha256(source).hexdigest()
    bootstrap = "import os,pathlib,sys,uuid; p=pathlib.Path.home()/'.hpharness'/'workers'/" + repr(revision) + "/'hph_worker.py'; p.parent.mkdir(parents=True,exist_ok=True); t=p.with_name(uuid.uuid4().hex+'.tmp'); t.write_bytes(sys.stdin.buffer.read()); os.replace(t,p); print(p)"
    prefix = []
    if container:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", container) or container.startswith("-"):
            raise ValueError("Invalid Docker container identifier")
        prefix = ["docker", "exec", "-i", container]
    if not host and not container:
        raise ValueError("A host or local container is required")
    transport = (lambda argv: ssh_command(host, argv)) if host else (lambda argv: argv)
    deployed = subprocess.run(transport(prefix + [python, "-c", bootstrap]), input=source, capture_output=True, timeout=30)
    if deployed.returncode:
        raise RuntimeError(deployed.stderr.decode("utf-8", errors="replace").strip())
    worker_path = deployed.stdout.decode("utf-8").strip()
    if not worker_path.startswith("/") or "\n" in worker_path:
        raise RuntimeError("SSH bootstrap returned an invalid worker path")
    root_id = hashlib.sha256(root.encode()).hexdigest()[:24]
    # Run through Python to expand ~ using the remote target's home, not Windows.
    launcher = "import os,pathlib,runpy,sys; root=str(pathlib.Path(" + repr(root) + ").expanduser()); state=str(pathlib.Path.home()/'.hpharness'/'state'/" + repr(root_id) + "); sys.argv=[" + repr(worker_path) + ",'--root',root,'--state-dir',state]; runpy.run_path(sys.argv[0],run_name='__main__')"
    return transport(prefix + [python, "-u", "-c", launcher])


def main():
    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--host")
    target.add_argument("--local-container")
    parser.add_argument("--root", required=True)
    parser.add_argument("--container")
    parser.add_argument("--python", default="python3")
    parser.add_argument("--print-command", action="store_true")
    args = parser.parse_args()
    try:
        if args.local_container and args.container:
            raise ValueError("Use either --local-container or --host with --container")
        command = prepare(args.host, args.root, args.local_container or args.container, args.python)
        if args.print_command:
            print(json.dumps(command))
            return
        raise SystemExit(subprocess.call(command))
    except (ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
