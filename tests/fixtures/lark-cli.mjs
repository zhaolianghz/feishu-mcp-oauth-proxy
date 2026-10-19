#!/usr/bin/env node
// External CLI boundary fixture. All identity state/routing remains production code.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const home = process.env.HOME;
const configFile = path.join(home, '.lark-cli/config.json');
const flag = (name) => args[args.indexOf(name) + 1];
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
let config;
try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { config = {}; }
if (args[0] === 'config') {
  let secret = '';
  for await (const part of process.stdin) secret += part;
  if (!secret.trim() || flag('--app-id') === 'cli_bad') process.exit(1);
  config = { appId: flag('--app-id') };
  write(configFile, JSON.stringify(config));
  write(path.join(home, '.local/share/lark-cli/master.key'), 'fixture-key');
  write(path.join(home, '.local/share/lark-cli/appsecret_fixture.enc'), 'fixture-encrypted-secret');
  console.log(JSON.stringify({ appId: config.appId, appSecret: '****', brand: 'feishu' }));
} else if (args.includes('--no-wait')) {
  console.log(JSON.stringify({ device_code: 'device-' + config.appId,
    verification_url: 'https://accounts.feishu.cn/user-authorize?app=' + config.appId, expires_in: 600 }));
} else if (args.includes('--device-code')) {
  if (config.appId === 'cli_slow') await new Promise((resolve) => setTimeout(resolve, 250));
  if (config.appId === 'cli_denied') process.exit(1);
  write(path.join(home, 'authorized'), 'yes');
  console.log('{}');
} else if (args[0] === 'api') {
  if (!fs.existsSync(path.join(home, 'authorized'))) process.exit(1);
  console.log(JSON.stringify({ ok: true, data: {
    open_id: 'ou_' + config.appId, tenant_key: 'tenant_' + config.appId, name: '赵亮',
  } }));
} else if (args[1] === 'status') {
  console.log(JSON.stringify({ appId: config.appId, identities: {
    user: { status: fs.existsSync(path.join(home, 'authorized')) ? 'ready' : 'missing', scope: 'docs:read offline_access' },
  } }));
} else process.exit(1);
