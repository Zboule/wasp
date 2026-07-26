#!/usr/bin/env python3
"""End-to-end AgentCore check: wait READY, measure cold vs warm latency, verify
session resume. Run after 30-create-runtime.sh. Shells out to the AWS CLI so it
needs no extra Python deps.

    python3 deploy/measure.py
"""
import json, os, subprocess, sys, time, uuid, pathlib

REGION = os.environ.get("AWS_REGION", "us-east-1")
PROFILE = os.environ.get("AWS_PROFILE", "perso")
STATE = pathlib.Path(__file__).with_name(".state")
ARN = (STATE / "runtime_arn").read_text().strip()
RID = ARN.split("/")[-1]

def aws(*args, capture=True):
    return subprocess.run(["aws", *args, "--region", REGION, "--profile", PROFILE],
                          capture_output=capture, text=True)

def wait_ready(timeout=300):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = aws("bedrock-agentcore-control", "get-agent-runtime", "--agent-runtime-id", RID)
        st = json.loads(r.stdout).get("status") if r.returncode == 0 else f"ERR:{r.stderr[:120]}"
        print(f"  status={st} ({time.time()-t0:.0f}s)")
        if st == "READY":
            return True
        if st in ("CREATE_FAILED", "UPDATE_FAILED", "DELETING"):
            print("  runtime failed:", r.stdout[:400]); return False
        time.sleep(5)
    return False

def new_sid():
    return uuid.uuid4().hex + uuid.uuid4().hex  # 64 chars (AgentCore wants 33+)

def invoke(sid, prompt):
    out = subprocess.run(["mktemp"], capture_output=True, text=True).stdout.strip()
    payload = json.dumps({"prompt": prompt})
    t = time.time()
    r = aws("bedrock-agentcore", "invoke-agent-runtime",
            "--agent-runtime-arn", ARN, "--runtime-session-id", sid,
            "--content-type", "application/json", "--accept", "application/json",
            "--cli-binary-format", "raw-in-base64-out", "--payload", payload, out)
    dt = time.time() - t
    if r.returncode != 0:
        return dt, None, r.stderr[:300]
    body = pathlib.Path(out).read_text()
    try:
        j = json.loads(body)
        text = j.get("text") or j
    except Exception:
        text = body[:300]
    return dt, text, None

CHEAP = "Reply with exactly: OK"

def main():
    print(f"runtime: {RID}")
    print("== wait READY ==")
    if not wait_ready():
        sys.exit("runtime never reached READY")

    print("\n== cold start (fresh session, cheap prompt) ==")
    sid = new_sid()
    t_cold, txt, err = invoke(sid, CHEAP)
    print(f"  cold  = {t_cold:.2f}s  -> {err or txt}")

    print("\n== warm (same session, cheap prompt) ==")
    t_warm, txt, err = invoke(sid, CHEAP)
    print(f"  warm  = {t_warm:.2f}s  -> {err or txt}")

    print("\n== second cold sample (new session) ==")
    t_cold2, txt, err = invoke(new_sid(), CHEAP)
    print(f"  cold2 = {t_cold2:.2f}s  -> {err or txt}")

    print("\n== session resume ==")
    rsid = new_sid()
    _, t1, e1 = invoke(rsid, "Remember this codeword: ZEBRA-42. Reply with exactly: OK")
    print(f"  turn1 -> {e1 or t1}")
    _, t2, e2 = invoke(rsid, "What codeword did I give you? Reply with just the codeword.")
    print(f"  turn2 -> {e2 or t2}")
    recalled = isinstance(t2, str) and "ZEBRA" in t2.upper()
    print(f"  RESUME {'OK' if recalled else 'FAILED'} (codeword {'recalled' if recalled else 'lost'})")

    print("\n== summary ==")
    print(f"  cold start (first invoke) : {t_cold:.2f}s")
    print(f"  warm invoke               : {t_warm:.2f}s")
    print(f"  cold - warm (startup est) : {max(0,t_cold-t_warm):.2f}s")
    print(f"  session resume            : {'PASS' if recalled else 'FAIL'}")

if __name__ == "__main__":
    main()
