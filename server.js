const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadEnv();

const root = __dirname;
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "purchases.json");
const port = Number(process.env.PORT || 3000);
const productId = process.env.PRODUCT_ID || "50-micro-saas-ebook";
const tokenTtlHours = Number(process.env.DOWNLOAD_TOKEN_TTL_HOURS || 168);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, getSiteUrl());

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/sales")) {
      return serveFile(res, path.join(publicDir, "index.html"));
    }

    if (req.method === "GET" && url.pathname === "/thank-you") {
      return serveFile(res, path.join(publicDir, "thank-you.html"));
    }

    if (req.method === "GET" && url.pathname === "/checkout") {
      return serveFile(res, path.join(publicDir, "checkout.html"));
    }

    if (req.method === "GET" && url.pathname === "/buy") {
      return redirectToCheckout(res);
    }

    if (req.method === "GET" && url.pathname === "/api/checkout-config") {
      return handleCheckoutConfig(res);
    }

    if (req.method === "POST" && url.pathname === "/api/razorpay/order") {
      return handleRazorpayOrder(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/razorpay/verify") {
      return handleRazorpayVerify(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/purchase-status") {
      return handlePurchaseStatus(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/webhook/payment") {
      return handlePaymentWebhook(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/download") {
      return handleDownload(req, res, url);
    }

    if (req.method === "GET") {
      return serveStatic(res, url.pathname);
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(port, () => {
  console.log(`50 Micro SaaS sales site running at ${getSiteUrl()}`);
});

function redirectToCheckout(res) {
  if (getPaymentProvider() === "razorpay") {
    res.writeHead(302, { Location: "/checkout" });
    res.end();
    return;
  }

  const paymentUrl = process.env.PAYMENT_URL;
  if (!paymentUrl) {
    return sendHtml(
      res,
      503,
      `<h1>Checkout is not configured yet.</h1><p>Add PAYMENT_URL in .env to connect your payment provider.</p>`
    );
  }
  res.writeHead(302, { Location: paymentUrl });
  res.end();
}

function handleCheckoutConfig(res) {
  if (getPaymentProvider() !== "razorpay") {
    return sendJson(res, 400, { error: "Razorpay is not the active payment provider" });
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const amount = Number(process.env.PRODUCT_AMOUNT || 0);
  const currency = process.env.PRODUCT_CURRENCY || "INR";
  const name = process.env.PRODUCT_NAME || "50 Micro SaaS You Can Build Without Coding";

  if (!keyId || !amount || !process.env.RAZORPAY_KEY_SECRET) {
    return sendJson(res, 503, {
      error: "Razorpay checkout is not configured",
      required: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "PRODUCT_AMOUNT"]
    });
  }

  sendJson(res, 200, {
    key_id: keyId,
    amount,
    currency,
    name,
    product_id: productId
  });
}

async function handleRazorpayOrder(req, res) {
  if (getPaymentProvider() !== "razorpay") {
    return sendJson(res, 400, { error: "Razorpay is not the active payment provider" });
  }

  const amount = Number(process.env.PRODUCT_AMOUNT || 0);
  const currency = process.env.PRODUCT_CURRENCY || "INR";
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || !amount) {
    return sendJson(res, 503, { error: "Razorpay credentials or product amount are missing" });
  }

  const order = await createRazorpayOrder({
    amount,
    currency,
    receipt: `ebook_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`,
    notes: {
      product_id: productId,
      product_name: process.env.PRODUCT_NAME || "50 Micro SaaS You Can Build Without Coding"
    }
  });

  if (!order.ok) {
    return sendJson(res, 502, { error: "Could not create Razorpay order" });
  }

  const db = readDb();
  db.pending_orders[order.data.id] = {
    provider: "razorpay",
    order_id: order.data.id,
    amount: order.data.amount,
    currency: order.data.currency,
    product_id: productId,
    created_at: new Date().toISOString()
  };
  writeDb(db);

  sendJson(res, 200, {
    order_id: order.data.id,
    amount: order.data.amount,
    currency: order.data.currency,
    product_id: productId
  });
}

async function handleRazorpayVerify(req, res) {
  const body = await readJsonRequest(req);
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = body || {};

  if (!verifyRazorpayPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    return sendJson(res, 400, { verified: false, error: "Invalid Razorpay payment signature" });
  }

  const payment = await fetchRazorpayPayment(razorpay_payment_id);
  if (!payment.ok || payment.data.status !== "captured") {
    return sendJson(res, 400, { verified: false, error: "Payment has not been captured" });
  }

  const db = readDb();
  const pending = db.pending_orders[razorpay_order_id];
  if (!pending || pending.product_id !== productId) {
    return sendJson(res, 400, { verified: false, error: "Order does not match this product" });
  }

  const purchase = upsertPurchaseFromPayment(db, normalizeRazorpayPayment(payment.data, pending));
  writeDb(db);
  setDownloadCookie(res, purchase.download_token, purchase.expires_at);

  sendJson(res, 200, {
    verified: true,
    redirect_url: `/thank-you?order_id=${encodeURIComponent(razorpay_order_id)}`
  });
}

async function handlePurchaseStatus(req, res, url) {
  const sessionId = url.searchParams.get("session_id") || "";
  const orderId = url.searchParams.get("order_id") || "";
  const tokenFromCookie = readCookie(req, "download_token");
  const db = readDb();

  let purchase =
    findValidPurchaseByToken(db, tokenFromCookie) ||
    findPurchaseBySession(db, sessionId) ||
    findPurchaseByOrder(db, orderId);

  if (!purchase && sessionId) {
    const verified = await verifyCheckoutSession(sessionId);
    if (verified.ok) {
      purchase = upsertPurchaseFromPayment(db, verified.payment);
      writeDb(db);
    }
  }

  if (!purchase || !isPurchaseDownloadable(purchase)) {
    return sendJson(res, 200, {
      verified: false,
      status: purchase ? purchase.payment_status : "unverified",
      message: "Your purchase could not be verified."
    });
  }

  setDownloadCookie(res, purchase.download_token, purchase.expires_at);
  sendJson(res, 200, {
    verified: true,
    status: purchase.payment_status,
    email: purchase.customer_email || null,
    expires_at: purchase.expires_at,
    download_url: "/api/download"
  });
}

async function handlePaymentWebhook(req, res) {
  const rawBody = await readRequestBody(req);
  const provider = getPaymentProvider();

  if (provider === "razorpay") {
    return handleRazorpayWebhook(req, res, rawBody);
  }

  if (provider !== "stripe") {
    return sendJson(res, 400, { error: "Unsupported payment provider" });
  }

  if (!verifyStripeWebhookSignature(req, rawBody)) {
    return sendJson(res, 400, { error: "Invalid webhook signature" });
  }

  const event = JSON.parse(rawBody.toString("utf8"));
  const db = readDb();

  if (db.processed_events[event.id]) {
    return sendJson(res, 200, { received: true, idempotent: true });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data && event.data.object;
    if (isStripeSessionPaidForProduct(session)) {
      upsertPurchaseFromPayment(db, normalizeStripeSession(session));
    }
  }

  db.processed_events[event.id] = new Date().toISOString();
  writeDb(db);
  sendJson(res, 200, { received: true });
}

function handleRazorpayWebhook(req, res, rawBody) {
  if (!verifyRazorpayWebhookSignature(req, rawBody)) {
    return sendJson(res, 400, { error: "Invalid webhook signature" });
  }

  const event = JSON.parse(rawBody.toString("utf8"));
  const db = readDb();
  const eventId = event.id || crypto.createHash("sha256").update(rawBody).digest("hex");

  if (db.processed_events[eventId]) {
    return sendJson(res, 200, { received: true, idempotent: true });
  }

  if (event.event === "payment.captured" || event.event === "order.paid") {
    const payment = event.payload && event.payload.payment && event.payload.payment.entity;
    const order = event.payload && event.payload.order && event.payload.order.entity;
    const orderId = (payment && payment.order_id) || (order && order.id);
    const pending = db.pending_orders[orderId] || {
      provider: "razorpay",
      order_id: orderId,
      amount: order && order.amount,
      currency: (order && order.currency) || (payment && payment.currency),
      product_id: productId
    };

    const productMatches = pending.product_id === productId || (order && order.notes && order.notes.product_id === productId);
    if (payment && payment.status === "captured" && productMatches) {
      upsertPurchaseFromPayment(db, normalizeRazorpayPayment(payment, pending));
    }
  }

  db.processed_events[eventId] = new Date().toISOString();
  writeDb(db);
  sendJson(res, 200, { received: true });
}

function handleDownload(req, res, url) {
  const token = readCookie(req, "download_token") || url.searchParams.get("token");
  const db = readDb();
  const purchase = findValidPurchaseByToken(db, token);

  if (!purchase || !isPurchaseDownloadable(purchase)) {
    return sendJson(res, 403, { error: "Access denied" });
  }

  const ebookPath = resolvePrivatePath(process.env.EBOOK_STORAGE_PATH || "private/50-micro-saas.pdf");
  if (!fs.existsSync(ebookPath)) {
    return sendJson(res, 500, { error: "Ebook file is not configured on the server" });
  }

  purchase.download_count = Number(purchase.download_count || 0) + 1;
  purchase.last_downloaded_at = new Date().toISOString();
  writeDb(db);

  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": 'attachment; filename="50-micro-saas-you-can-build-without-coding.pdf"',
    "Cache-Control": "no-store"
  });
  fs.createReadStream(ebookPath).pipe(res);
}

async function verifyCheckoutSession(sessionId) {
  const provider = getPaymentProvider();
  if (provider !== "stripe" || !process.env.PAYMENT_SECRET_KEY) {
    return { ok: false, reason: "provider_not_configured" };
  }

  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${process.env.PAYMENT_SECRET_KEY}` }
  });

  if (!response.ok) {
    return { ok: false, reason: "provider_rejected_session" };
  }

  const session = await response.json();
  if (!isStripeSessionPaidForProduct(session)) {
    return { ok: false, reason: "not_paid_or_wrong_product" };
  }

  return { ok: true, payment: normalizeStripeSession(session) };
}

function normalizeStripeSession(session) {
  return {
    provider: "stripe",
    payment_id: session.payment_intent || session.id,
    session_id: session.id,
    customer_email: session.customer_details && session.customer_details.email,
    payment_status: session.payment_status === "paid" ? "paid" : session.status,
    product_id: (session.metadata && session.metadata.product_id) || productId,
    purchase_timestamp: new Date((session.created || Date.now() / 1000) * 1000).toISOString()
  };
}

function normalizeRazorpayPayment(payment, pending) {
  return {
    provider: "razorpay",
    payment_id: payment.id,
    order_id: pending.order_id || payment.order_id,
    customer_email: payment.email || null,
    payment_status: payment.status === "captured" ? "paid" : payment.status,
    product_id: pending.product_id || productId,
    amount: payment.amount || pending.amount,
    currency: payment.currency || pending.currency,
    purchase_timestamp: new Date((payment.created_at || Date.now() / 1000) * 1000).toISOString()
  };
}

function isStripeSessionPaidForProduct(session) {
  if (!session) return false;
  const metadataProduct = session.metadata && session.metadata.product_id;
  const productMatches = !metadataProduct || metadataProduct === productId;
  return session.payment_status === "paid" && productMatches;
}

function upsertPurchaseFromPayment(db, payment) {
  const existing =
    db.purchases.find((item) => item.payment_id === payment.payment_id) ||
    db.purchases.find((item) => item.session_id && item.session_id === payment.session_id);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + tokenTtlHours * 60 * 60 * 1000).toISOString();

  if (existing) {
    Object.assign(existing, payment, {
      payment_status: "paid",
      updated_at: now.toISOString()
    });
    if (!existing.download_token || new Date(existing.expires_at) < now) {
      existing.download_token = createToken();
      existing.expires_at = expiresAt;
    }
    return existing;
  }

  const purchase = {
    ...payment,
    payment_status: "paid",
    download_token: createToken(),
    download_count: 0,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: expiresAt
  };
  db.purchases.push(purchase);
  return purchase;
}

function isPurchaseDownloadable(purchase) {
  return (
    purchase.payment_status === "paid" &&
    purchase.product_id === productId &&
    purchase.download_token &&
    new Date(purchase.expires_at).getTime() > Date.now()
  );
}

function findPurchaseBySession(db, sessionId) {
  if (!sessionId) return null;
  return db.purchases.find((item) => item.session_id === sessionId) || null;
}

function findPurchaseByOrder(db, orderId) {
  if (!orderId) return null;
  return db.purchases.find((item) => item.order_id === orderId) || null;
}

function findValidPurchaseByToken(db, token) {
  if (!token) return null;
  return db.purchases.find((item) => timingSafeEqual(item.download_token, token)) || null;
}

function verifyStripeWebhookSignature(req, rawBody) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  const signatureHeader = req.headers["stripe-signature"];
  if (!secret || !signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    })
  );

  if (!parts.t || !parts.v1) return false;
  const signedPayload = `${parts.t}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return timingSafeEqual(expected, parts.v1);
}

function verifyRazorpayPaymentSignature(orderId, paymentId, signature) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return timingSafeEqual(expected, signature);
}

function verifyRazorpayWebhookSignature(req, rawBody) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers["x-razorpay-signature"];
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(expected, signature);
}

