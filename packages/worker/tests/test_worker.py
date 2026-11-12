import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hph_worker import Worker, WorkerError, process_stamp
from remote import ssh_command, prepare


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "project"
        self.root.mkdir()
        self.worker = Worker(self.root, Path(self.temporary.name) / "state")

    def tearDown(self):
        # A durable result means the command ended, not that its detached owner
        # has exited Python and released inherited log handles (notably on Windows).
        jobs = self.worker.state / "jobs"
        owners = []
        for directory in jobs.iterdir() if jobs.exists() else []:
            if not (directory / "result.json").exists():
                (directory / "cancel").touch()
            owner_file = directory / "owner.json"
            if owner_file.exists():
                owners.append(json.loads(owner_file.read_text(encoding="utf-8")))
        deadline = time.monotonic() + 10
        while owners:
            owners = [owner for owner in owners if owner.get("stamp") is not None
                      and process_stamp(owner["pid"]) == owner["stamp"]]
            if not owners:
                break
            if time.monotonic() >= deadline:
                self.fail(f"Job owners did not exit before cleanup: {owners}")
            time.sleep(0.02)
        self.temporary.cleanup()

    def wait(self, identifier):
        for _ in range(200):
            result = self.worker.dispatch("jobs.status", {"job_id": identifier})
            if result["status"] in ("completed", "failed", "cancelled", "timed_out"):
                return result
            time.sleep(0.05)
        self.fail("job did not finish")

    def test_unicode_write_conflict_and_binary(self):
        result = self.worker.dispatch("files.write", {"path": "가나다.py", "content": "print('안녕')\n", "expected_hash": None})
        read = self.worker.dispatch("files.read", {"path": "가나다.py"})
        self.assertEqual(read["hash"], result["hash"])
        with self.assertRaisesRegex(WorkerError, "changed"):
            self.worker.dispatch("files.write", {"path": "가나다.py", "content": "oops", "expected_hash": None})
        self.assertEqual(self.worker.dispatch("files.list")["entries"][0]["name"], "가나다.py")
        (self.root / "binary").write_bytes(b"\xff\x00")
        self.assertEqual(self.worker.dispatch("files.read", {"path": "binary"})["encoding"], "base64")

    def test_path_escape(self):
        for path in ("../secret", str(self.root.parent / "secret")):
            with self.assertRaises(WorkerError) as caught:
                self.worker.dispatch("files.read", {"path": path})
            self.assertEqual(caught.exception.code, "OUTSIDE_WORKSPACE")
        if os.name != "nt":
            (self.root / "outside").symlink_to(self.root.parent, target_is_directory=True)
            with self.assertRaises(WorkerError):
                self.worker.path("outside/secret")

    def test_concurrent_writes_cannot_both_accept_one_base(self):
        first = self.worker.dispatch("files.write", {"path": "same.txt", "content": "base", "expected_hash": None})
        def write(value):
            try:
                return self.worker.dispatch("files.write", {"path": "same.txt", "content": value, "expected_hash": first["hash"]})
            except WorkerError as exc:
                return {"error": exc.code}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(write, ["left", "right"]))
        self.assertEqual(sum("hash" in item for item in results), 1)
        self.assertEqual(sum(item.get("error") in ("CONFLICT", "FILE_BUSY") for item in results), 1)

    def test_commands_do_not_interpret_shell_characters(self):
        result = self.worker.dispatch("command.run", {"argv": [sys.executable, "-c", "import sys; print(sys.argv[1])", "hello; not-a-command $(whoami)"]})
        self.assertEqual(result["status"], "completed")
        self.assertIn("hello; not-a-command $(whoami)", result["stdout"])

    def test_jobs_survive_worker_recreation(self):
        result = self.worker.dispatch("jobs.start", {"argv": [sys.executable, "-c", "import time; time.sleep(.15); print('durable')"]})
        self.worker = Worker(self.root, self.worker.state)
        complete = self.wait(result["job_id"])
        self.assertEqual(complete["exit_code"], 0)
        self.assertEqual(complete["stdout"].strip(), "durable")

    def test_cancellation_and_timeout(self):
        job = self.worker.dispatch("jobs.start", {"argv": [sys.executable, "-c", "import time; time.sleep(30)"]})
        self.worker.dispatch("jobs.cancel", job)
        self.assertEqual(self.wait(job["job_id"])["status"], "cancelled")
        result = self.worker.dispatch("command.run", {"argv": [sys.executable, "-c", "import time; time.sleep(30)"], "timeout": 0.15})
        self.assertEqual(result["status"], "timed_out")

    def test_cleanup_waits_for_owner_after_result_is_published(self):
        # Reproduce the CI race deterministically: publish a result while a real
        # owner still holds owner.log. Release it only after cleanup begins.
        directory = self.worker.job_path("lingering-owner")
        directory.mkdir(parents=True)
        release = self.root / "release-owner"
        script = (
            "import pathlib,sys,time; "
            "d=pathlib.Path(sys.argv[1]); release=pathlib.Path(sys.argv[2]); "
            "(d/'result.json').write_text('{\"status\":\"completed\"}'); "
            "exec('while not release.exists(): time.sleep(.01)')"
        )
        with (directory / "owner.log").open("wb") as log:
            owner = subprocess.Popen([sys.executable, "-c", script, str(directory), str(release)], stdout=log, stderr=log)
        def finish_owner():
            if owner.poll() is None:
                owner.terminate()
            owner.wait(timeout=10)
        self.addCleanup(finish_owner)
        stamp = process_stamp(owner.pid)
        self.assertIsNotNone(stamp)
        (directory / "owner.json").write_text(json.dumps({"pid": owner.pid, "stamp": stamp}), encoding="utf-8")
        deadline = time.monotonic() + 10
        while not (directory / "result.json").exists():
            if time.monotonic() >= deadline:
                self.fail("owner did not publish result")
            time.sleep(.01)
        real_stamp = process_stamp
        def release_during_cleanup(pid):
            current = real_stamp(pid)
            if pid == owner.pid:
                release.touch()
            return current
        # Keep the patch until tearDown; addCleanup stops it afterwards.
        patcher = patch(f"{__name__}.process_stamp", side_effect=release_during_cleanup)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_dummy_gpu_is_explicit_and_durable(self):
        job = self.worker.dispatch("gpu.submit", {"workload": {"name": "training"}})
        self.assertTrue(job["simulated"])
        self.assertEqual(job["backend"], "dummy")
        self.worker.dispatch("gpu.cancel", job)
        self.assertEqual(self.worker.dispatch("gpu.status", job)["status"], "cancelled")
        (self.root / "input.txt").write_text("data", encoding="utf-8")
        artifact = self.worker.dispatch("gpu.upload", dict(job, path="input.txt"))["artifact"]
        download = self.worker.dispatch("gpu.download", dict(job, artifact_id=artifact["id"], output="download.txt"))
        self.assertTrue(download["simulated"])
        self.assertEqual(download["sha256"], artifact["sha256"])

    def test_sdk_original_baseline_and_registration_gate(self):
        (self.root / "original.onnx").write_bytes(b"original fixture")
        (self.root / "derived.onnx").write_bytes(b"derived fixture")
        manifest = {"name": "fixture", "sdk": "qairt", "argv": [sys.executable, "-c", "import pathlib,sys;pathlib.Path(sys.argv[2]).write_bytes(pathlib.Path(sys.argv[1]).read_bytes())", "{input}", "{output}"]}
        with self.assertRaises(WorkerError):
            self.worker.dispatch("sdk.register", manifest)
        self.worker.dispatch("sdk.register", dict(manifest, approved=True))
        params = {"name": "fixture", "original_onnx": "original.onnx", "input": "derived.onnx", "output": "artifact.bin", "approved": True}
        result = self.worker.dispatch("sdk.run", params)
        self.assertEqual(result["run"]["status"], "completed")
        self.assertNotEqual(result["baseline"]["sha256"], result["input"]["sha256"])
        self.assertEqual(result["metrics"], {})
        self.assertEqual((self.root / "artifact.bin").read_bytes(), b"derived fixture")
        with self.assertRaises(WorkerError):
            self.worker.dispatch("sdk.run", dict(params, output="original.onnx"))

    def test_jsonl_error_does_not_kill_worker(self):
        script = Path(__file__).resolve().parents[1] / "hph_worker.py"
        requests = 'invalid\n' + json.dumps({"id": 2, "method": "ping"}) + '\n'
        result = subprocess.run([sys.executable, str(script), "--root", str(self.root), "--state-dir", str(self.worker.state)], input=requests, capture_output=True, text=True, encoding="utf-8")
        lines = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertIn("error", lines[0])
        self.assertEqual(lines[1]["id"], 2)
        self.assertEqual(lines[1]["result"]["root"], str(self.root.resolve()))

    def test_remote_alias_validation_and_shell_quoting(self):
        command = ssh_command("wsl", ["python3", "-c", "print('hello')", "path with spaces;$x"])
        self.assertEqual(command[-2], "wsl")
        self.assertIn("'path with spaces;$x'", command[-1])
        with self.assertRaises(ValueError):
            ssh_command("-oProxyCommand=oops", ["python3"])

    def test_local_container_deploys_real_worker_file_for_job_owner(self):
        with patch("remote.subprocess.run", return_value=subprocess.CompletedProcess([], 0, b"/home/user/.hpharness/workers/hash/hph_worker.py\n", b"")) as mocked:
            command = prepare(None, "/workspace", "fixture-container")
        deploy = mocked.call_args.args[0]
        self.assertEqual(deploy[:4], ["docker", "exec", "-i", "fixture-container"])
        self.assertIn("os.replace", deploy[-1])
        self.assertEqual(command[:4], deploy[:4])
        self.assertIn("runpy.run_path", command[-1])
        self.assertIn("hph_worker.py", command[-1])

    @unittest.skipIf(os.name == "nt", "POSIX executable bit")
    def test_write_preserves_executable_mode(self):
        first = self.worker.dispatch("files.write", {"path": "script.sh", "content": "echo before", "expected_hash": None})
        (self.root / "script.sh").chmod(0o755)
        self.worker.dispatch("files.write", {"path": "script.sh", "content": "echo after", "expected_hash": first["hash"]})
        self.assertEqual((self.root / "script.sh").stat().st_mode & 0o777, 0o755)


if __name__ == "__main__":
    unittest.main()
