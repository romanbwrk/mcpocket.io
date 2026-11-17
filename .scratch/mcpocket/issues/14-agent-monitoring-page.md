# 14: Agent monitoring page

**What to build:** An admin sees every known agent: identifier, currently assigned items, processing/completed/failed counts, last heartbeat and availability (online / idle / stale based on heartbeat age).

**Blocked by:** 09 — Statistics & monitoring; 10 — Dashboard shell + folder explorer

**Status:** done

- [x] Agents page listed in the dashboard navigation
- [x] Availability thresholds configurable
- [x] Drill-down from an agent to its assigned items (links into the tube view / inspector)
- [x] Picks up live updates if 13 has landed (otherwise periodic refresh)
