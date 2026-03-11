const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');

const client = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { site, range = '24h' } = event.queryStringParameters || {};

    if (!site) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'site is required' }) };
    }

    const now = new Date();
    const dates = [];

    if (range === '24h') {
      dates.push(formatDate(now));
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      dates.push(formatDate(yesterday));
    } else if (range === '7d') {
      for (let i = 0; i < 7; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        dates.push(formatDate(d));
      }
    } else if (range === '30d') {
      for (let i = 0; i < 30; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        dates.push(formatDate(d));
      }
    }

    const allItems = [];
    for (const date of dates) {
      const result = await client.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'siteDate = :sd',
        ExpressionAttributeValues: {
          ':sd': { S: `${site}#${date}` },
        },
      }));
      allItems.push(...(result.Items || []));
    }

    const cutoff = new Date(now);
    if (range === '24h') cutoff.setHours(cutoff.getHours() - 24);
    else if (range === '7d') cutoff.setDate(cutoff.getDate() - 7);
    else if (range === '30d') cutoff.setDate(cutoff.getDate() - 30);

    const parseTs = (raw) => new Date(raw.split('#')[0]);

    const items = allItems.filter(item => parseTs(item.timestamp.S) >= cutoff);

    const pageviews   = items.filter(i => (i.eventType?.S || 'pageview') === 'pageview');
    const leaveEvents = items.filter(i => i.eventType?.S === 'pageleave');
    const clickEvents = items.filter(i => i.eventType?.S === 'click');

    // ── Unique visitors ──
    const uniqueVisitors = new Set(pageviews.map(i => i.visitorHash?.S)).size;

    // ── Top pages ──
    const pageCounts = {};
    pageviews.forEach(i => {
      const p = i.path?.S || '/';
      pageCounts[p] = (pageCounts[p] || 0) + 1;
    });
    const topPages = Object.entries(pageCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, views]) => ({ path, views }));

    // ── Avg time on page ──
    const pageDurations = {};
    leaveEvents.forEach(i => {
      const p = i.path?.S || '/';
      const d = Number(i.duration?.N || 0);
      if (d > 0 && d < 3600000) {
        if (!pageDurations[p]) pageDurations[p] = [];
        pageDurations[p].push(d);
      }
    });
    const avgTimeOnPage = Object.entries(pageDurations).map(([path, durations]) => ({
      path,
      avgMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      avgFormatted: formatDuration(Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)),
      samples: durations.length,
    })).sort((a, b) => b.samples - a.samples);

    // ── Top clicked elements ──
    const clickCounts = {};
    clickEvents.forEach(i => {
      const label = i.elementText?.S
        ? `${i.elementTag?.S || 'element'}: "${i.elementText.S.slice(0, 50)}"`
        : i.elementHref?.S || i.elementTag?.S || 'unknown';
      const key = `${i.path?.S || '/'}||${label}`;
      if (!clickCounts[key]) clickCounts[key] = { path: i.path?.S || '/', label, count: 0 };
      clickCounts[key].count++;
    });
    const topClicks = Object.values(clickCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // ── Build sessions grouped by visitorHash ──
    const sessionMap = {};
    items.forEach(i => {
      const sid = i.sessionId?.S || 'unknown';
      if (!sessionMap[sid]) {
        sessionMap[sid] = {
          sessionId: sid,
          visitorHash: i.visitorHash?.S,
          device: i.device?.S,
          os: i.os?.S || 'Unknown',
          country: i.country?.S,
          countryCode: i.countryCode?.S || 'XX',
          region: i.region?.S || 'Unknown',
          city: i.city?.S || 'Unknown',
          referrer: i.referrer?.S,
          events: [],
          firstSeen: parseTs(i.timestamp.S),
          lastSeen: parseTs(i.timestamp.S),
        };
      }
      const ts = parseTs(i.timestamp.S);
      if (ts < sessionMap[sid].firstSeen) sessionMap[sid].firstSeen = ts;
      if (ts > sessionMap[sid].lastSeen) sessionMap[sid].lastSeen = ts;
      // Update geo if this item has real city data
      const itemCity = i.city?.S;
      if (itemCity && itemCity !== 'Unknown') {
        sessionMap[sid].city        = itemCity;
        sessionMap[sid].region      = i.region?.S || sessionMap[sid].region;
        sessionMap[sid].country     = i.country?.S || sessionMap[sid].country;
        sessionMap[sid].countryCode = i.countryCode?.S || sessionMap[sid].countryCode;
      }
      sessionMap[sid].events.push({
        type: i.eventType?.S || 'pageview',
        path: i.path?.S || '/',
        ts: ts.toISOString(),
        duration: i.duration?.N ? Number(i.duration.N) : undefined,
        elementText: i.elementText?.S,
        elementHref: i.elementHref?.S,
        elementTag: i.elementTag?.S,
      });
    });

    const allSessions = Object.values(sessionMap).map(s => ({
      ...s,
      firstSeen: s.firstSeen.toISOString(),
      lastSeen: s.lastSeen.toISOString(),
      totalMs: s.lastSeen - s.firstSeen,
      totalFormatted: formatDuration(s.lastSeen - s.firstSeen),
      pageCount: s.events.filter(e => e.type === 'pageview').length,
      clickCount: s.events.filter(e => e.type === 'click').length,
      events: s.events.sort((a, b) => new Date(a.ts) - new Date(b.ts)),
    }));

    // ── Group sessions by visitorHash ──
    // Uses the most recent session's geo if it has real city/region data
    const visitorMap = {};
    allSessions.forEach(s => {
      const vh = s.visitorHash || 'unknown';
      if (!visitorMap[vh]) {
        visitorMap[vh] = {
          visitorHash: vh,
          device: s.device,
          os: s.os,
          country: s.country,
          countryCode: s.countryCode,
          region: s.region,
          city: s.city,
          firstSeen: s.firstSeen,
          lastSeen: s.lastSeen,
          sessions: [],
          totalPageViews: 0,
          totalClicks: 0,
        };
      }
      const v = visitorMap[vh];
      if (s.firstSeen < v.firstSeen) v.firstSeen = s.firstSeen;
      if (s.lastSeen > v.lastSeen) {
        v.lastSeen = s.lastSeen;
        // ── FIX: update geo from the most recent session if it has real data ──
        const hasRealGeo = s.city && s.city !== 'Unknown';
        if (hasRealGeo) {
          v.city        = s.city;
          v.region      = s.region;
          v.country     = s.country;
          v.countryCode = s.countryCode;
        }
      }
      v.totalPageViews += s.pageCount;
      v.totalClicks    += s.clickCount;
      v.sessions.push(s);
    });

    // Sort visitors by most recent activity, limit to 20 unique visitors
    const visitors = Object.values(visitorMap)
      .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
      .slice(0, 20)
      .map(v => ({
        ...v,
        sessionCount: v.sessions.length,
        sessions: v.sessions.sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen)),
      }));

    // ── Referrers ──
    const refCounts = {};
    pageviews.forEach(i => {
      let ref = i.referrer?.S || 'direct';
      try { ref = ref === 'direct' ? 'direct' : new URL(ref).hostname; } catch {}
      refCounts[ref] = (refCounts[ref] || 0) + 1;
    });
    const referrers = Object.entries(refCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, visits]) => ({ name, visits, pct: Math.round(visits / Math.max(pageviews.length, 1) * 100) }));

    // ── Countries ──
    const countryCounts = {};
    pageviews.forEach(i => {
      const c = i.country?.S || 'Unknown';
      countryCounts[c] = (countryCounts[c] || 0) + 1;
    });
    const countries = Object.entries(countryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count, pct: Math.round(count / Math.max(pageviews.length, 1) * 100) }));

    // ── Devices ──
    const deviceCounts = { desktop: 0, mobile: 0, tablet: 0 };
    pageviews.forEach(i => {
      const d = i.device?.S || 'desktop';
      deviceCounts[d] = (deviceCounts[d] || 0) + 1;
    });
    const devices = Object.entries(deviceCounts)
      .map(([name, count]) => ({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        pct: Math.round(count / Math.max(pageviews.length, 1) * 100),
      }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        site,
        range,
        visitors: uniqueVisitors,
        pageviews: pageviews.length,
        totalEvents: items.length,
        topPages,
        avgTimeOnPage,
        topClicks,
        visitorSessions: visitors,
        referrers,
        countries,
        devices,
        generatedAt: now.toISOString(),
      }),
    };

  } catch (err) {
    console.error('Query error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal error' }),
    };
  }
};

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}
