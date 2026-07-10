"""IB pipeline orchestrator: drives the per-bank and per-office Apify runs.

Mechanical only -- launches, polls, archives. No relevance judgments (those
happen in the agent review gates between phases). Reuses the proven engine in
run_search.py (actor launch/poll/archive + resume-safe run markers).

Phases (run in order; agent review happens between scrape phases):

  alumni-breadth   Stage 2a. One profile-search run per bank: schools filter +
                   that bank's company URL, NO job-title filter (catch IB alumni
                   at every level). Full mode, no email.
                     -> scrapes/alumni/<bank_id>/

  office-pull      Stage 3. One company-employees run per (office x band): the
                   bank's company URL + the office's location + the band's job
                   titles, capped at the band target (6/3/1/1). Full mode, no email.
                     -> scrapes/office/<office_id>/<band>/

  office-backfill  Stage 5. After the office review gate, re-pull offices/bands
                   still short of their CONFIRMED non-alum target, with a grown
                   window, deduped against everyone already seen. Reads a shortfall
                   file produced by the audit step.
                     -> scrapes/office/<office_id>/<band>/backfill_<n>/

  email-enrich     Stage 2c. One by-URL run over all confirmed keeper URLs
                   (IB alumni + confirmed office contacts) to fetch emails.
                     -> scrapes/email/

Every run writes a run_launched.json marker before polling, so an interrupted
process reconnects to the in-flight run instead of double-spending.

Usage:
  python3 run_ib.py alumni-breadth [--only-bank goldman-sachs] [--dry-run]
  python3 run_ib.py office-pull    [--only-bank ...] [--only-band analyst] [--dry-run]
  python3 run_ib.py office-backfill --shortfall ../reviews/<...>/shortfall.json
  python3 run_ib.py email-enrich   --urls ../reviews/<...>/confirmed_urls.txt
"""
import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import run_search as engine  # reuse api/run_actor/write_result/markers

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                      # pipelines/ib-pipeline/
DATA = ROOT / "data"
CONFIG = ROOT / "config"
SCRAPES = ROOT / "scrapes"

BANK_BANDS = ["analyst", "associate", "vp", "director"]


def load(name):
    return json.loads((DATA / name).read_text())


def cfg(name):
    return json.loads((CONFIG / name).read_text())


def _run_one(actor, actor_input, charge_cap, out, config_path, extra=None):
    """Launch one run into `out`, resume-safe. Skips if already archived."""
    if (out / "dataset.json").exists():
        n = len(json.loads((out / "dataset.json").read_text()))
        print(f"  [skip] {out.name} already scraped ({n} items)")
        return n
    out.mkdir(parents=True, exist_ok=True)
    run, items = engine.run_actor(actor, actor_input, charge_cap,
                                  marker=engine.marker_file(out))
    args = SimpleNamespace(config=str(config_path))
    meta_cfg = {"actor": actor}
    engine.write_result(out, meta_cfg, args, run, items, actor_input, charge_cap, extra=extra)
    cost = run.get("usageTotalUsd")
    print(f"  {run['status']}: {len(items)} items ~${cost} -> {out.name}")
    return len(items)


def alumni_breadth(args):
    banks = load("banks.json")
    c = cfg("ib_alumni_breadth.json")
    actor, field, cap = c["actor"], c["companiesField"], c["maxTotalChargeUsd"]
    for b in banks:
        if args.only_bank and b["bank_id"] != args.only_bank:
            continue
        inp = dict(c["input"])
        inp[field] = [b["linkedin_url"]]
        out = SCRAPES / "alumni" / b["bank_id"]
        print(f"[alumni] {b['bank']} ({b['linkedin_url']})")
        if args.dry_run:
            print("   dry-run input:", json.dumps(inp)); continue
        _run_one(actor, inp, cap, out, CONFIG / "ib_alumni_breadth.json",
                 extra={"bank_id": b["bank_id"]})


