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
  "公園", "飯店", "旅館", "酒店", "汽旅", "商旅",
  "機場", "交流道", "醫美", "診所",
  "宮", "廟", "寺", "壇", "祠", "堂",
  "台中", "台南", "逢甲", "一中", "勤美", "東海",
  "新光", "三越", "老虎城", "秋紅谷", "鎮瀾宮", "林酒店"
];

function cleanText(text) {
  return text
    .replace(/[？?！!。]/g, "")
    .replace(/上車[:：]/g, "")
    .replace(/下車[:：]/g, "")
    .replace(/價格多少錢|多少錢|多少|幾錢|報價|試算|想詢問|請問|您好|你好|謝謝|謝/g, "")
    .replace(/幫我|幫忙|麻煩|我要|想問|請幫我/g, "")
    .trim();
}

function isLikelyAlias(text) {
  if (!text) return false;
  const t = text.trim();
  if (/^[A-Za-z0-9]{1,8}$/.test(t)) return true;
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(t)) return true;
  return false;
}

function looksLikeAddress(text) {
  if (!text) return false;
  if (addressKeywords.some(k => text.includes(k))) return true;
  if (/^[A-Za-z0-9\u4e00-\u9fa5]{2,20}$/.test(text)) return true;
  return false;
}

function parseAddresses(text) {
  const addresses = [];

  const pickup = text.match(/上車[:：]\s*([^\n\r]+)/);
  const dropoff = text.match(/下車[:：]\s*([^\n\r]+)/);

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

async function saveAlias(alias, address, useCount = 0) {
  await supabase
    .from("location_aliases")
    .upsert({
      alias,
      address,
      use_count: useCount,
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: "alias" });
}

async function increaseAliasCount(alias) {
  const { data } = await supabase
    .from("location_aliases")
    .select("use_count")
    .eq("alias", alias)
    .maybeSingle();

  await supabase
    .from("location_aliases")
    .update({
      use_count: (data?.use_count || 0) + 1,
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("alias", alias);
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

async function savePendingLocation(userId, lat, lng, address) {
  await supabase
    .from("pending_locations")
    .upsert({
      user_id: userId,
      lat,
      lng,
      address: address || "",
      created_at: new Date().toISOString()
    }, { onConflict: "user_id" });
}

async function getPendingLocation(userId) {
  const { data } = await supabase
    .from("pending_locations")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  return data || null;
}

async function clearPendingLocation(userId) {
  await supabase
    .from("pending_locations")
    .delete()
    .eq("user_id", userId);
}

async function deleteAlias(alias) {
  await supabase
    .from("location_aliases")
    .delete()
    .eq("alias", alias);
}

async function listAliases() {
  const { data } = await supabase
    .from("location_aliases")
    .select("alias, address")
    .order("alias", { ascending: true })
    .limit(20);

  if (!data || data.length === 0) return "目前沒有黑話資料";

  return "黑話列表：\n\n" + data
    .map((item, i) => `${i + 1}. ${item.alias} = ${item.address}`)
    .join("\n");
}

async function popularAliases() {
  const { data } = await supabase
    .from("location_aliases")
    .select("alias, use_count")
    .order("use_count", { ascending: false })
    .limit(20);

  if (!data || data.length === 0) return "目前沒有熱門黑話資料";

  return "熱門黑話：\n\n" + data
    .map((item, i) => `${i + 1}. ${item.alias}｜${item.use_count || 0}次`)
    .join("\n");
}

async function recentAliases() {
  const { data } = await supabase
    .from("location_aliases")
    .select("alias, address, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  if (!data || data.length === 0) return "目前沒有最近新增黑話";

  return "最近新增黑話：\n\n" + data
    .map((item, i) => `${i + 1}. ${item.alias} = ${item.address}`)
    .join("\n");
}

async function handleAliasCommand(text) {
  if (text === "黑話列表") return await listAliases();
  if (text === "熱門黑話") return await popularAliases();
  if (text === "最近新增黑話") return await recentAliases();

  const add = text.match(/^新增黑話\s+(.+?)=(.+)$/);
  if (add) {
    const alias = add[1].trim();
    const address = add[2].trim();
    await saveAlias(alias, address, 0);
    return `已記住\n${alias} = ${address}`;
  }

  const find = text.match(/^查黑話\s+(.+)$/);
  if (find) {
    const alias = find[1].trim();
    const address = await findAlias(alias);
    return address ? `${alias} = ${address}` : `查不到黑話：${alias}`;
  }

  const del = text.match(/^刪黑話\s+(.+)$/);
  if (del) {
    const alias = del[1].trim();
    await deleteAlias(alias);
    return `已刪除黑話：${alias}`;
  }

  return null;
}

async function searchPlace(input) {
  const { data } = await axios.get(
    "https://maps.googleapis.com/maps/api/place/textsearch/json",
    {
      params: {
        query: `${input} 台灣`,
        language: "zh-TW",
        region: "tw",
        key: process.env.GOOGLE_MAPS_API_KEY,
      },
    }
  );

  if (data.status !== "OK" || !data.results?.length) return null;

  const place = data.results[0];
  return place.formatted_address || place.name || null;
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

async function smartResolve(input) {
  const saved = await findAlias(input);

  if (saved) {
    await increaseAliasCount(input);
    return saved;
  }

  if (isLikelyAlias(input)) {
    const placeAddress = await searchPlace(input);

    if (placeAddress) {
      await saveAlias(input, placeAddress, 1);
      return placeAddress;
    }

    return null;
  }

  const placeAddress = await searchPlace(input);
  if (placeAddress) {
    await saveAlias(input, placeAddress, 1);
    return placeAddress;
  }

  const geoAddress = await geocodeAddress(input);
  if (geoAddress) {
    await saveAlias(input, geoAddress, 1);
    return geoAddress;
  }

  return null;
}

async function resolveAddresses(addresses) {
  const resolved = [];
  const unknown = [];

  for (const item of addresses) {
    const result = await smartResolve(item);

    if (result) resolved.push(result);
    else unknown.push(item);
  }

  return { resolved, unknown };
}

function calculateFare(km, minutes) {
  let fare = 80 + km * 15 + minutes * 3;

  if (km > 20) fare += (km - 20) * 10;
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
    alternatives: true,
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

  if (data.status !== "OK" || !data.routes?.length) {
    console.error("Directions error:", data);
    throw new Error(`Google Directions error: ${data.status}`);
  }

  let bestRoute = null;
  let bestMeters = Infinity;
  let bestSeconds = 0;

  for (const route of data.routes) {
    let totalMeters = 0;
    let totalSeconds = 0;

    for (const leg of route.legs) {
      totalMeters += leg.distance.value;
      totalSeconds += leg.duration.value;
    }

    if (totalMeters < bestMeters) {
      bestMeters = totalMeters;
      bestSeconds = totalSeconds;
      bestRoute = route;
    }
  }

  const km = bestMeters / 1000;
  const minutes = bestSeconds / 60;

  let orderedAddresses = addresses;

  if (middlePoints.length > 0 && bestRoute.waypoint_order) {
    const orderedMiddle = bestRoute.waypoint_order.map(i => middlePoints[i]);
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

      const userId = event.source.userId || event.source.groupId || "unknown";

      if (event.message.type === "location") {
        await savePendingLocation(
          userId,
          event.message.latitude,
          event.message.longitude,
          event.message.address || ""
        );

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "已收到您的位置，請再輸入目的地"
        });

        continue;
      }

      if (event.message.type !== "text") continue;

      const text = event.message.text.trim();

      const aliasReply = await handleAliasCommand(text);

      if (aliasReply) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: aliasReply,
        });
        continue;
      }

      const pending = await getPendingAlias(userId);

      if (pending) {
        const savedAddress =
          (await searchPlace(text)) ||
          (await geocodeAddress(text)) ||
          text;

        await saveAlias(pending.alias, savedAddress, 1);
        await clearPendingAlias(userId);

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `已記住\n${pending.alias} = ${savedAddress}`,
        });

        continue;
      }

      const pendingLocation = await getPendingLocation(userId);

      if (pendingLocation) {
        const destinationList = parseAddresses(text);

        if (destinationList.length < 1) {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "請輸入要去的地址"
          });
          continue;
        }

        const { resolved, unknown } = await resolveAddresses([destinationList[0]]);

        if (unknown.length > 0) {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: `找不到目的地【${unknown[0]}】，請輸入完整地址`
          });
          continue;
        }

        const origin = `${pendingLocation.lat},${pendingLocation.lng}`;
        const destination = resolved[0];

        const highway = await getRouteFare([origin, destination], false);
        const flat = await getRouteFare([origin, destination], true);

        await clearPendingLocation(userId);

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: buildReply(highway, flat)
        });

        continue;
      }

      const addresses = parseAddresses(text);

      if (addresses.length < 2) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "請輸入至少兩個地址"
        });
        continue;
      }

      const { resolved, unknown } = await resolveAddresses(addresses);

      if (unknown.length > 0) {
        await savePendingAlias(userId, unknown[0], text);

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `找不到地點【${unknown[0]}】\n請直接回覆它的完整地址`,
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
          text: "無法試算，請確認地址或地點名稱是否完整",
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