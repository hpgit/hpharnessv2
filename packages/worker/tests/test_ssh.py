"""Opt-in live SSH test: HPH_TEST_SSH=wsl. Uses an isolated remote home directory."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from remote import prepare, ssh_command


@unittest.skipUnless(os.environ.get("HPH_TEST_SSH"), "Set HPH_TEST_SSH to a configured SSH alias")
class SSHIntegrationTests(unittest.TestCase):
    def test_file_conflict_cwd_and_job_survival(self):
        alias = os.environ["HPH_TEST_SSH"]
        create = subprocess.run(ssh_command(alias, ["python3", "-c", "import pathlib,tempfile;print(tempfile.mkdtemp(prefix='.hpharness-test-',dir=pathlib.Path.home()))"]), capture_output=True, text=True, timeout=20, check=True)
        root = create.stdout.strip()
        self.assertIn("/.hpharness-test-", root)
        command = prepare(alias, root)

        def request(method, params=None):
            value = {"id": 1, "method": method, "params": params or {}}
            reply = subprocess.run(command, input=json.dumps(value, ensure_ascii=False) + "\n", capture_output=True, text=True, encoding="utf-8", timeout=20, check=True)
            return json.loads(reply.stdout)

        self.assertEqual(request("ping")["result"]["root"], root)
        created = request("files.write", {"path": "한글 directory/test.txt", "content": "remote 한글", "expected_hash": None})
        self.assertIn("hash", created["result"])
        self.assertEqual(request("files.read", {"path": "한글 directory/test.txt"})["result"]["content"], "remote 한글")
        self.assertEqual(request("files.write", {"path": "한글 directory/test.txt", "content": "overwritten", "expected_hash": None})["error"]["code"], "CONFLICT")
        result = request("command.run", {"argv": ["python3", "-c", "import os; print(os.getcwd())"], "cwd": "한글 directory"})
        self.assertEqual(result["result"]["stdout"].strip(), root + "/한글 directory")
        # The helper and SSH connection exit after jobs.start, before the managed command finishes.
        result = request("jobs.start", {"argv": ["python3", "-c", "import time;time.sleep(1);print('survived SSH disconnect')"]})
        identifier = result["result"]["job_id"]
        for _ in range(20):
            status = request("jobs.status", {"job_id": identifier})["result"]
            if status["status"] == "completed":
                break
            time.sleep(.1)
        self.assertEqual(status["status"], "completed")
        self.assertIn("survived SSH disconnect", status["stdout"])
        # Keep the remote test directory and log records for inspection; never remove user paths.
        print("SSH fixture retained:", root)


if __name__ == "__main__":
    unittest.main()
