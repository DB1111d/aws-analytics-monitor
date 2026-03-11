const { CloudWatchClient, GetMetricStatisticsCommand, ListMetricsCommand } = require('@aws-sdk/client-cloudwatch');
const { LambdaClient, ListFunctionsCommand } = require('@aws-sdk/client-lambda');
const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');

const REGION = process.env.AWS_REGION || 'us-east-1';
const cw = new CloudWatchClient({ region: REGION });
const cwGlobal = new CloudWatchClient({ region: 'us-east-1' }); // CloudFront metrics always in us-east-1
const lambda = new LambdaClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Free tier limits
const LIMITS = {
  lambda:     { requests: 1_000_000,   gbSeconds: 400_000 },
  apiGateway: { requests: 1_000_000 },
  // DynamoDB free tier is 25 RCU/WCU *provisioned* — but consumed CU are counted as unit-seconds.
  // For consumed capacity, free tier is effectively unlimited at low scale.
  // We show raw consumed units vs a reasonable monthly budget (25 RCU * 30days * 86400s = 64,800,000).
  dynamodb:   { rcuMonthly: 64_800_000, wcuMonthly: 64_800_000, storageGB: 25 },
  s3:         { storageGB: 5,          getRequests: 20_000, putRequests: 2_000 },
  ses:        { emails: 62_000 },
  cloudfront: { dataTransferGB: 1_024, requests: 10_000_000 },
  cognito:    { mau: 50_000 },
};

function now() { return new Date(); }
function monthStart() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function getMetric(client, namespace, metricName, dimensions, stat = 'Sum') {
  try {
    const res = await client.send(new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: metricName,
      Dimensions: dimensions,
      StartTime: monthStart(),
      EndTime: now(),
      Period: 2592000, // 30 days in seconds
      Statistics: [stat],
    }));
    const points = res.Datapoints || [];
    return points.reduce((sum, p) => sum + (p[stat] || 0), 0);
  } catch (e) {
    console.error(`Metric error ${namespace}/${metricName}:`, e.message);
    return 0;
  }
}

async function getLambdaMetrics() {
  let functions = [];
  let marker;
  do {
    const res = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }));
    functions.push(...(res.Functions || []));
    marker = res.NextMarker;
  } while (marker);

  const perFunction = await Promise.all(functions.map(async fn => {
    const dims = [{ Name: 'FunctionName', Value: fn.FunctionName }];
    const [invocations, errors, duration] = await Promise.all([
      getMetric(cw, 'AWS/Lambda', 'Invocations', dims),
      getMetric(cw, 'AWS/Lambda', 'Errors', dims),
      getMetric(cw, 'AWS/Lambda', 'Duration', dims, 'Sum'), // ms
    ]);
    const memoryMB = fn.MemorySize || 128;
    const gbSeconds = (duration / 1000) * (memoryMB / 1024);
    return {
      name: fn.FunctionName,
      invocations: Math.round(invocations),
      errors: Math.round(errors),
      gbSeconds: Math.round(gbSeconds * 100) / 100,
      memoryMB,
    };
  }));

  const totalInvocations = perFunction.reduce((s, f) => s + f.invocations, 0);
  const totalGbSeconds   = perFunction.reduce((s, f) => s + f.gbSeconds, 0);
  const totalErrors      = perFunction.reduce((s, f) => s + f.errors, 0);

  return {
    total: {
      invocations: totalInvocations,
      invocationsPct: Math.min(100, Math.round(totalInvocations / LIMITS.lambda.requests * 100)),
      gbSeconds: Math.round(totalGbSeconds * 100) / 100,
      gbSecondsPct: Math.min(100, Math.round(totalGbSeconds / LIMITS.lambda.gbSeconds * 100)),
      errors: totalErrors,
      limit: LIMITS.lambda,
    },
    functions: perFunction.sort((a, b) => b.invocations - a.invocations),
  };
}

async function getApiGatewayMetrics() {
  // Try without dimensions first (aggregates all APIs), fall back to 0
  const count = await getMetric(cw, 'AWS/ApiGateway', 'Count', []);
  return {
    requests: Math.round(count),
    requestsPct: Math.min(100, Math.round(count / LIMITS.apiGateway.requests * 100)),
    limit: LIMITS.apiGateway,
  };
}

