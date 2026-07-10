"""Launch an Apify actor run from a config file and archive the results.

Mechanical only: launches, polls, downloads, archives. No filtering.

Usage:
  python3 run_search.py config/search_c1.json --out ../scrapes/2026-07_tranche1/search_c1
  python3 run_search.py config/search_b.json --out ../scrapes/.../shakedown/mini_a \
      --companies-file shakedown_urls.txt --max-charge 2

Config JSON fields:
  actor            e.g. "harvestapi~linkedin-company-employees"
  input            full actor input (static part)
  companiesField   input key to inject company URLs into
                   ("companies" for employees actor, "currentCompanies" for profile-search);
                   omit for searches with no company scoping (search_a)
  companiesFromSheet  if true, read Tranche==1 rows' "LinkedIn URL" col from APM_Company_List.xlsx
  maxTotalChargeUsd   hard budget cap for the run (overridable with --max-charge)

Company URLs are injected from --companies-file (one URL per line) if given,
else from the sheet when companiesFromSheet is true.
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path

API = "https://api.apify.com/v2"
TOKEN = os.environ["APIFY_API_TOKEN"]
HERE = Path(__file__).resolve().parent


def api(path, method="GET", body=None, params=None):
    url = f"{API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    data = None
    if body is not None:
        req.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode()
    with urllib.request.urlopen(req, data) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--out", required=True, help="output dir for run_meta.json + dataset.json")
    ap.add_argument("--companies-file", help="txt file, one LinkedIn company URL per line")
    ap.add_argument("--max-charge", type=float, help="override maxTotalChargeUsd")
    ap.add_argument("--max-items", type=int, help="override input.maxItems")
    ap.add_argument("--dry-run", action="store_true", help="print final input, don't launch")
    ap.add_argument("--per-company", action="store_true",
                    help="loop companies one query each (Search B): 1 page first; "
                         "if the page is full (25), fetch pages 2-3 via startPage=2 and merge")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text())
    actor_input = dict(cfg["input"])

    if cfg.get("companiesField"):
        if args.companies_file:
            urls = [l.strip() for l in Path(args.companies_file).read_text().splitlines()
                    if l.strip() and not l.startswith("#")]
        else:
            sys.exit("config has companiesField but no --companies-file given "
                     "(the IB orchestrator run_ib.py injects companies directly)")
        if not urls:
            sys.exit("no company URLs resolved — aborting before spend")
        actor_input[cfg["companiesField"]] = urls
        print(f"injected {len(urls)} company URLs into {cfg['companiesField']}")

    if args.max_items:
        actor_input["maxItems"] = args.max_items
    if "maxItems" not in actor_input and actor_input.get("maxItemsPerCompany") and cfg.get("companiesField"):
        # employees actor exits silently with 0 items when maxItems is unset
        actor_input["maxItems"] = actor_input["maxItemsPerCompany"] * len(actor_input[cfg["companiesField"]])
        print("auto-set maxItems =", actor_input["maxItems"])
    if "maxItems" not in actor_input:
        sys.exit("refusing to launch without maxItems (actor may return 0 items or overspend)")
    charge_cap = args.max_charge or cfg["maxTotalChargeUsd"]

    if args.dry_run:
        print(json.dumps(actor_input, indent=2))
        print("maxTotalChargeUsd:", charge_cap)
        return

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    if args.per_company:
        per_company(cfg, actor_input, charge_cap, out, args)
        return

    if (out / "dataset.json").exists():
        sys.exit(f"{out}/dataset.json already exists — scrapes are immutable; use a new dir")
    run, items = run_actor(cfg["actor"], actor_input, charge_cap, marker=marker_file(out))
    write_result(out, cfg, args, run, items, actor_input, charge_cap)
    print(f"{run['status']}: {len(items)} items, ~${run.get('usageTotalUsd')} → {out}")
    if run["status"] != "SUCCEEDED":
        sys.exit(1)


def marker_file(out):
    return out / "run_launched.json"


def resume_if_launched(out):
    """Apify runs execute server-side and keep going (and keep the results)
    even if this local process dies mid-poll. If we already POSTed a run for
    this dir (marker exists) but never got to write dataset.json, reconnect
    to that same run_id instead of launching a duplicate (avoids double spend
    and recovers work already paid for)."""
    m = marker_file(out)
    if m.exists() and not (out / "dataset.json").exists():
        run_id = json.loads(m.read_text())["run_id"]
        print(f"  found in-flight marker — resuming run {run_id} instead of relaunching")
        return poll_and_fetch(run_id)
    return None


def poll_and_fetch(run_id):
    while True:
        run = api(f"/actor-runs/{run_id}")["data"]
        if run["status"] not in ("READY", "RUNNING"):
            break
        time.sleep(10)
    items = api(f"/actor-runs/{run_id}/dataset/items", params={"format": "json"})
    return run, items


def run_actor(actor, actor_input, charge_cap, marker=None):
    resumed = resume_if_launched(marker.parent) if marker else None
    if resumed:
        return resumed
    run = api(f"/acts/{actor}/runs", "POST", actor_input,
              params={"maxTotalChargeUsd": charge_cap})["data"]
    run_id = run["id"]
    if marker:
        marker.write_text(json.dumps({"run_id": run_id, "actor": actor}, indent=2))
    print(f"  run {run_id} started (cap ${charge_cap})")
    return poll_and_fetch(run_id)


def write_result(out, cfg, args, run, items, actor_input, charge_cap, extra=None):
    meta = {
        "run_id": run["id"] if isinstance(run, dict) else run,
        "actor": cfg["actor"],
        "config_file": str(args.config),
        "started_at": run.get("startedAt"),
        "finished_at": run.get("finishedAt"),
        "status": run["status"],
        "cost_usd": run.get("usageTotalUsd"),
        "item_count": len(items),
        "max_total_charge_usd": charge_cap,
        "input_snapshot": actor_input,
    }
    if extra:
        meta.update(extra)
    (out / "run_meta.json").write_text(json.dumps(meta, indent=2))
    (out / "dataset.json").write_text(json.dumps(items, indent=2))


def per_company(cfg, base_input, charge_cap, out, args):
    """Search-B mode: one query per company. 1 page first; if full (25 items),
    fetch pages 2-3 (startPage=2) and merge. Max 3 pages per company total.
    A zero on page 1 is a true zero — preserves the 'none found' inference."""
    field = cfg["companiesField"]
    urls = base_input.pop(field)
    counts = {}
    for url in urls:
        slug = url.rstrip("/").split("/")[-1]
        cdir = out / slug
        if (cdir / "dataset.json").exists():
            print(f"[{slug}] already scraped — skipping (immutable)")
            counts[slug] = len(json.loads((cdir / "dataset.json").read_text()))
            continue
        cdir.mkdir(parents=True, exist_ok=True)
        inp = dict(base_input, **{field: [url], "takePages": 1, "maxItems": 25})
        print(f"[{slug}] page 1…")
        run, items = run_actor(cfg["actor"], inp, charge_cap, marker=cdir / "run_launched_p1.json")
        runs = [run["id"]]
        cost = run.get("usageTotalUsd") or 0
        if run["status"] == "SUCCEEDED" and len(items) >= 25:
            inp2 = dict(inp, startPage=2, takePages=2, maxItems=50)
            print(f"[{slug}] full page → fetching pages 2-3…")
            run2, more = run_actor(cfg["actor"], inp2, charge_cap, marker=cdir / "run_launched_p23.json")
            runs.append(run2["id"])
            cost += run2.get("usageTotalUsd") or 0
            seen = {i.get("id") or i.get("linkedinUrl") for i in items}
            items += [i for i in more if (i.get("id") or i.get("linkedinUrl")) not in seen]
        write_result(cdir, cfg, args, run, items, inp, charge_cap,
                     extra={"all_run_ids": runs, "cost_usd": cost, "company_url": url})
        counts[slug] = len(items)
        print(f"[{slug}] {run['status']}: {len(items)} items, ~${round(cost,3)}")

    print("\n=== per-company alumni counts (zeros are true zeros) ===")
    for slug, n in sorted(counts.items(), key=lambda x: -x[1]):
        print(f"  {n:3d}  {slug}")
    (out / "counts.json").write_text(json.dumps(counts, indent=2))


if __name__ == "__main__":
    main()
