# 17: Webhooks via transactional outbox

**What to build:** An admin registers webhook URLs (optionally scoped to a folder/tube and event types). When items change, MCPocket delivers signed notifications reliably — events are never lost if the process crashes between the data change and delivery.

**Blocked by:** 05 — Claim & lease processing via REST

**Status:** done

- [x] Webhook subscriptions manageable via REST (and dashboard if 10 has landed)
- [x] Outbox entry written in the same mutex hold / persist as the item change
- [x] Background dispatcher delivers with retries and backoff; marks delivered / dead-lettered
- [x] Payloads HMAC-signed with a per-subscription secret
- [x] Delivery attempts inspectable