async function getDynamoDBMetrics() {
  // ConsumedReadCapacityUnits/ConsumedWriteCapacityUnits require a TableName dimension.
  // Discover all tables via ListMetrics first, then sum across them.
  let tableNames = [];
  try {
    const listed = await cw.send(new ListMetricsCommand({
      Namespace: 'AWS/DynamoDB',
      MetricName: 'ConsumedReadCapacityUnits',
    }));
    const seen = new Set();
    for (const m of (listed.Metrics || [])) {
      const dim = (m.Dimensions || []).find(d => d.Name === 'TableName');
      if (dim && !seen.has(dim.Value)) {
        seen.add(dim.Value);
        tableNames.push(dim.Value);
      }
    }
  } catch (e) {
    console.error('DynamoDB ListMetrics error:', e.message);
  }

  let totalRcu = 0, totalWcu = 0;
  if (tableNames.length > 0) {
    const results = await Promise.all(tableNames.map(async table => {
      const dims = [{ Name: 'TableName', Value: table }];
      const [rcu, wcu] = await Promise.all([
        getMetric(cw, 'AWS/DynamoDB', 'ConsumedReadCapacityUnits', dims, 'Sum'),
        getMetric(cw, 'AWS/DynamoDB', 'ConsumedWriteCapacityUnits', dims, 'Sum'),
      ]);
      return { rcu, wcu };
    }));
    totalRcu = results.reduce((s, r) => s + r.rcu, 0);
    totalWcu = results.reduce((s, r) => s + r.wcu, 0);
  }

  return {
    rcu: Math.round(totalRcu),
    rcuPct: Math.min(100, Math.round(totalRcu / LIMITS.dynamodb.rcuMonthly * 100)),
    wcu: Math.round(totalWcu),
    wcuPct: Math.min(100, Math.round(totalWcu / LIMITS.dynamodb.wcuMonthly * 100)),
    storageGB: null,
    limit: LIMITS.dynamodb,
  };
}

// All S3 storage classes that publish BucketSizeBytes
const S3_STORAGE_TYPES = [
  'StandardStorage',
  'IntelligentTieringFAStorage',
  'IntelligentTieringIAStorage',
  'IntelligentTieringAAStorage',
  'IntelligentTieringAIAStorage',
  'IntelligentTieringDAAStorage',
  'StandardIAStorage',
  'StandardIASizeOverhead',
  'OneZoneIAStorage',
  'OneZoneIASizeOverhead',
  'ReducedRedundancyStorage',
  'GlacierInstantRetrievalStorage',
  'GlacierStorage',
  'GlacierStagingStorage',
  'GlacierObjectOverhead',
  'GlacierS3ObjectOverhead',
  'DeepArchiveStorage',
  'DeepArchiveObjectOverhead',
  'DeepArchiveS3ObjectOverhead',
  'DeepArchiveStagingStorage',
];

async function getS3Metrics() {
  let totalSizeBytes = 0;
  try {
    const bucketsRes = await s3.send(new ListBucketsCommand({}));
    const buckets = bucketsRes.Buckets || [];

    // For each bucket, sum across all storage classes
    const bucketSizes = await Promise.all(buckets.map(async b => {
      const classBytes = await Promise.all(S3_STORAGE_TYPES.map(storageType => {
        // BucketSizeBytes only publishes with 'Average' stat
        return getMetric(cw, 'AWS/S3', 'BucketSizeBytes', [
          { Name: 'BucketName',   Value: b.Name },
          { Name: 'StorageType',  Value: storageType },
        ], 'Average').catch(() => 0);
      }));
      return classBytes.reduce((s, v) => s + v, 0);
    }));

    totalSizeBytes = bucketSizes.reduce((s, v) => s + v, 0);
  } catch (e) {
    console.error('S3 error:', e.message);
  }

  const storageGB = totalSizeBytes / (1024 ** 3);
  const storageMB = totalSizeBytes / (1024 ** 2);
  return {
    storageGB: Math.round(storageGB * 1000) / 1000,
    storageMB: Math.round(storageMB * 10) / 10,  // 1 decimal place
    storageGBPct: Math.min(100, Math.round(storageGB / LIMITS.s3.storageGB * 100)),
    limit: LIMITS.s3,
  };
}

async function getSESMetrics() {
  // SES 'Send' metric requires no dimensions.
  // Some regions may not publish at all if no emails have been sent.
  const sent = await getMetric(cw, 'AWS/SES', 'Send', []);
  return {
    emails: Math.round(sent),
    emailsPct: Math.min(100, Math.round(sent / LIMITS.ses.emails * 100)),
    limit: LIMITS.ses,
  };
}

