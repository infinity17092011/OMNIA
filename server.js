// Omnia server v2 (CommonJS, only needs "express")
const express = require("express");
const path = require("path");
const fs = require("fs");

const VERSION = "2";
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const MODELS = {
  chatgpt:  { name: "ChatGPT",  id: process.env.MODEL_CHATGPT  || "openai/gpt-5",                vision: true  },
  claude:   { name: "Claude",   id: process.env.MODEL_CLAUDE   || "anthropic/claude-sonnet-4.5", vision: true  },
  grok:     { name: "Grok",     id: process.env.MODEL_GROK     || "x-ai/grok-4.3",                vision: true  },
  deepseek: { name: "DeepSeek", id: process.env.MODEL_DEEPSEEK || "deepseek/deepseek-chat",      vision: false },
};
const ROUTER_MODEL = process.env.ROUTER_MODEL || "openai/gpt-4o-mini";

// ---- middleware (CORS done by hand, no extra package) ----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "15mb" }));

// ---- find index.html (public/index.html, or next to server.js) ----
const publicDir = path.join(__dirname, "public");
const indexInPublic = path.join(publicDir, "index.html");
const indexInRoot = path.join(__dirname, "index.html");
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

app.get("/", (_req, res) => {
  if (fs.existsSync(indexInPublic)) return res.sendFile(indexInPublic);
  if (fs.existsSync(indexInRoot)) return res.sendFile(indexInRoot);
  res.send("Omnia server is running (v" + VERSION + "), but index.html was not found. Put it in a folder named public.");
});

// ---- OpenRouter helper ----
async function callOpenRouter(model, messages, extra = {}) {
  const r = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + API_KEY,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.SITE_URL || "https://onrender.com",
      "X-Title": "Omnia",
    },
    body: JSON.stringify(Object.assign({ model, messages }, extra)),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || "OpenRouter error " + r.status);
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error("Empty response from model");
  return text;
}

// ---- routing ----
const ROUTER_PROMPT = `You are a router. Pick the single best AI for the user's request.

Options:
- claude: coding, debugging, long-form writing, editing, document analysis, nuanced reasoning
- chatgpt: general knowledge, everyday questions, brainstorming, summaries, translation, explaining images
- grok: current events, news, trending topics, real-time info, casual or witty conversation
- deepseek: math, logic puzzles, step-by-step problem solving, algorithms, science calculations

Reply ONLY with JSON, nothing else: {"ai":"claude|chatgpt|grok|deepseek","reason":"max 12 words"}`;

function fallbackRoute(text, hasImage) {
  const t = text.toLowerCase();
  if (hasImage) return { ai: "chatgpt", reason: "Image analysis" };
  if (/\b(code|function|bug|debug|javascript|python|html|css|react|sql|api|script)\b/.test(t)) return { ai: "claude", reason: "Coding task" };
  if (/\b(solve|equation|calculate|integral|derivative|proof|probability|math|algorithm)\b/.test(t)) return { ai: "deepseek", reason: "Math / logic task" };
  if (/\b(news|today|latest|trending|current|right now|twitter|election|score)\b/.test(t)) return { ai: "grok", reason: "Current events" };
  if (/\b(write|essay|story|email|rewrite|edit|article)\b/.test(t)) return { ai: "claude", reason: "Writing task" };
  return { ai: "chatgpt", reason: "General question" };
}

async function pickAI(text, hasImage) {
  try {
    const out = await callOpenRouter(
      ROUTER_MODEL,
      [
        { role: "system", content: ROUTER_PROMPT },
        { role: "user", content: (hasImage ? "[User attached an image]\n" : "") + (text || "(image only)") },
      ],
      { temperature: 0, max_tokens: 60 }
    );
    const m = out.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : out);
    let ai = String(parsed.ai || "").toLowerCase();
    if (!MODELS[ai]) throw new Error("bad router choice");
    if (hasImage && !MODELS[ai].vision) ai = "chatgpt";
    return { ai, reason: String(parsed.reason || "Best fit").slice(0, 120) };
  } catch (e) {
    console.warn("Router failed, using fallback:", e.message);
    return fallbackRoute(text, hasImage);
  }
}

// ---- API routes ----
app.get("/health", (_req, res) => res.json({ ok: true, version: VERSION, keySet: !!API_KEY }));

app.get("/api/models", (_req, res) =>
  res.json(Object.keys(MODELS).map((k) => ({ key: k, name: MODELS[k].name, vision: MODELS[k].vision })))
);

app.post("/api/chat", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: "OPENROUTER_API_KEY is not set on the server." });

    const body = req.body || {};
    const text = String(body.message || "").trim();
    const image = body.image;
    const hasImage = typeof image === "string" && image.startsWith("data:image/");
    const requested = body.model || "auto";
    if (!text && !hasImage) return res.status(400).json({ error: "Send a message or an image." });

    let choice, auto = true;
    if (requested !== "auto" && MODELS[requested]) {
      auto = false;
      choice = { ai: requested, reason: "Manually selected" };
      if (hasImage && !MODELS[requested].vision) {
        choice = { ai: "chatgpt", reason: MODELS[requested].name + " can't read images, used ChatGPT" };
      }
    } else {
      choice = await pickAI(text, hasImage);
    }
    const chosen = MODELS[choice.ai];

    const past = (Array.isArray(body.history) ? body.history : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    const userContent = hasImage
      ? [
          { type: "text", text: text || "Describe this image." },
          { type: "image_url", image_url: { url: image } },
        ]
      : text;

    const reply = await callOpenRouter(chosen.id, [
      { role: "system", content: "You are a helpful assistant. Answer clearly and concisely." },
      ...past,
      { role: "user", content: userContent },
    ]);

    res.json({ reply, ai: { key: choice.ai, name: chosen.name, model: chosen.id }, reason: choice.reason, auto });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message || "Something went wrong." });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log("Omnia server v" + VERSION + " running on port " + PORT));
