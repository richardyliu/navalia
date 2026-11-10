#!/usr/bin/env -S python3 -I
"""OG-02 manual CAP checks: READ-ONLY, REDACTED evidence collector (stdlib only).

Never writes anything (every file is opened 'rb'; no utime/chmod/unlink/mkdir; SQLite is not
opened at all). Prints to stdout only; redirect it into docs/test-evidence/CAP-xx/. Never prints:
tokens, the screenshot key, the env file's contents, AX text, visible_text, screenshot bytes.
Window titles are replaced by sha256[:10] + length unless --show-titles is given; URLs are cut
to scheme://host.

Roots: by default only /tmp/persome-test/... is accepted. The real ~/.persome (or any other
root) needs --real-root-readonly; even then nothing is written.

usage:
  og02_cap_readonly.py ps
  og02_cap_readonly.py config    --root R
  og02_cap_readonly.py frames    --root R [--since ISO] [--show-titles]
  og02_cap_readonly.py heartbeat --root R [--since ISO]
  og02_cap_readonly.py crypto    --root R
  og02_cap_readonly.py retention --root R
  og02_cap_readonly.py all       --root R [--since ISO]
"""

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
TEMP_PREFIXES = ("/tmp/persome-test/", "/private/tmp/persome-test/")
SECRETISH = re.compile(r"(PERSOME_[A-Z_]*(TOKEN|KEY)[A-Z_]*\s*=\s*)\S+|(Bearer\s+)\S+|\b[0-9a-fA-F]{48,}\b")
CAPTURE_KEYS = (
    "source", "include_screenshot", "encrypt_screenshots", "buffer_retention_hours",
    "screenshot_retention_hours", "screenshot_max_width", "screenshot_jpeg_quality",
    "enable_ocr_fallback", "ocr_policy", "ocr_tier", "pause_on_lock", "suppress_secure_input",
)


def fold(s):
    s = SECRETISH.sub(lambda m: (m.group(1) or m.group(3) or "") + "<redacted>", s)
    return s.replace(HOME, "~")


def out(line=""):
    print(fold(str(line)))


def read_bytes(path, limit=None):
    with open(path, "rb") as f:
        return f.read() if limit is None else f.read(limit)


def check_root(root, allow_real):
    real = os.path.realpath(root)
    if any(real.startswith(p) for p in TEMP_PREFIXES):
        return real
    if not allow_real:
        sys.exit(f"refusing root {fold(real)}: not under /tmp/persome-test/ (pass --real-root-readonly to read it)")
    out(f"# NOTE: reading a non-temp root READ-ONLY: {real}")
    return real


def h(s):
    s = s or ""
    return f"sha256:{hashlib.sha256(s.encode('utf-8')).hexdigest()[:10]} len={len(s)}" if s else "(empty)"


def origin(url):
    if not url:
        return None
    m = re.match(r"^([a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]+)", str(url))
    return m.group(1) if m else "(non-url)"


