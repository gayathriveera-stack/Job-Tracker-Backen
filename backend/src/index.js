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

// ── OAuth ─────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ── AUTH ─────────────────────────
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

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    const { data: user } = await supabase
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

    await scanGmailForUser(user);

    res.redirect(`${process.env.FRONTEND_URL}?user=${encodeURIComponent(JSON.stringify({
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture
    }))}`);

  } catch (err) {
    console.error(err);
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`);
  }
});

// ── CRUD ─────────────────────────
app.get("/applications/:userId", async (req, res) => {
  const { data } = await supabase
    .from("applications")
    .select("*")
    .eq("user_id", req.params.userId)
    .order("applied_date", { ascending: false });

  res.json(data);
});

app.post("/applications", async (req, res) => {
  const { data } = await supabase.from("applications").insert(req.body).select().single();
  res.json(data);
});

app.put("/applications/:id", async (req, res) => {
  const { data } = await supabase.from("applications").update(req.body).eq("id", req.params.id).select().single();
  res.json(data);
});

app.delete("/applications/:id", async (req, res) => {
  await supabase.from("applications").delete().eq("id", req.params.id);
  res.json({ success: true });
});

// ── SYNC ─────────────────────────
app.post("/sync/:userId", async (req, res) => {
  try {
    const { data: user } = await supabase.from("users").select("*").eq("id", req.params.userId).single();
    const count = await scanGmailForUser(user);
    res.json({ imported: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EMAIL BODY ───────────────────
function getEmailBody(payload) {
  if (!payload) return "";

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
    }
  }

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  return "";
}

// ── COMPANY ──────────────────────
function extractCompany(from, subject) {
  const domainMatch = from.match(/@([\w.-]+)/);

  if (domainMatch) {
    let domain = domainMatch[1];
    domain = domain.replace(/^(mail|careers|jobs|apply|notifications)\./, "");
    const name = domain.split(".")[0];

    if (!["gmail", "yahoo", "outlook"].includes(name)) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }

  const match = subject.match(/at ([A-Za-z\s]+)/i);
  if (match) return match[1].trim();

  return "Unknown";
}

// ── STATUS ───────────────────────
function detectStatus(text) {
  if (/interview/i.test(text)) return "Interview";
  if (/regret|not selected|unfortunately/i.test(text)) return "Rejected";
  return "Applied";
}

// ── PARSER ───────────────────────
function parseJobEmail(headers, body = "") {
  const subject = headers["subject"] || "";
  const from = headers["from"] || "";

  // ❌ Ignore forwards only
  if (/^fwd:/i.test(subject)) return null;

  const text = (subject + " " + body).toLowerCase();

  // ❌ Ignore junk
  if (/github|otp|password|invoice|payment|order|discount|sale/i.test(text)) {
    return null;
  }

  // ❌ Ignore job alert emails
if (/jobs\s*\|/i.test(subject)) return null;

  // ❌ Ignore job alert emails
if (/job\s*\|/i.test(subject)) return null;

// ❌ Ignore USYD mails
if (/Admissions\s*/i.test(subject)) return null;
  if (/emba\s*&\s*mba\s*alumni\s*invitation/i.test(subject)) return null;
if (/Admission\s*/i.test(subject)) return null;
  
  // ✅ Accept if job-like
  const isJobEmail =
    /application|applied|interview|role|position|job/i.test(text);

  if (!isJobEmail) return null;

  const status = detectStatus(text);
  const company = extractCompany(from, subject);

  const date = headers["date"]
    ? new Date(headers["date"]).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const role = subject
    .replace(/^re:|^fwd:/gi, "")
    .replace(/application|interview|thank you/gi, "")
    .trim()
    .slice(0, 60);

  return {
    company,
    role,
    applied_date: date,
    status,
    source: "Gmail",
  };
}

// ── SCANNER ─────────────────────
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

  const gmail = google.gmail({ version: "v1", auth });

  const query = [
    "(in:inbox OR in:sent)",
    "-category:promotions",
    "-category:social",
    "-category:updates",
    "newer_than:90d",
  ].join(" ");

  const { data } = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 150,
  });

  if (!data.messages) return 0;

  let count = 0;

  for (const msg of data.messages) {
    const exists = await supabase
      .from("applications")
      .select("id")
      .eq("gmail_message_id", msg.id)
      .maybeSingle();

    if (exists.data) continue;

    const full = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "full",
    });

    const headers = Object.fromEntries(
      full.data.payload.headers.map(h => [h.name.toLowerCase(), h.value])
    );

    const body = getEmailBody(full.data.payload);

    const parsed = parseJobEmail(headers, body);
    if (!parsed) continue;

    await supabase.from("applications").insert({
      user_id: user.id,
      gmail_message_id: msg.id,
      ...parsed,
    });

    count++;
  }

  return count;
}

// ── CRON ────────────────────────
cron.schedule("0 */6 * * *", async () => {
  const { data: users } = await supabase.from("users").select("*");
  for (const user of users || []) {
    try { await scanGmailForUser(user); } catch (e) { console.error(e.message); }
  }
});

// ── SERVER ──────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