def office_pull(args):
    offices = load("offices.json")
    bank_url = {b["bank_id"]: b["linkedin_url"] for b in load("banks.json")}
    band_cfgs = {band: cfg(f"ib_{band}.json") for band in BANK_BANDS}
    for o in offices:
        if args.only_bank and o["bank_id"] != args.only_bank:
            continue
        url = bank_url[o["bank_id"]]
        for band in BANK_BANDS:
            if args.only_band and band != args.only_band:
                continue
            c = band_cfgs[band]
            inp = dict(c["input"])
            inp[c["companiesField"]] = [url]
            inp["locations"] = [o["linkedin_location"]]
            inp["maxItems"] = c["input"]["maxItemsPerCompany"]  # one office per run
            out = SCRAPES / "office" / o["office_id"] / band
            print(f"[office] {o['bank']} {o['city']} / {band} (target {c['targetPerOffice']})")
            if args.dry_run:
                print("   dry-run input:", json.dumps(inp)); continue
            _run_one(c["actor"], inp, c["maxTotalChargeUsd"], out,
                     CONFIG / f"ib_{band}.json",
                     extra={"office_id": o["office_id"], "band": band,
                            "target": c["targetPerOffice"]})


def office_backfill(args):
    """Re-pull office/bands short of their confirmed target, grown window,
    deduped against everyone already scraped for that office/band."""
    shortfalls = json.loads(Path(args.shortfall).read_text())  # [{office_id, band, need, seen_urls}]
    offices = {o["office_id"]: o for o in load("offices.json")}
    bank_url = {b["bank_id"]: b["linkedin_url"] for b in load("banks.json")}
    for s in shortfalls:
        o = offices[s["office_id"]]
        c = cfg(f"ib_{s['band']}.json")
        seen = set(s.get("seen_urls", []))
        grown = min(25, len(seen) + s["need"] * 2)  # cap at one LinkedIn page
        inp = dict(c["input"])
        inp[c["companiesField"]] = [bank_url[o["bank_id"]]]
        inp["locations"] = [o["linkedin_location"]]
        inp["maxItemsPerCompany"] = grown
        inp["maxItems"] = grown
        rounds = len(list((SCRAPES / "office" / s["office_id"] / s["band"]).glob("backfill_*")))
        out = SCRAPES / "office" / s["office_id"] / s["band"] / f"backfill_{rounds+1}"
        print(f"[backfill] {o['bank']} {o['city']} / {s['band']} need {s['need']}, window {grown}")
        if args.dry_run:
            print("   dry-run input:", json.dumps(inp)); continue
        n = _run_one(c["actor"], inp, c["maxTotalChargeUsd"], out, CONFIG / f"ib_{s['band']}.json",
                     extra={"office_id": s["office_id"], "band": s["band"], "backfill_round": rounds + 1})
        # a run that surfaces no NEW urls means the office is dry for this band
        if n is not None and out.exists() and (out / "dataset.json").exists():
            got = {i.get("linkedinUrl") for i in json.loads((out / "dataset.json").read_text())}
            fresh = [u for u in got if u and u not in seen]
            print(f"   {len(fresh)} new (office {'DRY' if not fresh else 'has more'})")


def email_enrich(args):
    c = cfg("ib_alumni_email.json")
    urls = [l.strip() for l in Path(args.urls).read_text().splitlines()
            if l.strip() and not l.startswith("#")]
    if not urls:
        sys.exit("no confirmed URLs to enrich -- aborting before spend")
    inp = dict(c["input"])
    inp[c["urlsField"]] = urls
    out = SCRAPES / "email"
    print(f"[email] enriching {len(urls)} confirmed profiles")
    if args.dry_run:
        print("   dry-run input:", json.dumps(inp)[:400], "..."); return
    _run_one(c["actor"], inp, c["maxTotalChargeUsd"], out, CONFIG / "ib_alumni_email.json")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="phase", required=True)

    p = sub.add_parser("alumni-breadth"); p.add_argument("--only-bank"); p.add_argument("--dry-run", action="store_true"); p.set_defaults(fn=alumni_breadth)
    p = sub.add_parser("office-pull"); p.add_argument("--only-bank"); p.add_argument("--only-band"); p.add_argument("--dry-run", action="store_true"); p.set_defaults(fn=office_pull)
    p = sub.add_parser("office-backfill"); p.add_argument("--shortfall", required=True); p.add_argument("--dry-run", action="store_true"); p.set_defaults(fn=office_backfill)
    p = sub.add_parser("email-enrich"); p.add_argument("--urls", required=True); p.add_argument("--dry-run", action="store_true"); p.set_defaults(fn=email_enrich)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
