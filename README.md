# Micro Buddy Dashboard (web)

Self-hosted web dashboard for the Micro Buddy iOS app. Sign in by scanning a
QR code with the phone app — your phone's Supabase session becomes the
dashboard login, so you always see your own data. Works offline after the
first sync.

## Run with Docker

```bash
docker run -d -p 5002:5002 \
  -e MICROBUDDY_TOKEN="<your-mcp-token>" \
  -e SUPABASE_ANON_KEY="<your-supabase-anon-key>" \
  ghcr.io/bubbywoodz/microbuddy-dashboard:latest
```

Then open http://localhost:5002.

## On Umbrel

Install "Micro Buddy" from the BubbyWoodz community store —
it uses this image.

## Develop

All app files live at the repo root (`microbuddy.py` is the server,
`dashboard.html` + `*.js` the frontend). Pushing to `main` rebuilds and
pushes `:latest` to GHCR automatically.
