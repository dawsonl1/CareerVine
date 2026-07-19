#!/usr/bin/env node
/**
 * Wait for the Vercel production deployment of a commit to be live (CAR-168).
 *
 * Usage:
 *   node scripts/wait-for-deploy.mjs [--sha <commit>] [--timeout <seconds>]
 *
 *   --sha      Full commit SHA to wait for. Defaults to `git rev-parse origin/main`
 *              (the commit a just-merged PR landed as). Short SHAs are accepted
 *              and matched by prefix.
 *   --timeout  Give up after this many seconds (default 900).
 *
 * Exit codes: 0 = READY and alias assigned (live on the domain);
 *             1 = build ERROR or CANCELED; 2 = timeout; 3 = usage/env error.
 *
 * Why this exists: `vercel ls` writes its human status table (the `● Ready`
 * column) to STDERR and bare URLs to stdout, its format shifts between CLI
 * versions, and it cannot answer "is COMMIT X live" at all — so every ad-hoc
 * grep-the-CLI watcher ever written against it either hung or lied. This
 * script polls the REST API instead: it finds the deployment whose
 * meta.githubCommitSha matches, reports state transitions, and only exits 0
 * once the deployment is READY *and* aliasAssigned, which is the "actually
 * serving on careervine.app" signal (READY alone can precede promotion).
 *
 * Auth: $VERCEL_TOKEN (in every shell via ~/.config/claude/secrets.zsh).
 */

import { execSync } from "node:child_process";

const TEAM_ID = "team_hbjDvLthHya2Gd7W6y3Cyao2";
const PROJECT_ID = "prj_olcHrQsp17HZPNj5NYYbXsNKzvlN";
const POLL_MS = 15_000;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const token = process.env.VERCEL_TOKEN;
if (!token) {
  console.error("wait-for-deploy: VERCEL_TOKEN is not set");
  process.exit(3);
}

let sha = arg("sha", "");
if (!sha) {
  try {
    sha = execSync("git rev-parse origin/main", { encoding: "utf8" }).trim();
  } catch {
    console.error("wait-for-deploy: no --sha given and `git rev-parse origin/main` failed");
    process.exit(3);
  }
}
const timeoutMs = Number(arg("timeout", "900")) * 1000;

async function fetchDeployments() {
  const url =
    `https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}` +
    `&teamId=${TEAM_ID}&target=production&limit=20`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Vercel API ${res.status}: ${await res.text()}`);
  return (await res.json()).deployments ?? [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`wait-for-deploy: waiting for production deployment of ${sha}`);
const deadline = Date.now() + timeoutMs;
let lastReported = "";

while (Date.now() < deadline) {
  let deployments;
  try {
    deployments = await fetchDeployments();
  } catch (err) {
    // Transient API failures must not kill the watch.
    console.error(`wait-for-deploy: poll failed (${err.message}), retrying`);
    await sleep(POLL_MS);
    continue;
  }

  const dep = deployments.find((d) => (d.meta?.githubCommitSha ?? "").startsWith(sha));
  const status = dep
    ? `${dep.state}${dep.aliasAssigned ? "+aliased" : ""}`
    : "no deployment for this commit yet";
  if (status !== lastReported) {
    console.log(`wait-for-deploy: ${status}${dep ? ` (https://${dep.url})` : ""}`);
    lastReported = status;
  }

  if (dep) {
    if (dep.state === "READY" && dep.aliasAssigned) {
      console.log("wait-for-deploy: LIVE");
      process.exit(0);
    }
    if (dep.state === "ERROR" || dep.state === "CANCELED") {
      console.error(`wait-for-deploy: deployment ${dep.state} — check: vercel inspect ${dep.url} --logs`);
      process.exit(1);
    }
  }

  await sleep(POLL_MS);
}

console.error(`wait-for-deploy: timed out after ${timeoutMs / 1000}s`);
process.exit(2);
