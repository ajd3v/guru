# ◎ guru

A study companion for your own multi-tradition spiritual library that never misquotes.
Every substantive claim is a verbatim quote cited with title, author, and page. No citation,
no claim.

See [SPEC.md](SPEC.md) for the design and the measured numbers.

## Run it

```sh
npm install
python -m venv .venv && .venv/bin/pip install pymupdf ebooklib   # ingest sidecar
node src/cli.ts starter                 # fetch and ingest the public-domain library
node src/cli.ts ask "what is the self?"
node src/cli.ts find "quieting a restless mind"
npm test
```

`node src/cli.ts add "Author - Title.pdf"` adds your own books. `GURU_DB` picks the database,
default `data/library.db`.

## Web

```sh
GURU_DB=data/starter.db node src/cli.ts starter   # once, build the template
npm run serve                                     # http://localhost:8080
npm run worker                                    # separate process, drains the ingest queue
```

Uploads are PUT with the file as the raw body (no multipart), capped while streaming, and
restricted to `.pdf` and `.epub`. The server only writes the file and records a job; parsing
and embedding happen in the worker, because a book is minutes of CPU and PDF parsers are an
RCE surface worth keeping in another process. Re-uploading a book replaces it rather than
shelving a second copy.

Each reader gets their own SQLite file under `data/users/`, cloned from the starter template
the first time they appear.

Sign-in is Clerk. Without `CLERK_SECRET_KEY` the server runs unauthenticated and every request
resolves to one local user (`GURU_USER`, default `demo`), which is fine for development and
refuses to boot under `NODE_ENV=production`. To turn auth on:

```sh
CLERK_SECRET_KEY=sk_...        # Clerk dashboard, API keys
CLERK_PUBLISHABLE_KEY=pk_...
GURU_ORIGINS=https://guru.app  # origins allowed to present a session token
```

## Eval

```sh
GURU_DB=data/eval.db node src/cli.ts starter   # once, to build the eval corpus
node eval/run.ts                               # hybrid search only, offline
node eval/run.ts --hyde --rerank               # the full launch stack
```
