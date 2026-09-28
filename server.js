const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.use(cors());
app.use(express.json());

/*
  FOOD RADAR
  10 公里附近美食搜尋
  近的優先，遠的也保留
*/

const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.maprva.org/api/interpreter"
];

const SEARCH_RADIUS = 10000;

const CATEGORY_RULES = {
  all: true,
  restaurant: true,
  cafe: true,
  fastfood: true,
  japanese: true,
  bbq: true,
  hotpot: true,
  dessert: true,
  night: true
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;

  const dLat =
    (lat2 - lat1) * Math.PI / 180;

  const dLng =
    (lng2 - lng1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

function escapeRegex(text) {
  return String(text || "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
  店家分類
  分不出來也不會直接丟掉。
*/

function getCategory(tags = {}) {
  const amenity =
    String(tags.amenity || "").toLowerCase();

  const shop =
    String(tags.shop || "").toLowerCase();

  const cuisine =
    String(
      tags.cuisine ||
      tags["cuisine:zh"] ||
      ""
    ).toLowerCase();

  const name =
    String(
      tags.name ||
      tags["name:zh"] ||
      tags["name:zh-Hant"] ||
      ""
    ).toLowerCase();

  /* 甜點 */
  if (
    shop === "bakery" ||
    shop === "confectionery" ||
    shop === "ice_cream" ||
    /dessert|cake|bakery|甜點|蛋糕|麵包|冰店|冰品|豆花|剉冰/.test(name)
  ) {
    return "dessert";
  }

  /* 飲料 / 咖啡 / 茶 */
  if (
    amenity === "cafe" ||
    shop === "coffee" ||
    shop === "beverages" ||
    /bubble_tea|tea|coffee|juice/.test(cuisine) ||
    /咖啡|飲料|茶飲|手搖|珍珠|奶茶|茶店/.test(name)
  ) {
    return "cafe";
  }

  /* 速食 */
  if (
    amenity === "fast_food" ||
    /fast_food/.test(cuisine)
  ) {
    return "fastfood";
  }

  /* 日料 */
  if (
    /japanese|sushi|ramen|udon|tempura|yakitori|japan/.test(cuisine) ||
    /日式|日本料理|壽司|拉麵|烏龍|串燒/.test(name)
  ) {
    return "japanese";
  }

  /* 燒肉 */
  if (
    /barbecue|bbq|korean/.test(cuisine) ||
    /燒肉|烤肉|韓式/.test(name)
  ) {
    return "bbq";
  }

  /* 火鍋 */
  if (
    /hotpot|shabu|steamboat/.test(cuisine) ||
    /火鍋|涮涮鍋|麻辣鍋/.test(name)
  ) {
    return "hotpot";
  }

  /* 宵夜 */
  if (
    amenity === "bar" ||
    amenity === "pub" ||
    amenity === "nightclub"
  ) {
    return "night";
  }

  return "restaurant";
}

/*
  取得店家座標
*/

function getCenter(element) {
  if (
    element.lat != null &&
    element.lon != null
  ) {
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

/*
  OSM → FOOD RADAR 資料
*/

function normalize(
  element,
  userLat,
  userLng
) {
  const tags =
    element.tags || {};

  const center =
    getCenter(element);

  if (!center) {
    return null;
  }

  const name =
    tags.name ||
    tags["name:zh"] ||
    tags["name:zh-Hant"] ||
    tags["name:en"];

  if (!name) {
    return null;
  }

  const distance =
    distanceKm(
      userLat,
      userLng,
      center.lat,
      center.lng
    );

  /*
    保持 10 公里上限
  */

  if (
    distance > 10
  ) {
    return null;
  }

  const addressParts = [
    tags["addr:postcode"],
    tags["addr:city"],
    tags["addr:district"],
    tags["addr:suburb"],
    tags["addr:quarter"],
    tags["addr:neighbourhood"],
    tags["addr:street"],
    tags["addr:housenumber"]
  ].filter(Boolean);

  const address =
    addressParts.join("") ||
    tags["addr:full"] ||
    tags["contact:address"] ||
    "";

  return {
    id:
      `${element.type}-${element.id}`,

    name,

    lat:
      center.lat,

    lng:
      center.lng,

    distanceKm:
      Number(
        distance.toFixed(2)
      ),

    category:
      getCategory(tags),

    cuisine:
      tags.cuisine ||
      tags["cuisine:zh"] ||
      "",

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

    source:
      "OpenStreetMap"
  };
}

/*
  核心搜尋：

  10 公里內
  盡可能抓餐飲相關店家

  nwr = node + way + relation
*/

function buildQuery(lat, lng) {
  return `
    [out:json][timeout:25];

    (
      /* 一般餐廳 */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["amenity"="restaurant"];

      /* 咖啡 / 飲料 */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["amenity"="cafe"];

      /* 速食 */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["amenity"="fast_food"];

      /* 美食廣場 */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["amenity"="food_court"];

      /* 酒吧 / Pub / 宵夜 */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["amenity"="bar"];

      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["amenity"="pub"];

      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["amenity"="nightclub"];

      /* 麵包 */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["shop"="bakery"];

      /* 糖果 / 甜點 */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["shop"="confectionery"];

      /* 冰品 */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["shop"="ice_cream"];

      /* 咖啡 */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["shop"="coffee"];

      /* 飲料 */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["shop"="beverages"];

      /*
        有 cuisine 的店
        可以補抓很多沒有正確 amenity 的店
      */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["cuisine"];

      /*
        名稱補抓。

        這一段是為了像：
        麻古
        五十嵐
        清心
        可不可
        迷客夏
        早餐店
        便當店
        小吃店
        牛肉麵
        雞排
        滷味
        等。
      */

      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )[
        "name"~"餐廳|小吃|飲料|茶|咖啡|咖啡廳|咖啡館|早餐|早午餐|便當|麵店|牛肉麵|拉麵|滷味|火鍋|燒肉|烤肉|壽司|炸雞|雞排|鹽酥雞|豆花|冰|甜點|蛋糕|麵包|漢堡|披薩|義大利麵|麻古|五十嵐|清心|可不可|迷客夏|得正|龜記|茶湯會|珍煮丹|CoCo|COMEBUY|大苑子|康青龍|日出茶太",
        i
      ];

      /*
        OSM 有些店會標 amenity=food
      */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["amenity"="food"];

      /*
        部分餐飲店使用 shop=restaurant
      */
      nwr(
        around:${SEARCH_RADIUS},
        ${lat},
        ${lng}
      )["shop"="restaurant"];
    );

    out center tags;
  `;
}

/*
  單一搜尋伺服器
*/

async function queryServer(
  url,
  query
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      30000
    );

  try {
    const response =
      await fetch(
        url,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",

            "User-Agent":
              "FOOD-RADAR/2.0"
          },

          body:
            "data=" +
            encodeURIComponent(
              query
            ),

          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !data ||
      !Array.isArray(
        data.elements
      )
    ) {
      throw new Error(
        "API 回傳資料格式錯誤"
      );
    }

    return data.elements;

  } finally {
    clearTimeout(timer);
  }
}

/*
  同時查詢多個 Overpass
*/

async function queryOverpass(
  query
) {
  const jobs =
    OVERPASS_SERVERS.map(
      server =>
        queryServer(
          server,
          query
        )
    );

  try {
    /*
      第一個成功的結果先回來
    */

    return await Promise.any(
      jobs
    );

  } catch {
    throw new Error(
      "附近店家資料服務目前無法連線"
    );
  }
}

/*
  健康檢查
*/

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "FOOD RADAR",
      status:
        "online",
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

    const lat =
      num(
        req.query.lat
      );

    const lng =
      num(
        req.query.lng
      );

    const category =
      String(
        req.query.category ||
        "all"
      ).toLowerCase();

    const keyword =
      String(
        req.query.q ||
        ""
      )
        .trim()
        .toLowerCase();

    if (
      lat === null ||
      lng === null
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          message:
            "定位資料無效"
        });
    }

    if (
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          message:
            "定位座標無效"
        });
    }

    const safeCategory =
      CATEGORY_RULES[
        category
      ]
        ? category
        : "all";

    console.log(
      `[NEARBY] ${lat}, ${lng} category=${safeCategory} q=${keyword}`
    );

    try {

      const query =
        buildQuery(
          lat,
          lng
        );

      const elements =
        await queryOverpass(
          query
        );

      /*
        先全部轉換
      */

      let places =
        elements
          .map(
            element =>
              normalize(
                element,
                lat,
                lng
              )
          )
          .filter(Boolean);

      /*
        關鍵字
      */

      if (
        keyword
      ) {

        const re =
          new RegExp(
            escapeRegex(
              keyword
            ),
            "i"
          );

        places =
          places.filter(
            p =>
              re.test(
                p.name
              ) ||
              re.test(
                p.cuisine
              ) ||
              re.test(
                p.address
              )
          );
      }

      /*
        分類
      */

      if (
        safeCategory !==
        "all"
      ) {

        places =
          places.filter(
            p =>
              p.category ===
              safeCategory
          );
      }

      /*
        最近的排最前面
      */

      places.sort(
        (a, b) =>
          a.distanceKm -
          b.distanceKm
      );

      /*
        去除完全重複
      */

      const seen =
        new Set();

      places =
        places.filter(
          p => {

            const key =
              `${p.name}|${p.lat.toFixed(5)}|${p.lng.toFixed(5)}`;

            if (
              seen.has(
                key
              )
            ) {
              return false;
            }

            seen.add(
              key
            );

            return true;
          }
        );

      /*
        最多 500 間
      */

      places =
        places.slice(
          0,
          500
        );

      console.log(
        `[NEARBY] success: ${places.length} places`
      );

      return res.json({
        success:
          true,

        count:
          places.length,

        places
      });

    } catch (
      error
    ) {

      console.error(
        "[NEARBY ERROR]",
        error.message
      );

      return res
        .status(502)
        .json({
          success:
            false,

          message:
            "附近店家資料服務暫時忙碌，請稍後再試"
        });
    }
  }
);

/*
  網站
*/

app.use(
  express.static(
    __dirname
  )
);

app.get(
  "*",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
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
    console.log(
      `FOOD RADAR running on ${HOST}:${PORT}`
    );
  }
);
