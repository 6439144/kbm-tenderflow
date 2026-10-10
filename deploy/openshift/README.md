# TenderFlow on Red Hat OpenShift (Kustomize)

The full procedure, including PostgreSQL, backups, key rotation, upgrades and troubleshooting, is in
[docs/INSTALLATION-AND-OPERATIONS.md](../../docs/INSTALLATION-AND-OPERATIONS.md). This page covers the manifests.

```
deploy/openshift/
├── base/                       shared resources (do not apply directly)
│   ├── kustomization.yaml      ConfigMap generator `tenderflow-config`, image name, common labels
│   ├── deployment.yaml         probes, resources, non-root securityContext, /data and /tmp volumes
│   ├── service.yaml            ClusterIP :4000
│   ├── route.yaml              edge TLS, http → https redirect, 120 s router timeout, HSTS
│   ├── pvc.yaml                /data, ReadWriteOnce 5 Gi
│   ├── networkpolicy.yaml      ingress only from the OpenShift router namespace
│   ├── pdb.yaml                maxUnavailable 1
│   └── secret.template.yaml    placeholders only, NOT applied (see "Secret")
└── overlays/
    ├── demo/                   1 pod, Recreate, embedded PGlite on the PVC, TF_ENV=demo, DEMO_MODE + SEED_DEMO,
    │                           TENANCY_MODE=shared (KBM's three-entity demo)
    └── production/             2 pods, PostgreSQL, FileNet, TF_ENV=production, TRUST_PROXY=1, ReadWriteMany PVC,
                                TENANCY_MODE=dedicated + ENTITY_ID (set it: one installation per entity)
```

**One installation per government entity** ([docs/DEPLOYMENT-MODEL.md](../../docs/DEPLOYMENT-MODEL.md)): apply the
production overlay once per entity, each in its own namespace (`tenderflow-<code>`) with its own Secret, database and
FileNet object store (or root folder), and `ENTITY_ID=<code>` in the ConfigMap.

## What the manifests guarantee

| Concern | How |
|---|---|
| Non-root, arbitrary UID | No `runAsUser`; `runAsNonRoot`, all capabilities dropped, no privilege escalation, seccomp `RuntimeDefault`, read-only root filesystem. The image makes `/data` writable by group 0, which OpenShift's restricted-v2 SCC assigns. `/tmp` is an `emptyDir`. |
| Probes | `startupProbe` `/health` (up to 5 min for migrations and the first demo seed) · `readinessProbe` `/ready` (database reachable, every migration applied, content store reachable; 503 while draining) · `livenessProbe` `/health` (no database call, so a database outage does not restart pods). |
| Shutdown | `terminationGracePeriodSeconds: 45`. On SIGTERM the API answers `/ready` with 503 for `SHUTDOWN_DELAY_MS` (5 s), stops accepting connections, lets in-flight requests finish for up to `SHUTDOWN_TIMEOUT_MS` (25 s), stops background jobs and closes the database. |
| Several pods | Migrations run under a PostgreSQL advisory lock (pods starting together wait for each other). The token signing key is created once (insert-if-absent). Background jobs take a database lease, so each job runs on one pod at a time. Tender closing is a guarded `UPDATE … WHERE status='PUBLISHED'`, safe on every pod. |
| Demo safety | PGlite is single-process: the demo overlay pins `replicas: 1` and `strategy: Recreate` so two pods never open the same database files. |
| Production safety | `TF_ENV=production`: the API refuses to start on any unsafe setting and lists every reason (see `npm run config:check`). |

## Build the image

The `Containerfile` is a two-stage UBI 9 build (`ubi9/nodejs-22` → `ubi9/nodejs-22-minimal`).

