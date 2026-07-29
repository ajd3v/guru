# One image, two roles: `serve` answers requests, `worker` drains the ingest queue.
#
# Python is here because PyMuPDF is the only irreplaceable dependency in the stack, and the
# language boundary doubles as the boundary the PDF parser runs behind.
FROM node:24-bookworm-slim

# build-essential and python3-dev: better-sqlite3 compiles from source. ca-certificates:
# model weights and Gutenberg are fetched over TLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 python3-venv python3-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source edit does not rebuild better-sqlite3 or reinstall PyMuPDF.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY ingest/requirements.txt ingest/
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir -r ingest/requirements.txt

COPY . .

# Bake the embedding model into the image. Left to first use it downloads ~100MB while a
# reader waits, and every replacement container pays it again.
ENV TRANSFORMERS_CACHE=/app/.cache/huggingface HF_HOME=/app/.cache/huggingface
RUN node -e "const {embed}=await import('./src/embed.ts'); await embed(['warm the model cache']); console.log('embedder cached');"

ENV NODE_ENV=production PORT=8080
EXPOSE 8080

# `serve` and `worker` are the two roles; the entrypoint builds the starter library once.
ENTRYPOINT ["./deploy/entrypoint.sh"]
CMD ["serve"]
