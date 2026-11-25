"""
Jac Syndicate - 24/7 Liveness & Cloud Failure Status Tracker
Writes root status.json and docs/status.json so the KPI terminal (and GitHub Pages)
can prominently alert if cloud cron fails 3+ times in a row or sync is >45 min stale.
"""
import argparse
import datetime
import json
import os
import shutil

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATUS_PATH = os.path.join(BASE_DIR, "status.json")
DOCS_STATUS_PATH = os.path.join(BASE_DIR, "docs", "status.json")


def load_status():
    if os.path.exists(STATUS_PATH):
        try:
            with open(STATUS_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "last_synced_utc": None,
        "source": "unknown",
        "consecutive_cloud_failures": 0,
        "last_cloud_run_utc": None,
        "last_cloud_status": "unknown",
        "last_cloud_error": "",
        "alert_active": False,
        "alert_message": "",
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source", default="local_daemon", choices=["local_daemon", "github_actions", "manual"])
    p.add_argument("--cloud-result", default="unchanged", choices=["ok", "failed", "billing_locked", "unchanged"])
    p.add_argument("--error", default="")
    p.add_argument("--failures", type=int, default=None, help="Explicitly override consecutive_cloud_failures")
    args = p.parse_args()

    now_utc = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    st = load_status()
    st["last_synced_utc"] = now_utc
    st["source"] = args.source

    if args.cloud_result == "ok":
        st["consecutive_cloud_failures"] = 0
        st["last_cloud_run_utc"] = now_utc
        st["last_cloud_status"] = "ok"
        st["last_cloud_error"] = ""
    elif args.cloud_result in ("failed", "billing_locked"):
        st["consecutive_cloud_failures"] = int(st.get("consecutive_cloud_failures") or 0) + 1
        st["last_cloud_run_utc"] = now_utc
        st["last_cloud_status"] = args.cloud_result
        st["last_cloud_error"] = (args.error or "").strip()

    if args.failures is not None:
        st["consecutive_cloud_failures"] = max(0, args.failures)

    fails = int(st.get("consecutive_cloud_failures") or 0)
    if fails >= 3:
        st["alert_active"] = True
        err_suffix = f" — {st['last_cloud_error']}" if st.get("last_cloud_error") else ""
        st["alert_message"] = f"CLOUD CRON ALERT: {fails} consecutive GitHub Actions failures ({st.get('last_cloud_status', 'failed')}){err_suffix}"
    else:
        st["alert_active"] = False
        st["alert_message"] = ""

    with open(STATUS_PATH, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=2)
    os.makedirs(os.path.dirname(DOCS_STATUS_PATH), exist_ok=True)
    shutil.copy2(STATUS_PATH, DOCS_STATUS_PATH)
    print(f"[Status] Updated {STATUS_PATH} & {DOCS_STATUS_PATH} | last_synced_utc={now_utc} | cloud_failures={fails} | alert={st['alert_active']}")


if __name__ == "__main__":
    main()
