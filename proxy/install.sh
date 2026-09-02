#!/usr/bin/env bash
# holdonquietly proxy installer — run on the VPS as root.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/dwindles/holdonquietly-soundcloud/master/proxy/install.sh) sc.holdonquietly.com
#
# It fetches everything it needs from GitHub itself. That is deliberate: every
# deploy failure so far came from the hand-off, not the config — files scp'd
# from Windows arrive with CRLF (bash reads "set -euo pipefail\r" as an invalid
# option), commands get run on the wrong machine, or a previous run already
# consumed a staged file. Fetching over https sidesteps all of it.
set -euo pipefail

H="${1:-sc.holdonquietly.com}"
H_RE="${H//./\\.}"                 # dots escaped, for the regex server_names
RAW="https://raw.githubusercontent.com/dwindles/holdonquietly-soundcloud/master"
SUBS=(api-v2 api-auth api graph secure secure-cdn a-v2 style va wis i1 i2 i3 i4 hls hls2 wave pushers)

echo "==> base host: $H"
echo "==> ${#SUBS[@]} upstream subdomains"

command -v nginx >/dev/null || { echo "nginx not found"; exit 1; }
nginx -V 2>&1 | grep -q with-http_sub_module || {
  echo "FAIL: this nginx has no sub_filter module — the whole design needs it"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> fetching from GitHub"
curl -fsSL "$RAW/proxy/hoq-proxy.conf"        -o "$TMP/hoq-proxy.conf"
curl -fsSL "$RAW/proxy/hoq-rewrites.conf"     -o "$TMP/hoq-rewrites.conf"
curl -fsSL "$RAW/dist/holdonquietly.proxy.js" -o "$TMP/holdonquietly.proxy.js"

# Belt and braces: strip CRs even though raw.githubusercontent serves LF.
sed -i 's/\r$//' "$TMP/hoq-proxy.conf" "$TMP/hoq-rewrites.conf"

# Order matters: __PROXY_HOST_RE__ before __PROXY_HOST__, or the second
# substitution eats the prefix of the first.
sed -i "s/__PROXY_HOST_RE__/$H_RE/g; s/__PROXY_HOST__/$H/g" \
    "$TMP/hoq-proxy.conf" "$TMP/hoq-rewrites.conf"

mkdir -p /etc/nginx/snippets /var/www/hoq
install -m 0644 "$TMP/hoq-rewrites.conf"      /etc/nginx/snippets/hoq-rewrites.conf
install -m 0644 "$TMP/hoq-proxy.conf"         /etc/nginx/sites-available/hoq-proxy
install -m 0644 "$TMP/holdonquietly.proxy.js" /var/www/hoq/holdonquietly.proxy.js
ln -sf /etc/nginx/sites-available/hoq-proxy /etc/nginx/sites-enabled/hoq-proxy

# Expand the certificate across every subdomain. HTTP-01 works for all of them
# because the wildcard DNS record points here and the default port-80 server
# answers unknown hostnames from /var/www/html.
DOMS=(-d "$H"); for s in "${SUBS[@]}"; do DOMS+=(-d "$s.$H"); done
echo "==> certificate"
certbot certonly --webroot -w /var/www/html --cert-name "$H" \
        --expand --non-interactive --agree-tos --register-unsafely-without-email \
        --keep-until-expiring "${DOMS[@]}"

echo "==> testing nginx"
nginx -t
systemctl reload nginx

echo
echo "==> deployed. checking it actually works:"
sleep 1
page=$(curl -s --max-time 30 "https://$H/" || true)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "https://$H/" || echo 000)
inj=$(printf '%s' "$page" | grep -c 'hoq.js' || true)
left=$(printf '%s' "$page" | grep -oE '(api-v2|a-v2|i1|secure)\.(soundcloud|sndcdn)\.com' | wc -l | tr -d ' ')
loop=$(curl -s --max-time 30 "https://$H/hoq.js" | grep -c "getAttribute('content') !== want" || true)

echo "    app responds       : HTTP $code   (want 200)"
echo "    theme injected     : $inj           (want 1)"
echo "    un-proxied hosts   : $left           (want 0)"
echo "    infinite-load fix  : $loop           (want 1)"
echo
if [ "$code" = "200" ] && [ "$inj" -ge 1 ] && [ "$left" = "0" ] && [ "$loop" -ge 1 ]; then
  echo "==> ALL GREEN — open https://$H"
else
  echo "==> something is off; the numbers above say which layer."
fi
