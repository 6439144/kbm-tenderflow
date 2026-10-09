# FileNet Content Services Provisioning Scripts

This directory contains automated provisioning scripts to rebuild IBM FileNet Content Manager classes, property definitions, and folder taxonomy from scratch on an empty TechZone reservation.

## Environment Variables
Before running provisioning, configure the following environment variables:
```bash
export CONTENT_GRAPHQL_URL="https://techzone-content.example.com/content-services-graphql/api"
export CONTENT_REPO_ID="OS01"
export CONTENT_STORE_USERNAME="p8admin"
export CONTENT_STORE_PASSWORD="password"
```

## Running the Provisioning Script
```bash
node services/content-adapter/provision/provision-classes.js
```

## What it Provisions
1. **Document Class**: `TenderFlowDocument` (subclass of `Document`)
2. **Custom Properties**:
   - `TenantId` (String, length 64)
   - `TenderId` (String, length 64)
   - `VendorId` (String, length 64)
   - `DocumentType` (String, length 64)
   - `ChecksumSha256` (String, length 64)
   - `EnvelopeEncrypted` (Boolean)
3. **Folder Structure**:
   - `/TenderFlow`
   - `/TenderFlow/Tenants`
   - `/TenderFlow/Templates`
