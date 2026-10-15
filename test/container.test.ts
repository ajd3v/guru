import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync("Dockerfile", "utf8");
assert.match(dockerfile, /chown -R node:node \/app\/data \/app\/\.cache/);
assert.match(dockerfile, /USER node\s+#.*\nENTRYPOINT/);
assert.match(readFileSync("deploy/backup-verify.sh", "utf8"), /--user "\$\(id -u\):\$\(id -g\)"/);
assert.match(readFileSync("docker-compose.yml", "utf8"), /GURU_TRUST_PROXY=\$\{GURU_TRUST_PROXY:-1\}/);
console.log("container permissions ok");
