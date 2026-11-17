# 05: Claim & lease processing via REST

**What to build:** Multiple agents can pull work from the same tube over HTTP without ever getting the same item. An agent claims the next item, renews its lease with heartbeats, and completes, fails or releases it. If an agent dies, its lease expires and the item becomes claimable again.

Endpoints: `POST /api/items/claim`, `POST /api/items/{id}/complete|fail|release|heartbeat`, `GET /api/agents/{id}/items`.

**Blocked by:** 04 — Items + audit history via REST

**Status:** done

- [x] Claim (inside the write mutex) picks the highest-priority, oldest `pending`/`retry` item — or a `processing` item whose lease has expired — sets `processing`, `assignedAgent`, `leaseExpiresAt`, increments `attempts`
- [x] Claim response includes item id, agent id, lease expiry, claim timestamp, attempt count; empty queue returns a clear "nothing to claim"
- [x] Only the current lease owner can complete / fail / release / heartbeat (403 otherwise; 409 if lease expired)
- [x] Complete stores `result` and `completedAt`; fail stores error info; release returns item to `pending`
- [x] Heartbeat extends the lease; lease duration configurable
- [x] Every transition recorded in history with the agent as actor
- [x] Concurrency test: N parallel claimers on M items → every item claimed exactly once
