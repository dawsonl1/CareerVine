# CAR-212 — The drift-check test hands out a port it has already released

Reported from the CAR-206 deep review as "observed once in ~13 full-suite runs,
not reproducible on demand". Dawson asked for it closed properly, so the
reproduction came first and the fix second.

## Reproduced, then quantified

`freePort()` binds an ephemeral port, reads the number, **closes the listener**,
and returns the number. Three cases pass that number to the script, which probes
it from a freshly spawned bash some milliseconds later
(`scripts/supabase-prod-drift-check.sh:53`) and exits 1 without invoking the stub
if anything accepts.

Measured on this machine:

| Question | Result |
| --- | --- |
| Is the released port immediately re-bindable by another socket? | **200/200** |
| Does it fall inside the OS ephemeral pool? | **200/200** (darwin 49152-65535) |
| Blunt port pressure reclaiming that exact port | **0/150** |
| Allocations before the OS reissues that exact number | **16,375** (~460ms) |

The third row is why this looked unreproducible, and the fourth is the actual
mechanism. Ephemeral allocation marches **sequentially**, so the number only
comes back when the allocator wraps the whole range — 16,384 ports on darwin,
and 16,375 was the measured wrap. A full suite run makes tens of thousands of
ephemeral allocations across 276 files plus a local Supabase stack, so it wraps
several times; each wrap is a chance to hand one of these three numbers to
another process that then holds it. Three vulnerable draws per run, each live for
the duration of a `spawnSync`, is entirely consistent with ~1 run in 13.

Forcing the collision (re-binding the port right after `freePort()` releases it,
which is exactly what the reissue recipient does) turns all three red, and the
middle one fails with the byte-for-byte symptom seen during the CAR-206 review:

```
× exits 0 on a clean diff when the shadow port is free
× does not retry a mid-run shadow-provisioning failure and names the real cause
× keeps the 3-attempt retry and generic fail-closed message for other failures

AssertionError: expected 'Error: shadow database port 58667 is …'
                to contain 'failed to provision its shadow databa…'
```

## Fix

Draw from **below** both platforms' ephemeral floors (Linux 32768, darwin 49152)
so ambient allocation structurally cannot produce the number, then verify the
candidate with the same question the script asks — does anything *accept* a
connection here — rather than assuming. The scan starts at an offset derived from
the pid, so two concurrent suite runs on one machine do not converge on the same
candidate.

Proven directly: 60,000 ephemeral allocations on this machine produced ports in
49152-65535 and **zero** inside the new 20000-32000 window.

This removes accidental collision, which is the failure mode. It does not make
the port unseizable by a process that deliberately binds that range — nothing
can — so the third piece is diagnosability.

## Diagnosability

`assertPreCheckPassed` runs before the assertions in all three cases. If the
script ever does short-circuit on the pre-check, the failure now names the cause
instead of surfacing as `expected 1 to be +0` or a `toContain` about a branch
that never ran. That opacity is why the original flake cost a review to diagnose
rather than a glance.

## Guard

One test pins the property that actually matters: the allocator's window sits
entirely below the platform's ephemeral pool, read live from
`/proc/sys/net/ipv4/ip_local_port_range` or `sysctl`. Reverting `freePort()` to
the `listen(0)`-then-close idiom turns it red. That idiom is common and
reasonable-looking, which is precisely why the property needs pinning rather than
a comment.

## Falsification

* Revert `freePort()` to `listen(0)` → guard goes red. ✓
* Squat the port the fixed allocator returns → all three cases fail with the
  explicit precondition message rather than a confusing assertion. ✓

## Verify

`npm run test` from `careervine/`, plus repeated runs of the affected file;
typecheck, lint, `check:conventions`, `check:ui-events`, build.

No product code changes. `scripts/supabase-prod-drift-check.sh` is untouched.
