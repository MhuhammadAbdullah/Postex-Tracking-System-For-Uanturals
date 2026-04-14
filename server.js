// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();

// ✅ CORS (Shopify + local testing dono allow)
app.use(cors({
  origin: [
    // "https://thenaturemist.myshopify.com",
    "https://www.uanaturals.com",
    "http://localhost:3000"
  ]
}));

const PORT = process.env.PORT || 3000;
const POSTEX_TOKEN = process.env.MY_POSTEX_TOKEN;

// ✅ Route
app.get("/api/track", async (req, res) => {
  try {
    const tracking = req.query.tracking;

    if (!tracking) {
      return res.status(400).json({
        success: false,
        message: "Tracking number required"
      });
    }

    const response = await fetch(
      `${POSTEX_TRACKING_API_URL}${tracking}`,
      {
        method: "GET",
        headers: {
          token: POSTEX_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );

    const data = await response.json();

    // ✅ Better response handling
    if (!data || !data.dist) {
      return res.status(404).json({
        success: false,
        message: "Tracking not found"
      });
    }

    res.json(data.dist);

  } catch (error) {
    console.error("Tracking API Error:", error);

    res.status(500).json({
      success: false,
      message: "Server error while fetching tracking data"
    });
  }
});

// ✅ Render-friendly log
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});