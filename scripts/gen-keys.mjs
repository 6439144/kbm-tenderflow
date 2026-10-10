#!/usr/bin/env node
// Prints fresh secrets for .env (or an OpenShift Secret env file). Copy the lines; never commit them.
//   npm run gen-keys                    BID_MASTER_KEY + AUDIT_SIGNING_KEY (enough for the Windows demo)
//   npm run gen-keys -- --production    also JWT_PRIVATE_KEY_PEM (RSA 3072, one line with \n escapes) and MFA_ENC_KEY,
//                                       as required/recommended with TF_ENV=production
import crypto from 'node:crypto';

console.log(`BID_MASTER_KEY=${crypto.randomBytes(32).toString('base64')}`);
console.log(`AUDIT_SIGNING_KEY=${crypto.randomBytes(32).toString('base64url')}`);
if (process.argv.includes('--production')) {
  console.log(`MFA_ENC_KEY=${crypto.randomBytes(32).toString('base64')}`);
  const pem = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  console.log(`JWT_PRIVATE_KEY_PEM=${pem.trim().replace(/\r?\n/g, '\\n')}`);
}
