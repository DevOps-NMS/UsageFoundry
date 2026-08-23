# Option D: web push with a service worker

The option that sounds like the answer to "reach an operator who is not looking at
the page", and the one whose cost is most consistently underestimated. It is
**refused**, on four independent grounds, and the condition that would flip it is
stated at the end.

## The premise, corrected

The brief said "there is no service worker and no web manifest in the tree" and
asked for that to be verified rather than trusted. Half of it is wrong.

**A manifest exists and is real.** `src/app/manifest.ts` is a Next metadata route
producing `display: "standalone"`,
`display_override: ["window-controls-overlay","standalone"]`,
`theme_color`/`background_color` `#f0f0f3`, and four icons including
`/icon-maskable-512.png` at `purpose: "maskable"`. `public/` holds five rasterised
icons and no manifest file, which is correct — the route generates it, and
`python3 scripts/make-icons.py` re-rasterises the source SVG. `layout.tsx:27-85`
carries `appleWebApp: {capable, title, statusBarStyle}`, the
`apple-mobile-web-app-capable` meta, `viewportFit: "cover"` and a dual
`themeColor`. **This app is deliberately installable and somebody did the work.**

**No service worker exists.** `grep -rn "serviceWorker\|navigator\.serviceWorker" src/`
exits 1. `find src public -name 'sw*.js' -o -name 'sw*.ts'` returns nothing.
`grep -rn "PushManager\|showNotification\|Notification(" src/` returns nothing.

So the delta is not "become a PWA". It is a service worker, a subscription store,
a VAPID key pair, RFC 8291 payload encryption, and a permission prompt. Which is
where it falls apart.

## Ground 1: the destination is chosen by the browser vendor, not by the operator

This is the strongest objection and it is the one the brief's security constraint
is pointed at.

A push subscription's `endpoint` is a URL on the browser vendor's push service:
`fcm.googleapis.com` for Chromium, `updates.push.services.mozilla.com` for
Firefox, `web.push.apple.com` for Safari. The app does not choose it and cannot.
Compare Option C, where the operator names the host.

RFC 8291 encrypts the payload end-to-end, so **content** is protected from the
push service — which is genuinely good, and better than an email or a chat
message. But **metadata is not**: the push service learns that a particular
subscription received a message of a particular size at a particular time. For
this app that metadata is a work log. A message every time a run ends is a
timestamped record of when this install's agents finish, at what rate, at what
hour, held by a third party the operator did not choose and has no contract with.

`src/lib/status.ts:25-27` refuses a folder path on an authenticated endpoint
because it "is a leak of what this install works on into whatever scrapes it".
The same reasoning applied to a timing channel is not obviously weaker.

## Ground 2: reaching a device that is not the host means exposing the app

A service worker needs a secure context. `localhost` counts, so on the host
itself this works — and on the host itself the operator can just open the tab,
which is Option B.

The entire value of push is reaching a *phone*. That requires the app to be
reachable from the phone over HTTPS, which means it is exposed beyond
`docker-compose.yml:62`'s `${UF_BIND_ADDRESS:-127.0.0.1}` bind. The variable
exists, so this is supported rather than forbidden, and `UF_COOKIE_SECURE`
(`config.ts:305`) shows the app anticipates running behind TLS. But the security
delta is not the notification: it is that a shared-secret-gated app that spawns
billed processes with write access to every mount becomes internet-reachable, and
`docs/agent/security.md:24` records that `/api/login` is "the one unauthenticated
write surface here" and that until recently "nothing else bounded it: no counter,
no lockout, no record, and a 400 ms `await` on a timer that delays one request and
serialises nothing, so two hundred concurrent connections guess at the rate of the
event loop".

**The notification is the small half of this change.** An option that requires
exposing the app to deliver its value is proposing the exposure, and it must be
scored on that. It is not scored on it below because it does not survive Ground 3
either.

