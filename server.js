const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter'
];

const FILTERS = {
  all: 'nwr["amenity"~"restaurant|cafe|fast_food|food_court|ice_cream|bar|pub|bakery|confectionery"]',
  restaurant: 'nwr["amenity"="restaurant"]',
  cafe: 'nwr["amenity"="cafe"]',
  fastfood: 'nwr["amenity"="fast_food"]',
  japanese: 'nwr["cuisine"~"japanese|sushi",i]',
  bbq: 'nwr["cuisine"~"barbecue|bbq|korean",i]',
  hotpot: 'nwr["cuisine"~"hot_pot|hotpot",i]',
  dessert: 'nwr["amenity"~"ice_cream|bakery|confectionery"]',
  night: 'nwr["amenity"~"restaurant|fast_food|cafe|bar|pub"]'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = v => String(v || '').replace(/[<>&"]/g, '');
const regexEscape = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildQuery(lat, lng, category, keyword, radius = 5000) {
  let filter = FILTERS[category] || FILTERS.all;
  if (keyword) filter += `["name"~"${regexEscape(keyword.slice(0, 50))}",i]`;
  return `[out:json][timeout:18];(${filter}(around:${radius},${lat},${lng}););out center tags;`;
}

async function requestOverpass(query) {
  let last;
  for (const endpoint of OVERPASS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 22000);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'FOOD-RADAR/1.0 local-development'
        },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`資料服務 HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      last = err;
      await sleep(250);
    }
  }
  throw last || new Error('附近美食資料服務無法連線');
}

function normalize(el, lat, lng) {
  const t = el.tags || {};
  const la = el.lat ?? el.center?.lat;
  const lo = el.lon ?? el.center?.lon;
  if (!Number.isFinite(la) || !Number.isFinite(lo) || !t.name) return null;

  const dLat = (la - lat) * 111;
  const dLng = (lo - lng) * 111 * Math.cos(lat * Math.PI / 180);
  const distanceKm = Math.sqrt(dLat * dLat + dLng * dLng);
  const address = [t['addr:city'], t['addr:district'], t['addr:street'], t['addr:housenumber']].filter(Boolean).join('');
  const cuisine = t.cuisine ? t.cuisine.split(';').slice(0, 3).join('、') : '';

  let category = 'restaurant';
  if (t.amenity === 'cafe') category = 'cafe';
  else if (t.amenity === 'fast_food') category = 'fastfood';
  else if (/japanese|sushi/i.test(t.cuisine || '')) category = 'japanese';
  else if (/barbecue|bbq|korean/i.test(t.cuisine || '')) category = 'bbq';
  else if (/hot_pot|hotpot/i.test(t.cuisine || '')) category = 'hotpot';
  else if (/ice_cream|bakery|confectionery/i.test(t.amenity || '')) category = 'dessert';

  return {
    id: `${el.type}-${el.id}`,
    name: clean(t.name),
    lat: la, lng: lo,
    address: clean(address), phone: clean(t.phone || t['contact:phone']),
    website: clean(t.website || t['contact:website']),
    cuisine: clean(cuisine), openingHours: clean(t.opening_hours),
    distanceKm: Number(distanceKm.toFixed(2)), category
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'FOOD RADAR' }));

app.get('/api/nearby', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const category = String(req.query.category || 'all');
  const keyword = String(req.query.q || '').trim();

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ success: false, message: '定位座標無效，請重新定位。' });
  }

  try {
    let data;
    try {
      data = await requestOverpass(buildQuery(lat, lng, category, keyword));
    } catch (firstError) {
      // If a category/keyword query is rejected, retry once with a lighter radius.
      data = await requestOverpass(buildQuery(lat, lng, category, keyword, 2500));
    }

    const seen = new Set();
    const places = (data.elements || [])
      .map(e => normalize(e, lat, lng))
      .filter(Boolean)
      .filter(p => {
        const key = `${p.name}|${p.lat.toFixed(5)}|${p.lng.toFixed(5)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 100);

    res.json({ success: true, places, source: 'OpenStreetMap / Overpass' });
  } catch (error) {
    console.error('Nearby error:', error);
    res.status(502).json({ success: false, message: '附近美食服務暫時無法連線。請確認電腦有網路後再試一次。' });
  }
});

app.get('*', (_req, res) => res.sendFile(__dirname + '/index.html'));
app.listen(PORT, () => console.log(`FOOD RADAR 已啟動：http://localhost:${PORT}`));
