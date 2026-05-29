require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const addressKeywords = [
  "路", "街", "巷", "弄", "號", "段",
  "區", "市", "縣", "鎮", "鄉",
  "站", "高鐵", "火車站", "轉運站",
  "夜市", "百貨", "醫院", "學校", "大學",
  "公園", "飯店", "旅館", "機場", "交流道",
  "台中", "台南", "逢甲", "一中", "勤美", "東海",
  "新光", "三越", "老虎城", "秋紅谷"
];

function cleanText(text) {
  return text
    .replace(/[？?！!。]/g, "")
    .replace(/價格多少錢|多少錢|多少|幾錢|報價|試算|想詢問|請問|您好|你好|謝謝|謝/g, "")
    .replace(/幫我|幫忙|麻煩|我要|想問|請幫我/g, "")
    .trim();
}

function looksLikeAddress(text) {
  if (!text) return false;
  if (addressKeywords.some(k => text.includes(k))) return true;
  if (/^[A-Za-z0-9\u4e00-\u9fa5]{2,12}$/.test(text)) return true;
  return false;
}

function isShortAlias(text) {
  return /^[A-Za-z0-9\u4e00-\u9fa5]{2,8}$/.test(text);
}

function parseAddresses(text) {
  const addresses = [];

  const pickup = text.match(/上車[:：]\s*(.+)/);
  const dropoff = text.match(/下車[:：]\s*(.+)/);

  if (pickup) addresses.push(cleanText(pickup[1]));
  if (dropoff) addresses.push(cleanText(dropoff[1]));

  if (addresses.length >= 2) {
    return addresses.filter(Boolean).slice(0, 7);
  }

  const normalized = text
    .replace(/➜|➡️|->|→|➡/g, "\n")
    .replace(/先到|再到|最後到|送到|載到|先去|再去|最後去/g, "\n")
    .replace(/到|去|至|往/g, "\n");

  return normalized
    .split(/\n|，|,|、/)
    .map(s => cleanText(s))
    .filter(Boolean)
    .filter(looksLikeAddress)
    .slice(0, 7);
}

async function findAlias(alias) {
  const { data } = await supabase
    .from("location_aliases")
    .select("address")
    .eq("alias", alias)
    .maybeSingle();

  return data?.address || null;
}

async function saveAlias(alias, address) {
  await supabase
    .from("location_aliases")
    .upsert({ alias, address }, { onConflict: "alias" });
}

async function getPendingAlias(userId) {
  const { data } = await supabase
    .from("pending_aliases")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data || null;
}

async function savePendingAlias(userId, alias, originalText) {
  await supabase.from("pending_aliases").delete().eq("user_id", userId);

  await supabase.from("pending_aliases").insert({
    user_id: userId,
    alias,
    original_text: originalText,
  });
}

async function clearPendingAlias(userId) {
  await supabase.from("pending_aliases").delete().eq("user_id", userId);
}

async function geocodeAddress(input) {
  const { data } = await axios.get(
    "https://maps.googleapis.com/maps/api/geocode/json",
    {
      params: {
        address: input,
        language: "zh-TW",
        region: "tw",
        key: process.env.GOOGLE_MAPS_API_KEY,
      },
    }
  );

  if (data.status !== "OK" || !data.results?.length) return null;

  return data.results[0].formatted_address;
}

async function resolveAddresses(addresses) {
  const resolved = [];
  const unknown = [];

  for (const item of addresses) {
    const saved = await findAlias(item);

    if (saved) {
      resolved.push(saved);
      continue;
    }

    if (isShortAlias(item) && !addressKeywords.some(k => item.includes(k))) {
      unknown.push(item);
      continue;
    }

    const googleAddress = await geocodeAddress(item);

    if (googleAddress) {
      await saveAlias(item, googleAddress);
      resolved.push(googleAddress);
    } else {
      unknown.push(item);
    }
  }

  return { resolved, unknown };
}

