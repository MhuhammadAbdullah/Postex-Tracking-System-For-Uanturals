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
const SHOPIFY_STORE_DOMAIN = (process.env.SHOPIFY_STORE_DOMAIN || "").trim();
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://www.uanaturals.com,http://localhost:3000")
  .split(",").map((origin) => origin.trim()).filter(Boolean);

app.use(cors({ origin: ALLOWED_ORIGINS }));

async function postexGet(url, extraHeaders = {}) {
  if (!POSTEX_TOKEN) throw new Error("PostEx token is not configured");
  const response = await fetch(url, {
    headers: { token: POSTEX_TOKEN, "Content-Type": "application/json", ...extraHeaders },
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw Object.assign(new Error(`PostEx request failed (${response.status})`), {
      status: response.status,
      responseMessage: typeof data?.statusMessage === "string" ? data.statusMessage : "",
    });
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
    message: order.message || "",
    trackingUrl: order.trackingUrl || "",
  };
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

async function findShopifyOrder(orderNumber, customer) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) return null;

  const safeDomain = SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.myshopify\.com$/.test(safeDomain)) {
    throw new Error("Shopify store domain is invalid");
  }

  const normalizedOrderNumber = orderNumber.startsWith("#") ? orderNumber : `#${orderNumber}`;
  const searchTerm = `name:"${normalizedOrderNumber.replaceAll('"', '\\"')}"`;
  const query = `query FindTrackingOrder($search: String!) {
    orders(first: 10, query: $search, sortKey: CREATED_AT, reverse: true) {
      nodes {
        name
        email
        phone
        displayFulfillmentStatus
        fulfillments(first: 10) {
          displayStatus
          trackingInfo { company number url }
        }
      }
    }
  }`;

  const response = await fetch(`https://${safeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables: { search: searchTerm } }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.errors?.length) {
    console.error("Shopify order lookup failed:", response.status, data?.errors?.[0]?.message || "GraphQL request failed");
    throw new Error("Shopify could not verify this order. Check the Shopify API configuration.");
  }

  const email = customer.toLowerCase();
  const phone = normalizePhone(customer);
  return (data?.data?.orders?.nodes || []).find((order) => {
    const emailMatches = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      && String(order.email || "").trim().toLowerCase() === email;
    const orderPhone = normalizePhone(order.phone);
    const phoneMatches = phone.length >= 10 && orderPhone.length >= 10
      && phone.slice(-10) === orderPhone.slice(-10);
    return String(order.name || "").trim().toLowerCase() === normalizedOrderNumber.toLowerCase()
      && (emailMatches || phoneMatches);
  }) || null;
}

async function trackShopifyFulfillment(order) {
  const tracking = (order.fulfillments || []).flatMap((fulfillment) => fulfillment.trackingInfo || [])
    .find((info) => info.number);
  if (!tracking) {
    return publicTrackingData({
      orderRefNumber: order.name,
      transactionStatus: order.displayFulfillmentStatus || "Unfulfilled",
      message: "Order mil gaya hai, lekin Shopify par shipment tracking abhi add nahi hui.",
    });
  }

  try {
    const data = await postexGet(`${POSTEX_API}/track-order/${encodeURIComponent(tracking.number)}`);
    if (validResult(data) && data.dist) {
      return publicTrackingData({ ...data.dist, orderRefNumber: order.name });
    }
  } catch (error) {
    console.error("PostEx tracking lookup for Shopify order failed:", error.message);
  }

  return publicTrackingData({
    orderRefNumber: order.name,
    trackingNumber: tracking.number,
    transactionStatus: order.fulfillments?.[0]?.displayStatus || order.displayFulfillmentStatus || "In transit",
    trackingUrl: tracking.url || "",
    message: "Shopify par shipment mil gaya hai. Latest courier status filhal available nahi.",
  });
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
    if (SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_ACCESS_TOKEN) {
      const shopifyOrder = await findShopifyOrder(orderNumber, customer);
      if (!shopifyOrder) {
        return res.status(404).json({ success: false, message: "Shopify order nahi mila. Order number aur checkout email/phone check karein." });
      }
      return res.json(await trackShopifyFulfillment(shopifyOrder));
    }

    const today = new Date();
    const fromDate = new Date(today);
    fromDate.setUTCDate(fromDate.getUTCDate() - Math.max(1, POSTEX_LOOKBACK_DAYS));
    const startDate = fromDate.toISOString().slice(0, 10);
    const endDate = today.toISOString().slice(0, 10);
    const params = new URLSearchParams({
      orderStatusId: "0",
      startDate,
      endDate,
      // Keep the guide's names too; PostEx deployments use both parameter conventions.
      orderStatusID: "0",
      fromDate: startDate,
      toDate: endDate,
    });
    const data = await postexGet(`${POSTEX_API}/get-all-order?${params}`, {
      orderStatusId: "0",
      startDate,
      endDate,
      fromDate: startDate,
      toDate: endDate,
    });
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
        : error.status ? `PostEx request rejected (HTTP ${error.status})${error.responseMessage ? `: ${error.responseMessage}` : ". Check the API token and request settings."}`
        : "PostEx did not respond in time. Please try again later.",
    });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
