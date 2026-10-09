#!/usr/bin/env node
/**
 * TenderFlow v0.9.0 - CycloneDX SBOM Generator (Agent A6 / Task T01)
 * Generates an Enterprise Software Bill of Materials (SBOM) for IBM ESA Review.
 */
import fs from 'fs';
import path from 'path';

const rootPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:tenderflow-0.9.0-${Date.now()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      name: rootPkg.name,
      version: rootPkg.version,
      description: rootPkg.description,
      author: rootPkg.author
    },
    tools: [
      { vendor: 'KBM', name: 'TenderFlow SBOM Generator', version: '0.9.0' }
    ]
  },
  components: []
};

// Traverse workspace packages
const workspaceDirs = ['services/api', 'apps/web'];

for (const ws of workspaceDirs) {
  const wsPkgPath = path.join(ws, 'package.json');
  if (fs.existsSync(wsPkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(wsPkgPath, 'utf8'));
    sbom.components.push({
      type: 'library',
      name: pkg.name,
      version: pkg.version,
      description: pkg.description || '',
      scope: 'required',
      purl: `pkg:npm/${pkg.name}@${pkg.version}`
    });

    if (pkg.dependencies) {
      for (const [dep, ver] of Object.entries(pkg.dependencies)) {
        if (!dep.startsWith('@tenderflow/')) {
          sbom.components.push({
            type: 'library',
            name: dep,
            version: ver,
            scope: 'required',
            purl: `pkg:npm/${dep}@${ver}`
          });
        }
      }
    }
  }
}

// Deduplicate components by purl
const uniqueComponents = [];
const seenPurls = new Set();
for (const comp of sbom.components) {
  if (!seenPurls.has(comp.purl)) {
    seenPurls.add(comp.purl);
    uniqueComponents.push(comp);
  }
}
sbom.components = uniqueComponents;

const outPath = path.join(process.cwd(), 'tenderflow-sbom.json');
fs.writeFileSync(outPath, JSON.stringify(sbom, null, 2), 'utf8');

console.log(`>>> Generated CycloneDX 1.5 SBOM with ${sbom.components.length} components.`);
console.log(`Written to: ${outPath}`);
