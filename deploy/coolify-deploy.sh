#!/usr/bin/env bash
# Deploy guru to Coolify from the current git HEAD of master.
#
# Coolify connects to GitHub via an SSH deploy key rather than a GitHub App webhook,
# so pushes do not auto-deploy on their own. This script queues Coolify's deployment
# directly over SSH.
#
# Prereqs: git push origin master first.
#
# Usage: ./deploy/coolify-deploy.sh
# Env overrides: GURU_SSH_KEY, GURU_DEPLOY_HOST, GURU_COOLIFY_APP_UUID
set -euo pipefail

SSH_KEY="${GURU_SSH_KEY:-$HOME/.ssh/gainful_deploy}"
HOST="${GURU_DEPLOY_HOST:-deploy@108.61.220.243}"
APP_UUID="${GURU_COOLIFY_APP_UUID:-kk72jd0hcw347wc2qy1nkx8c}"

if [[ ! -r "$SSH_KEY" ]]; then
  echo "Error: SSH key is not readable: $SSH_KEY" >&2
  exit 1
fi

PHP=$(cat <<PHP
\$app = App\Models\Application::where('uuid','${APP_UUID}')->firstOrFail();
\$uuid = (string) new Visus\Cuid2\Cuid2();
\$r = queue_application_deployment(application: \$app, deployment_uuid: \$uuid);
echo 'DEPLOY '.json_encode(\$r).PHP_EOL;
PHP
)

echo "Triggering Coolify deploy of ${APP_UUID}..."
set +e
DEPLOY_OUTPUT=$(ssh -i "$SSH_KEY" \
  -o BatchMode=yes \
  -o ConnectTimeout=15 \
  -o StrictHostKeyChecking=accept-new \
  "$HOST" "docker exec -i coolify php artisan tinker" <<<"$PHP" 2>&1)
SSH_STATUS=$?
set -e

printf '%s\n' "$DEPLOY_OUTPUT"

if (( SSH_STATUS != 0 )); then
  echo "Error: Coolify deploy command failed (SSH exit $SSH_STATUS)." >&2
  exit "$SSH_STATUS"
fi

if ! grep -q 'DEPLOY .*"status":"queued"' <<<"$DEPLOY_OUTPUT"; then
  echo "Error: Coolify did not confirm that a deployment was queued." >&2
  exit 1
fi

echo
echo "Build runs on the box. Watch the deployed commit with:"
echo "  ssh -i $SSH_KEY $HOST \"docker ps --format '{{.Image}}' | grep guru:\""
