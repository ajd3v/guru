# <img src="mark.svg" alt="" height="30"> guru

A study companion for your own multi-tradition spiritual library that never misquotes.
Every substantive claim is a verbatim quote cited with title, author, and page. No citation,
no claim.

Ask it a question and it answers out of books you own, in their words rather than its own.
A model that cannot find an answer in your shelf says so instead of writing one.

**The reading room is open at [guru.alanj.dev](https://guru.alanj.dev).** Search the starter
shelf, 123 public-domain books, as much as you like and with no model in the loop. Five
composed answers come with the visit, which is enough to ask something the shelf covers,
something it covers badly, and something it does not cover at all. The last one is the
interesting one.

The shelf runs from scripture through to the writers who left scripture behind: the Tao Te
Ching, the Gita, the Dhammapada and the Analects alongside Emerson, Thoreau, Whitman and
Margaret Fuller; the Stoics and Plotinus alongside Schopenhauer, Nietzsche and Pascal;
Underhill and Maeterlinck studying mysticism rather than preaching it; the whole New Thought
line from Trine and Troward to Atkinson and Allen; Muir and Burroughs and Richard Jefferies
finding it outdoors; Okakura, Nitobe and Hearn on the Japanese inner life. Every id is
resolved against Gutenberg rather than recalled.

See [CONFIGURATION.md](CONFIGURATION.md) to run another library on the same engine.
[RETRIEVAL.md](RETRIEVAL.md) records the current local search measurements.
[SPEC.md](SPEC.md) contains historical design notes and measurements.

## How it refuses to misquote

The model is never allowed to type a quotation. It cites a sentence id and the exact wording
is spliced in from the source, so a misquote is not expressible rather than merely detected.
The renderer builds each quotation and its citation from the selected source record.
Generated claims and summaries are discarded. An explicit refusal produces a fixed message.

The tests verify this contract against stub model responses. Historical model scores in
SPEC.md predate the current renderer and must be remeasured before comparing answer quality.
Quotation fidelity does not establish whether a passage answers the question.

Retrieval refuses too. If the reranker judges that nothing on the shelf bears on the question,
the answer is one sentence saying so, with no citations under it.

## Run it

Node 24+ and Python 3, for the ingest sidecar.

```sh
npm install
python -m venv .venv && .venv/bin/pip install -r ingest/requirements.txt
cp .env.example .env                    # then add a model API key

npm test                                # no API key needed, runs against stubs

node src/cli.ts starter --limit 5       # five books, ~3 minutes
node src/cli.ts ask "what is the self?"
node src/cli.ts find "quieting a restless mind"
node src/cli.ts books                  # IDs in the current library
node src/cli.ts find --book 1 "what is the self?"
```

Drop `--limit` for the whole starter library. That is 123 books and **hours** of CPU, because
every chunk is embedded locally, so it is worth knowing before you start it rather than after.
The first five books are already four traditions, which is enough to see whether the
cross-tradition answers are what you want.

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

Choose a book with Search in to limit Find or Ask to that source. All books searches the
whole shelf. Duplicate titles show a filename and book ID so you can choose the intended copy.

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
GURU_BASIC_AUTH=ada:replace-with-a-long-password,lin:use-a-different-long-password
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
entrypoint builds the starter library once onto the volume, hours of CPU at 123 books, and it
is rebuilt when the book list or the extractor changes. Only the first build blocks: a rebuild
runs in the background and the old shelf keeps answering until it is ready.

Set `GURU_URL` to the public URL, and the model provider variables from `.env.example`.

### Backups

A reader's whole library is one SQLite file, so a backup is a snapshot of that file, and
`deploy/backup.sh` takes one of every database on the volume nightly.

It uses `VACUUM INTO` rather than copying the file. These databases run in WAL mode, so the
`.db` on its own is missing whatever is still in its `-wal` sidecar, and a plain copy of a live
one restores as a library with books quietly absent. It also runs inside the serving container
rather than a throwaway one with the volume mounted read-only, because a WAL database has to
touch its `-shm` file even to be read and a read-only mount fails before it reads a byte.

```sh
install -m755 deploy/backup.sh        /home/deploy/backup-guru.sh
install -m755 deploy/backup-verify.sh /home/deploy/backup-verify-guru.sh
(crontab -l 2>/dev/null; echo '30 2 * * * /home/deploy/backup-guru.sh >> /home/deploy/backups/guru-backup.log 2>&1') | crontab -
```

`deploy/backup-verify.sh` restores the newest archive into a throwaway directory, runs SQLite's
integrity check on every database and reads a chunk of text back out. Run it monthly. A backup
nobody has restored is a file, not a backup.

**A local snapshot is half a backup.** It covers the losses that actually happen, someone types
DELETE into the delete box, a deploy goes wrong, a file is corrupted. It does not cover the disk
going away, because it is on that disk. Set `GURU_BACKUP_REMOTE` to an `rclone` remote and the
same script copies off-site as well; without one it says so on every run rather than letting the
gap go quiet.

## Eval

Retrieval and answering are scored separately, because a cheap answer model otherwise looks
bad for the search stage's reasons.

```sh
GURU_DB=data/eval.db node src/cli.ts starter   # once, to build the eval corpus
node eval/run.ts                               # hybrid search only, offline and free
node eval/compare.ts --output /tmp/retrieval.json # paired local search comparison
node eval/run.ts --hyde --rerank               # the full stack
node eval/answers.ts --cache data/answer-cases.json --limit 30
```

`eval/run.ts` scores whether the right passage reaches the top 5. `eval/answers.ts` scores
whether a rendered quotation contains the case's expected source span. Neither score proves
that the answer supports the reader's intended claim. The answer evaluation freezes retrieved
passages so models can be compared against the same input. The paired retrieval check records
excluded cases and the corpus identity. Model-based runs can incur provider charges.

Subsets are not interchangeable. The eval's `--limit` strides through the case file rather than
taking a prefix, because the file is ordered by book and a prefix is one author's cases. Two
different limits therefore select two different subsets, and runs that used different ones are
not comparable, however similar the numbers look. (`starter --limit` is the plain meaning: the
first N books.)

## Licence

ISC. See [LICENSE](LICENSE).

Built by [Alan De Vaney](https://alanj.dev). The engine is library-agnostic.
Swap in your own texts and nothing else changes.
