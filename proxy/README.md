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

Everything runs on the VPS (155.138.222.253, ssh port 2222). Pick a hostname,
e.g. `sc.holdonquietly.com`, and point an A record at the box first.

**1. Check nginx has the sub_filter module** — the whole design depends on it:

```bash
nginx -V 2>&1 | grep -o with-http_sub_module
```

If that prints nothing, install `nginx-extras` (Debian/Ubuntu) and re-check.

**2. Copy the two files up** (from the Windows box):

```bash
scp -P 2222 proxy/hoq-proxy.conf dist/holdonquietly.proxy.js root@155.138.222.253:/tmp/
```

**3. On the VPS, set your hostname and install:**

```bash
export H=sc.holdonquietly.com
mkdir -p /var/www/hoq && mv /tmp/holdonquietly.proxy.js /var/www/hoq/
sed -i "s/__PROXY_HOST__/$H/g" /tmp/hoq-proxy.conf
mv /tmp/hoq-proxy.conf /etc/nginx/sites-available/hoq-proxy
ln -sf /etc/nginx/sites-available/hoq-proxy /etc/nginx/sites-enabled/hoq-proxy
```

**4. Get a certificate** (the conf references it, so do this before reloading):

```bash
certbot certonly --webroot -w /var/www/html -d sc.holdonquietly.com
```

**5. Test the config, then reload — never reload blind:**

```bash
nginx -t && systemctl reload nginx
```

If `nginx -t` complains about **`unknown directive "http2"`**, your nginx predates
1.25.1. Delete the `http2 on;` line and put it on the listen directive instead:

```bash
sed -i 's/    http2 on;//; s/listen 443 ssl;/listen 443 ssl http2;/' /etc/nginx/sites-available/hoq-proxy
```

## Smoke test, in order

Each step isolates one layer, so a failure tells you where it is.

```bash
curl -sI https://sc.holdonquietly.com/ | head -1
curl -s https://sc.holdonquietly.com/ | grep -c 'hoq.js'
curl -s https://sc.holdonquietly.com/ | grep -c 'a-v2.sndcdn.com'
curl -sI https://sc.holdonquietly.com/hoq.js | grep -i content-type
```

- Line 1 should be `200`.
- Line 2 should be `1` — the theme got injected.
- Line 3 should be **`0`** — every original host was rewritten. Any number above
  zero is a host escaping the rewrite, and that is what to fix first.
- Line 4 should say `application/javascript`.

Then open it on the phone. You want the nav to read
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
