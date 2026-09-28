const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

/*
  FOOD RADAR
  店家資料服務備援
*/
const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter"
];

/*
  分類
*/
const CATEGORY_FILTERS = {
  all: `
    nwr[
      "amenity"~"restaurant|cafe|fast_food|food_court|ice_cream|bar|pub|biergarten|bakery|confectionery"
    ]
  `,

  restaurant: `
    nwr["amenity"="restaurant"]
  `,

  cafe: `
    nwr["amenity"="cafe"]
  `,

  fastfood: `
    nwr["amenity"="fast_food"]
  `,

  japanese: `
    nwr["cuisine"~"japanese|sushi",i]
  `,

  bbq: `
    nwr["cuisine"~"barbecue|bbq|korean",i]
  `,

  hotpot: `
    nwr["cuisine"~"hot_pot|hotpot",i]
  `,

  dessert: `
    nwr["amenity"~"ice_cream|bakery|confectionery"]
  `,

  night: `
    nwr[
      "amenity"~"restaurant|fast_food|cafe|bar|pub"
    ]
  `
};

/*
  清理文字
*/
function clean(value) {
  return String(value || "")
    .replace(/[<>&"]/g, "");
}

/*
  避免搜尋關鍵字破壞 Overpass Regex
*/
function escapeRegex(value) {
  return String(value || "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .slice(0, 50);
}

/*
  建立搜尋 Query
*/
function buildQuery(lat, lng, category, keyword) {
  const filter =
    CATEGORY_FILTERS[category] ||
    CATEGORY_FILTERS.all;

  const keywordPart = keyword
    ? `["name"~"${escapeRegex(keyword)}",i]`
    : "";

  return `
[out:json][timeout:45];

(
  ${filter}${keywordPart}(around:5000,${lat},${lng});
);

out center tags;
`;
}

/*
  嘗試所有 Overpass 服務
*/
async function fetchOverpass(query) {
  let lastError = null;

  for (const server of OVERPASS_SERVERS) {
    let controller;
    let timeout;

    try {
      console.log("");
      console.log("================================");
      console.log("嘗試店家資料服務");
      console.log(server);
      console.log("================================");

      controller = new AbortController();

      timeout = setTimeout(() => {
        controller.abort();
      }, 50000);

      const response = await fetch(server, {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",

          "User-Agent":
            "FOOD-RADAR/2.0 (+https://food-radar-6vbo.onrender.com)"
        },

        body:
          "data=" +
          encodeURIComponent(query),

        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(
          `資料服務 HTTP ${response.status}`
        );
      }

      const text =
        await response.text();

      if (!text) {
        throw new Error(
          "資料服務沒有回傳內容"
        );
      }

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          "資料服務回傳格式錯誤"
        );
      }

      if (
        !data ||
        !Array.isArray(data.elements)
      ) {
        throw new Error(
          "資料服務沒有有效店家資料"
        );
      }

      console.log(
        `資料服務成功：${server}`
      );

      return data;

    } catch (error) {
      lastError = error;

      console.log(
        `資料服務失敗：${server}`
      );

      console.log(
        error?.message || error
      );

    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "所有店家資料服務都無法使用"
    )
  );
}

/*
  判斷店家分類
*/
function getCategory(tags) {
  const amenity =
    String(tags.amenity || "");

  const cuisine =
    String(tags.cuisine || "");

  if (amenity === "cafe") {
    return "cafe";
  }

  if (amenity === "fast_food") {
    return "fastfood";
  }

  if (
    /japanese|sushi/i.test(cuisine)
  ) {
    return "japanese";
  }

  if (
    /barbecue|bbq|korean/i.test(cuisine)
  ) {
    return "bbq";
  }

  if (
    /hot_pot|hotpot/i.test(cuisine)
  ) {
    return "hotpot";
  }

  if (
    /ice_cream|bakery|confectionery/i.test(
      amenity
    )
  ) {
    return "dessert";
  }

  if (
    /bar|pub/i.test(amenity)
  ) {
    return "night";
  }

  return "restaurant";
}

/*
  計算距離
*/
function calculateDistance(
  userLat,
  userLng,
  lat,
  lng
) {
  const dLat =
    (lat - userLat) * 111;

  const dLng =
    (lng - userLng) *
    111 *
    Math.cos(
      userLat *
        Math.PI /
        180
    );

  return Math.sqrt(
    dLat * dLat +
    dLng * dLng
  );
}

/*
  OSM 資料 → FOOD RADAR 店家格式
*/
function normalizePlace(
  element,
  userLat,
  userLng
) {
  const tags =
    element.tags || {};

  const lat =
    element.lat ??
    element.center?.lat;

  const lng =
    element.lon ??
    element.center?.lon;

  if (
    !Number.isFinite(Number(lat)) ||
    !Number.isFinite(Number(lng)) ||
    !tags.name
  ) {
    return null;
  }

  const address = [
    tags["addr:city"],
    tags["addr:district"],
    tags["addr:town"],
    tags["addr:village"],
    tags["addr:suburb"],
    tags["addr:street"],
    tags["addr:housenumber"]
  ]
    .filter(Boolean)
    .join("");

  const distance =
    calculateDistance(
      userLat,
      userLng,
      Number(lat),
      Number(lng)
    );

  const cuisine =
    tags.cuisine
      ? String(tags.cuisine)
          .split(";")
          .slice(0, 3)
          .join("、")
      : "";

  return {
    id:
      `${element.type}-${element.id}`,

    name:
      clean(tags.name),

    lat:
      Number(lat),

    lng:
      Number(lng),

    address:
      clean(address),

    phone:
      clean(
        tags.phone ||
        tags["contact:phone"]
      ),

    website:
      clean(
        tags.website ||
        tags["contact:website"]
      ),

    cuisine:
      clean(cuisine),

    openingHours:
      clean(
        tags.opening_hours
      ),

    takeaway:
      clean(
        tags.takeaway
      ),

    wheelchair:
      clean(
        tags.wheelchair
      ),

    category:
      getCategory(tags),

    distanceKm:
      Number(
        distance.toFixed(2)
      )
  };
}

/*
  健康檢查
*/
app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      service: "FOOD RADAR",
      status: "online",
      time:
        new Date().toISOString()
    });
  }
);

