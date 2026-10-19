import { existsSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if(existsSync('.env')) {console.log('.env already exists; keeping your existing credentials.');process.exit(0);}
const password=randomBytes(18).toString('base64url');
const secret=()=>randomBytes(32).toString('hex');
writeFileSync('.env',`# Private local configuration. Never commit this file.\nADMIN_USERNAME=admin\nADMIN_NAME=Admin\nADMIN_PASSWORD=${password}\nAGENT_SPARK_TOKEN=${secret()}\nAGENT_SAGE_TOKEN=${secret()}\nWEB_PORT=8080\nCOOKIE_SECURE=false\n`,{mode:0o600});chmodSync('.env',0o600);
console.log('Created private .env with an admin password and separate worker tokens.');
console.log('Username: admin. Read ADMIN_PASSWORD in .env to sign in.');
console.log('Start with: docker compose up --build -d');
