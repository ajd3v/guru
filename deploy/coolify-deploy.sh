#!/usr/bin/env bash
# Queue the exact published master commit. A queued build is not a completed release.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
SSH_KEY="${GURU_SSH_KEY:-$HOME/.ssh/gainful_deploy}"
HOST="${GURU_DEPLOY_HOST:-deploy@108.61.220.243}"
APP_UUID="${GURU_COOLIFY_APP_UUID:-kk72jd0hcw347wc2qy1nkx8c}"
[[ -r "$SSH_KEY" ]] || { echo "SSH key is not readable" >&2; exit 1; }
[[ "$APP_UUID" =~ ^[a-zA-Z0-9]+$ ]] || { echo "Invalid application UUID" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "Commit local changes before deploying" >&2; exit 1; }
COMMIT=$(git rev-parse HEAD)
PUBLISHED=$(git ls-remote origin refs/heads/master | cut -f1)
[[ "$COMMIT" == "$PUBLISHED" ]] || { echo "HEAD must match published master" >&2; exit 1; }
npm test
DEPLOYMENT=$(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
  "docker exec -i coolify php /dev/stdin '$APP_UUID' '$COMMIT'" <<'PHP'
<?php
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$application = App\Models\Application::where('uuid', $argv[1])->firstOrFail();
$uuid = strtolower(Illuminate\Support\Str::random(24));
$result = queue_application_deployment(application: $application, deployment_uuid: $uuid, commit: $argv[2]);
if (($result['status'] ?? '') !== 'queued') {
    fwrite(STDERR, "Deployment was not queued\n");
    exit(1);
}
echo $uuid.PHP_EOL;
PHP
 )
[[ "$DEPLOYMENT" =~ ^[a-zA-Z0-9]+$ ]] || { echo "Invalid deployment response" >&2; exit 1; }
echo "Waiting for deployment $DEPLOYMENT ($COMMIT)"
deadline=$((SECONDS + 1200))
while (( SECONDS < deadline )); do
  status=$(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
    "docker exec -i coolify php /dev/stdin '$DEPLOYMENT'" <<'PHP'
<?php
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
echo App\Models\ApplicationDeploymentQueue::where('deployment_uuid', $argv[1])->firstOrFail()->status;
PHP
  )
  case "$status" in
    finished) break ;;
    failed|cancelled-by-user|cancelled) echo "Deployment $status" >&2; exit 1 ;;
  esac
  sleep 10
done
[[ "$status" == finished ]] || { echo "Deployment timed out" >&2; exit 1; }
curl --fail --silent --show-error --location --max-time 20 --retry 5 --retry-all-errors \
  "${GURU_HEALTH_URL:-https://guru.alanj.dev/}" -o /dev/null
echo "Deployment finished and HTTP check passed ($COMMIT)"
