"""Run once on the trusted host; stdin is GitHub encoded_jit_config.
Caller must generate a one-job JIT registration, verify the actual run/job/SHA,
and never reuse this retained directory or accept evidence from a different job.
No GitHub registration or production dispatch is performed by this script.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

IMAGE = "ghcr.io/actions/actions-runner@sha256:5036480998280bb21e32ade9fe1b02b493861ac314b62ba1aea320b94f56ec97"

def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)

def isolate(pid):
    if run(["readlink", "/proc/self/ns/net"]).stdout == run(["readlink", f"/proc/{pid}/ns/net"]).stdout:
        raise RuntimeError("host_network_namespace_rejected")
    def fw(*args):run(['nsenter','-t',pid,'-n','iptables',*args])
    fw('-P','OUTPUT','DROP');fw('-P','INPUT','DROP')
    run(['nsenter','-t',pid,'-n','ip6tables','-P','OUTPUT','DROP'])
    run(['nsenter','-t',pid,'-n','ip6tables','-P','INPUT','DROP'])
    fw('-A','INPUT','-m','conntrack','--ctstate','ESTABLISHED,RELATED','-j','ACCEPT')
    fw('-A','INPUT','-i','lo','-j','ACCEPT');fw('-A','OUTPUT','-o','lo','-j','ACCEPT')
    for cidr in ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','198.18.0.0/15','224.0.0.0/4','240.0.0.0/4','188.166.24.162/32','209.38.106.83/32']:
     fw('-A','OUTPUT','-d',cidr,'-j','REJECT')
    fw('-A','OUTPUT','-m','conntrack','--ctstate','ESTABLISHED,RELATED','-j','ACCEPT')
    for protocol in ['udp','tcp']:
     fw('-A','OUTPUT','-p',protocol,'-d','1.1.1.1','--dport','53','-j','ACCEPT')
    fw('-A','OUTPUT','-p','tcp','-m','multiport','--dports','80,443,5432','-j','ACCEPT')
    # Docker embedded DNS resolver stays in the container loopback namespace.

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operation", required=True)
    parser.add_argument("--machine-id", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"rr-h89-[a-f0-9]{32}", args.operation):
        raise RuntimeError("invalid_operation_name")
    if Path("/etc/machine-id").read_text().strip() != args.machine_id:
        raise RuntimeError("wrong_host")
    # No credentials are read from files or printed. Consume the one-use config.
    config = sys.stdin.read(1024 * 1024).strip()
    if not config or not re.fullmatch(r"[A-Za-z0-9+/=]+", config):
        raise RuntimeError("invalid_jit_config")
    root = Path("/var/data/rr-migration-journals")
    root.mkdir(mode=0o700, exist_ok=True)
    retained = root / args.operation
    retained.mkdir(mode=0o700)  # Never reuse or overwrite an earlier operation.
    # Reserve a fixed backing file; all job-writable disk lives inside this filesystem.
    if shutil.disk_usage(root).free < 3584 * 1024**2:
        raise RuntimeError("insufficient_space_for_bounded_runner")
    backing = retained / "storage.ext4"
    os.close(os.open(backing, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
    mount = retained / "fs"
    mount.mkdir(mode=0o700)
    cid = seed = None
    mounted = False
    try:
        run(["fallocate", "-l", "3G", str(backing)])
        run(["mkfs.ext4", "-F", "-q", str(backing)])
        run(["mount", "-o", "loop,nodev,nosuid", str(backing), str(mount)])
        mounted = True
        home = mount / "runner"
        journal = mount / "journal"
        home.mkdir(mode=0o700)
        journal.mkdir(mode=0o700)
        seed = run(["docker", "create", "--network", "none", "--read-only", IMAGE]).stdout.strip()
        run(["docker", "cp", f"{seed}:/home/runner/.", str(home)])
        run(["docker", "rm", seed])
        seed = None
        run(["chown", "-R", "1001:1001", str(home), str(journal)])
        cid = run([
            "docker", "run", "-d", "--name", args.operation, "--dns", "1.1.1.1",
            "--log-driver", "none",
            "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--memory", "3g", "--cpus", "2", "--pids-limit", "512",
            "--env", "RUNNER_TOOL_CACHE=/home/runner/toolcache",
            "--mount", f"type=bind,src={journal},dst=/retained",
            "--mount", f"type=bind,src={home},dst=/home/runner",
            "--entrypoint", "sleep", IMAGE, "infinity",
        ]).stdout.strip()
        info = json.loads(run(["docker", "inspect", cid]).stdout)[0]
        isolate(str(info["State"]["Pid"]))
        run(["docker", "exec", "-i", cid, "bash", "-c",
             "umask 077; cat > /home/runner/.jit"], input=config)
        config = None
        # Keep diagnostics private. They are untrusted until actual job identity is checked.
        fd = os.open(journal / "runner.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            result = subprocess.run([
                "docker", "exec", cid, "bash", "-c",
                'jit=$(cat /home/runner/.jit); rm /home/runner/.jit; exec ./run.sh --jitconfig "$jit"',
            ], stdout=output, stderr=subprocess.STDOUT, timeout=5400)
        print(json.dumps({"runnerExit": result.returncode, "retainedDirectory": str(retained),
                          "jobIdentityVerified": False}))
        return result.returncode
    finally:
        if cid:
            run(["docker", "rm", "-f", cid])
        if seed:
            run(["docker", "rm", "-f", seed])
        if mounted:
            run(["umount", str(mount)])
        # Preserve the bounded filesystem; never replay or delete its journal.
        retained.chmod(0o700)

if __name__ == "__main__":
    sys.exit(main())
