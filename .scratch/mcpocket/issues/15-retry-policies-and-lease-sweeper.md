# 15: Retry policies & lease sweeper

**What to build:** Failed items are automatically retried according to policy, and items held by dead agents are recovered without anyone having to claim them first — both visible in history.

**Blocked by:** 05 — Claim & lease processing via REST

**Status:** done

- [x] Per-tube retry policy (max attempts, backoff) with sensible global defaults
- [x] `fail` with attempts remaining → `retry` with a not-before time honoured by claim; attempts exhausted → stays `failed`
- [x] Periodic in-process sweeper returns expired-lease items to `retry`/`pending` and writes a history event (actor: system)
- [x] Sweeper is a singleton per process and safe alongside concurrent claims (runs under the write mutex)
- [x] Tests with a controllable clock
