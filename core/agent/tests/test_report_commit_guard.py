"""Report preparation failures cannot bypass workspace policy restoration."""
import subprocess
import pytest
from llm.ports import run_harness_turn
from shared.gitenv import scrubbed_git_env


def test_failed_preparation_restores_all_mount_policies_without_committing(tmp_path):
    mounts = [tmp_path / "primary", tmp_path / "shared"]
    def git(mount, *args):
        return subprocess.run(["git", "-C", str(mount), *args], env=scrubbed_git_env(), check=True, capture_output=True).stdout
    heads = []
    for mount in mounts:
        policy = mount / "policy/members.json"
        policy.parent.mkdir(parents=True)
        policy.write_text('{"authorized":true}')
        git(mount, "init")
        git(mount, "add", ".")
        git(mount, "-c", "user.name=test", "-c", "user.email=test@vexa.local", "commit", "-m", "policy")
        heads.append(git(mount, "rev-parse", "HEAD"))
    class Harness:
        def run_turn(self, work, prompt, **kwargs):
            for mount in mounts:
                (mount / "policy/members.json").write_text('{"intruder":true}')
            yield {"type": "done", "ok": True}
    def fail():
        raise ValueError("invalid report")
    with pytest.raises(ValueError, match="invalid report"):
        list(run_harness_turn(mounts[0], "report", Harness(), extra_mounts=mounts[1:], before_commit=fail))
    for mount, head in zip(mounts, heads):
        assert (mount / "policy/members.json").read_text() == '{"authorized":true}'
        assert git(mount, "rev-parse", "HEAD") == head
