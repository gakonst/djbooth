---
"@gakonst/spots": patch
"@gakonst/soundcloud": patch
---

Coordinate rate-limit cooldowns across concurrent requests made by one client, honor the longest
provider reset signal, serialize or stagger waiting callers, and allow queued waits to be cancelled
without dispatching another API request. Keep isolated network and transient-server backoff local to
the request that observed it.
