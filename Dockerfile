# Micro Buddy Dashboard — portable Docker image.
# Ships with zero secrets: auth happens via QR pairing with the phone app,
# which hands over its Supabase session. The shared Supabase project is the
# only backend config, and its URL + anon key are public.
#
# Secrets (MICROBUDDY_TOKEN, SUPABASE_ANON_KEY) are read from env vars first,
# then from files. Pass them via environment in docker-compose.yml.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    SUPABASE_URL=https://tgarraczeevyrjfxzkkf.supabase.co

WORKDIR /app
COPY microbuddy.py dashboard.html manifest.json sw.js themes.css login-bg.jpg ./
COPY db.js sb.js sync.js buddy.js settings.js qrcode.min.js ./
COPY payengine.js daydetail.js stats.js schedule.js journal.js coworkers.js ./
COPY goals.js microcharm.js profile.js leaderboard.js brands.js ./
COPY home-widgets.js buddy-actions.js ./
COPY icons/ ./icons/

EXPOSE 5002
CMD ["python3", "microbuddy.py"]
