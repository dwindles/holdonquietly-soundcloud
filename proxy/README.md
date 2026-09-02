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

**1. Check nginx has the sub_filter module** — the whole design needs it:

```bash
nginx -V 2>&1 | grep -o with-http_sub_module
```

**2. Copy everything up** (from the Windows box, in the repo root):

```bash
scp -P 2222 proxy/hoq-proxy.conf proxy/hoq-rewrites.conf proxy/install.sh dist/holdonquietly.proxy.js root@155.138.222.253:/tmp/
```

**3. Run the installer on the VPS.** It substitutes the hostname (including the
regex-escaped form the `server_name` patterns need), installs both configs,
expands the certificate to cover all 15 subdomains, then tests and reloads:

```bash
bash /tmp/install.sh sc.holdonquietly.com
```

That replaces the old hand-typed one-liners, which were the single biggest
source of mistakes — in particular `__PROXY_HOST_RE__` has to be substituted
before `__PROXY_HOST__`, or the second pass eats the prefix of the first.

## Smoke test

```bash
curl -s https://sc.holdonquietly.com/ | grep -c 'hoq.js'
curl -s https://sc.holdonquietly.com/ | grep -oE '(api-v2|a-v2|i1)\.[a-z.]*(soundcloud|sndcdn)\.com' | wc -l
curl -sI https://api-v2.sc.holdonquietly.com/ | head -1
```

Want `1`, then **`0`** (every host rewritten), then a response from the API
subdomain rather than a TLS error.

Then open it on the phone. The nav should read
**Discover / Stream / Collection / Social/Settings**.

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
