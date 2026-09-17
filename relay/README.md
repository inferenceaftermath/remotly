# remotly-relay

A Cloudflare Worker that sends Remotly's push notifications on behalf of bridges that do not hold the app's push
credentials. The APNs authentication key is issued per Apple developer team, so handing it to every host would let
any of them push to every app of the team; the relay keeps that key and the Firebase service account in one place,
as Worker secrets, and every other bridge posts its notifications here.

It relays **only** the bridge → Apple/Google hop. Approve, Deny and Reply from a notification still go phone → bridge
over Tailscale and are verified there (prompt id, dialog signature), so a spoofed notice cannot approve anything.
The live terminal, pairing and input never touch the relay. A bridge with its own secrets in `~/.config/remotly`
(the owner's host) sends directly and never calls it.

There are no accounts: a caller needs a device token, which only the paired bridge, the phone, Apple/Google and this
relay ever see. With one, the worst case is nuisance notices on that phone (rate-limited to 60/min), plus — today —
a forged `done` or `status` notice that the Android app applies locally (it un-arms a pane or hides its progress
notification; see `docs/BACKLOG.md`). Every FCM message carries `restricted_package_name`, so a token from another app
in the same Firebase project is refused by Google.

Free plan: 100 000 requests/day, 10 ms CPU per request. A push costs about 1 ms (cached credentials) or 3–5 ms on a
cold isolate that has to sign both JWTs; WebCrypto and `fetch` only, no libraries. Apple's API is HTTP/2-only,
which production Workers negotiate; `wrangler dev` on macOS does not, so test against the deployed Worker.

## API

`POST /v1/push` — JSON body, one message. The relay pins everything that names the app (APNs topic, Firebase
project); the caller only supplies what the bridge's direct clients would.

```jsonc
// iOS
{ "platform": "ios", "token": "<64 hex>", "env": "production" | "sandbox", "collapse_id": "w1:p1",
  "push_type": "alert" | "liveactivity" /* default alert */, "priority": 10 | 5 /* default 10 */,
  "ttl_sec": 600 /* default 600, 60 for liveactivity, max 86400 */, "payload": { "aps": { … }, … } }
// Android
{ "platform": "android", "token": "<FCM registration token>", "collapse_key": "w1:p1", "ttl_sec": 600,
  "data": { "type": "approval", … } /* strings only */ }
```

Limits: body ≤ 16 KiB, payload/data ≤ 4096 bytes, collapse id ≤ 64 bytes. Responses:

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok":true}` | Apple/Google accepted it. |
| 200 | `{"ok":false,"status":410,"reason":"Unregistered","drop_token":true}` | Upstream refused; same mapping as the bridge's direct clients. `drop_token: true` → forget the registration. `status: 0` = no upstream answer: `reason` is the transport error, `response_body_error` (headers came, body did not) or `deadline_exceeded`. |
| 400 | `{"error":"bad_request","detail":"…"}` | Field named in `detail`. |
| 413 | `{"error":"body_too_large"}` | |
| 429 | `{"error":"rate_limited","scope":"ip"\|"token"}` | 600/min per source address, 60/min per device token (per Cloudflare location). |
| 503 | `{"error":"not_configured","platform":"ios"}` | That platform's secrets are not set on the Worker. |
| 503 | `{"error":"rate_limiter_unavailable"}` | A rate-limit binding is missing or failing; the relay fails closed rather than serve unlimited. |

Retries and time: the bridge makes exactly one request per push and waits up to 25 s. Inside that, the relay gives
everything one push does upstream a single 20 s budget (`RELAY_DEADLINE_MS`): an APNs request whose connection failed
is retried once if at least 1.5 s remain (like the bridge's direct client), an FCM send is never retried (like
`FcmClient`), the Google token exchange once. A failure after response headers arrived is `response_body_error` and is
not retried. When the budget has no room left, a skipped *retry* keeps the first attempt's transport reason and a skipped
*first* attempt is `deadline_exceeded`. So the bridge always sees the real outcome and never re-sends a push the relay
delivered.

`GET /health` → `{"ok":true,"version":"0.1.0","apns":true,"fcm":true}`; the bridge's `doctor` calls it. It sits behind
the per-address limiter like everything else.

Logs (Workers observability) carry platform, upstream status, reason and duration — never tokens or payload text.

## Deploy (app owner)

```sh
cd relay && npm ci
npx wrangler login                                   # once, opens the browser on the Cloudflare account that owns remotly.dev
npx wrangler secret put APNS_TEAM_ID                 # Apple developer team id
npx wrangler secret put APNS_KEY_ID                  # APNs auth key id
npx wrangler secret put APNS_P8 < ~/.config/remotly/secrets/AuthKey.p8
npx wrangler secret put FCM_SERVICE_ACCOUNT < ~/.config/remotly/secrets/fcm-service-account.json
npm run deploy                                       # binds relay.remotly.dev (the zone is on Cloudflare; DNS is created for you)
curl -sA 'remotly-bridge/manual' https://relay.remotly.dev/health   # {"ok":true,"version":"0.1.0","apns":true,"fcm":true}
                                                     # (the user agent matters once the WAF rule below is in place)
```

`APNS_BUNDLE_ID`, `FCM_PROJECT_ID` and `FCM_PACKAGE_NAME` are plain vars in `wrangler.jsonc` (they ship inside the
apps). Use a service account that holds only the **Firebase Cloud Messaging API Admin** role, not the default
owner-level `firebase-adminsdk` account. Rotating a credential is `wrangler secret put` again; the new version deploys
at once.

**The free plan's daily quota is a soft spot — decide knowingly.** Rate limits enforced *inside* the Worker (the
`ratelimits` bindings) still consume an invocation for every request, including the ones they refuse, and the free plan
stops serving after 100 000 invocations in a day (UTC). A determined party who floods `relay.remotly.dev` therefore
switches off everyone's notifications until midnight; nothing else is affected (the live terminal, pairing and
approvals never touch the relay) and no data is exposed. Two things raise the bar at the edge, before the Worker runs
and before anything is counted, both included in the free plan:

