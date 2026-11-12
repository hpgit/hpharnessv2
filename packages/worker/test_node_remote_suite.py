"""Opt-in Linux Node workspace build/tests through SSH in an isolated directory."""
import argparse
import io
from pathlib import Path
import subprocess
import tarfile

from remote import ssh_command


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("host")
    parser.add_argument("--node-bin", default="~/.nvm/versions/node/v24.16.0/bin")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w:gz") as tar:
        for name in ("package.json", "package-lock.json"):
            tar.add(root / name, arcname=name, recursive=False)
        for package in ("providers", "extensions", "harness", "worker"):
            for path in (root / "packages" / package).rglob("*"):
                if path.is_file() and not set(path.parts).intersection({"node_modules", "__pycache__", "dist", ".venv"}):
                    tar.add(path, arcname=str(path.relative_to(root)), recursive=False)
        for path in (root / "browser-extension").iterdir():
            if path.is_file():
                tar.add(path, arcname=str(path.relative_to(root)), recursive=False)
    script = "import io,pathlib,sys,tarfile,tempfile,subprocess,os; root=pathlib.Path(tempfile.mkdtemp(prefix='.hpharness-node-tests-',dir=pathlib.Path.home())); t=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz'); t.extractall(root,filter='data'); print('Remote Node test directory:',root,flush=True); env=dict(os.environ); env['PATH']=str(pathlib.Path(" + repr(args.node_bin) + ").expanduser())+':'+env.get('PATH',''); env['npm_config_cache']=str(root/'.npm-cache'); commands=[['npm','ci','--ignore-scripts','--no-audit','--no-fund'],['npm','run','build'],['npm','test']]; result=0\nfor command in commands:\n result=subprocess.call(command,cwd=root,env=env)\n if result: break\nsys.exit(result)"
    raise SystemExit(subprocess.run(ssh_command(args.host, ["python3", "-c", script]), input=archive.getvalue()).returncode)


if __name__ == "__main__":
    main()