## Ground 3: the crypto is hand-written and its failure is silent

C4 says a dependency is a standing decision to be argued. The honest reading here
is worse: **web push does not need a dependency, and that is the problem.**

`node:crypto`'s `webcrypto` can do all of it — ECDSA P-256 for the VAPID JWT,
ECDH plus HKDF plus AES-128-GCM for RFC 8291 payload encryption. So the four
runtime dependencies stay four, and the cost lands as **hand-written cryptographic
code** instead: key generation, JWT construction with the right `aud` per endpoint
origin, the ECDH shared secret, two HKDF derivations with the exact info strings
the RFC specifies, the padding scheme, the record framing.

Every bug in that path fails the same way: the push service returns 201 and the
notification never appears. There is no error, no exception, nothing in the log.
`CLAUDE.md`'s bar — "A pure function whose failure mode is silent gets a unit
test" — makes this the most test-hungry code anyone would add to this repository,
and `docs/agent/testing.md` "names every existing one and the grounds each earned,
and that is the bar". The grounds are easy to state and the tests are RFC 8291
vectors, which is real work.

Assumed 300-500 lines of crypto plus a test suite over published vectors. That
estimate is not measured against anything in this repository, because nothing in
this repository resembles it.

## Ground 4: nothing about it can be verified here

C9: no browser has ever been driven at this app, at any viewport, and the one that
tried "refused to resize below the host window and reported `innerWidth: 2560` at
a 1519px window" (`docs/agent/ui-density-audit.md:2624-2628`).

A push notification is **entirely** a rendering on a device. Its title, its body
truncation, whether it groups, whether iOS shows it at all, whether the permission
prompt appears at a moment the operator will accept — none of that is inspectable
from source, and all of it decides whether the feature works. Option B's
components can at least be reasoned about against the kit's conventions; this
cannot be reasoned about at all.

And one specific unverifiable: iOS delivers web push only to a PWA added to the
home screen. `manifest.ts`'s docblock records that the manifest route "is inside
`middleware.ts`'s matcher, so an unauthenticated fetch redirects to `/login`" and
"Signing in first is what makes the app installable. The exemption list is
deliberately not widened for this." So the install path exists and runs through a
login — **assumed** to work on iOS, since no device has been used.

## Two more costs, briefly

**Subscriptions expire silently.** A push subscription is invalidated by browser
data clearing, by long inactivity, and by vendor policy. The app learns only from
a 404 or 410 on the next send. So this option needs the same
consecutive-failure counter Option C needs, plus a re-subscribe path in the
client, plus a place to store per-device subscription rows — a schema change of
three columns rather than one table (C11).

**It is per-device, so it is per-browser-profile.** One operator on a laptop and a
phone is two subscriptions, two permission prompts, two expiry paths.

## Its genuine strength, which nothing else here has

**It is the only option that reaches a person who is not at a computer, without a
third-party account, without a recurring bill, and with the payload
cryptographically closed to the intermediary.** For the two interrupt-shaped rows
in C1 — the 429 ladder holding three resources for ~26 minutes, and a dead login
compounding across every admitted run — that is exactly the right shape, and no
other option in this survey is.

That strength is why this is a refusal with a condition rather than a refusal.

## What would flip it

**One measurement and one decision, in that order.** The measurement: the ending
mix and the park rate on a real install over a fortnight, which C10 says is
unobtainable here — `/data` is `Permission denied`, and the stale database has zero
`runs` rows. If a real install parks or reaches `needs-review` more than a couple
of times a week outside working hours, the interrupt is earned and the crypto is
worth writing. If it happens twice a month, Option C into a receiver the operator
already runs delivers the same outcome for a tenth of the code.

The decision: whether this app is exposed beyond `127.0.0.1`. If the answer is
already yes for other reasons, Ground 2 disappears and this option's score rises
sharply. If it is no, Ground 2 alone is fatal and the rest is academic.
