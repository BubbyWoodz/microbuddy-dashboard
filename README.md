# Micro Buddy Dashboard (web)

Self-hosted web dashboard for the Micro Buddy iOS app. Sign in by scanning a
QR code with the phone app — your phone's Supabase session becomes the
dashboard login, so you always see your own data. Works offline after the
first sync.

## Run with Docker

```bash
docker run -d -p 5002:5002 \
  -e SUPABASE_ANON_KEY="<micro-buddy-supabase-anon-key>" \
  -v "$PWD/users:/app/users" \
  ghcr.io/bubbywoodz/microbuddy-dashboard:latest
```

Then open http://localhost:5002 and scan the QR code with the Micro Buddy
iPhone app. Any Micro Buddy user can pair; each person sees only their own
data, names, pay settings and goals (nothing is tied to one account). Logins
and per-user settings live in the mounted `users/` folder.

## On Umbrel

Install "Micro Buddy" from the BubbyWoodz community store —
it uses this image.

## Develop

All app files live at the repo root (`microbuddy.py` is the server,
`dashboard.html` + `*.js` the frontend). Pushing to `main` rebuilds and
pushes `:latest` to GHCR automatically.
