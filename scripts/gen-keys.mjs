#!/usr/bin/env node
// Prints fresh secrets for .env. Copy the lines into your .env (never commit them).
import crypto from 'node:crypto';

console.log(`BID_MASTER_KEY=${crypto.randomBytes(32).toString('base64')}`);
console.log(`AUDIT_SIGNING_KEY=${crypto.randomBytes(32).toString('base64url')}`);
