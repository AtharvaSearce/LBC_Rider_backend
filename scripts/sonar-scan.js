require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const token = process.env.SONAR_TOKEN;

if (!token) {
  console.error('SONAR_TOKEN is required. Add it to .env or export it in your shell.');
  process.exit(1);
}

const args = ['sonar', `-Dsonar.token=${token}`];

if (process.env.SONAR_HOST_URL) {
  args.push(`-Dsonar.host.url=${process.env.SONAR_HOST_URL}`);
}
if (process.env.SONAR_ORGANIZATION) {
  args.push(`-Dsonar.organization=${process.env.SONAR_ORGANIZATION}`);
}
if (process.env.SONAR_PROJECT_KEY) {
  args.push(`-Dsonar.projectKey=${process.env.SONAR_PROJECT_KEY}`);
}

const result = spawnSync('npx', args, { cwd: root, stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