/*
  附近店家
*/
app.get(
  "/api/nearby",
  async (req, res) => {
    try {
      const lat =
        Number(req.query.lat);

      const lng =
        Number(req.query.lng);

      const category =
        String(
          req.query.category ||
          "all"
        );

      const keyword =
        String(
          req.query.q || ""
        ).trim();

      /*
        檢查座標
      */
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "定位座標無效"
        });
      }

      if (
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180
      ) {
        return res.status(400).json({
          success: false,
          message:
            "定位座標超出範圍"
        });
      }

      /*
        防止亂傳分類
      */
      const validCategories =
        Object.keys(
          CATEGORY_FILTERS
        );

      const safeCategory =
        validCategories.includes(
          category
        )
          ? category
          : "all";

      console.log("");
      console.log(
        "========== 新搜尋 =========="
      );

      console.log(
        `位置：${lat}, ${lng}`
      );

      console.log(
        `分類：${safeCategory}`
      );

      console.log(
        `關鍵字：${keyword || "無"}`
      );

      /*
        建立 Query
      */
      const query =
        buildQuery(
          lat,
          lng,
          safeCategory,
          keyword
        );

      /*
        取得資料
      */
      const data =
        await fetchOverpass(
          query
        );

      /*
        去除重複
      */
      const seen =
        new Set();

      const places =
        (data.elements || [])
          .map(
            element =>
              normalizePlace(
                element,
                lat,
                lng
              )
          )

          .filter(Boolean)

          .filter(place => {
            const key =
              `${place.name}-${place.lat.toFixed(5)}-${place.lng.toFixed(5)}`;

            if (
              seen.has(key)
            ) {
              return false;
            }

            seen.add(key);

            return true;
          })

          .sort(
            (a, b) =>
              a.distanceKm -
              b.distanceKm
          )

          .slice(0, 100);

      console.log(
        `成功找到 ${places.length} 間店家`
      );

      return res.json({
        success: true,
        count:
          places.length,
        places
      });

    } catch (error) {
      console.error("");
      console.error(
        "========== 搜尋失敗 =========="
      );

      console.error(
        error?.message ||
        error
      );

      return res.status(502).json({
        success: false,

        message:
          "附近美食資料服務暫時無法連線，請稍後再試。",

        detail:
          process.env.NODE_ENV ===
          "development"
            ? error?.message
            : undefined
      });
    }
  }
);

/*
  網站首頁
*/
app.get(
  "*",
  (req, res) => {
    res.sendFile(
      __dirname +
      "/index.html"
    );
  }
);

/*
  啟動
*/
app.listen(
  PORT,
  HOST,
  () => {
    console.log("");
    console.log(
      "================================"
    );

    console.log(
      "        FOOD RADAR ONLINE"
    );

    console.log(
      "================================"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Local: http://localhost:${PORT}`
    );

    console.log(
      `Host: ${HOST}`
    );

    console.log(
      "================================"
    );

    console.log("");
  }
);
