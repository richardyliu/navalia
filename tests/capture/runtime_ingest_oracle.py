"""Feed Lens-built ingest bodies through the OSS Runtime's own ingest code (read-only checkout).

Driven by tests/capture/runtime-oracle.test.ts. Reads a job JSON on stdin, prints one JSON
result on stdout. Never touches ~/.persome: PERSOME_ROOT must be a fresh /tmp/persome-test/
directory and the screenshot key is a throwaway test key passed in the environment.

Per case:
  body (exact bytes Lens POSTs) -> CaptureIngestBody.model_validate_json (what FastAPI does)
  -> model_dump() -> scheduler.build_ingest_capture(respect_screen_lock=False)
  -> optional _write_capture_and_invalidate_content_receipts (temp capture-buffer)
The route's ingest_capture() differs only by the live-runner dedup and the OS lock probe,
which needs the real console session and is skipped here.

Retention: writes frames, back-dates their mtime, runs scheduler.cleanup_buffer.
"""

import base64
import json
import os
import sys

root = os.path.realpath(os.environ["PERSOME_ROOT"])
assert root.startswith("/private/tmp/persome-test/") or root.startswith("/tmp/persome-test/"), "temp root only"
home = os.path.realpath(os.path.expanduser("~/.persome"))
assert not root.startswith(home)

from persome import paths  # noqa: E402

paths.ensure_dirs()
assert os.path.realpath(str(paths.capture_buffer_dir())).startswith(root)

from persome.api.models import CaptureIngestBody  # noqa: E402
from persome.capture import scheduler, screenshot_crypto  # noqa: E402
from persome.config import CaptureConfig  # noqa: E402

job = json.load(sys.stdin)
key = screenshot_crypto.load_key()
out_cases = {}


def ingest(case):
    cfg = CaptureConfig(**case.get("config", {}))
    body = CaptureIngestBody.model_validate_json(case["body"])
    out = scheduler.build_ingest_capture(cfg, body.model_dump(), respect_screen_lock=False)
    r = {"built": out is not None}
    if out is None:
        return r, None
    ocr = out.pop("_ocr_pending_jpeg", None)
    out.pop("_ocr_tier", None)
    out.pop("_ocr_structured", None)
    r["ocr_pending_b64"] = base64.b64encode(ocr).decode("ascii") if ocr is not None else None
    stored = out
    raw = None
    if case.get("write"):
        path = scheduler._write_capture_and_invalidate_content_receipts(out)
        raw = path.read_bytes()
        r["file_mode"] = oct(path.stat().st_mode & 0o777)
        r["file_name"] = path.name
        stored = json.loads(raw)
    shot = stored.get("screenshot") or {}
    r["stored"] = {
        "keys": sorted(stored),
        "timestamp": stored.get("timestamp"),
        "capture_source": stored.get("capture_source"),
        "window_meta": stored.get("window_meta"),
        "trigger": stored.get("trigger"),
        "url": stored.get("url"),
        "ax_unavailable": stored.get("ax_unavailable", False),
        "secure_input_suppressed": stored.get("secure_input_suppressed", False),
        "visible_text": stored.get("visible_text"),
        "has_ax_tree": "ax_tree" in stored,
        "screenshot_enc": shot.get("screenshot_enc", False),
        "screenshot_prefix": (shot.get("image_base64") or "")[:10] or None,
    }
    if shot.get("screenshot_enc") and key is not None:
        r["decrypted_b64"] = screenshot_crypto.decrypt(shot["image_base64"], key).decode("ascii")
    text = raw if raw is not None else json.dumps(stored, ensure_ascii=False).encode("utf-8")
    r["contains"] = {n: (n.encode("utf-8") in text) for n in case.get("needles", [])}
    return r, stored


for name, case in job.get("cases", {}).items():
    out_cases[name], _ = ingest(case)

retention = None
if "retention" in job:
    import time

    spec = job["retention"]
    now = time.time()
    files = {}
    for name, case in spec["frames"].items():
        r, _ = ingest({**case, "write": True})
        p = paths.capture_buffer_dir() / r["file_name"]
        age = case["age_hours"] * 3600
        os.utime(p, (now - age, now - age))
        files[name] = p
    stats = scheduler.cleanup_buffer(
        spec["buffer_retention_hours"],
        None,
        screenshot_retention_hours=spec["screenshot_retention_hours"],
    )
    after = {}
    for name, p in files.items():
        if not p.exists():
            after[name] = {"exists": False}
            continue
        d = json.loads(p.read_bytes())
        after[name] = {
            "exists": True,
            "has_screenshot": "screenshot" in d,
            "screenshot_stripped": d.get("screenshot_stripped", False),
            "visible_text": d.get("visible_text"),
            "window_meta": d.get("window_meta"),
        }
    retention = {"stats": stats, "after": after}

print(json.dumps({"key_loaded": key is not None, "cases": out_cases, "retention": retention}))