async function getCloudFrontMetrics() {
  // CloudFront metrics require a DistributionId dimension, not 'Region: Global'.
  // We list all distributions via CloudWatch metrics to find valid DistributionIds,
  // then sum across all of them.
  let distributionIds = [];
  try {
    const listed = await cwGlobal.send(new ListMetricsCommand({
      Namespace: 'AWS/CloudFront',
      MetricName: 'Requests',
    }));
    const seen = new Set();
    for (const m of (listed.Metrics || [])) {
      const dim = (m.Dimensions || []).find(d => d.Name === 'DistributionId');
      if (dim && !seen.has(dim.Value)) {
        seen.add(dim.Value);
        distributionIds.push(dim.Value);
      }
    }
  } catch (e) {
    console.error('CloudFront ListMetrics error:', e.message);
  }

  if (distributionIds.length === 0) {
    // No distributions found — return zeros
    return {
      dataTransferGB: 0,
      dataTransferPct: 0,
      requests: 0,
      requestsPct: 0,
      limit: LIMITS.cloudfront,
    };
  }

  // Sum metrics across all distributions
  const results = await Promise.all(distributionIds.map(async id => {
    const dims = [
      { Name: 'DistributionId', Value: id },
      { Name: 'Region',         Value: 'Global' },
    ];
    const [bytes, reqs] = await Promise.all([
      getMetric(cwGlobal, 'AWS/CloudFront', 'BytesDownloaded', dims),
      getMetric(cwGlobal, 'AWS/CloudFront', 'Requests',        dims),
    ]);
    return { bytes, reqs };
  }));

  const totalBytes = results.reduce((s, r) => s + r.bytes, 0);
  const totalReqs  = results.reduce((s, r) => s + r.reqs,  0);
  const dataGB = totalBytes / (1024 ** 3);

  return {
    dataTransferGB: Math.round(dataGB * 100) / 100,
    dataTransferPct: Math.min(100, Math.round(dataGB / LIMITS.cloudfront.dataTransferGB * 100)),
    requests: Math.round(totalReqs),
    requestsPct: Math.min(100, Math.round(totalReqs / LIMITS.cloudfront.requests * 100)),
    limit: LIMITS.cloudfront,
  };
}

async function getCognitoMetrics() {
  // NOTE: Cognito MAU (Monthly Active Users) metrics via CloudWatch are only available
  // on the Cognito paid/advanced tier. If you are on the free tier, this metric will
  // always return 0 — Cognito does NOT publish SignInSuccesses to CloudWatch on the free plan.
  // See: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-advanced-security.html
  //
  // TODO: Set your Cognito User Pool ID via the COGNITO_USER_POOL_ID environment variable,
  // or replace the process.env reference below with your pool ID string.
  const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
  if (!USER_POOL_ID) {
    console.warn('COGNITO_USER_POOL_ID environment variable not set — skipping Cognito metrics');
    return { mau: 0, mauPct: 0, limit: LIMITS.cognito, note: 'Set COGNITO_USER_POOL_ID env var to enable' };
  }

  const dims = [{ Name: 'UserPoolId', Value: USER_POOL_ID }];
  const mau = await getMetric(cw, 'AWS/Cognito', 'SignInSuccesses', dims);

  return {
    mau: Math.round(mau),
    mauPct: Math.min(100, Math.round(mau / LIMITS.cognito.mau * 100)),
    limit: LIMITS.cognito,
    note: 'Reflects sign-in successes this month as MAU proxy',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const [lambdaData, apiGateway, dynamodb, s3Data, ses, cloudfront, cognito] = await Promise.all([
      getLambdaMetrics().catch(e => {
        console.error('Lambda metrics error:', e.message);
        return { total: { invocations: 0, invocationsPct: 0, gbSeconds: 0, gbSecondsPct: 0, errors: 0, limit: LIMITS.lambda }, functions: [] };
      }),
      getApiGatewayMetrics().catch(e => {
        console.error('APIGW metrics error:', e.message);
        return { requests: 0, requestsPct: 0, limit: LIMITS.apiGateway };
      }),
      getDynamoDBMetrics().catch(e => {
        console.error('DDB metrics error:', e.message);
        return { rcu: 0, rcuPct: 0, wcu: 0, wcuPct: 0, storageGB: null, limit: LIMITS.dynamodb };
      }),
      getS3Metrics().catch(e => {
        console.error('S3 metrics error:', e.message);
        return { storageGB: 0, storageGBPct: 0, limit: LIMITS.s3 };
      }),
      getSESMetrics().catch(e => {
        console.error('SES metrics error:', e.message);
        return { emails: 0, emailsPct: 0, limit: LIMITS.ses };
      }),
      getCloudFrontMetrics().catch(e => {
        console.error('CF metrics error:', e.message);
        return { dataTransferGB: 0, dataTransferPct: 0, requests: 0, requestsPct: 0, limit: LIMITS.cloudfront };
      }),
      getCognitoMetrics().catch(e => {
        console.error('Cognito metrics error:', e.message);
        return { mau: 0, mauPct: 0, limit: LIMITS.cognito, note: 'Could not load' };
      }),
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        generatedAt: now().toISOString(),
        monthStart: monthStart().toISOString(),
        lambda: lambdaData,
        apiGateway,
        dynamodb,
        s3: s3Data,
        ses,
        cloudfront,
        cognito,
      }),
    };
  } catch (err) {
    console.error('Usage error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
