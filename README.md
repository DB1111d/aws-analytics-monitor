# AWS Analytics Monitor

A lightweight, self-hosted website analytics platform built entirely on the AWS free tier. AWS Analytics Monitor tracks page views, visitor sessions, click events, and referrers across one or more websites — and includes a built-in AWS free tier usage monitor so you can keep an eye on your cloud costs.

---

## Features

- **Session-level visitor tracking** — page views, clicks, time on page, and page leave events grouped by visitor and session
- **Referrer analysis** — see where your traffic is coming from
- **Geo data** — visitor location (country, region, city) with flag display
- **Device & OS detection** — desktop/mobile/tablet breakdown with OS icons
- **Multi-site support** — track as many sites as you want from a single dashboard
- **Time range filtering** — 24h, 7d, and 30d views
- **AWS free tier monitor** — live dashboard showing usage vs. limits for Lambda, API Gateway, DynamoDB, S3, SES, CloudFront, and Cognito
- **Cognito authentication** — the dashboard is login-protected; no public access to your data
- **Bot filtering** — heuristic filtering of obvious bot traffic from the session view

---

## Architecture

```
Your Website(s)
      │
      │  beacon tracker script (JS snippet)
      ▼
API Gateway  ──►  Lambda (ingest)  ──►  DynamoDB
                                             │
Dashboard (index.html)                       │
      │                                      │
      │  fetch /stats                        │
      ▼                                      ▼
API Gateway  ──►  Lambda (query)  ◄──  DynamoDB
      │
      │  fetch /aws-usage
      ▼
Lambda (aws-usage)  ──►  CloudWatch Metrics
```

All components run within the AWS free tier for low-traffic personal or portfolio sites.

---

## Repository Structure

```
aws-analytics-monitor/
├── index.html                    # Dashboard frontend (single-file, no build step)
├── beacon-query/
│   └── index.js                  # Lambda: queries DynamoDB and returns analytics data
├── beacon-aws-usage/
│   └── index.js                  # Lambda: polls CloudWatch and returns free tier usage
└── beaconanalytics-custom/
    └── index.js                  # CDK custom resource helper (auto-generated, S3 cleanup)
```

---

## Prerequisites

