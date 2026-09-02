# SoundCloud reverse proxy

Serves SoundCloud through your own domain with the theme injected, so a phone
needs **nothing installed and nothing tapped**. Open the URL, that's it.

The reason this is worth the trouble: once the app is served from one origin,
every constraint the other mobile builds fight disappears — no CSP, no CORS, no
canvas tainting on artwork, no mixed-content block on the friends backend. It is
the most capable mobile build, not a degraded one.

## Before you start

Two facts worth knowing, both checked rather than assumed:

- `soundcloud.com` returns **HTTP 200 to a plain datacenter request** (it's
  CloudFront, no bot challenge). That was the make-or-break risk and it's clear.
- The app's own runtime config declares its hosts, so the list in the conf is
  taken from `"host":"api-v2.soundcloud.com"` and friends — not guessed.

## Deploy

**0. DNS — one wildcard record.** Every upstream gets its own subdomain, so in
Cloudflare (holdonquietly.com → DNS → Records) add:

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `*.sc` | `155.138.222.253` | **DNS only** (grey cloud) |

Grey cloud matters: Cloudflare's ToS restricts proxying audio through their CDN,
and their edge interferes with certbot's HTTP-01 challenge.

**1. One command.** From Windows, or anywhere with ssh:

```bash
ssh -p 2222 root@155.138.222.253 "bash <(curl -fsSL https://raw.githubusercontent.com/dwindles/holdonquietly-soundcloud/master/proxy/install.sh) sc.holdonquietly.com"
```

The installer fetches the configs and the theme from GitHub itself, substitutes
the hostname (including the regex-escaped form the `server_name` patterns need),
installs everything, expands the certificate across all 18 subdomains, reloads,
and then verifies the result.

That self-fetch is deliberate. Every deploy failure in this project came from the
hand-off rather than the config: files scp'd from Windows arrive with CRLF and
bash reads `set -euo pipefail
` as an invalid option; commands get pasted into
the wrong machine's shell; a previous run has already consumed a staged file.
Fetching over https removes all three.

## Smoke test

The installer runs it for you and prints four numbers:

```
app responds       : HTTP 200   (want 200)
theme injected     : 1          (want 1)
un-proxied hosts   : 0          (want 0)
infinite-load fix  : 1          (want 1)
```

`un-proxied hosts` is the one that matters most — anything above zero is a
SoundCloud host escaping the rewrite, and that is always the next thing to fix.

## When something breaks

Almost every failure is *a host that isn't proxied yet*. SoundCloud loads one we
don't rewrite, the browser reaches for it directly, and it dies on CORS. That is
how `api-auth`, `secure.sndcdn.com`, `wave` and `pushers` were each found.

To find the next one, fetch what the app actually loads and look for stragglers:

```bash
curl -s https://sc.holdonquietly.com/ | grep -oE '[a-z0-9-]+\.(soundcloud|sndcdn)\.com' | sort -u
```

Anything functional in that list needs three lines, in three files:

1. `hoq-rewrites.conf` — `sub_filter 'NAME.soundcloud.com' 'NAME.__PROXY_HOST__';`
2. `hoq-proxy.conf` — an entry in the `$hoq_upstream` map, and the name added to
   the `server_name` regex
3. `install.sh` — the name in `SUBS`, so the certificate covers it

Then re-run the installer. It checks all three stay in sync implicitly: a name
missing from `SUBS` gets no certificate and fails TLS immediately.

**Never add a bare `soundcloud.com` or `sndcdn.com` rewrite** — both are
substrings of every host above and would corrupt all of them.

## Known limits

- **OAuth sign-in cannot work.** "Continue with Google/Apple/Facebook" sends you
  to the provider with a `redirect_uri` registered to `soundcloud.com`, so it
  redirects back *there*, not here — you get a blank popup. Only SoundCloud can
  whitelist another host. **Use email and password.** If the account was created
  through Apple and has no password, set one on real soundcloud.com first.
- **It will break when SoundCloud ships changes.** A rewrite list is a snapshot
  of their infrastructure. The upside is that fixes are three lines.
- **Everything routes through the VPS**, so audio bandwidth is yours and
  SoundCloud sees one IP for all of it.
- **Rich Presence and account switching still can't work** — the first needs
  Discord's local IPC, the second swaps WebView2 profile directories.

## Status

**Live and working** at https://sc.holdonquietly.com — nothing installed on the
phone, nothing tapped.

Verified against the deployed proxy at 390px:

- page completes loading, theme applied, **18 tiles rendering**, no errors
- nav reads Discover / Stream / Collection / Social/Settings, one row, 18px gaps
- containers 390px (were 1240), right rail dropped, tiles 172px two-up
- no horizontal overflow; header scrolls away instead of eating half the screen
- 61 requests through the proxy; the only host left off it is `dwt` (tracking)
- all 18 upstream subdomains resolve with valid TLS
- `/`, `/discover`, `/search`, `/signin` all 200; `/feed` and `/you/library`
  return 401 only because the session is logged out
- the sign-in iframe renders, its scripts load from `secure-cdn`, and `/me`
  returns 200 with no "Something unexpected happened"

**Not verified: a completed sign-in.** That needs real credentials, so it has to
be done by hand. Everything the flow touches before the password is confirmed
working; if it still fails, the console will name a host and that is a
three-line fix (see "When something breaks").

**OAuth will never work** — "Continue with Google/Apple/Facebook" carries a
`redirect_uri` registered to soundcloud.com, so the provider sends you back
there rather than here. Use email and password.
