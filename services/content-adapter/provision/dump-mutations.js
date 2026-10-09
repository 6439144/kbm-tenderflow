import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Load .env cleanly without hardcoding secrets
if (typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(path.resolve(process.cwd(), '.env'));
}

async function dumpMutations() {
  const url = process.env.FILENET_GRAPHQL_URL;
  const user = process.env.FILENET_SERVICE_USER;
  const pass = process.env.FILENET_SERVICE_PASSWORD;

  if (!url || !user || !pass) {
    console.error('Missing FILENET_GRAPHQL_URL, FILENET_SERVICE_USER, or FILENET_SERVICE_PASSWORD in .env');
    process.exit(1);
  }

  const xsrf = crypto.randomUUID();
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  const query = {
    query: `
      query {
        __schema {
          mutationType {
            name
            fields {
              name
              description
              args {
                name
                type {
                  name
                  kind
                }
              }
            }
          }
        }
      }
    `
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`,
      'ECM-CS-XSRF-Token': xsrf,
      'Cookie': `ECM-CS-XSRF-Token=${xsrf}`
    },
    body: JSON.stringify(query)
  });

  if (!res.ok) {
    console.error(`GraphQL query failed with status ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const data = await res.json();
  if (data.errors) {
    console.error('GraphQL errors:', JSON.stringify(data.errors, null, 2));
    process.exit(1);
  }

  const fields = data.data?.__schema?.mutationType?.fields || [];
  const lines = fields.map(f => {
    const args = f.args.map(a => `${a.name}: ${a.type?.name || a.type?.kind}`).join(', ');
    return `${f.name}(${args}): ${f.description || ''}`;
  });

  const outDir = path.resolve(process.cwd(), 'docs/evidence/G2-b');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'mutations.txt'), lines.join('\n'), 'utf8');

  console.log(`Saved ${fields.length} mutations to docs/evidence/G2-b/mutations.txt`);
}

dumpMutations().catch(err => {
  console.error('Error dumping mutations:', err.message);
  process.exit(1);
});