- An [AWS account](https://aws.amazon.com/free/)
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) configured with appropriate permissions
- [Node.js](https://nodejs.org/) 18+ (for Lambda runtimes and local testing)
- Basic familiarity with the AWS Console

---

## Setup Guide

### Step 1 — DynamoDB Table

Create a DynamoDB table to store analytics events.

1. Go to **DynamoDB → Tables → Create table**
2. Set the following:
   - **Table name:** `beacon-events` (or any name you prefer)
   - **Partition key:** `siteDate` (String)
   - **Sort key:** `timestamp` (String)
3. Leave capacity mode as **On-demand** (free tier friendly)
4. Note your table name — you'll use it as a Lambda environment variable

**How the key structure works:**
- `siteDate` stores values like `example.com#2025-03-11` (site + date), which allows efficient range queries per site per day
- `timestamp` stores values like `2025-03-11T14:23:01.000Z#<uuid>` (ISO timestamp + unique suffix)

---

### Step 2 — Cognito User Pool (Dashboard Auth)

The dashboard uses Amazon Cognito for login. This keeps your analytics data private.

1. Go to **Cognito → User Pools → Create user pool**
2. Configure:
   - Sign-in: **Email**
   - Password policy: your preference
   - MFA: optional
   - Self-registration: **disabled** (you don't want strangers signing up)
3. Under **App clients**, create a new app client:
   - **App type:** Public client
   - **Auth flows:** Enable `ALLOW_USER_PASSWORD_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH`
   - Disable client secret
4. Note down:
   - **User Pool ID** (e.g. `us-east-1_AbCdEfGhI`)
   - **App Client ID** (e.g. `1abc2defghij3klmno4pqrst`)
   - **Region**

5. Create yourself a user:
   - Go to **Users → Create user**
   - Enter your email, set a temporary password
   - After first login you'll be prompted to set a permanent password

---

### Step 3 — Lambda Functions

#### 3a. beacon-query (Analytics Query)

This function reads events from DynamoDB and returns processed analytics data.

1. Go to **Lambda → Create function**
2. **Runtime:** Node.js 20.x
3. Upload or paste the contents of `beacon-query/index.js`
4. Set **Environment variables:**
   - `TABLE_NAME` = your DynamoDB table name (e.g. `beacon-events`)
5. Set **Timeout** to at least 10 seconds (30 recommended for 30d queries)
6. Attach an **IAM role** with these permissions:
   ```json
   {
     "Effect": "Allow",
     "Action": ["dynamodb:Query"],
     "Resource": "arn:aws:dynamodb:REGION:ACCOUNT_ID:table/YOUR_TABLE_NAME"
   }
   ```

#### 3b. beacon-aws-usage (AWS Free Tier Monitor)

This function reads CloudWatch metrics and returns free tier usage data.

1. Go to **Lambda → Create function**
2. **Runtime:** Node.js 20.x
3. Upload or paste the contents of `beacon-aws-usage/index.js`
4. Set **Environment variables:**
   - `COGNITO_USER_POOL_ID` = your User Pool ID (e.g. `us-east-1_AbCdEfGhI`)
5. Set **Timeout** to at least 30 seconds (it makes many CloudWatch API calls in parallel)
6. Attach an **IAM role** with these permissions:
   ```json
   {
     "Effect": "Allow",
     "Action": [
       "cloudwatch:GetMetricStatistics",
       "cloudwatch:ListMetrics",
       "lambda:ListFunctions",
       "s3:ListAllMyBuckets",
       "s3:GetBucketTagging",
       "cognito-idp:DescribeUserPool"
     ],
     "Resource": "*"
   }
   ```

> **Note:** The `beacon-aws-usage` Lambda needs a broader IAM role because it introspects your AWS account. Scope it down further if you prefer.

---

### Step 4 — API Gateway

Create a single REST API with two routes.

1. Go to **API Gateway → Create API → REST API**
2. Create a resource `/stats` with a **GET** method pointing to your `beacon-query` Lambda
3. Create a resource `/aws-usage` with a **GET** method pointing to your `beacon-aws-usage` Lambda
4. Enable **CORS** on both resources (required for browser requests):
   - Allow origin: `*` (or your specific dashboard domain)
   - Allow headers: `Content-Type`
   - Allow methods: `GET, OPTIONS`
5. **Deploy** the API to a stage named `prod`
6. Note your **Invoke URL** (e.g. `https://abc123.execute-api.us-east-1.amazonaws.com/prod`)

---

### Step 5 — Configure the Dashboard

Open `index.html` and update the `CONFIG` section at the top of the `<script>` block:

```javascript
// ─── CONFIG ───────────────────────────────────────────
const STATS_API = 'https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com/prod/stats';
const USAGE_API = 'https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com/prod/aws-usage';

const SITES = [
  { id: 'example.com',       label: 'example.com' },
  { id: 'another-site.com',  label: 'Another Site' },
  // Add as many sites as you want
];

const COGNITO_REGION    = 'us-east-1';           // Your region
const COGNITO_POOL_ID   = 'us-east-1_AbCdEfGhI'; // Your User Pool ID
const COGNITO_CLIENT_ID = '1abc2defghij...';      // Your App Client ID
// ──────────────────────────────────────────────────────
```

The `id` field in each `SITES` entry must exactly match the `site` value your tracker sends. See Step 6.

---

### Step 6 — Add the Tracker to Your Website(s)

You need a Lambda (or any HTTP endpoint) to receive tracking events and write them to DynamoDB. The ingest Lambda is not included in this repo (it's site-specific), but the expected DynamoDB record format is:

| Attribute       | Type   | Description |
|----------------|--------|-------------|
| `siteDate`     | String | `"example.com#2025-03-11"` |
| `timestamp`    | String | `"2025-03-11T14:23:01.000Z#<uuid>"` |
| `eventType`    | String | `"pageview"`, `"click"`, or `"pageleave"` |
| `visitorHash`  | String | Anonymised visitor identifier (hashed IP or fingerprint) |
| `sessionId`    | String | UUID for this browser session |
| `path`         | String | URL path, e.g. `"/about"` |
| `referrer`     | String | Full referrer URL or `"direct"` |
| `device`       | String | `"desktop"`, `"mobile"`, or `"tablet"` |
| `os`           | String | `"Mac"`, `"Windows"`, `"iOS"`, etc. |
| `country`      | String | Country name, e.g. `"United States"` |
| `countryCode`  | String | ISO-2 code, e.g. `"US"` |
| `region`       | String | State/region name |
| `city`         | String | City name |
| `duration`     | Number | (pageleave only) milliseconds on page |
| `elementText`  | String | (click only) visible text of clicked element |
| `elementHref`  | String | (click only) href of clicked element |
| `elementTag`   | String | (click only) HTML tag of clicked element |

A minimal tracker script on your site should:
1. Generate or retrieve a `visitorHash` (e.g. from localStorage)
2. Generate a `sessionId` per browser session
3. `POST` or `GET` the ingest endpoint on `pageview`, `click`, and `beforeunload` events
4. Pass `site=example.com` (matching the `id` in your dashboard config)

---

### Step 7 — Deploy the Dashboard

`index.html` is a single self-contained file with no build step required.

**Options:**
- **S3 + CloudFront** — upload `index.html` to an S3 bucket configured for static website hosting, then put CloudFront in front of it
- **Any static host** — Netlify, Vercel, GitHub Pages, etc.
- **Local** — just open `index.html` directly in a browser for local use

---

## Environment Variables Reference

| Function | Variable | Description |
|---|---|---|
| `beacon-query` | `TABLE_NAME` | DynamoDB table name |
| `beacon-aws-usage` | `AWS_REGION` | AWS region (defaults to `us-east-1`) |
| `beacon-aws-usage` | `COGNITO_USER_POOL_ID` | Cognito User Pool ID for MAU tracking |

---

## AWS Free Tier Limits Tracked

| Service | Free Tier Limit |
|---|---|
| Lambda | 1M requests / month, 400,000 GB-seconds / month |
| API Gateway | 1M API calls / month |
| DynamoDB | 25 RCU / 25 WCU provisioned capacity |
| S3 | 5 GB storage |
| SES | 62,000 emails / month |
| CloudFront | 1 TB data transfer / 10M requests / month |
| Cognito | 50,000 MAU / month ⚠️ See note below |

> **⚠️ Cognito MAU tracking requires a paid Cognito feature.**
> The CloudWatch `SignInSuccesses` metric is only published when **Advanced Security Features** are enabled on your User Pool — this is a paid Cognito add-on and is **not available on the free tier**. If you are on the free tier, the Cognito panel in the AWS Usage dashboard will always show 0 MAU. This is a Cognito limitation, not a bug in AWS Analytics Monitor.
> The usage dashboard auto-discovers your Lambda functions, DynamoDB tables, S3 buckets, and CloudFront distributions — no manual configuration needed beyond the Cognito pool ID.

---

## Security Notes

- The dashboard is protected by Cognito login — only users you create in your User Pool can sign in
- Session tokens are stored in `sessionStorage` and cleared on tab close
- Analytics data is only accessible through your authenticated API Gateway endpoints
- Self-registration is disabled by default in the setup above
- Visitor hashing should be done server-side or using a privacy-preserving method — avoid storing raw IP addresses

---

## License

MIT
