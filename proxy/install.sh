#!/usr/bin/env bash
# holdonquietly proxy installer — run on the VPS as root.
#
#   bash /tmp/install.sh sc.holdonquietly.com
#
# Does the whole deploy: substitutes the hostname (including the regex-escaped
# form the server_name patterns need), installs both files, expands the TLS
# certificate to cover every upstream subdomain, then tests and reloads.
set -euo pipefail

H="${1:-sc.holdonquietly.com}"
H_RE="${H//./\\.}"                      # dots escaped, for the regex server_names
SUBS=(api-v2 api-auth api graph secure a-v2 style va wis i1 i2 i3 i4 hls hls2)

echo "==> base host: $H"

for f in /tmp/hoq-proxy.conf /tmp/hoq-rewrites.conf; do
  [ -f "$f" ] || { echo "MISSING: $f — scp it up first"; exit 1; }
done

# Order matters: __PROXY_HOST_RE__ before __PROXY_HOST__, or the second
# substitution eats the prefix of the first.
sed -i "s/__PROXY_HOST_RE__/$H_RE/g; s/__PROXY_HOST__/$H/g" \
    /tmp/hoq-proxy.conf /tmp/hoq-rewrites.conf

mkdir -p /etc/nginx/snippets /var/www/hoq
mv /tmp/hoq-rewrites.conf /etc/nginx/snippets/hoq-rewrites.conf
mv /tmp/hoq-proxy.conf    /etc/nginx/sites-available/hoq-proxy
ln -sf /etc/nginx/sites-available/hoq-proxy /etc/nginx/sites-enabled/hoq-proxy
[ -f /tmp/holdonquietly.proxy.js ] && mv /tmp/holdonquietly.proxy.js /var/www/hoq/

# Expand the certificate to cover every subdomain the app will now be sent to.
# HTTP-01 works for all of them because the wildcard DNS record points here and
# the default port-80 server answers unknown hostnames from /var/www/html.
DOMS=(-d "$H")
for s in "${SUBS[@]}"; do DOMS+=(-d "$s.$H"); done

echo "==> requesting/expanding certificate for ${#SUBS[@]} subdomains + base"
certbot certonly --webroot -w /var/www/html --cert-name "$H" \
        --expand --non-interactive --agree-tos --register-unsafely-without-email \
        "${DOMS[@]}"

echo "==> testing nginx"
nginx -t
systemctl reload nginx
echo "==> done. try: https://$H"
