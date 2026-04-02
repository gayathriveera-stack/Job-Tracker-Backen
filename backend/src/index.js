require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");
const { google } = require("googleapis");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── OAuth2 client ──────────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ── Auth routes ────────────────────────────────────────────────────────────────
app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
  });
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    // Upsert user + tokens into Supabase
    const { data: user, error } = await supabase
      .from("users")
      .upsert({
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expiry: tokens.expiry_date,
      }, { onConflict: "email" })
      .select()
      .single();

    if (error) throw error;

    // Trigger first Gmail scan
    await scanGmailForUser(user);

    res.redirect(`${process.env.FRONTEND_URL}?user=${encodeURIComponent(JSON.stringify({ id: user.id, email: user.email, name: user.name, picture: user.picture }))}`);
  } catch (err) {
    console.error("Auth error:", err);
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`);
  }
});

// ── Applications CRUD ──────────────────────────────────────────────────────────
app.get("/applications/:userId", async (req, res) => {
  const { data, error } = await supabase
    .from("applications")
    .select("*")
    .eq("user_id", req.params.userId)
    .order("applied_date", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/applications", async (req, res) => {
  const { data, error } = await supabase
    .from("applications")
    .insert(req.body)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/applications/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("applications")
    .update(req.body)
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/applications/:id", async (req, res) => {
  const { error } = await supabase
    .from("applications")
    .delete()
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Manual Gmail sync trigger ──────────────────────────────────────────────────
app.post("/sync/:userId", async (req, res) => {
  try {
    const { data: user } = await supabase.from("users").select("*").eq("id", req.params.userId).single();
    const count = await scanGmailForUser(user);
    res.json({ imported: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gmail scanning logic ───────────────────────────────────────────────────────
async function scanGmailForUser(user) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({
    access_token: user.access_token,
    refresh_token: user.refresh_token,
    expiry_date: user.token_expiry,
  });

  // Auto-refresh token
  auth.on("tokens", async (tokens) => {
    await supabase.from("users").update({
      access_token: tokens.access_token,
      token_expiry: tokens.expiry_date,
    }).eq("id", user.id);
  });

  const gmail = google.gmail({ version: "v1", auth });

  // Search for job-related emails (last 90 days)
  const query = [
  "(in:inbox OR in:sent)",
  "-category:promotions",
  "-category:social",
  "-category:updates",
  "subject:(application OR applied OR interview OR rejected)",
  "newer_than:90d",
].join(" ");

  const { data: listData } = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 100,
  });

  if (!listData.messages?.length) return 0;

  let imported = 0;

  for (const msg of listData.messages) {
    // Skip already imported
    const { data: existing } = await supabase
      .from("applications")
      .select("id")
      .eq("gmail_message_id", msg.id)
      .maybeSingle();
    if (existing) continue;

    const { data: full } = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = Object.fromEntries(
      full.payload.headers.map((h) => [h.name.toLowerCase(), h.value])
    );

    const parsed = parseJobEmail(headers);
    if (!parsed) continue;

    await supabase.from("applications").insert({
      user_id: user.id,
      gmail_message_id: msg.id,
      ...parsed,
    });
    imported++;
  }

  return imported;
}

// ── Email parser ───────────────────────────────────────────────────────────────
function parseJobEmail(headers) {
  const subject = headers["subject"] || "";
  const from = headers["from"] || "";
  const s = subject.toLowerCase();
  const f = from.toLowerCase();

  // ❌ Step 1: HARD REJECTION (non-job emails)
  const negativeKeywords = [
    "github", "otp", "verify", "password", "account",
    "subscription", "payment", "invoice", "order",
    "discount", "sale", "offer", "premium", "upgrade"
  ];

  if (negativeKeywords.some(k => s.includes(k))) return null;

  // ✅ Step 2: Strong job signal required
  const hasJobSignal =
    /job|role|position|career|hiring/i.test(subject) ||
    /linkedin|naukri|indeed|greenhouse|lever|workday|careers/i.test(from);

  if (!hasJobSignal) return null;

  // ✅ Step 3: Only allow 3 statuses

  let status = null;

  if (/applied|application received|thank you for applying/i.test(s)) {
    status = "Applied";
  }

  else if (/interview|schedule|invited|assessment|next round/i.test(s)) {
    status = "Interview";
  }

  else if (/regret|not selected|not moving forward|unfortunately|declined/i.test(s)) {
    status = "Rejected";
  }

  else {
    return null; // ❌ ignore everything else
  }

  const date = headers["date"]
    ? new Date(headers["date"]).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const companyMatch = from.match(/^"?([^"<]+)"?\s*</);
  const company = companyMatch
    ? companyMatch[1].trim()
    : from.split("@")[1]?.split(".")[0] || "Unknown";

  const role = subject
    .replace(/re:|fwd:/gi, "")
    .replace(/application|applied|interview|thank you/gi, "")
    .trim()
    .slice(0, 60) || "Unknown Role";

  return {
    company,
    role,
    applied_date: date,
    status,
    source: "Gmail",
  };
}

// ── Cron: scan all users every 6 hours ────────────────────────────────────────
cron.schedule("0 */6 * * *", async () => {
  console.log("Running scheduled Gmail scan...");
  const { data: users } = await supabase.from("users").select("*");
  for (const user of users || []) {
    try { await scanGmailForUser(user); } catch (e) { console.error(`Scan failed for ${user.email}:`, e.message); }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
