"""Trusted execution worker. Cwd/file confinement is not an OS command sandbox.

Supervisors must approve commands before dispatch. Nothing executes on import.
The single file can be deployed to a Python-equipped Linux host or container.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager, ExitStack
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid


class WorkerError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def safe_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise WorkerError("INVALID_ARGUMENT", "Invalid identifier")
    return value


def command_args(value):
    if not isinstance(value, list) or not value or any(not isinstance(v, str) or "\0" in v for v in value):
        raise WorkerError("INVALID_ARGUMENT", "argv must be a non-empty array of strings")
    return value


def bounded_timeout(value, default=60):
    result = float(default if value is None else value)
    if result <= 0 or result > 604800:
        raise WorkerError("INVALID_ARGUMENT", "timeout must be between 0 and 604800 seconds")
    return result


def process_stamp(pid):
    """Identify a process instance without treating a reused PID as the same owner."""
    if not isinstance(pid, int) or pid < 1:
        return None
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME)]
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        try:
            created, exited, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
            code = wintypes.DWORD()
            if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != 259:
                return None
            if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel_time), ctypes.byref(user_time)):
                return None
            return str((created.dwHighDateTime << 32) | created.dwLowDateTime)
        finally:
            kernel.CloseHandle(handle)
    try:
        stat = Path(f"/proc/{pid}/stat").read_text().split(")", 1)[1].split()
        if stat[0] == "Z":
            return None
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        return boot + ":" + stat[19]
    except (FileNotFoundError, PermissionError):
        return None


def terminate_child(child):
    if child.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"], capture_output=True, check=False)
    else:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    child.wait(timeout=10)


@contextmanager
def resource_lock(lock, code="FILE_BUSY"):
    lock.parent.mkdir(parents=True, exist_ok=True)
    if lock.is_dir():
        raise WorkerError(code, "Legacy directory lock requires inspection before removal")
    # Keep the inode; OS ownership is automatically released if the worker dies.
    with lock.open("a+b") as stream:
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise WorkerError(code, "Another worker operation holds this resource") from None
        try:
            yield
        finally:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def run_job(directory):
    """Detached owner keeps an actual Popen handle; cancellation never kills a stale recorded PID."""
    directory = Path(directory)
    metadata = read_json(directory / "job.json")
    started = time.monotonic()
    child = None
    resources = ExitStack()
    result = dict(metadata, status="failed", finished_at=None, exit_code=None)
    try:
        if metadata.get("device_serial"):
            resources.enter_context(resource_lock(directory.parent.parent / "devices" / digest(metadata["device_serial"].encode()), "DEVICE_BUSY"))
        if (directory / "cancel").exists():
            result["status"] = "cancelled"
            return
        with (directory / "stdout.log").open("wb") as stdout, (directory / "stderr.log").open("wb") as stderr:
            child = subprocess.Popen(metadata["argv"], cwd=metadata["cwd"], env=dict(os.environ, **metadata.get("env", {})), stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=os.name != "nt", creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
            atomic_json(directory / "running.json", dict(metadata, status="running", pid=child.pid, owner_pid=os.getpid()))
            while child.poll() is None:
                if (directory / "cancel").exists():
                    terminate_child(child)
                    result["status"] = "cancelled"
                    break
                if metadata.get("timeout") and time.monotonic() - started > metadata["timeout"]:
                    terminate_child(child)
                    result["status"] = "timed_out"
                    break
                time.sleep(0.05)
            result["exit_code"] = child.wait()
            if result["status"] not in ("cancelled", "timed_out"):
                result["status"] = "completed" if child.returncode == 0 else "failed"
    except Exception as exc:
        result["error"] = str(exc)
        result["error_code"] = getattr(exc, "code", "EXECUTION_ERROR")
        if child is not None:
            terminate_child(child)
    finally:
        result["finished_at"] = timestamp()
        if metadata.get("sdk_audit"):
            audit = dict(metadata["sdk_audit"])
            try:
                baseline = Path(audit["baseline"]["path"])
                audit["original_unchanged"] = baseline.exists() and digest(baseline.read_bytes()) == audit["baseline"]["sha256"]
                if not audit["original_unchanged"]:
                    result["status"] = "failed"
                    audit["integrity_error"] = "Registered command modified the original ONNX; inspect before any further action"
                output = Path(audit["output"])
                if result["status"] == "completed" and output.exists():
                    audit["output_sha256"] = digest(output.read_bytes())
            except Exception as exc:
                audit["integrity_error"] = "Integrity verification failed: " + str(exc)
                result["status"] = "failed"
            audit.update(run={k: v for k, v in result.items() if k != "sdk_audit"}, audit_status="complete")
            atomic_json(directory.parent.parent / "sdk-runs" / (metadata["job_id"] + ".json"), audit)
        atomic_json(directory / "result.json", result)
        resources.close()


class Worker:
    def __init__(self, root, state_dir, mail_root=None):
        self.root = Path(root).expanduser().resolve(strict=True)
        if not self.root.is_dir():
            raise WorkerError("INVALID_ARGUMENT", "Workspace root must be a directory")
        self.state = Path(state_dir).expanduser().resolve()
        self.state.mkdir(parents=True, exist_ok=True)
        # This path comes from trusted supervisor CLI configuration, never RPC params.
        self.mail_root = Path(mail_root).expanduser().resolve() if mail_root else None
        if self.mail_root is not None:
            self.mail_root.mkdir(parents=True, exist_ok=True)

    def path(self, value=".", must_exist=False):
        if not isinstance(value, str) or "\0" in value:
            raise WorkerError("INVALID_ARGUMENT", "path must be a string")
        candidate = Path(value).expanduser()
        candidate = (candidate if candidate.is_absolute() else self.root / candidate).resolve()
        if not candidate.is_relative_to(self.root):
            raise WorkerError("OUTSIDE_WORKSPACE", "Path escapes the execution workspace")
        if must_exist and not candidate.exists():
            raise WorkerError("NOT_FOUND", "Workspace path does not exist")
        return candidate

    def job_path(self, identifier):
        return self.state / "jobs" / safe_id(identifier)

    def dispatch(self, method, params=None):
        params = params or {}
        if not isinstance(params, dict):
            raise WorkerError("INVALID_ARGUMENT", "params must be an object")
        method = {"office.outlook_fetch": "outlook.fetch", "office.word_replace": "office.edit", "office.excel_write": "office.edit"}.get(method, method)
        handler = getattr(self, "rpc_" + method.replace(".", "_"), None)
        if not method or not callable(handler):
            raise WorkerError("METHOD_NOT_FOUND", f"Unknown method: {method}")
        return handler(params)

    def rpc_ping(self, p):
        return {"protocol": 1, "platform": sys.platform, "python": sys.version.split()[0], "root": str(self.root), "state_dir": str(self.state), "pid": os.getpid()}

    def rpc_capabilities(self, p):
        return {"files": True, "jobs": True, "docker": shutil.which("docker") is not None, "adb": shutil.which("adb") is not None, "office": "requires-windows-pywin32-and-installed-office" if os.name == "nt" else "unavailable", "gpu_pool": "dummy", "sdk": "requires-registered-corporate-command"}

    def rpc_files_list(self, p):
        path = self.path(p.get("path", "."), True)
        if not path.is_dir():
            raise WorkerError("NOT_DIRECTORY", "Requested path is not a directory")
        entries = []
        for entry in sorted(path.iterdir(), key=lambda v: (not v.is_dir(), v.name.lower())):
            if len(entries) >= 5000:
                break
            entries.append({"name": entry.name, "path": str(entry.relative_to(self.root)), "directory": entry.is_dir(), "symlink": entry.is_symlink(), "size": entry.stat().st_size if entry.is_file() else None})
        return {"path": str(path), "entries": entries}

    def rpc_files_read(self, p):
        path = self.path(p["path"], True)
        limit = min(int(p.get("limit", 4 * 1024 * 1024)), 16 * 1024 * 1024)
        if path.stat().st_size > limit:
            raise WorkerError("FILE_TOO_LARGE", "Use artifact transfer for large files")
        data = path.read_bytes()
        try:
            content = data.decode("utf-8")
            if "\0" in content:
                raise UnicodeDecodeError("utf-8", data, 0, len(data), "NUL byte")
        except UnicodeDecodeError:
            return {"path": str(path), "hash": digest(data), "encoding": "base64", "content": base64.b64encode(data).decode("ascii")}
        return {"path": str(path), "hash": digest(data), "encoding": "utf-8", "content": content}

    def rpc_files_write(self, p):
        path = self.path(p["path"])
        lock = self.state / "file-locks" / digest(str(path).encode())
        with resource_lock(lock):
            return self._write_file(p)

    def _write_file(self, p):
        path = self.path(p["path"])
        expected = p.get("expected_hash")
        existing = path.read_bytes() if path.exists() else None
        actual = digest(existing) if existing is not None else None
        if "expected_hash" not in p:
            raise WorkerError("EXPECTED_HASH_REQUIRED", "Supply the previously read hash, or null for a new file")
        if expected != actual:
            raise WorkerError("CONFLICT", "File changed since it was read")
        content = p["content"]
        if not isinstance(content, str):
            raise WorkerError("INVALID_ARGUMENT", "content must be text")
        data = content.encode("utf-8")
        path.parent.mkdir(parents=True, exist_ok=True)
        # Re-resolve after mkdir to reject directory symlinks installed before writing.
        path = self.path(str(path))
        temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if path.exists():
                os.chmod(temporary, stat.S_IMODE(path.stat().st_mode))
            current = path.read_bytes() if path.exists() else None
            if (digest(current) if current is not None else None) != expected:
                raise WorkerError("CONFLICT", "File changed while preparing the write")
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        return {"path": str(path), "hash": digest(data), "bytes": len(data)}

    def rpc_command_run(self, p):
        argv = command_args(p.get("argv"))
        cwd = self.path(p.get("cwd", "."), True)
        # Managed jobs provide bounded captured output and terminate process trees on timeout.
        job = self.rpc_jobs_start(dict(p, argv=argv, cwd=str(cwd), timeout=bounded_timeout(p.get("timeout"))))
        while True:
            result = self.rpc_jobs_status({"job_id": job["job_id"]})
            if result["status"] in ("completed", "failed", "cancelled", "timed_out", "unknown"):
                return result
            time.sleep(0.05)

    def rpc_jobs_start(self, p):
        argv = command_args(p.get("argv"))
        cwd = self.path(p.get("cwd", "."), True)
        if not cwd.is_dir():
            raise WorkerError("NOT_DIRECTORY", "cwd is not a directory")
        env = p.get("env", {})
        if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) or "\0" in k + v or "=" in k for k, v in env.items()):
            raise WorkerError("INVALID_ARGUMENT", "env must contain string names and values")
        identifier = uuid.uuid4().hex
        directory = self.job_path(identifier)
        directory.mkdir(parents=True)
        metadata = {"job_id": identifier, "argv": argv, "cwd": str(cwd), "env": env, "created_at": timestamp(), "status": "starting", "timeout": bounded_timeout(p["timeout"]) if p.get("timeout") is not None else None}
        if p.get("_device_serial"):
            metadata["device_serial"] = p["_device_serial"]
        if p.get("_sdk_audit"):
            metadata["sdk_audit"] = p["_sdk_audit"]
            atomic_json(self.state / "sdk-runs" / (identifier + ".json"), dict(p["_sdk_audit"], audit_status="pending", job_id=identifier))
        atomic_json(directory / "job.json", metadata)
        with (directory / "owner.log").open("wb") as log:
            owner = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--job-runner", str(directory)], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=os.name != "nt", creationflags=(subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == "nt" else 0, close_fds=True)
        atomic_json(directory / "owner.json", {"pid": owner.pid, "stamp": process_stamp(owner.pid)})
        threading.Thread(target=owner.wait, daemon=True).start()
        return {"job_id": identifier, "status": "starting"}

    def rpc_jobs_status(self, p):
        directory = self.job_path(p["job_id"])
        if not directory.exists():
            raise WorkerError("NOT_FOUND", "Unknown job")
        state_file = next((directory / name for name in ("result.json", "running.json", "job.json") if (directory / name).exists()))
        result = read_json(state_file)
        owner_path = directory / "owner.json"
        if state_file.name != "result.json" and owner_path.exists():
            owner = read_json(owner_path)
            if owner.get("stamp") is not None and process_stamp(owner["pid"]) != owner["stamp"]:
                # Re-read after checking liveness to avoid racing a just-completed owner.
                if (directory / "result.json").exists():
                    result = read_json(directory / "result.json")
                else:
                    result["status"] = "unknown"
                    result["recovery"] = "Job owner exited without a durable result; inspect external state before retrying"
        result.pop("env", None)
        limit = min(max(int(p.get("log_bytes", 65536)), 0), 1024 * 1024)
        for name in ("stdout", "stderr"):
            log = directory / (name + ".log")
            if log.exists():
                with log.open("rb") as stream:
                    size = log.stat().st_size
                    stream.seek(max(0, size - limit))
                    result[name] = stream.read(limit).decode("utf-8", errors="replace")
                    result[name + "_truncated"] = size > limit
            else:
                result[name] = ""
        return result

    def rpc_jobs_list(self, p):
        jobs = self.state / "jobs"
        return [self.rpc_jobs_status({"job_id": entry.name, "log_bytes": 0}) for entry in sorted(jobs.iterdir()) if entry.is_dir()] if jobs.exists() else []

    def rpc_jobs_cancel(self, p):
        directory = self.job_path(p["job_id"])
        if not directory.exists():
            raise WorkerError("NOT_FOUND", "Unknown job")
        if not (directory / "result.json").exists():
            (directory / "cancel").touch()
        return self.rpc_jobs_status(p) | {"cancel_requested": True}

    def tool(self, name, argv, p=None):
        if shutil.which(name) is None:
            raise WorkerError("UNAVAILABLE", name + " is not installed on this execution target")
        return self.rpc_command_run({"argv": [name, *argv], "cwd": (p or {}).get("cwd", "."), "timeout": (p or {}).get("timeout", 60)})

    def rpc_docker_list(self, p):
        return self.tool("docker", ["ps", "-a", "--format", "{{json .}}"], p)

    def rpc_docker_create(self, p):
        image = p.get("image")
        if not isinstance(image, str) or not image or image.startswith("-"):
            raise WorkerError("INVALID_ARGUMENT", "An explicit image is required")
        name = "hph-" + safe_id(p.get("name", uuid.uuid4().hex[:12]))
        argv = ["create", "--name", name, "--label", "hpharness.managed=true"]
        for mount in p.get("mounts", []):
            source = self.path(mount["source"], True)
            target = mount["target"]
            if not isinstance(target, str) or not target.startswith("/") or "," in target or "," in str(source):
                raise WorkerError("INVALID_ARGUMENT", "Mount target must be an absolute container path without commas")
            argv += ["--mount", f"type=bind,source={source},target={target}" + (",readonly" if mount.get("readonly") else "")]
        for key, flag in (("user", "--user"), ("cwd", "--workdir"), ("gpus", "--gpus"), ("shm_size", "--shm-size")):
            if key in p:
                argv += [flag, str(p[key])]
        for key, value in p.get("env", {}).items():
            argv += ["--env", f"{key}={value}"]
        for port in p.get("ports", []):
            argv += ["--publish", str(port)]
        argv += [image, *command_args(p.get("command", ["sleep", "infinity"]))]
        # cwd is container workdir for this RPC, not the host command directory.
        return self.tool("docker", argv, {"timeout": p.get("timeout", 120)})

    def rpc_docker_start(self, p):
        return self.tool("docker", ["start", safe_id(p["container"])], p)

    def rpc_docker_exec(self, p):
        return self.tool("docker", ["exec", "--workdir", p.get("container_cwd", "/"), safe_id(p["container"]), *command_args(p["argv"])], p)

    def rpc_adb_devices(self, p):
        return self.tool("adb", ["devices", "-l"], p)

    def rpc_adb_run(self, p):
        serial = p.get("serial")
        if not isinstance(serial, str) or not serial or serial.startswith("-"):
            raise WorkerError("INVALID_ARGUMENT", "An explicit device serial is required")
        result = self.rpc_command_run({"argv": ["adb", "-s", serial, *command_args(p["argv"])], "cwd": p.get("cwd", "."), "timeout": p.get("timeout", 60), "_device_serial": serial})
        if result.get("error_code") == "DEVICE_BUSY":
            raise WorkerError("DEVICE_BUSY", result["error"])
        return result

    def rpc_gpu_submit(self, p):
        identifier = "dummy-" + uuid.uuid4().hex
        result = {"job_id": identifier, "backend": "dummy", "simulated": True, "status": "queued", "created_at": timestamp(), "workload": p.get("workload", {}), "artifacts": []}
        atomic_json(self.state / "gpu" / (identifier + ".json"), result)
        return result

    def rpc_gpu_status(self, p):
        path = self.state / "gpu" / (safe_id(p["job_id"]) + ".json")
        if not path.exists():
            raise WorkerError("NOT_FOUND", "Unknown dummy GPU workload")
        return read_json(path)

    def rpc_gpu_list(self, p):
        directory = self.state / "gpu"
        return [read_json(path) for path in sorted(directory.glob("*.json"))] if directory.exists() else []

    def rpc_gpu_advance(self, p):
        result = self.rpc_gpu_status(p)
        status = p.get("status")
        if status not in ("running", "completed", "failed", "cancelled"):
            raise WorkerError("INVALID_ARGUMENT", "Invalid simulated workload state")
        result["status"] = status
        atomic_json(self.state / "gpu" / (result["job_id"] + ".json"), result)
        return result

    def rpc_gpu_cancel(self, p):
        return self.rpc_gpu_advance(dict(p, status="cancelled"))

    def rpc_gpu_upload(self, p):
        job = self.rpc_gpu_status(p)
        source = self.path(p["path"], True)
        name = safe_id(p.get("artifact_id", uuid.uuid4().hex))
        destination = self.state / "gpu-artifacts" / job["job_id"] / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        artifact = {"id": name, "name": source.name, "size": source.stat().st_size, "sha256": digest(source.read_bytes())}
        job["artifacts"].append(artifact)
        atomic_json(self.state / "gpu" / (job["job_id"] + ".json"), job)
        return {"simulated": True, "backend": "dummy", "artifact": artifact}

    def rpc_gpu_download(self, p):
        job = self.rpc_gpu_status(p)
        identifier = safe_id(p["artifact_id"])
        source = self.state / "gpu-artifacts" / job["job_id"] / identifier
        destination = self.path(p["output"])
        if destination.exists():
            raise WorkerError("CONFLICT", "Download destination already exists")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        return {"simulated": True, "backend": "dummy", "path": str(destination), "sha256": digest(destination.read_bytes())}

    def rpc_sdk_register(self, p):
        identifier = safe_id(p["name"])
        manifest = dict(p)
        command_args(manifest.get("argv"))
        if p.get("approved") is not True:
            raise WorkerError("APPROVAL_REQUIRED", "Supervisor approval is required before registering executable commands")
        if manifest.get("sdk") not in ("qairt", "enntools", "neuropilot", "custom"):
            raise WorkerError("INVALID_ARGUMENT", "Unknown SDK")
        manifest["status"] = "registered_unverified"
        manifest["registered_at"] = timestamp()
        atomic_json(self.state / "sdk" / (identifier + ".json"), manifest)
        return manifest

    def rpc_sdk_list(self, p):
        directory = self.state / "sdk"
        return [read_json(v) for v in directory.glob("*.json")] if directory.exists() else []

    def rpc_sdk_run(self, p):
        name = safe_id(p["name"])
        manifest = read_json(self.state / "sdk" / (name + ".json"))
        if p.get("approved") is not True:
            raise WorkerError("APPROVAL_REQUIRED", "Supervisor approval is required before executing a registered SDK command")
        original = self.path(p["original_onnx"], True)
        input_path = self.path(p.get("input", p["original_onnx"]), True)
        output = self.path(p["output"])
        if output in (original, input_path):
            raise WorkerError("INVALID_ARGUMENT", "Output must not overwrite original or derived model")
        original_hash = digest(original.read_bytes())
        input_hash = digest(input_path.read_bytes())
        replacements = {"{original_onnx}": str(original), "{input}": str(input_path), "{output}": str(output)}
        argv = [replacements.get(arg, arg) for arg in manifest["argv"]]
        audit = {"sdk": manifest["sdk"], "baseline": {"path": str(original), "sha256": original_hash}, "input": {"path": str(input_path), "sha256": input_hash}, "output": str(output), "metrics": {}, "validation": "command_only; numerical evaluation requires registered evaluator"}
        run = self.rpc_command_run({"argv": argv, "cwd": manifest.get("cwd", "."), "timeout": p.get("timeout", 600), "_sdk_audit": audit})
        unchanged = original.exists() and digest(original.read_bytes()) == original_hash
        result = {"run": run, "sdk": manifest["sdk"], "baseline": {"path": str(original), "sha256": original_hash}, "input": {"path": str(input_path), "sha256": input_hash}, "original_unchanged": unchanged, "output": str(output), "metrics": {}, "validation": "command_only; numerical evaluation requires registered evaluator"}
        if not unchanged:
            result["run"]["status"] = "failed"
            result["integrity_error"] = "Registered command modified the original ONNX; inspect before any further action"
        if run["status"] == "completed" and output.exists():
            result["output_sha256"] = digest(output.read_bytes())
        atomic_json(self.state / "sdk-runs" / (run["job_id"] + ".json"), result)
        return result

    def com(self):
        if os.name != "nt":
            raise WorkerError("UNAVAILABLE", "Office COM is available only on Windows")
        try:
            import pythoncom
            import win32com.client
        except ImportError:
            raise WorkerError("UNAVAILABLE", "Install worker[office] with uv and configure classic Outlook / Office") from None
        pythoncom.CoInitialize()
        return win32com.client

    def rpc_outlook_fetch(self, p):
        client = self.com()
        namespace = client.Dispatch("Outlook.Application").GetNamespace("MAPI")
        since = dt.datetime.now() - dt.timedelta(days=int(p.get("days", 90)))
        limit = min(max(int(p.get("limit", 200)), 1), 5000)
        archive = self.mail_root / "mail-archive" if self.mail_root else (self.path(p["archive"]) if p.get("archive") else self.state / "mail-archive")
        archive.mkdir(parents=True, exist_ok=True)
        archive = archive.resolve()
        if self.mail_root and not archive.is_relative_to(self.mail_root):
            raise WorkerError("OUTSIDE_WORKSPACE", "Archive directory escapes configured mail root")
        quota = min(max(int(p.get("quota_bytes", 50 * 1024**3)), 0), 50 * 1024**3)
        quota_root = self.mail_root or archive
        used = sum(entry.stat().st_size for entry in quota_root.rglob("*") if entry.is_file())
        quota_reached = False
        messages = []
        cursor = p.get("cursor")
        snapshots = self.state / "outlook-snapshots"
        snapshots.mkdir(parents=True, exist_ok=True)
        if cursor:
            if not isinstance(cursor, dict):
                raise WorkerError("INVALID_ARGUMENT", "Invalid mail cursor")
            identifier = safe_id(cursor.get("snapshot", ""))
            snapshot = read_json(snapshots / (identifier + ".json"))
            offset = int(cursor.get("offset", 0))
            if time.time() >= snapshot["expires_at"]:
                raise WorkerError("CURSOR_EXPIRED", "Mail snapshot expired; start a new fetch")
            if offset < 0 or offset > len(snapshot["items"]):
                raise WorkerError("INVALID_ARGUMENT", "Invalid mail cursor offset")
        else:
            identifier = uuid.uuid4().hex
            snapshot = {"expires_at": time.time() + 86400, "items": [], "truncated": False}
            offset = 0
            # Freeze IDs before paging so live inserts cannot duplicate or skip older mail.
            for folder_id, label in ((6, "inbox"), (5, "sent")):
                folder = namespace.GetDefaultFolder(folder_id)
                items = folder.Items
                items.Sort("[ReceivedTime]", True)
                for item in items:
                    if getattr(item, "Class", None) != 43:
                        continue
                    if item.ReceivedTime.replace(tzinfo=None) < since:
                        break
                    if len(snapshot["items"]) >= 100000:
                        snapshot["truncated"] = True
                        break
                    snapshot["items"].append({"entry_id": str(item.EntryID), "store_id": str(folder.StoreID), "folder": label})
                if snapshot["truncated"]:
                    break
            atomic_json(snapshots / (identifier + ".json"), snapshot)
            # Expired snapshots contain IDs only and can be safely reclaimed.
            for expired in snapshots.glob("*.json"):
                if expired.stat().st_mtime < time.time() - 86400:
                    expired.unlink(missing_ok=True)
        snapshot_id = identifier
        next_offset = offset
        skipped = 0
        for item_index in range(offset, len(snapshot["items"])):
                if len(messages) >= limit:
                    break
                entry = snapshot["items"][item_index]
                try:
                    item = namespace.GetItemFromID(entry["entry_id"], entry["store_id"])
                except Exception:
                    # Deleted/moved items are absent from this frozen snapshot.
                    skipped += 1
                    next_offset = item_index + 1
                    continue
                label = entry["folder"]
                received = item.ReceivedTime
                identifier = digest(str(item.EntryID).encode())
                attachments = [{"name": item.Attachments.Item(i).FileName, "size": item.Attachments.Item(i).Size, "downloaded": False} for i in range(1, item.Attachments.Count + 1)]
                record = {"id": identifier, "entry_id": item.EntryID, "conversation_id": item.ConversationID, "folder": label, "subject": item.Subject, "body": item.Body, "html_body": item.HTMLBody, "sender": item.SenderEmailAddress, "to": item.To, "cc": item.CC, "received_at": received.isoformat(), "attachments": attachments}
                data = json.dumps(record, ensure_ascii=False).encode("utf-8")
                version = digest(data)
                destination = archive / identifier / (version + (".msg" if p.get("archive_msg") else ".json"))
                if not destination.resolve().is_relative_to(archive):
                    raise WorkerError("OUTSIDE_WORKSPACE", "Archive message directory escapes archive root")
                if not destination.exists():
                    if used + (int(item.Size) if p.get("archive_msg") else len(data)) > quota:
                        quota_reached = True
                        break
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if p.get("archive_msg"):
                        pending = destination.with_name(version + "." + uuid.uuid4().hex + ".pending.msg")
                        try:
                            item.SaveAs(str(pending), 3)
                            if used + pending.stat().st_size > quota:
                                quota_reached = True
                                break
                            os.replace(pending, destination)
                        finally:
                            pending.unlink(missing_ok=True)
                    else:
                        atomic_json(destination, record)
                    used += destination.stat().st_size
                messages.append(record | {"original": str(destination), "version": version, "original_format": "msg_including_attachments" if p.get("archive_msg") else "outlook_properties_v1"})
                next_offset = item_index + 1
        next_cursor = {"snapshot": snapshot_id, "offset": next_offset} if next_offset < len(snapshot["items"]) else None
        return {"messages": messages, "next_cursor": next_cursor, "partial": next_cursor is not None or quota_reached or snapshot["truncated"] or skipped > 0, "snapshot_truncated": snapshot["truncated"], "skipped_unavailable": skipped, "quota_reached": quota_reached, "archive_bytes": used, "quota_scope": "shared_knowledge_root" if self.mail_root else "worker_archive_only", "attachments_policy": "msg_archive_includes_attachment_bytes" if p.get("archive_msg") else "metadata_only; explicit fetch needed"}

    def rpc_outlook_attachment(self, p):
        client = self.com()
        namespace = client.Dispatch("Outlook.Application").GetNamespace("MAPI")
        item = namespace.GetItemFromID(p["entry_id"])
        attachment = item.Attachments.Item(int(p["index"]))
        if attachment.Size > int(p.get("max_bytes", 20 * 1024 * 1024)):
            raise WorkerError("ATTACHMENT_TOO_LARGE", "Attachment exceeds configured individual size limit")
        if self.mail_root:
            attachment_root = self.mail_root / "mail-attachments"
            destination = (attachment_root / p["output"]).resolve()
            if not destination.is_relative_to(attachment_root):
                raise WorkerError("OUTSIDE_WORKSPACE", "Attachment output escapes mail attachment root")
        else:
            destination = self.path(p["output"])
        if destination.exists():
            raise WorkerError("CONFLICT", "Attachment output already exists")
        quota_root = self.mail_root or self.state / "mail-archive"
        quota = min(max(int(p.get("quota_bytes", 50 * 1024**3)), 0), 50 * 1024**3)
        used = sum(entry.stat().st_size for entry in quota_root.rglob("*") if entry.is_file())
        if used + int(attachment.Size) > quota:
            raise WorkerError("QUOTA_EXCEEDED", "Mail collection quota reached")
        destination.parent.mkdir(parents=True, exist_ok=True)
        pending = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".pending")
        try:
            attachment.SaveAsFile(str(pending))
            if pending.stat().st_size > int(p.get("max_bytes", 20 * 1024 * 1024)) or used + pending.stat().st_size > quota:
                raise WorkerError("QUOTA_EXCEEDED", "Extracted attachment exceeds size or collection quota")
            # Refuse replacement even when another extractor raced the initial check.
            os.link(pending, destination)
        finally:
            pending.unlink(missing_ok=True)
        return {"path": str(destination), "sha256": digest(destination.read_bytes()), "quota_scope": "shared_knowledge_root" if self.mail_root else "worker_archive_only"}

    def rpc_office_edit(self, p):
        if p.get("approved") is not True:
            raise WorkerError("APPROVAL_REQUIRED", "Explicit document handoff is required")
        client = self.com()
        path = self.path(p["path"], True)
        if digest(path.read_bytes()) != p.get("expected_hash"):
            raise WorkerError("CONFLICT", "Document changed before COM handoff")
        backup = self.state / "office-backups" / (uuid.uuid4().hex + path.suffix)
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup)
        app = None
        document = None
        try:
            if path.suffix.lower() in (".docx", ".docm", ".doc"):
                app = client.DispatchEx("Word.Application")
                app.DisplayAlerts = False
                document = app.Documents.Open(str(path), ReadOnly=False)
                if document.ReadOnly:
                    raise WorkerError("DOCUMENT_BUSY", "Word opened the document read-only")
                for change in p.get("replacements", []):
                    document.Content.Find.Execute(FindText=change["find"], ReplaceWith=change["replace"], Replace=2)
                document.Save()
            elif path.suffix.lower() in (".xlsx", ".xlsm", ".xls"):
                app = client.DispatchEx("Excel.Application")
                app.DisplayAlerts = False
                document = app.Workbooks.Open(str(path), ReadOnly=False)
                if document.ReadOnly:
                    raise WorkerError("DOCUMENT_BUSY", "Excel opened the document read-only")
                for cell in p.get("cells", []):
                    document.Worksheets(cell["sheet"]).Range(cell["address"]).Value = cell["value"]
                document.Save()
            elif path.suffix.lower() in (".pptx", ".pptm", ".ppt"):
                app = client.DispatchEx("PowerPoint.Application")
                app.DisplayAlerts = 1
                document = app.Presentations.Open(str(path), ReadOnly=False, WithWindow=False)
                for change in p.get("shapes", []):
                    shape = document.Slides(int(change["slide"])).Shapes(change["name"])
                    if "text" in change:
                        shape.TextFrame.TextRange.Text = change["text"]
                    if "image" in change:
                        image_path = self.path(change["image"], True)
                        replacement = document.Slides(int(change["slide"])).Shapes.AddPicture(str(image_path), False, True, shape.Left, shape.Top, shape.Width, shape.Height)
                        old_name = shape.Name
                        shape.Delete()
                        replacement.Name = old_name
                document.Save()
            else:
                raise WorkerError("UNSUPPORTED", "Unsupported Office document format")
            return {"path": str(path), "backup": str(backup), "hash": digest(path.read_bytes()), "corporate_drm_validated": False}
        finally:
            try:
                if document is not None:
                    if path.suffix.lower() in (".pptx", ".pptm", ".ppt"):
                        # Never turn an exception into a modal save prompt or a partial save.
                        document.Saved = True
                        document.Close()
                    else:
                        document.Close(SaveChanges=False)
            finally:
                if app is not None:
                    app.Quit()

    def rpc_office_word_read(self, p):
        client = self.com()
        path = self.path(p["path"], True)
        initial_hash = digest(path.read_bytes())
        app = client.DispatchEx("Word.Application")
        document = None
        try:
            app.DisplayAlerts = False
            document = app.Documents.Open(str(path), ReadOnly=True)
            if digest(path.read_bytes()) != initial_hash:
                raise WorkerError("CONFLICT", "Document changed during extraction")
            return {"path": str(path), "hash": initial_hash, "text": document.Content.Text, "corporate_drm_validated": False}
        finally:
            try:
                if document is not None:
                    document.Close(SaveChanges=False)
            finally:
                app.Quit()

    def rpc_office_excel_read(self, p):
        client = self.com()
        path = self.path(p["path"], True)
        initial_hash = digest(path.read_bytes())
        app = client.DispatchEx("Excel.Application")
        document = None
        try:
            app.DisplayAlerts = False
            document = app.Workbooks.Open(str(path), ReadOnly=True)
            sheets = []
            for sheet in document.Worksheets:
                if p.get("sheet") and sheet.Name != p["sheet"]:
                    continue
                area = sheet.Range(p["range"]) if p.get("range") else sheet.UsedRange
                rows, columns = min(area.Rows.Count, 2000), min(area.Columns.Count, 200)
                cells = area.Resize(rows, columns).Value
                sheets.append({"name": sheet.Name, "range": area.Address, "values": cells, "truncated": rows < area.Rows.Count or columns < area.Columns.Count})
            if digest(path.read_bytes()) != initial_hash:
                raise WorkerError("CONFLICT", "Document changed during extraction")
            return {"path": str(path), "hash": initial_hash, "sheets": sheets, "corporate_drm_validated": False}
        finally:
            try:
                if document is not None:
                    document.Close(SaveChanges=False)
            finally:
                app.Quit()

    def rpc_office_ppt_templates(self, p):
        client = self.com()
        path = self.path(p["path"], True)
        initial_hash = digest(path.read_bytes())
        app = client.DispatchEx("PowerPoint.Application")
        document = None
        try:
            app.DisplayAlerts = 1
            document = app.Presentations.Open(str(path), ReadOnly=True, WithWindow=False)
            slides = []
            for slide in document.Slides:
                shapes = []
                for shape in slide.Shapes:
                    shapes.append({"name": shape.Name, "type": shape.Type, "left": shape.Left, "top": shape.Top, "width": shape.Width, "height": shape.Height, "text": shape.TextFrame.TextRange.Text if shape.HasTextFrame else None})
                slides.append({"index": slide.SlideIndex, "layout": slide.CustomLayout.Name, "shapes": shapes})
            if digest(path.read_bytes()) != initial_hash:
                raise WorkerError("CONFLICT", "Document changed during extraction")
            return {"path": str(path), "hash": initial_hash, "slides": slides, "corporate_drm_validated": False}
        finally:
            try:
                if document is not None:
                    document.Close()
            finally:
                app.Quit()

    def rpc_office_ppt_add(self, p):
        if p.get("approved") is not True:
            raise WorkerError("APPROVAL_REQUIRED", "Explicit document handoff is required")
        client = self.com()
        target = self.path(p["path"], True)
        template = self.path(p["template"], True)
        if target == template:
            raise WorkerError("INVALID_ARGUMENT", "Template and destination must be different files")
        if digest(target.read_bytes()) != p.get("expected_hash"):
            raise WorkerError("CONFLICT", "Document changed before COM handoff")
        backup = self.state / "office-backups" / (uuid.uuid4().hex + target.suffix)
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, backup)
        app = client.DispatchEx("PowerPoint.Application")
        document = None
        try:
            app.DisplayAlerts = 1
            document = app.Presentations.Open(str(target), ReadOnly=False, WithWindow=False)
            after = int(p.get("after", document.Slides.Count))
            source_index = int(p["template_slide"])
            if source_index < 1 or after < 0 or after > document.Slides.Count:
                raise WorkerError("INVALID_ARGUMENT", "Slide positions are one-based; insertion after 0 is allowed")
            count = document.Slides.InsertFromFile(str(template), after, source_index, source_index)
            if count != 1:
                raise WorkerError("TEMPLATE_ERROR", "Template slide was not inserted")
            slide = document.Slides(after + 1)
            for change in p.get("shapes", []):
                shape = slide.Shapes(change["name"])
                if "text" in change:
                    shape.TextFrame.TextRange.Text = change["text"]
                if "image" in change:
                    image = self.path(change["image"], True)
                    replacement = slide.Shapes.AddPicture(str(image), False, True, shape.Left, shape.Top, shape.Width, shape.Height)
                    name = shape.Name
                    shape.Delete()
                    replacement.Name = name
            document.Save()
            return {"path": str(target), "hash": digest(target.read_bytes()), "backup": str(backup), "slide": after + 1, "template": str(template), "template_slide": source_index, "corporate_drm_validated": False}
        finally:
            try:
                if document is not None:
                    document.Saved = True
                    document.Close()
            finally:
                app.Quit()

    def desktop(self):
        if os.name != "nt":
            raise WorkerError("UNAVAILABLE", "Windows UI Automation requires Windows")
        try:
            from pywinauto import Desktop
        except ImportError:
            raise WorkerError("UNAVAILABLE", "Install worker[desktop] using uv") from None
        return Desktop(backend="uia")

    def input_tick(self):
        import ctypes
        from ctypes import wintypes
        class LastInput(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]
        value = LastInput(ctypes.sizeof(LastInput), 0)
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(value)):
            raise WorkerError("UNAVAILABLE", "Cannot inspect user input ownership")
        return value.dwTime

    def rpc_desktop_windows(self, p):
        return [{"handle": window.handle, "title": window.window_text(), "pid": window.process_id()} for window in self.desktop().windows()]

    def rpc_desktop_lease(self, p):
        if p.get("approved") is not True:
            raise WorkerError("APPROVAL_REQUIRED", "User handoff is required for desktop access")
        duration = bounded_timeout(p.get("seconds"), 600)
        window = self.desktop().window(handle=int(p["handle"])).wrapper_object()
        identifier = uuid.uuid4().hex
        lease = {"lease_id": identifier, "handle": window.handle, "pid": window.process_id(), "process_stamp": process_stamp(window.process_id()), "title": window.window_text(), "expires_at": time.time() + duration, "input_tick": self.input_tick(), "revoked": False}
        atomic_json(self.state / "desktop" / (identifier + ".json"), lease)
        return lease

    def desktop_lease(self, p):
        lease = read_json(self.state / "desktop" / (safe_id(p["lease_id"]) + ".json"))
        if lease["revoked"] or time.time() >= lease["expires_at"]:
            raise WorkerError("HANDOFF_EXPIRED", "Desktop handoff expired or was reclaimed")
        if process_stamp(lease["pid"]) != lease["process_stamp"]:
            raise WorkerError("TARGET_CHANGED", "The handed-off application process changed")
        if self.input_tick() != lease["input_tick"]:
            self.rpc_desktop_revoke(p)
            raise WorkerError("USER_RECLAIMED", "User input reclaimed desktop control")
        window = self.desktop().window(handle=lease["handle"]).wrapper_object()
        if window.process_id() != lease["pid"]:
            raise WorkerError("TARGET_CHANGED", "The handed-off window changed")
        return lease, window

    def rpc_desktop_revoke(self, p):
        path = self.state / "desktop" / (safe_id(p["lease_id"]) + ".json")
        lease = read_json(path)
        lease["revoked"] = True
        atomic_json(path, lease)
        return {"lease_id": lease["lease_id"], "revoked": True}

    def rpc_desktop_read(self, p):
        lease, window = self.desktop_lease(p)
        limit = min(max(int(p.get("limit", 500)), 1), 2000)
        elements = []
        pending = [(window, [])]
        while pending and len(elements) < limit:
            element, indices = pending.pop(0)
            info = element.element_info
            # Password controls do not contribute text even when the provider exposes it.
            password = bool(getattr(info, "is_password", False))
            elements.append({"path": indices, "automation_id": info.automation_id, "control_type": info.control_type, "name": "" if password else info.name, "enabled": element.is_enabled(), "visible": element.is_visible(), "protected": password})
            if len(indices) < 12 and not password:
                pending.extend((child, [*indices, index]) for index, child in enumerate(element.children()))
        snapshot = digest(json.dumps(elements, sort_keys=True).encode())
        return {"lease_id": lease["lease_id"], "snapshot": snapshot, "elements": elements, "truncated": bool(pending)}

    def rpc_desktop_action(self, p):
        snapshot = self.rpc_desktop_read(p)
        if snapshot["snapshot"] != p.get("expected_snapshot"):
            raise WorkerError("STALE_SNAPSHOT", "UI changed; inspect again before acting")
        lease, element = self.desktop_lease(p)
        indices = p.get("path")
        if not isinstance(indices, list) or any(not isinstance(index, int) or index < 0 for index in indices):
            raise WorkerError("INVALID_ARGUMENT", "Use the element path from the current snapshot")
        for index in indices:
            element = element.children()[index]
        action = p.get("action")
        if action == "invoke":
            element.invoke()
        elif action == "set_text":
            element.set_edit_text(str(p.get("text", "")))
        else:
            raise WorkerError("INVALID_ARGUMENT", "Supported UIA actions: invoke, set_text")
        return {"lease_id": lease["lease_id"], "action": action, "performed": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--state-dir", default=str(Path.home() / ".hpharness" / "worker"))
    parser.add_argument("--job-runner")
    parser.add_argument("--mail-root")
    args = parser.parse_args()
    if args.job_runner:
        run_job(args.job_runner)
        return
    worker = Worker(args.root, args.state_dir, args.mail_root)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 20 * 1024 * 1024:
                raise WorkerError("REQUEST_TOO_LARGE", "Request exceeds 20 MiB")
            request = json.loads(line)
            if not isinstance(request, dict):
                raise WorkerError("INVALID_REQUEST", "Request must be an object")
            result = worker.dispatch(request.get("method", ""), request.get("params"))
            response = {"id": request.get("id"), "result": result}
        except Exception as exc:
            response = {"id": request.get("id") if isinstance(request, dict) else None, "error": {"code": getattr(exc, "code", "EXECUTION_ERROR"), "message": str(exc)}}
        print(json.dumps(response, ensure_ascii=False, default=str), flush=True)


if __name__ == "__main__":
    main()
