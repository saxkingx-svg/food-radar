const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.use(cors());
app.use(express.json());

/*
  FOOD RADAR
  附近美食搜尋後端

  重要：
  不再一個 API 一個 API 慢慢等。
  多個 Overpass 同時查詢，第一個成功的直接使用。
*/

const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.maprva.org/api/interpreter"
];

const CATEGORY_RULES = {
  all: null,

  restaurant: `
    ["amenity"="restaurant"]
  `,

  cafe: `
    ["amenity"="cafe"]
  `,

  fastfood: `
    ["amenity"="fast_food"]
  `,

  japanese: `
    ["amenity"="restaurant"]["cuisine"~"japanese|sushi|ramen|udon|tempura",i]
  `,

  bbq: `
    ["amenity"="restaurant"]["cuisine"~"barbecue|bbq|korean",i]
  `,

  hotpot: `
    ["amenity"="restaurant"]["cuisine"~"hotpot|shabu|steamboat",i]
  `,

  dessert: `
    (
      ["amenity"="cafe"]
      ["shop"="bakery"]
      ["shop"="confectionery"]
    )
  `,

  night: `
    ["amenity"~"restaurant|fast_food|cafe|bar",i]
  `
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;

  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getCategory(tags = {}) {
  const amenity = String(tags.amenity || "").toLowerCase();
  const shop = String(tags.shop || "").toLowerCase();
  const cuisine = String(tags.cuisine || "").toLowerCase();
  const name = String(tags.name || "").toLowerCase();

  if (
    shop === "bakery" ||
    shop === "confectionery" ||
    /dessert|cake|甜點|蛋糕|麵包/.test(name)
  ) {
    return "dessert";
  }

  if (amenity === "cafe") {
    return "cafe";
  }

  if (amenity === "fast_food") {
    return "fastfood";
  }

  if (
    /japanese|sushi|ramen|udon|tempura|japan/.test(cuisine) ||
    /日式|日本|壽司|拉麵|烏龍/.test(name)
  ) {
    return "japanese";
  }

  if (
    /barbecue|bbq|korean/.test(cuisine) ||
    /燒肉|烤肉|韓式/.test(name)
  ) {
    return "bbq";
  }

  if (
    /hotpot|shabu|steamboat/.test(cuisine) ||
    /火鍋|涮涮鍋|麻辣鍋/.test(name)
  ) {
    return "hotpot";
  }

  if (
    amenity === "restaurant" ||
    amenity === "food_court" ||
    amenity === "biergarten"
  ) {
    return "restaurant";
  }

  if (
    amenity === "bar" ||
    amenity === "pub" ||
    amenity === "nightclub"
  ) {
    return "night";
  }

  return "restaurant";
}

function getCenter(element) {
  if (element.lat != null && element.lon != null) {
    return {
      lat: Number(element.lat),
      lng: Number(element.lon)
    };
  }

  if (
    element.center &&
    element.center.lat != null &&
    element.center.lon != null
  ) {
    return {
      lat: Number(element.center.lat),
      lng: Number(element.center.lon)
    };
  }

  return null;
}

function normalize(element, userLat, userLng) {
  const tags = element.tags || {};
  const center = getCenter(element);

  if (!center) return null;

  const name =
    tags.name ||
    tags["name:zh"] ||
    tags["name:zh-Hant"] ||
    tags["name:en"];

  if (!name) return null;

  const distance = distanceKm(
    userLat,
    userLng,
    center.lat,
    center.lng
  );

  const addressParts = [
    tags["addr:postcode"],
    tags["addr:city"],
    tags["addr:district"],
    tags["addr:suburb"],
    tags["addr:street"],
    tags["addr:housenumber"]
  ].filter(Boolean);

  const address =
    addressParts.join("") ||
    tags["addr:full"] ||
    tags["contact:address"] ||
    "";

  const category = getCategory(tags);

  return {
    id: `${element.type}-${element.id}`,
    name,
    lat: center.lat,
    lng: center.lng,
    distanceKm: Number(distance.toFixed(2)),
    category,
    cuisine: tags.cuisine || "",
    address,
    phone:
      tags.phone ||
      tags["contact:phone"] ||
      "",
    openingHours:
      tags.opening_hours ||
      "",
    website:
      tags.website ||
      tags["contact:website"] ||
      "",
    source: "OpenStreetMap"
  };
}

/*
  建立查詢
  搜尋 5 公里內的餐飲相關店家。
*/

function buildQuery(lat, lng, category) {
  const rule = CATEGORY_RULES[category] || CATEGORY_RULES.all;

  let selector;

  if (category === "all") {
    selector = `
      (
        nwr(around:5000,${lat},${lng})["amenity"~"restaurant|cafe|fast_food|food_court|bar|pub|biergarten|nightclub"];
        nwr(around:5000,${lat},${lng})["shop"~"bakery|confectionery"];
      );
    `;
  } else if (category === "dessert") {
    selector = `
      (
        nwr(around:5000,${lat},${lng})["amenity"="cafe"];
        nwr(around:5000,${lat},${lng})["shop"="bakery"];
        nwr(around:5000,${lat},${lng})["shop"="confectionery"];
      );
    `;
  } else {
    selector = `
      nwr(around:5000,${lat},${lng})${rule};
    `;
  }

  return `
    [out:json][timeout:10];
    ${selector}
    out center tags;
  `;
}

/*
  單一 Overpass 查詢
  最多等待 12 秒。
*/

async function queryServer(url, query) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 12000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "FOOD-RADAR/2.0"
      },
      body: "data=" + encodeURIComponent(query),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data || !Array.isArray(data.elements)) {
      throw new Error("API 回傳資料格式錯誤");
    }

    return data.elements;
  } finally {
    clearTimeout(timer);
  }
}