- **WAF custom rule** (Security → WAF → Custom rules): expression
  `(http.host eq "relay.remotly.dev" and not starts_with(http.user_agent, "remotly-bridge/"))`, action *Block*. Every
  bridge sends that user agent; scanners and stray bots do not. Trivial to spoof on purpose, decisive against noise.
- **Rate-limiting rule** (Security → WAF → Rate limiting rules; the free plan allows one, matching on URI path and
  verified-bot state only, counted per IP over a 10 s window, blocking for 10 s): expression
  `(http.request.uri.path eq "/v1/push")`, rate 30 requests per 10 s. A bridge sends a few pushes a minute and never
  meets it.

Neither caps the *total*: a per-address rule is bypassed by many addresses, and even one address pacing itself just
under 30/10 s can burn the daily budget in a few hours. If notifications must survive a deliberate flood, move the
Worker to the **Workers Paid** plan ($5/month, 10 million requests included, no daily cap). The bridge's `doctor`
reports the relay as unreachable when the quota is exhausted.

Verify from a bridge without secrets (a second instance on the same host works; the bridge lives in `../bridge`):

```sh
cd ../bridge
REMOTLY_CONFIG_DIR=~/.config/remotly-relaytest node src/main.ts doctor      # push relay … reachable (apns=yes fcm=yes)
REMOTLY_CONFIG_DIR=~/.config/remotly-relaytest node src/main.ts serve &      # or a second systemd unit, see README "Several instances"
REMOTLY_CONFIG_DIR=~/.config/remotly-relaytest node src/main.ts pair        # pair a phone, then:
REMOTLY_CONFIG_DIR=~/.config/remotly-relaytest node src/main.ts push-test <device_id>
```

## Development

```sh
npm test            # node --test: JWT signing (verified with node:crypto), routing, validation, limits, retries, both upstreams
npm run typecheck   # Worker sources against the generated runtime types, then sources + tests against @types/node
npx wrangler deploy --dry-run --outdir /tmp/relay-dist
```

`wrangler types` regenerates `worker-configuration.d.ts` from `wrangler.jsonc` and `.dev.vars` (copy
`.dev.vars.example`; the file is gitignored). Layout: `src/jwt.ts` (ES256/RS256 with WebCrypto), `src/upstream.ts`
(APNs and FCM senders with cached credentials, the bridge's status → result mapping), `src/relay.ts` (routing,
validation, rate limits), `src/index.ts` (entry; one relay per isolate).