# ---------------------------------------------------------------- ps (CAP-01 part 1)
def cmd_ps(_args):
    out(f"# CAP-01 part 1: process view {datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    out("# read-only: ps only; home folded to ~")
    ps = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,lstart=,command="], capture_output=True, text=True).stdout
    rows = {}
    for line in ps.splitlines():
        parts = line.split(None, 7)
        if len(parts) < 8:
            continue
        pid, ppid = parts[0], parts[1]
        rows[pid] = (ppid, " ".join(parts[2:7]), parts[7])
    pat = re.compile(r"persome|mac-ax", re.I)
    shell = re.compile(r"^(/bin/|/usr/bin/)?(zsh|bash|sh)\s+-c\b")
    out("## matching processes: pid ppid started command(160)")
    for pid, (ppid, started, cmd) in sorted(rows.items(), key=lambda kv: int(kv[0])):
        if pat.search(cmd) and not shell.search(cmd) and "og02_cap_readonly" not in cmd:
            out(f"{pid:>6} {ppid:>6} {started}  {cmd[:160]}")
    out("## every mac-ax-* process and its ancestry (expect: none attached to the Lens-launched Runtime)")
    found = False
    for pid, (ppid, _s, cmd) in rows.items():
        if "mac-ax-" in cmd and "og02_cap_readonly" not in cmd:
            found = True
            out(f"{pid} {cmd[:160]}")
            seen, cur = set(), ppid
            while cur in rows and cur not in seen and cur != "0":
                seen.add(cur)
                out(f"   parent {cur}: {rows[cur][2][:160]}")
                cur = rows[cur][0]
    if not found:
        out("(none)")


# ---------------------------------------------------------------- config (CAP-01 part 3, CAP-03 key file)
def capture_section(root):
    p = os.path.join(root, "config.toml")
    try:
        text = read_bytes(p).decode("utf-8", "replace")
    except OSError as e:
        return None, f"unreadable: {e.strerror}"
    sec, found = "", {}
    for line in text.splitlines():
        t = line.strip()
        if t.startswith("["):
            sec = t.replace(" ", "")
            continue
        if sec != "[capture]":
            continue
        m = re.match(r"^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*(#.*)?$", t)
        if m and m.group(1) in CAPTURE_KEYS:
            found[m.group(1)] = m.group(2)
    return found, None


def cmd_config(args):
    root = check_root(args.root, args.real_root_readonly)
    out(f"# CAP-01 part 3 / CAP-03 key-file check, root={root}")
    sec, err = capture_section(root)
    out("## config.toml [capture] (allow-listed keys; absent key = Runtime default)")
    if err:
        out(err)
    else:
        for k in CAPTURE_KEYS:
            out(f"{k} = {sec[k]}" if k in sec else f"{k} = (default)")
    out("## .runtime-state.json (selected fields)")
    try:
        st = json.loads(read_bytes(os.path.join(root, ".runtime-state.json")))
        for k in ("capture_mode", "permissions", "phase", "ocr", "ocr_enabled", "ocr_worker", "last_capture_reason"):
            out(f"{k}: {json.dumps(st.get(k), ensure_ascii=False)}")
    except (OSError, ValueError) as e:
        out(f"unreadable: {e}")
    out("## capture log: first 'capture source=' line (logs/*.log, first 4 MiB each)")
    logs = os.path.join(root, "logs")
    hit = None
    try:
        for name in sorted(os.listdir(logs)):
            if not name.endswith(".log"):
                continue
            for raw in read_bytes(os.path.join(logs, name), 4 << 20).decode("utf-8", "replace").splitlines():
                if "capture source=" in raw:
                    hit = (name, raw[:400])
                    break
            if hit:
                break
    except OSError as e:
        out(f"logs unreadable: {e.strerror}")
    out(f"{hit[0]}: {hit[1]}" if hit else "(no 'capture source=' line found)")
    out("## env file: mode and key PRESENCE only (contents never printed)")
    envp = os.path.join(root, "env")
    try:
        mode = stat.S_IMODE(os.stat(envp).st_mode)
        names = [ln.split("=", 1)[0].strip() for ln in read_bytes(envp).decode("utf-8", "replace").splitlines() if "=" in ln and not ln.strip().startswith("#")]
        out(f"mode={oct(mode)} (expect 0o600)  PERSOME_SCREENSHOT_KEY present={'PERSOME_SCREENSHOT_KEY' in names}  PERSOME_LOCAL_API_TOKEN present={'PERSOME_LOCAL_API_TOKEN' in names}")
    except OSError as e:
        out(f"env: {e.strerror}")


# ---------------------------------------------------------------- frames
def iter_frames(root, since):
    buf = os.path.join(root, "capture-buffer")
    for name in sorted(os.listdir(buf)):
        if not name.endswith(".json") or name.startswith("."):
            continue
        p = os.path.join(buf, name)
        try:
            d = json.loads(read_bytes(p))
        except (OSError, ValueError):
            continue
        if since and str(d.get("timestamp", "")) < since:
            continue
        yield name, p, d


def frame_summary(d, show_titles):
    wm = d.get("window_meta") or {}
    tr = d.get("trigger") or {}
    shot = d.get("screenshot") or {}
    title = wm.get("title", "")
    return {
        "timestamp": d.get("timestamp"),
        "capture_source": d.get("capture_source"),
        "trigger": tr.get("event_type"),
        "app_name": wm.get("app_name"),
        "bundle_id": wm.get("bundle_id"),
        "title": title if show_titles else h(title),
        "url_origin": origin(d.get("url")),
        "ax_unavailable": bool(d.get("ax_unavailable", False)),
        "secure_input_suppressed": bool(d.get("secure_input_suppressed", False)),
        "has_screenshot": bool(shot),
        "screenshot_enc": bool(shot.get("screenshot_enc", False)),
        "screenshot_stripped": bool(d.get("screenshot_stripped", False)),
        "ocr_submitted": bool(d.get("ocr_submitted", False)),
        "keys": sorted(d),
    }


def cmd_frames(args):
    root = check_root(args.root, args.real_root_readonly)
    rows = [frame_summary(d, args.show_titles) for _n, _p, d in iter_frames(root, args.since)]
    by_bundle = Counter(r["bundle_id"] for r in rows)
    by_trigger = Counter(r["trigger"] for r in rows)
    missing = [r["timestamp"] for r in rows if not (r["timestamp"] and r["app_name"] and r["bundle_id"] and r["title"] != "(empty)")]
    out(json.dumps({
        "root": root, "since": args.since, "frames": len(rows),
        "by_bundle": dict(by_bundle), "by_trigger": dict(by_trigger),
        "capture_source_values": dict(Counter(r["capture_source"] for r in rows)),
        "frames_missing_app_bundle_title_or_timestamp": missing,
        "rows": rows,
    }, ensure_ascii=False, indent=1))


def cmd_heartbeat(args):
    root = check_root(args.root, args.real_root_readonly)
    ts = []
    beats = []
    for _n, _p, d in iter_frames(root, args.since):
        t = d.get("timestamp")
        ts.append(t)
        if (d.get("trigger") or {}).get("event_type") == "heartbeat":
            beats.append(t)

    def parse(x):
        return datetime.fromisoformat(str(x).replace("Z", "+00:00"))

    gaps = []
    allts = sorted(ts)
    for b in beats:
        prev = [t for t in allts if t < b]
        if prev:
            gaps.append(round((parse(b) - parse(prev[-1])).total_seconds(), 1))
    out(json.dumps({"since": args.since, "frames": len(ts), "heartbeats": beats, "seconds_since_previous_frame": gaps,
                    "expect": "each gap ~600 s (10 min) when nothing else was captured"}, indent=1))


def cmd_crypto(args):
    root = check_root(args.root, args.real_root_readonly)
    total = with_shot = enc = plain = bad_mode = 0
    jpeg_magic_files = 0
    for _n, p, d in iter_frames(root, None):
        total += 1
        if stat.S_IMODE(os.stat(p).st_mode) != 0o600:
            bad_mode += 1
        shot = d.get("screenshot") or {}
        if shot:
            with_shot += 1
            img = str(shot.get("image_base64") or "")
            if img.startswith("PSOMEGCM1:") and shot.get("screenshot_enc"):
                enc += 1
            else:
                plain += 1
        if b'"/9j/' in read_bytes(p):  # base64 JPEG SOI anywhere in the file as a JSON string start
            jpeg_magic_files += 1
    out(json.dumps({"frames": total, "with_screenshot": with_shot, "encrypted_PSOMEGCM1": enc, "plaintext_screenshots": plain,
                    "files_with_plaintext_jpeg_base64": jpeg_magic_files, "files_not_0600": bad_mode,
                    "expect": "plaintext_screenshots=0, files_with_plaintext_jpeg_base64=0, files_not_0600=0"}, indent=1))


def cmd_retention(args):
    root = check_root(args.root, args.real_root_readonly)
    now = datetime.now(timezone.utc).timestamp()
    sec, _ = capture_section(root)
    sec = sec or {}
    keep_h = float(sec.get("buffer_retention_hours", 168))
    shot_h = float(sec.get("screenshot_retention_hours", 24))
    oldest = None
    over_keep = shot_over = 0
    for _n, p, d in iter_frames(root, None):
        age_h = (now - os.stat(p).st_mtime) / 3600
        oldest = age_h if oldest is None else max(oldest, age_h)
        if age_h > keep_h:
            over_keep += 1
        if age_h > shot_h and d.get("screenshot"):
            shot_over += 1
    out(json.dumps({"buffer_retention_hours": keep_h, "screenshot_retention_hours": shot_h, "oldest_frame_age_h": round(oldest or 0, 2),
                    "frames_older_than_buffer_retention": over_keep, "frames_with_screenshot_older_than_screenshot_retention": shot_over,
                    "note": "the Runtime sweeps on its timeline tick; non-zero counts right after a long idle are expected until the next sweep"}, indent=1))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["ps", "config", "frames", "heartbeat", "crypto", "retention", "all"])
    ap.add_argument("--root")
    ap.add_argument("--since", default=None)
    ap.add_argument("--show-titles", action="store_true")
    ap.add_argument("--real-root-readonly", action="store_true")
    args = ap.parse_args()
    if args.cmd != "ps" and not args.root:
        sys.exit("--root is required")
    cmds = {"ps": cmd_ps, "config": cmd_config, "frames": cmd_frames, "heartbeat": cmd_heartbeat, "crypto": cmd_crypto, "retention": cmd_retention}
    if args.cmd == "all":
        for name in ("ps", "config", "frames", "heartbeat", "crypto", "retention"):
            out(f"\n######## {name}")
            cmds[name](args)
    else:
        cmds[args.cmd](args)


if __name__ == "__main__":
    main()
