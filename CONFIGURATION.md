# Application profiles

Guru owns the engine. A configured application supplies a JSON profile and its own source manifest. Its presentation files and evaluation cases stay with that application. Engine fixes belong here.

Guru uses `guru.config.json` in the working directory. Set `GURU_PROFILE` to select another file. Paths inside a profile are relative to that file. Environment settings still control credentials and database locations.

```json
{
  "version": 1,
  "id": "field-notes",
  "name": "Field Notes",
  "tagline": "Read the original observations.",
  "library": "library.json",
  "evaluation": ["eval/cases.json"],
  "sourceRegister": "natural history field guides",
  "queryExpansions": [
    { "terms": ["lady bird", "ladybug"], "append": "beetles insects" }
  ],
  "assets": "assets",
  "starterMode": "managed"
}
```

The manifest supports Gutenberg IDs, direct HTTP source URLs, local paths, or a Python source builder. Each entry must select one source method.

```json
[
  { "gutenberg": 216, "author": "Laozi", "title": "Tao Teh King" },
  { "path": "books/notes.pdf", "author": "A. Writer", "title": "Notebook", "page_offset": 10 }
]
```

A `build` entry names an application-owned Python script. The engine passes the destination path as its first argument and runs it from the profile directory. The script must write the source PDF there. Builder changes invalidate its cached output. Local source contents participate in the starter fingerprint.

The profile requires its own evaluation paths. It never falls back to the engine's cases when an application supplies a profile. A missing file or an empty case set fails explicitly. Frozen evaluation caches are tied to the profile and corpus contents.

| Setting | Behavior |
| --- | --- |
| `maxQuotesPerBook` | Maximum selected passages per indexed document. Default 1. Zero removes this limit. Adjacent selected sentences count as one passage. |
| `starterMode` | `automatic` builds a missing starter and refreshes it after source changes. `managed` requires an existing starter and never rebuilds it. `GURU_STARTER_MODE` overrides this setting. |
| `styles`, `mark` | Optional application CSS and SVG files. These are trusted deployment files. |
| `themeColor`, `backgroundColor` | Six-digit hex colors for the installed web app. |
| `showControls`, `showQuota` | Show library controls or the remaining question count. Route permissions apply independently. |
| `cookieName`, `tokenNamespace`, `historyKey` | Preserve existing application sessions during migration. Defaults derive from `id`. |
| `dailyReading` | Optional `{ "book": "Notebook", "label": "Today's reading", "timezone": "UTC" }`. Selects dated entries headed by an English month and day. |

The answer renderer accepts source sentence IDs only. It builds quotations and citations from stored records. Generated prose and model-written refusals never reach the answer. A valid quotation can still be irrelevant to a question. Corpus-specific evaluations must measure that separately.

Existing reader libraries survive starter updates. Updating a template does not reconcile books into existing readers. That needs a separate migration which preserves uploads and usage.

## Consume the engine

Pin Guru as a Git submodule in the configured application's repository.

```sh
git submodule add https://github.com/ajd3v/guru.git engine
npm --prefix engine ci
python -m venv .venv
.venv/bin/pip install -r engine/ingest/requirements.txt
node engine/src/server.ts
node engine/src/cli.ts worker
```

Commit the submodule revision with the application profile. Fresh checkouts use `git clone --recurse-submodules`. Update the pin only after testing the application against that revision. Application source files should not copy engine implementations.

The same Dockerfile builds both arrangements.

```sh
docker build -f engine/Dockerfile --build-arg ENGINE_DIR=engine -t field-notes .
```

Set `GURU_PYTHON` if the Python environment is outside `.venv`. Data paths remain relative to the process working directory unless explicitly set. Source code and the ingest sidecar resolve from the engine directory.

Backups accept `GURU_CONTAINER` to select an application container. Give each deployment its own `GURU_BACKUP_DIR`. Set `GURU_BACKUP_ENV` to an application-specific environment file, or `/dev/null` to use only the current environment. Run both backup and restore verification before replacing a deployed engine version.

Global logs and sign-in links require `GURU_OPERATORS`. When it is unset, an explicitly configured `GURU_LIBRARIAN` list supplies the operators. An empty list grants nobody access. Managing a personal library does not grant access to other readers. Browser history is scoped to the signed-in reader. Old unscoped browser history remains stored but is no longer displayed.
