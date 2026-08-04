# Answering through the 9router

Guru talks to an OpenAI-compatible endpoint. In production that is not DeepInfra any more, it
is the 9router gateway running on the same host as part of the incubator stack.

```
DEEPINFRA_BASE_URL=http://ninerouter:20128/v1
DEEPINFRA_API_KEY=sk-...            # the `guru-app` key, not gainful's
GURU_PIPELINE_MODEL=gh/gpt-4o-mini
GURU_ANSWER_MODEL=gh/gpt-4o-mini
```

## The network is attached from the other side

The router is joined to guru's network, rather than guru being joined to the router's:

```sh
docker network connect --alias ninerouter kk72jd0hcw347wc2qy1nkx8c incubator-shared-ninerouter-1
```

It was done the obvious way round first and it took the site down. Putting guru on a second
network left the container with three addresses and no `traefik.docker.network` label to
choose between them, so Traefik routed to one nothing was listening on. Every request
returned nothing while the container itself sat there healthy, answering 401 correctly on
127.0.0.1:8080. Coolify regenerates those labels on deploy, which is the same reason the
basic-auth check lives in the app instead of a proxy middleware (see `src/auth.ts`).

**This command is imperative state and nothing replays it.** If the incubator stack recreates
its ninerouter container the alias goes with it, and guru stops being able to answer with no
warning until somebody asks a question. The durable fix is to add guru's network to the
ninerouter service in the incubator stack's own compose file. Until that happens, re-run the
line above after anything that recreates that container.

## Not every model on it works

The gateway lists 94 models. Most cannot be called. Measured from inside the guru container:

| route | result |
| --- | --- |
| `gh/gpt-4o-mini` | 5/5 |
| `nvidia/deepseek-ai/deepseek-v4-flash` | 1/3, `529 Service temporarily overloaded` |
| `kc/deepseek/deepseek-chat` | `402 Paid Model - Credits Required` |
| `machina` | `429 No active credentials for provider: local` |
| `xai/grok-4-fast-reasoning` | `402 personal-team-blocked` |
| `gc/gemini-2.0-flash`, `ag/claude-3-5-haiku` | `404` |

An answer is four or five sequential calls, so a route that succeeds one time in three
effectively never produces one. That is why the deepseek-v4-flash id guru used on DeepInfra
is not usable here despite being present, and why the answer model is now GPT-4o-mini.

That model swap is the part worth revisiting. `src/llm.ts` records that every DeepSeek model
reworded archaic English about half the time when asked to copy a quotation, which is what
the splice-and-verify machinery was built around. GPT-4o-mini currently returns answers whose
quotes survive verification, but it has not been measured across the eval set.

## It appends an SSE terminator to replies nobody asked to stream

`POST /chat/completions` without `stream` comes back as a complete JSON object followed by
`data: [DONE]`. `res.json()` parses the object, meets the terminator and throws. See
`pickContent` in `src/llm.ts`, which cuts at the terminator and still throws on a body that
is malformed for any other reason.

## Going back to DeepInfra

Set `DEEPINFRA_BASE_URL` and `DEEPINFRA_API_KEY` back to the DeepInfra values and clear both
`GURU_*_MODEL` overrides, then redeploy. The old key is no longer in Coolify, it was
overwritten with the router key, so take it from a working `.env`.

Env-only changes do not need a rebuild. A `restart_only` deployment recreates the containers
with the new values in about 90 seconds:

```php
queue_application_deployment(application: $app, deployment_uuid: (string) new Visus\Cuid2\Cuid2(), restart_only: true);
```
