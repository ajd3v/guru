# ◎ guru

A study companion for your own multi-tradition spiritual library that never misquotes.
Every substantive claim is a verbatim quote cited with title, author, and page. No citation,
no claim.

Ask it a question and it answers out of books you own, in their words rather than its own.
A model that cannot find an answer in your shelf says so instead of writing one.

See [SPEC.md](SPEC.md) for the design and the measured numbers.

## How it refuses to misquote

The model is never allowed to type a quotation. It cites a sentence id and the exact wording
is spliced in from the source, so a misquote is not expressible rather than merely detected.
Anything that survives that is checked against the book again, and a claim whose quote fails
is dropped rather than shipped. Measured on cases where retrieval supplied the answer, the
deployed model quoted the right passage 91% of the time and invented a quotation zero times.

Retrieval refuses too. If the reranker judges that nothing on the shelf bears on the question,
the answer is one sentence saying so, with no citations under it.

## Run it

Node 24+ and Python 3, for the ingest sidecar.

```sh
npm install
python -m venv .venv && .venv/bin/pip install -r ingest/requirements.txt
cp .env.example .env                    # then add a model API key

node src/cli.ts starter                 # fetch and ingest 50 public-domain books
node src/cli.ts ask "what is the self?"
node src/cli.ts find "quieting a restless mind"
npm test
```

`node src/cli.ts add "Author - Title.pdf"` adds your own books. The `Author - Title` filename
is used in preference to the file's own metadata, because a catalogue record makes a poor
citation. `GURU_DB` picks the database, default `data/library.db`.

Any OpenAI-compatible endpoint works, or Anthropic directly. Set a base URL and the protocol
is inferred. Embedding is local, so ingest and search cost nothing and run offline; only
query expansion, reranking and the answer itself call a model.

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
the first time they appear. Isolation is by filesystem, not by `WHERE` clause.

### Sign-in

Sign-in is Clerk. Without `CLERK_SECRET_KEY` the server runs unauthenticated and every request
resolves to one local user (`GURU_USER`, default `demo`), which is fine for development and
refuses to boot under `NODE_ENV=production`. To turn auth on:

```sh
CLERK_SECRET_KEY=sk_...        # Clerk dashboard, API keys
CLERK_PUBLISHABLE_KEY=pk_...
GURU_ORIGINS=https://example.com  # origins allowed to present a session token
```

For a handful of people who know each other, a password each is enough and Clerk is more than
you need. `GURU_SINGLE_USER` runs without it, and `GURU_BASIC_AUTH` takes a comma-separated
list of `user:password`:

```sh
GURU_SINGLE_USER=reader
GURU_BASIC_AUTH=ada:secret,lin:other
```

The username that matches is the reader's id, so each one gets `data/users/<username>.db`.
Renaming a username hands that person a fresh library and leaves their books under the old
name. Usernames must be `[A-Za-z0-9_-]`, since they become filenames, and the app refuses to
start if one is not.

`GURU_LIBRARIAN` names who may add books and download the whole library, comma-separated.
Unset means everyone, which is right for a one-person deployment. Everyone else can still ask
questions, and still export their own data, which is their ask history rather than the corpus.

## Deploy

`docker-compose.yml` builds one image and runs it twice, as `serve` and as `worker`. They
share a volume because the worker writes into the reader's database. On first boot the
entrypoint builds the starter library once onto the volume, which takes about 70 minutes for
50 books on 8 cores, and it is rebuilt when the book list or the extractor changes.

Set `GURU_URL` to the public URL, and the model provider variables from `.env.example`.

## Eval

Retrieval and answering are scored separately, because a cheap answer model otherwise looks
bad for the search stage's reasons.

```sh
GURU_DB=data/eval.db node src/cli.ts starter   # once, to build the eval corpus
node eval/run.ts                               # hybrid search only, offline and free
node eval/run.ts --hyde --rerank               # the full stack
node eval/answers.ts --cache data/answer-cases.json --limit 30
```

`eval/run.ts` scores whether the right passage reaches the top 5. `eval/answers.ts` scores
what happens next, and is deliberately not an LLM judge: the cases carry the gold passage, so
"did the answer quote a sentence from it" is a fact. It freezes the retrieved passages to a
file so two models can be compared against identical input, since retrieval is stochastic and
otherwise each model gets a different set of cases.

Subsets are not interchangeable. `--limit` strides through the case file rather than taking a
prefix, and different limits still select different cases, so only compare runs that used the
same one.

## Licence

ISC. See [LICENSE](LICENSE).
