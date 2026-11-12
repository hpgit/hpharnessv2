"""Run the worker tests using an existing SSH host's Python, without installing packages."""
import argparse
import io
from pathlib import Path
import subprocess
import tarfile

from remote import ssh_command


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("host")
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w:gz") as tar:
        for path in directory.rglob("*.py"):
            if "__pycache__" not in path.parts:
                tar.add(path, arcname=str(path.relative_to(directory)), recursive=False)
    script = "import io,pathlib,sys,tarfile,tempfile,subprocess; root=pathlib.Path(tempfile.mkdtemp(prefix='.hpharness-worker-tests-',dir=pathlib.Path.home())); data=sys.stdin.buffer.read(); t=tarfile.open(fileobj=io.BytesIO(data),mode='r:gz'); t.extractall(root,filter='data'); print('Remote test directory:',root,flush=True); sys.exit(subprocess.call([sys.executable,'-m','unittest','discover','-s','tests','-v'],cwd=root))"
    result = subprocess.run(ssh_command(args.host, ["python3", "-c", script]), input=archive.getvalue())
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
