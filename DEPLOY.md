# Deploying the backend (feed + friends)

The app's social features talk to a tiny zero‑dependency Node server on the
Vultr box:

```
BACKEND = http://155.138.222.253:8790   (Program.cs)
```

That server is **`backend/server.js`** (port **8790**). It serves:

| Method | Path        | Purpose                                   |
|--------|-------------|-------------------------------------------|
| POST   | `/presence` | your now‑playing (drives Friends)         |
| GET    | `/friends`  | everyone's now‑playing                     |
| POST   | `/feed`     | **new** — post a message / shared song    |
| GET    | `/feed`     | **new** — the last 60 feed items           |
| GET    | `/health`   | liveness check                            |

The feed is **file‑backed** (`feed.json` next to `server.js`) so posts survive a
restart, and it's seeded with a pinned welcome so it's never blank.

> `backend/` is gitignored, so `server.js` is **not** in the repo — the copy on
> your disk is the source of truth and you push it up by hand (below).

---

## Deploy the update (do this to make the feed go live cross‑user)

SSH is on the custom port for that box (confirm with your notes — it's been
`2222`):

```bash
# 1. copy the new server up (run from the repo root, D:\Claude Coding\... on Windows use Git Bash)
scp -P 2222 backend/server.js root@155.138.222.253:/opt/hoq/server.js

# 2. restart it and confirm
ssh -p 2222 root@155.138.222.253 'cd /opt/hoq && pm2 restart hoq --update-env || pm2 start server.js --name hoq; pm2 save; curl -s http://localhost:8790/health'
```

If step 2 says the process name is wrong, list what's running and use the real
name:

```bash
ssh -p 2222 root@155.138.222.253 'pm2 list'
```

(The friends service is whatever is already answering on **8790** — restart
*that* one after replacing its `server.js`. It may be named `hoq`,
`hoq-friends`, or similar. Do **not** use the old `deploy.sh` as‑is: it writes to
port **8787** and an older `server.js` with no feed.)

---

## Verify it's live

From anywhere:

```bash
# should return a JSON array (starts with the seeded welcome item)
curl -s http://155.138.222.253:8790/feed

# post a test message
curl -s -X POST http://155.138.222.253:8790/feed -H 'Content-Type: application/json' \
  -d '{"id":"sc_test","name":"Test","text":"hello from curl"}'

# read it back
curl -s http://155.138.222.253:8790/feed
```

Then open the app → **Social/Settings → Feed**. You should see the feed load and
your own posts appear.

If nothing loads, check the firewall allows the port:

```bash
ssh -p 2222 root@155.138.222.253 'ufw allow 8790/tcp; ufw status'
```

---

## Rollback / housekeeping

* The feed data is just `/opt/hoq/feed.json`. Back it up or clear it anytime:
  ```bash
  ssh -p 2222 root@155.138.222.253 'cp /opt/hoq/feed.json /opt/hoq/feed.bak.json'   # backup
  ssh -p 2222 root@155.138.222.253 'echo "[]" > /opt/hoq/feed.json && pm2 restart hoq'  # wipe
  ```
* Logs: `ssh -p 2222 root@155.138.222.253 'pm2 logs hoq --lines 50'`
* To point the app at a different host/port, change `BACKEND` in `Program.cs`.

## Worth fixing later (optional)

`backend/deploy.sh` is stale — it embeds an inline copy of `server.js` on port
**8787** with no feed, which no longer matches what runs on **8790**. Either
delete it or rewrite it to just `scp` the real `backend/server.js` and restart,
so there's one source of truth.
