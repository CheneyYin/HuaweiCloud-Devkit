# Runbook: LangChain demo → Huawei Cloud MaaS → AgentArts

End-to-end, mainland-China-first. Mirrors are the default in every step.
Placeholders: `<name>` (agent/project name), `<region>` (control plane is
`cn-southwest-2`), `<root>` (parent directory you run from).

Backend assumed here: Huawei Cloud MaaS OpenAI-compatible endpoint
(`OPENAI_BASE_URL=https://api.modelarts-maas.com/v1`, `OPENAI_MODEL_NAME=<model>`).
Any OpenAI-compatible endpoint works the same way.

## 0. Prereqs

- `agentarts --version` → `0.1.7` (install: `npx huaweicloud-devkit install-agentarts`).
- Docker available locally; a MaaS endpoint + API key.
- Devkit runtime credentials present (`huaweicloud_auth_status`); the wrapper
  injects AK/SK — never `export` them.

## 1. Init the project

```
agentarts init -n <name> -t langchain -r <region>
```

- Run from `<root>`; the project is created at `<root>/<name>`.
- `-p <dir>` is a PARENT dir: `-p foo -n foo` nests `foo/foo`. Omit `-p` if unsure.
- Templates: `basic | langchain | langgraph | google-adk`. Framework templates
  need the project-venv smoke test in step 4 (the CLI's own `dev` cannot load
  their deps).

## 2. Configure the MaaS backend (no secret in argv)

Set `runtime.environment_variables` in `<root>/<name>/.agentarts_config.yaml`:

- `OPENAI_BASE_URL` = `https://api.modelarts-maas.com/v1`
- `OPENAI_MODEL_NAME` = e.g. `glm-5.2`
- `OPENAI_API_KEY` = the MaaS key

Write the key through the YAML library (never `config set-env`, never `sed`):

```
chmod 600 /tmp/maas_key.txt      # user writes the key here, one line, no trailing newline issues
python3 set_env.py <root>/<name>/.agentarts_config.yaml
```

`set_env.py` loads YAML, sets the three keys, writes atomically (`os.replace`),
`chmod 600`s the config, then re-parses and prints only `set=True/False len=N`.
It exits non-zero if any value does not match. See `credentials.md`.

## 3. Pre-warm the build (keeps `launch` inside the ~300s client timeout)

```
docker pull docker.m.daocloud.io/library/python:3.10-slim \
  && docker tag docker.m.daocloud.io/library/python:3.10-slim python:3.10-slim
```

- Dockerfile pip step must use a mirror via an overridable ARG (pip reads it):
  `ARG PIP_INDEX_URL=https://mirrors.huaweicloud.com/repository/pypi/simple`
  - `ENV PIP_INDEX_URL=${PIP_INDEX_URL}`. (Do not inline `-i`: `agentarts config`
    regenerates the Dockerfile from a mirror-less template and reverts it.)
- `.dockerignore` must contain: `.venv/`, `__pycache__/`, `*.pyc`, `.git/`,
  `.agentarts_config.yaml`, and local helper scripts. **Critical:** without the
  config entry, `COPY . .` bakes the API key into the image pushed to SWR.
- Add `.gitignore` (`.venv/`, `.agentarts_config.yaml`, …) so a later `git init`
  cannot commit the secret.

## 4. Local smoke test (framework templates)

`agentarts dev` runs in the CLI venv and fails with
`ModuleNotFoundError: No module named 'langchain_core'`. Instead:

```
cd <root>/<name>
python3 -m venv .venv
.venv/bin/pip install -i https://mirrors.huaweicloud.com/repository/pypi/simple \
  -r requirements.txt
.venv/bin/python local_dev.py          # POST http://127.0.0.1:8081/invocations
```

Green here is a smoke test, not proof of the container (different Python than
`python:3.10-slim` and unpinned deps resolve differently). The cloud `invoke`
is the real verification.

## 5. Deploy

```
# from <root>/<name>, via the approved-command wrapper:
agentarts config set base.region <region>   # if not already set in the YAML
agentarts launch                            # docker build + SWR push + runtime create (billing)
```

- `launch` prints SWR org/repo auto-create on first run (`Namespace does not
exists` → `Created ...`), then the runtime ID and Access Endpoint.
- If it returns JSON-RPC `-32001`, the build exceeded the client timeout: check
  `docker ps -a` for an orphaned build container, remove it, and re-run (with a
  warm cache the second run is fast).

## 6. Invoke (real verification)

```
agentarts invoke '{"message":"用一句话介绍你自己"}'
```

Expected shape:

```json
{ "response": "<model text>", "status": "success", "agent": "<name>", "model": "<model>" }
```

Runtime readiness is asynchronous — if you get "could not get access_endpoint",
retry after ~20s.

## 7. Teardown

```
agentarts destroy --yes        # irreversible; removes the runtime
docker image prune / rm the local build images if desired
```

## Secret hygiene checklist

- [ ] Secret only in `.agentarts_config.yaml` (chmod 600) and a 0600 source file.
- [ ] `.agentarts_config.yaml` + helpers in `.dockerignore` (verified: not in the image).
- [ ] `.gitignore` covers the config.
- [ ] Temp key file removed after use.
- [ ] If a secret was deployed before the `.dockerignore` fix, **rotate it** —
      the earlier image is already in SWR.

## Troubleshooting

See `cli-workflows.md` → "Error Signatures" and "Restricted Networks" for the
`-32001` / orphan / mirror signatures, and `SKILL.md` → "Measured Traps".
