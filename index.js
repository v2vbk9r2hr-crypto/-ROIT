require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

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

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `收到地址：\n${text}\n\n下一步會幫你接 Google 地圖試算價格。`,
      });
    } catch (err) {
      console.error("handle event error:", err);
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Fare bot running on port ${PORT}`);
});