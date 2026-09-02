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
bash reads `set -euo pipefail` as an invalid option; commands get pasted into
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

Almost every failure is *a host that isn't proxied yet*. SoundCloud adds one,
the browser tries to reach it directly, and it fails.

Find it in the browser console / network tab — look for a request to anything
`*.soundcloud.com` or `*.sndcdn.com` that isn't on your domain. Then add a block
for it in `hoq-proxy.conf`, following the pattern:

```nginx
location ^~ /__u/NAME/ {
    proxy_pass https://REAL-HOST/;
    proxy_set_header Host REAL-HOST;
}
```

and a matching `sub_filter` pair (plain and `\/`-escaped) in the `location /`
block. Then `nginx -t && systemctl reload nginx`.

## Known limits — read before you rely on it

- **Login is the fragile part.** Cookie domains are rewritten
  (`proxy_cookie_domain`), which is what makes a session stick, but OAuth
  ("continue with Google/Apple") redirects to hosts that will bounce you back to
  the real soundcloud.com. Sign in with **email and password** if you hit that.
- **Playback may need another host added.** HLS manifests are rewritten, but
  SoundCloud hands out media hosts at play time and not all of them are in the
  conf yet. If audio is silent, that is the first thing to check.
- **It will break when SoundCloud ships changes.** This is the real cost of the
  approach: a rewrite list is a snapshot of their infrastructure. The upside is
  that fixes are usually one `location` block.
- **Everything routes through your VPS**, so audio bandwidth is yours, and
  SoundCloud sees one IP for all of it.
- **Rich Presence and account switching still can't work** — the first needs
  Discord's local IPC, the second swaps WebView2 profile directories.

## Not yet deployed

The config and the script are written and the script is syntax-checked, but
**this has not been run against a live nginx**. The smoke test above exists
because the first deploy is where the rewrite list gets corrected.
