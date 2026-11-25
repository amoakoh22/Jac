# Free 24/7 hosting options (no GitHub Actions)
Measured 2026-11-25 14:17 PT: a browserless fetch with the saved cookies returns HTTP 401. The saved storageState holds no auth cookie, so Chromium (Playwright) is required. A "lite monitor" is therefore NOT viable (tested).

The engine is `bash syndicate/run_daemon_supervisor.sh`. It needs Node 22, Python 3, Chromium and the gitignored `runtime/` files.

| Option | Cost | Notes (untested here) |
|---|---|---|
| Home PC / laptop / Raspberry Pi 4+ | free | Best choice. Ghana residential IP, so fewer bot blocks. Run the supervisor under systemd or Task Scheduler. |
| Oracle Cloud Always Free ARM VM | free, card for verification only | True 24/7. Datacenter IP may be challenged. Availability varies. |
| Android + Termux | free | Chromium is hard to run. Not recommended. |
| Cloudflare Workers / HF Spaces | free | No persistent Chromium. Not suitable. |

Fresh logins always need a human (captcha and OTP) on any host. Never commit `runtime/`.
Also: the repo is public, so GitHub Actions minutes are free once the billing lock is cleared (Settings > Billing, or GitHub Support).
