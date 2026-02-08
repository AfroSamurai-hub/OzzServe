# OzzServe GCP Deployment Runbook

Guide to deploying OzzServe API on Google Cloud Run and Cloud SQL (Postgres).

## 1. Project Setup
Enable required APIs:
```bash
gcloud services enable \
    run.googleapis.com \
    sqladmin.googleapis.com \
    artifactregistry.googleapis.com
```

## 2. Cloud SQL Setup
Create a Postgres instance:
```bash
gcloud sql instances create ozzserve-db \
    --database-version=POSTGRES_15 \
    --tier=db-f1-micro \
    --region=europe-west1

# Set the password for the default 'postgres' user
gcloud sql users set-password postgres \
    --instance=ozzserve-db \
    --password=YOUR_SECURE_PASSWORD

# Create the application database
gcloud sql databases create ozzserve --instance=ozzserve-db
```

**Get the Connection Name:**
```bash
gcloud sql instances describe ozzserve-db --format='value(connectionName)'
# Example output: project-id:region:ozzserve-db
```

## 3. Database Migration
For MVP, connect via Cloud SQL Auth Proxy and run schema manually:
```bash
# 1. Start Proxy
./cloud-sql-proxy project-id:region:ozzserve-db

# 2. Run Migration
psql "host=127.0.0.1 port=5432 user=postgres dbname=ozzserve" -f apps/api/db/init.sql
```

## 4. Deploy API to Cloud Run
Build and push the image:
```bash
# 1. Create Repository
gcloud artifacts repositories create ozzserve-repo \
    --repository-format=docker \
    --location=europe-west1

# 2. Build and Deploy
gcloud builds submit --tag europe-west1-docker.pkg.dev/PROJECT_ID/ozzserve-repo/api apps/api

gcloud run deploy ozzserve-api \
    --image europe-west1-docker.pkg.dev/PROJECT_ID/ozzserve-repo/api \
    --add-cloudsql-instances=PROJECT_ID:region:ozzserve-db \
    --update-env-vars="DB_USER=postgres,DB_PASS=YOUR_SECURE_PASSWORD,DB_NAME=ozzserve,DB_HOST=/cloudsql/PROJECT_ID:region:ozzserve-db" \
    --update-env-vars="FIREBASE_CONFIG={...}" \
    --allow-unauthenticated \
    --region=europe-west1
```

## 5. Verification
Check health:
```bash
curl https://[SERVICE_URL]/v1/health
```
Result should be: `{"ok": true}`