/*
  多個服務「同時」查詢。
  第一個成功就回傳，不再浪費時間等待其他服務。
*/

async function queryOverpass(query) {
  const jobs = OVERPASS_SERVERS.map((server) => {
    return queryServer(server, query);
  });

  try {
    return await Promise.any(jobs);
  } catch (error) {
    throw new Error("附近店家資料服務目前無法連線");
  }
}

/*
  健康檢查
*/

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "FOOD RADAR",
    status: "online",
    time: new Date().toISOString()
  });
});

/*
  附近店家
*/

app.get("/api/nearby", async (req, res) => {
  const lat = num(req.query.lat);
  const lng = num(req.query.lng);

  const category =
    String(req.query.category || "all").toLowerCase();

  const keyword =
    String(req.query.q || "").trim().toLowerCase();

  if (lat === null || lng === null) {
    return res.status(400).json({
      success: false,
      message: "定位資料無效"
    });
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({
      success: false,
      message: "定位座標無效"
    });
  }

  const allowedCategories = Object.keys(CATEGORY_RULES);

  const safeCategory = allowedCategories.includes(category)
    ? category
    : "all";

  console.log(
    `[NEARBY] ${lat}, ${lng} category=${safeCategory} q=${keyword}`
  );

  try {
    const query = buildQuery(
      lat,
      lng,
      safeCategory
    );

    const elements = await queryOverpass(query);

    let places = elements
      .map((element) =>
        normalize(element, lat, lng)
      )
      .filter(Boolean);

    /*
      關鍵字搜尋
    */

    if (keyword) {
      const re = new RegExp(
        escapeRegex(keyword),
        "i"
      );

      places = places.filter((p) => {
        return (
          re.test(p.name) ||
          re.test(p.cuisine) ||
          re.test(p.address)
        );
      });
    }

    /*
      分類再次過濾。
      避免不同 OSM 標籤造成分類跑掉。
    */

    if (safeCategory !== "all") {
      places = places.filter(
        (p) => p.category === safeCategory
      );
    }

    /*
      距離排序
    */

    places.sort(
      (a, b) =>
        a.distanceKm - b.distanceKm
    );

    /*
      去除同名、同座標重複資料
    */

    const seen = new Set();

    places = places.filter((p) => {
      const key =
        `${p.name}-${p.lat.toFixed(5)}-${p.lng.toFixed(5)}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });

    /*
      最多回傳 100 間
    */

    places = places.slice(0, 100);

    console.log(
      `[NEARBY] success: ${places.length} places`
    );

    return res.json({
      success: true,
      count: places.length,
      places
    });

  } catch (error) {
    console.error(
      "[NEARBY ERROR]",
      error.message
    );

    return res.status(502).json({
      success: false,
      message:
        "附近店家資料服務暫時忙碌，請稍後再試"
    });
  }
});

/*
  靜態網站
*/

app.use(express.static(__dirname));

app.get("*", (req, res) => {
  res.sendFile(
    require("path").join(
      __dirname,
      "index.html"
    )
  );
});

/*
  啟動
*/

app.listen(PORT, HOST, () => {
  console.log(
    `FOOD RADAR running on ${HOST}:${PORT}`
  );
});
