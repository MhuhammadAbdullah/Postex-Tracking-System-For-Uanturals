// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const POSTEX_TOKEN = process.env.MY_POSTEX_TOKEN;
const POSTEX_API = "https://api.postex.pk/services/integration/api/order/v1";
const POSTEX_LOOKBACK_DAYS = Number(process.env.POSTEX_LOOKBACK_DAYS || 365);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://www.uanaturals.com,http://localhost:3000")
  .split(",").map((origin) => origin.trim()).filter(Boolean);

app.use(cors({ origin: ALLOWED_ORIGINS }));

async function postexGet(url) {
  if (!POSTEX_TOKEN) throw new Error("PostEx token is not configured");
  const response = await fetch(url, {
    headers: { token: POSTEX_TOKEN, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw Object.assign(new Error(`PostEx request failed (${response.status})`), { status: response.status });
  }
  return data;
}

function validResult(data) {
  return data?.statusCode === "200" || data?.statusCode === 200;
}

function publicTrackingData(order) {
  return {
    trackingNumber: order.trackingNumber || "",
    orderRefNumber: order.orderRefNumber || "",
    customerName: order.customerName || "",
    transactionStatus: order.transactionStatus || "Unknown",
    transactionDate: order.transactionDate || "",
    orderPickupDate: order.orderPickupDate || "",
    orderDeliveryDate: order.orderDeliveryDate || "",
    transactionStatusHistory: Array.isArray(order.transactionStatusHistory) ? order.transactionStatusHistory : [],
  };
}

// Track using a PostEx tracking number.
app.get("/api/track", async (req, res) => {
  const tracking = String(req.query.tracking || "").trim();
  if (!tracking || tracking.length > 100) {
    return res.status(400).json({ success: false, message: "Valid tracking number required" });
  }
  try {
    const data = await postexGet(`${POSTEX_API}/track-order/${encodeURIComponent(tracking)}`);
    if (!validResult(data) || !data.dist) {
      return res.status(404).json({ success: false, message: "Tracking not found" });
    }
    return res.json(publicTrackingData(data.dist));
  } catch (error) {
    console.error("PostEx tracking error:", error.message);
    const missingToken = !POSTEX_TOKEN;
    return res.status(missingToken ? 503 : 502).json({
      success: false,
      message: missingToken ? "Tracking service is not configured"
        : error.status ? `PostEx rejected the request (HTTP ${error.status}). Check the API token and request settings.`
        : "PostEx did not respond in time. Please try again later.",
    });
  }
});

// Find an order by merchant order reference + the customer's email.
// PostEx has no direct order-reference lookup endpoint: get-all-order requires a date range.
app.get("/api/track-order", async (req, res) => {
  const orderNumber = String(req.query.orderNumber || "").trim();
  const customer = String(req.query.customer || req.query.email || "").trim();
  const email = customer.toLowerCase();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const phoneDigits = customer.replace(/\D/g, "");
  const isPhone = phoneDigits.length >= 10 && phoneDigits.length <= 15;
  if (!orderNumber || orderNumber.length > 100 || (!isEmail && !isPhone)) {
    return res.status(400).json({ success: false, message: "Enter a valid order number and email or phone number." });
  }

  try {
    const today = new Date();
    const fromDate = new Date(today);
    fromDate.setUTCDate(fromDate.getUTCDate() - Math.max(1, POSTEX_LOOKBACK_DAYS));
    const params = new URLSearchParams({
      orderStatusID: "0",
      fromDate: fromDate.toISOString().slice(0, 10),
      toDate: today.toISOString().slice(0, 10),
    });
    const data = await postexGet(`${POSTEX_API}/get-all-order?${params}`);
    if (!validResult(data) || !Array.isArray(data.dist)) {
      return res.status(502).json({
        success: false,
        message: data?.statusMessage || "PostEx rejected the order lookup request.",
      });
    }

    const found = data.dist.map((entry) => entry?.trackingResponse || entry)
      .find((order) => {
        const cleanOrderNumber = (value) => String(value || "").trim().replace(/^#/, "").toLowerCase();
        if (cleanOrderNumber(order?.orderRefNumber) !== cleanOrderNumber(orderNumber)) return false;
        if (isEmail) return String(order?.deliveryAddress || "").trim().toLowerCase() === email;
        const orderPhone = String(order?.customerPhone || "").replace(/\D/g, "");
        return orderPhone === phoneDigits || (orderPhone.length >= 10 && phoneDigits.length >= 10
          && orderPhone.slice(-10) === phoneDigits.slice(-10));
      });
    if (!found) {
      return res.status(404).json({ success: false, message: "Order not found. Check the order number and email." });
    }

    // Return only information needed by the customer-facing tracking page.
    return res.json(publicTrackingData({ ...found, orderRefNumber: found.orderRefNumber || orderNumber }));
  } catch (error) {
    console.error("PostEx order lookup error:", error.message);
    const missingToken = !POSTEX_TOKEN;
    return res.status(missingToken ? 503 : 502).json({
      success: false,
      message: missingToken ? "Tracking service is not configured"
        : error.status ? `PostEx rejected the request (HTTP ${error.status}). Check the API token and request settings.`
        : "PostEx did not respond in time. Please try again later.",
    });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
