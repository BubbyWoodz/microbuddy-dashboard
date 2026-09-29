# Micro Buddy Dashboard — portable Docker image.
# Ships with zero secrets: auth happens via QR pairing with the phone app,
# which hands over its Supabase session. The shared Supabase project is the
# only backend config, and its URL + anon key are public.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    SUPABASE_URL=https://tgarraczeevyrjfxzkkf.supabase.co

WORKDIR /app
COPY microbuddy.py dashboard.html manifest.json sw.js themes.css ./
COPY brands.js buddy.js buddy-actions.js coworkers.js daydetail.js db.js goals.js \
     home-widgets.js journal.js leaderboard.js microcharm.js payengine.js profile.js \
     qrcode.min.js sb.js schedule.js settings.js stats.js sw.js sync.js \
     login-bg.jpg ./
COPY icons/ ./icons/

# Optional: bake in the public Supabase anon key so pairing works out of the
# box. (It's public by design — it ships inside the phone app.)
# COPY .supabase_anon_key ./

EXPOSE 5002
CMD ["python3", "microbuddy.py"]
