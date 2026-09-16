#!/usr/bin/env bash
# Queue the exact published master commit. A queued build is not a completed release.
set -euo pipefail
SSH_KEY="${GURU_SSH_KEY:-$HOME/.ssh/gainful_deploy}"
HOST="${GURU_DEPLOY_HOST:-deploy@108.61.220.243}"
APP_UUID="${GURU_COOLIFY_APP_UUID:-kk72jd0hcw347wc2qy1nkx8c}"
[[ -r "$SSH_KEY" ]] || { echo "SSH key is not readable" >&2; exit 1; }
[[ "$APP_UUID" =~ ^[a-zA-Z0-9]+$ ]] || { echo "Invalid application UUID" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "Commit local changes before deploying" >&2; exit 1; }
COMMIT=$(git rev-parse HEAD)
PUBLISHED=$(git ls-remote origin refs/heads/master | cut -f1)
[[ "$COMMIT" == "$PUBLISHED" ]] || { echo "HEAD must match published master" >&2; exit 1; }
ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
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
echo json_encode(['deployment' => $uuid, 'commit' => $argv[2], 'status' => 'queued']).PHP_EOL;
PHP
