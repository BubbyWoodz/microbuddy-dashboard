# Micro Buddy Dashboard — portable Docker image.
# Ships with zero secrets: auth happens via QR pairing with the phone app,
# which hands over its Supabase session. The shared Supabase project is the
# only backend config, and its URL + anon key are public.
FROM python:3.12-slim

LABEL org.opencontainers.image.title="Micro Buddy Dashboard" \
      org.opencontainers.image.version="2.0.10"

ENV PYTHONUNBUFFERED=1 \
    SUPABASE_URL=https://tgarraczeevyrjfxzkkf.supabase.co

WORKDIR /app
COPY microbuddy.py dashboard.html manifest.json sw.js themes.css components.css ./
COPY badges.js brands.js buddy.js buddy-actions.js coworkers.js daydetail.js db.js heic2any.min.js \
     goals.js home-widgets.js icons.js journal.js leaderboard.js microcharm.js \
     brandaliases.js shiftmath.js payengine.js profile.js qrcode.min.js sales.js sale-entry.js sb.js schedule.js \
     screen-lock.js settings.js stats.js sync.js \
     login-bg.jpg ./
COPY icons/ ./icons/

# Optional: bake in the public Supabase anon key so pairing works out of the
# box. (It's public by design — it ships inside the phone app.)
# COPY .supabase_anon_key ./

EXPOSE 5002
CMD ["python3", "microbuddy.py"]