async function createRazorpayOrder(payload) {
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) return { ok: false };
  return { ok: true, data: await response.json() };
}

async function fetchRazorpayPayment(paymentId) {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || !paymentId) {
    return { ok: false };
  }

  const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`
    }
  });

  if (!response.ok) return { ok: false };
  return { ok: true, data: await response.json() };
}

function serveStatic(res, pathname) {
  const normalized = pathname.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, normalized);
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: "Access denied" });
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, 404, { error: "Not found" });
  }
  serveFile(res, filePath);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400"
  });
  fs.createReadStream(filePath).pipe(res);
}

function readDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  const defaults = { purchases: [], processed_events: {}, pending_orders: {} };
  if (!fs.existsSync(dbPath)) return defaults;
  return { ...defaults, ...JSON.parse(fs.readFileSync(dbPath, "utf8")) };
}

function writeDb(db) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function resolvePrivatePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function createToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function setDownloadCookie(res, token, expiresAt) {
  const secure = getSiteUrl().startsWith("https://") ? "; Secure" : "";
  res.setHeader("Set-Cookie", `download_token=${token}; HttpOnly; SameSite=Lax; Path=/; Expires=${new Date(expiresAt).toUTCString()}${secure}`);
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  return header
    .split(";")
    .map((cookie) => cookie.trim().split("="))
    .find(([key]) => key === name)?.[1];
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body>${html}</body></html>`);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonRequest(req) {
  const rawBody = await readRequestBody(req);
  if (!rawBody.length) return {};
  return JSON.parse(rawBody.toString("utf8"));
}

function timingSafeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getSiteUrl() {
  return process.env.SITE_URL || `http://localhost:${port || 3000}`;
}

function getPaymentProvider() {
  return (process.env.PAYMENT_PROVIDER || "razorpay").toLowerCase();
}

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!match || match[1].startsWith("#")) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