function calculateFare(km, minutes) {
  let fare = 80 + km * 15 + minutes * 3;

  if (km > 20) {
    fare += (km - 20) * 10;
  }

  if (fare < 100) fare = 100;

  return Math.ceil(fare);
}

async function getRouteFare(addresses, avoidHighways = false) {
  const origin = addresses[0];
  const destination = addresses[addresses.length - 1];
  const middlePoints = addresses.slice(1, -1);

  const params = {
    origin,
    destination,
    mode: "driving",
    language: "zh-TW",
    region: "tw",
    key: process.env.GOOGLE_MAPS_API_KEY,
  };

  if (middlePoints.length > 0) {
    params.waypoints = "optimize:true|" + middlePoints.join("|");
  }

  if (avoidHighways) {
    params.avoid = "highways";
  }

  const { data } = await axios.get(
    "https://maps.googleapis.com/maps/api/directions/json",
    { params }
  );

  if (data.status !== "OK") {
    console.error("Directions error:", data);
    throw new Error(`Google Directions error: ${data.status}`);
  }

  const route = data.routes[0];

  let totalMeters = 0;
  let totalSeconds = 0;

  for (const leg of route.legs) {
    totalMeters += leg.distance.value;
    totalSeconds += leg.duration.value;
  }

  const km = totalMeters / 1000;
  const minutes = totalSeconds / 60;

  let orderedAddresses = addresses;

  if (middlePoints.length > 0 && route.waypoint_order) {
    const orderedMiddle = route.waypoint_order.map(i => middlePoints[i]);
    orderedAddresses = [origin, ...orderedMiddle, destination];
  }

  return {
    km,
    minutes,
    fare: calculateFare(km, minutes),
    orderedAddresses,
  };
}

function formatRoute(addresses) {
  if (addresses.length <= 2) return "";

  let text = "\n\n建議路線：\n";

  addresses.forEach((addr, index) => {
    if (index === 0) text += `起點：${addr}\n`;
    else if (index === addresses.length - 1) text += `終點：${addr}\n`;
    else text += `停靠點${index}：${addr}\n`;
  });

  return text.trimEnd();
}

function buildReply(highway, flat) {
  const diff = Math.abs(Math.round(highway.minutes - flat.minutes));
  const routeText = formatRoute(highway.orderedAddresses);

  return `幫您試算高速為${highway.fare}
平路試算為${flat.fare}
兩者相差了${diff}分鐘

約 ⬆️⬇️
🔺此價錢為初估試算金額🔺
若有遇到施工或塞車…不可控因素，會有所異動 
©實際車程價格© 需依當時路況及司機跳表為主，感謝您の詢問🙇🏻‍♀️
若有乘車需求可先為您安排車輛 🚗  謝謝♥️${routeText ? "\n\n" + routeText : ""}`;
}

app.get("/", (req, res) => {
  res.send("Fare bot is running");
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  res.status(200).end();

  for (const event of req.body.events) {
    try {
      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      const userId = event.source.userId || event.source.groupId || "unknown";
      const text = event.message.text.trim();

      const pending = await getPendingAlias(userId);

      if (pending) {
        await saveAlias(pending.alias, text);
        await clearPendingAlias(userId);

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `已記住\n${pending.alias} = ${text}`,
        });
        continue;
      }

      const addresses = parseAddresses(text);

      if (addresses.length < 2) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "請輸入至少兩個地址",
        });
        continue;
      }

      const { resolved, unknown } = await resolveAddresses(addresses);

      if (unknown.length > 0) {
        await savePendingAlias(userId, unknown[0], text);

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `找不到黑話【${unknown[0]}】\n請直接回覆它的完整地址`,
        });
        continue;
      }

      const highway = await getRouteFare(resolved, false);
      const flat = await getRouteFare(resolved, true);

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: buildReply(highway, flat),
      });
    } catch (err) {
      console.error("handle event error:", err);

      try {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "無法試算，請確認地址是否完整",
        });
      } catch (replyErr) {
        console.error("reply error:", replyErr);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Fare bot running on port ${PORT}`);
});