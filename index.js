require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

function parseAddresses(text) {
  return text
    .replace(/➜|➡️|->|→/g, "\n")
    .replace(/到/g, "\n")
    .replace(/去/g, "\n")
    .split(/\n|，|,|、/)
    .map(s => s.trim())
    .filter(Boolean);
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
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  const origin = addresses[0];
  const destination = addresses[addresses.length - 1];
  const middlePoints = addresses.slice(1, -1);

  const params = {
    origin,
    destination,
    mode: "driving",
    language: "zh-TW",
    region: "tw",
    key: apiKey,
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
  const fare = calculateFare(km, minutes);

  let orderedAddresses = addresses;

  if (middlePoints.length > 0 && route.waypoint_order) {
    const orderedMiddle = route.waypoint_order.map(i => middlePoints[i]);
    orderedAddresses = [origin, ...orderedMiddle, destination];
  }

  return {
    km,
    minutes,
    fare,
    orderedAddresses,
  };
}

function formatRoute(addresses) {
  if (addresses.length <= 2) return "";

  let text = "\n\n建議路線：\n";
  addresses.forEach((addr, index) => {
    if (index === 0) {
      text += `起點：${addr}\n`;
    } else if (index === addresses.length - 1) {
      text += `終點：${addr}\n`;
    } else {
      text += `停靠點${index}：${addr}\n`;
    }
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

      const text = event.message.text.trim();
      const addresses = parseAddresses(text);

      if (addresses.length < 2) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "請輸入至少兩個地址",
        });
        continue;
      }

      if (addresses.length > 7) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "一次最多試算7個地址",
        });
        continue;
      }

      const highway = await getRouteFare(addresses, false);
      const flat = await getRouteFare(addresses, true);

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: buildReply(highway, flat),
      });
    } catch (err) {
      console.error("handle event error:", err);

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "無法試算，請確認地址是否完整",
      });
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Fare bot running on port ${PORT}`);
});