```bash
# Option A: build inside OpenShift (binary Docker-strategy build from your working copy)
oc new-build --name tenderflow --strategy docker --binary
oc patch bc/tenderflow -p '{"spec":{"strategy":{"dockerStrategy":{"dockerfilePath":"Containerfile"}}}}'
oc start-build tenderflow --from-dir . --follow \
  --build-arg TF_VERSION=1.0.0-rc3 --build-arg TF_COMMIT=$(git rev-parse HEAD) \
  --build-arg TF_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
oc tag tenderflow:latest tenderflow:1.0.0-rc3

# Option B: Podman, then push to your registry and set `images:` in the overlay
podman build -f Containerfile -t quay.example.com/kbm/tenderflow:1.0.0-rc3 --build-arg TF_COMMIT=$(git rev-parse HEAD) .
podman push quay.example.com/kbm/tenderflow:1.0.0-rc3
```

The overlays reference `image-registry.openshift-image-registry.svc:5000/<namespace>/tenderflow:1.0.0-rc3`; change the
`images:` entry of your overlay if the namespace, registry or tag differ.

## Secret

`tenderflow-secrets` is never created by Kustomize, so no placeholder can reach a cluster. Write a local env file (never
commit it), then:

```bash
npm run gen-keys -- --production > tenderflow-secrets.env     # BID_MASTER_KEY, AUDIT_SIGNING_KEY, MFA_ENC_KEY, JWT_PRIVATE_KEY_PEM
# add DATABASE_URL, FILENET_*, WXO_*, SMTP_PASS, … (see base/secret.template.yaml for the list)
oc create secret generic tenderflow-secrets --from-env-file=tenderflow-secrets.env
```

Demo: `BID_MASTER_KEY`, `AUDIT_SIGNING_KEY` and `DEMO_PASSWORD` are enough. Keep a copy of the keys in your vault:
without the same `BID_MASTER_KEY` a database backup cannot open sealed bids, and without `AUDIT_SIGNING_KEY` the
audit chain cannot be verified.

## Apply

```bash
# check the configuration first with the same values the pod will get
oc run tf-config-check --rm -it --restart=Never --image=<image> \
  --overrides='{"spec":{"containers":[{"name":"tf-config-check","image":"<image>","command":["node","services/api/dist/tools/config-check.js"],"envFrom":[{"secretRef":{"name":"tenderflow-secrets"}}],"env":[{"name":"TF_ENV","value":"production"},{"name":"PUBLIC_BASE_URL","value":"https://tenders.entity.example.gov.kw"},{"name":"TRUST_PROXY","value":"1"},{"name":"CONTENT_STORE_TYPE","value":"filenet"}]}]}}'

oc apply -k deploy/openshift/overlays/production        # or overlays/demo
oc rollout status deploy/tenderflow
oc get route tenderflow -o jsonpath='{.spec.host}'
```

Set `PUBLIC_BASE_URL` in the overlay's `configMapGenerator` to the exact `https://` URL of the Route (it is the token
issuer and the base of links in e-mails). To use your own host name add `spec.host` to the Route with a patch.

## Create the first entity

```bash
oc exec deploy/tenderflow -- node services/api/dist/tools/entity-create.js \
  --code moh --name-en "Ministry of Health (example)" --name-ar "وزارة الصحة (مثال)" --default-template PUBLIC_TENDER
```

The one-time administrator password is printed once. With the demo overlay (PGlite) scale to 0 first and run the
command in a one-off pod on the same PVC, because PGlite allows one process per data directory.

## Optional hardening

* **Egress policy:** add a NetworkPolicy with `policyTypes: [Egress]` allowing DNS, the PostgreSQL service, the FileNet
  and Orchestrate endpoints, and the mail/SMS relays used at your site.
* **Autoscaling:** a HorizontalPodAutoscaler on CPU works with the production overlay (keep `minReplicas: 2`).
* **FileNet as the only document store:** with `CONTENT_STORE_TYPE=filenet`, `/data` keeps only evidence reports;
  you may replace the ReadWriteMany claim with an `emptyDir`.
