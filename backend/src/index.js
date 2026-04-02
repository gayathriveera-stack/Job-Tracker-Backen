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

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ── AUTH ─────────────────────────────────────────────────────────────────────
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
      id: user.id, email: user.email, name: user.name, picture: user.picture
    }))}`);
  } catch (err) {
    console.error(err);
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`);
  }
});

// ── CRUD ─────────────────────────────────────────────────────────────────────
app.get("/applications/:userId", async (req, res) => {
  const { data } = await supabase
    .from("applications").select("*")
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

app.post("/sync/:userId", async (req, res) => {
  try {
    const { data: user } = await supabase.from("users").select("*").eq("id", req.params.userId).single();
    const count = await scanGmailForUser(user);
    res.json({ imported: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EMAIL BODY EXTRACTOR ─────────────────────────────────────────────────────
function getEmailBody(payload) {
  if (!payload) return "";

  // Recursively search all parts for text/plain or text/html
  function extractFromParts(parts) {
    if (!parts) return "";
    for (const part of parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
      if (part.parts) {
        const nested = extractFromParts(part.parts);
        if (nested) return nested;
      }
    }
    // Fallback to html if no plain text
    for (const part of parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64")
          .toString("utf-8")
          .replace(/<[^>]+>/g, " ") // strip HTML tags
          .replace(/\s+/g, " ")
          .trim();
      }
    }
    return "";
  }

  if (payload.parts) return extractFromParts(payload.parts);
  if (payload.body?.data) return Buffer.from(payload.body.data, "base64").toString("utf-8");
  return "";
}

// ── COMPANY EXTRACTOR ─────────────────────────────────────────────────────────
function extractCompany(from, subject, body) {
  // 1. Try domain-based extraction first
  const domainMatch = from.match(/@([\w.-]+)\./);
  if (domainMatch) {
    let domain = domainMatch[1];
    // Strip common email service prefixes
    domain = domain.replace(/^(mail|careers|jobs|apply|notifications|hr|talent|recruit|noreply|no-reply|hello|info|team)$/i, "");
    if (domain && !["gmail", "yahoo", "outlook", "hotmail", "icloud", "googlemail"].includes(domain.toLowerCase())) {
      return domain.charAt(0).toUpperCase() + domain.slice(1);
    }
  }

  // 2. Try "at CompanyName" pattern in subject
  const atMatch = subject.match(/\bat\s+([A-Z][A-Za-z\s&]+?)(?:\s*[-|!,.]|$)/);
  if (atMatch) return atMatch[1].trim();

  // 3. Try "from CompanyName" in body
  const fromBodyMatch = body.match(/(?:from|at|with)\s+([A-Z][A-Za-z\s&]{2,30})(?:\s*[,.]|\s+team|\s+is)/);
  if (fromBodyMatch) return fromBodyMatch[1].trim();

  // 4. Try sender display name — e.g. "Natalie Hatchard <...>" → check body for company
  const companyInBody = body.match(/([A-Z][A-Za-z\s&]{2,25})\s+(?:is hiring|has a|team|role|position|opportunity)/i);
  if (companyInBody) return companyInBody[1].trim();

  // 5. Use sender display name as fallback (e.g. "Josh Hadley" → "Josh Hadley")
  const displayName = from.match(/^"?([^"<@]+)"?\s*</);
  if (displayName) return displayName[1].trim();

  return "Unknown";
}

// ── ROLE EXTRACTOR ────────────────────────────────────────────────────────────
function extractRole(subject, body) {
  // 1. "Role: X" or "Position: X" patterns
  const labeled = body.match(/(?:role|position|job title|opening)[:\s]+([A-Za-z\s\/\-]+?)(?:\n|\.|\bat\b)/i);
  if (labeled) return labeled[1].trim().slice(0, 80);

  // 2. Subject line — strip noise words
  const cleaned = subject
    .replace(/^(re:|fwd:|fw:)\s*/gi, "")
    .replace(/\b(your application|application for|thank you|interview|update on|an update|opportunity|hello|hi)\b/gi, "")
    .replace(/[-|–—]\s*(employment hero|linkedin|indeed|naukri|greenhouse).*/gi, "")
    .replace(/\[.*?\]/g, "")   // remove [EH-48...] ticket refs
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 3) return cleaned.slice(0, 80);

  // 3. Scan body for role mention
  const bodyRole = body.match(/(?:applying for|applied for|role of|position of)\s+(?:the\s+)?([A-Za-z\s\/\-]+?)(?:\s+at|\s+role|\.|,)/i);
  if (bodyRole) return bodyRole[1].trim().slice(0, 80);

  return "Unknown Role";
}

// ── STATUS DETECTOR ───────────────────────────────────────────────────────────
function detectStatus(subject, body, from) {
  const text = (subject + " " + body).toLowerCase();
  const f = from.toLowerCase();

  // Offer
  if (/we('d| would) like to offer|pleased to offer|offer letter|job offer|congratulations.*(?:role|position|joining)/i.test(text)) {
    return "Offer";
  }

  // Rejected
  if (/regret|not (?:moving forward|selected|progressing|shortlisted)|unfortunately.*(?:position|role|candidat)|we will not|decided to move forward with other/i.test(text)) {
    return "Rejected";
  }

  // Interview
  if (/(?:schedule|invite|invited|book|confirm).*(?:interview|call|meeting|chat)|interview.*(?:schedule|invite|confirm)|next (?:step|round|stage)|assessment|technical (?:test|round|interview)/i.test(text)) {
    return "Interview";
  }

  // Applied — confirmation emails
  if (/(?:received|reviewing|thank you for applying|application (?:received|submitted|confirmed)|we have received your)/i.test(text)) {
    return "Applied";
  }

  // Recruiter outreach — treat as Applied (they reached out about a role)
  if (/(?:came across your profile|your background|thought you(?:'d| would) be|great fit|exciting opportunity|we(?:'re| are) hiring|open to.*(?:role|opportunity)|people operations director|talent acquisition)/i.test(text)) {
    return "Applied";
  }

  // Fallback: if it came from a known job platform, mark as Applied
  if (/linkedin|indeed|naukri|greenhouse|lever|workday|employmenthero|smartrecruiters|jobvite/i.test(f + " " + text)) {
    return "Applied";
  }

  return null; // not a job email
}

// ── MAIN PARSER ───────────────────────────────────────────────────────────────
function parseJobEmail(headers, body = "") {
  const subject = headers["subject"] || "";
  const from = headers["from"] || "";
  const date = headers["date"]
    ? new Date(headers["date"]).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  // Hard ignore list — never job emails
  const fullText = (subject + " " + body).toLowerCase();
  if (/otp|password|reset|invoice|payment|transaction|imps|neft|bank|bill|receipt|order confirmed|shipment|delivery|unsubscribe from all/i.test(fullText)) {
    return null;
  }
  if (/^fwd:/i.test(subject)) return null;

  const status = detectStatus(subject, body, from);
  if (!status) return null;

  const company = extractCompany(from, subject, body);
  const role = extractRole(subject, body);

  return { company, role, applied_date: date, status, source: "Gmail" };
}

// ── SCANNER ───────────────────────────────────────────────────────────────────
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
  auth.on("tokens", async (tokens) => {
    await supabase.from("users").update({
      access_token: tokens.access_token,
      token_expiry: tokens.expiry_date,
    }).eq("id", user.id);
  });

  const gmail = google.gmail({ version: "v1", auth });

  // Broader search — catch more emails including recruiter outreach
  const query = [
    "newer_than:90d",
    "-category:promotions",
    "-category:social",
    "(",
      "subject:(application OR applied OR interview OR offer OR rejected OR assessment OR opportunity OR role OR position OR hiring)",
      "OR from:(linkedin OR indeed OR naukri OR greenhouse OR lever OR workday OR employmenthero OR smartrecruiters)",
    ")",
  ].join(" ");

  const { data } = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 150 });
  if (!data.messages) return 0;

  let count = 0;
  for (const msg of data.messages) {
    const exists = await supabase.from("applications").select("id").eq("gmail_message_id", msg.id).maybeSingle();
    if (exists.data) continue;

    const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
    const hdrs = Object.fromEntries(full.data.payload.headers.map(h => [h.name.toLowerCase(), h.value]));
    const body = getEmailBody(full.data.payload);
    const parsed = parseJobEmail(hdrs, body);
    if (!parsed) continue;

    await supabase.from("applications").insert({ user_id: user.id, gmail_message_id: msg.id, ...parsed });
    count++;
  }
  return count;
}

// ── CRON ─────────────────────────────────────────────────────────────────────
cron.schedule("0 */6 * * *", async () => {
  const { data: users } = await supabase.from("users").select("*");
  for (const user of users || []) {
    try { await scanGmailForUser(user); } catch (e) { console.error(e.message); }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
