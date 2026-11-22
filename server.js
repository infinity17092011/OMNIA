import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// ---------------------------------------------------------------
// The 4 AIs. Model IDs can be changed from Render env vars
// without touching the code (check openrouter.ai/models for names).
// vision = can the model read images?
// ---------------------------------------------------------------
const MODELS = {
  chatgpt: {
    name: "ChatGPT",
    id: process.env.MODEL_CHATGPT || "openai/gpt-5",
    vision: true,
  },
  claude: {
    name: "Claude",
    id: process.env.MODEL_CLAUDE || "anthropic/claude-sonnet-4.5",
    vision: true,
  },
  grok: {
    name: "Grok",
    id: process.env.MODEL_GROK || "x-ai/grok-4",
    vision: true,
  },
  deepseek: {
    name: "DeepSeek",
    id: process.env.MODEL_DEEPSEEK || "deepseek/deepseek-chat",
    vision: false, // text only
  },
};

// Cheap, fast model that decides which AI should answer
const ROUTER_MODEL = process.env.ROUTER_MODEL || "openai/gpt-4o-mini";

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "15mb" })); // room for base64 images
app.use(express.static(path.join(__dirname, "public"))); // index.html goes in /public

// ---------------------------------------------------------------
// OpenRouter helper
// ---------------------------------------------------------------
async function callOpenRouter(model, messages, extra = {}) {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.SITE_URL || "https://onrender.com",
      "X-Title": process.env.SITE_NAME || "Multi-AI Chatbot",
    },
    body: JSON.stringify({ model, messages, ...extra }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `OpenRouter error ${res.status}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty response from model");
  return text;
}

// ---------------------------------------------------------------
// Routing: pick the best AI for the task
// ---------------------------------------------------------------
const ROUTER_PROMPT = `You are a router. Pick the single best AI for the user's request.

Options:
- claude: coding, debugging, long-form writing, editing, document analysis, nuanced or careful reasoning
- chatgpt: general knowledge, everyday questions, brainstorming, summaries, translation, explaining images
- grok: current events, news, trending topics, real-time info, casual/witty or edgy conversation
- deepseek: math, logic puzzles, step-by-step problem solving, algorithms, science calculations

Reply ONLY with JSON, no other text: {"ai":"claude|chatgpt|grok|deepseek","reason":"max 12 words"}`;

function heuristicRoute(text, hasImage) {
  const t = text.toLowerCase();
  if (hasImage) return { ai: "chatgpt", reason: "Image analysis" };
  if (/\b(code|function|bug|debug|javascript|python|html|css|react|sql|api|script|refactor)\b/.test(t))
    return { ai: "claude", reason: "Coding task" };
  if (/\b(solve|equation|calculate|integral|derivative|proof|probability|math|algorithm)\b/.test(t) || /\d\s*[+\-*/^]\s*\d/.test(t))
    return { ai: "deepseek", reason: "Math / logic task" };
  if (/\b(news|today|latest|trending|current|right now|tweet|twitter|x\.com|election|score)\b/.test(t))
    return { ai: "grok", reason: "Current events" };
  if (/\b(write|essay|story|email|rewrite|edit|article)\b/.test(t))
    return { ai: "claude", reason: "Writing task" };
  return { ai: "chatgpt", reason: "General question" };
}

async function pickAI(text, hasImage) {
  try {
    const out = await callOpenRouter(
      ROUTER_MODEL,
      [
        { role: "system", content: ROUTER_PROMPT },
        {
          role: "user",
          content: `${hasImage ? "[The user also attached an image]\n" : ""}${text || "(no text, image only)"}`,
        },
      ],
      { temperature: 0, max_tokens: 60 }
    );

    const match = out.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : out);
    let ai = String(parsed.ai || "").toLowerCase();

    if (!MODELS[ai]) throw new Error("Invalid router choice");
    // DeepSeek can't see images, so swap if the router picked it
    if (hasImage && !MODELS[ai].vision) ai = "chatgpt";

    return { ai, reason: String(parsed.reason || "Best fit for this task").slice(0, 120) };
  } catch (err) {
    console.warn("Router failed, using fallback:", err.message);
    return heuristicRoute(text, hasImage);
  }
}

// ---------------------------------------------------------------
// Routes
// ---------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/models", (_req, res) => {
  res.json(
    Object.entries(MODELS).map(([key, m]) => ({ key, name: m.name, vision: m.vision }))
  );
});

/**
 * POST /api/chat
 * body: {
 *   message: "text",
 *   image: "data:image/png;base64,...."   (optional),
 *   history: [{ role: "user"|"assistant", content: "text" }]  (optional),
 *   model: "auto" | "chatgpt" | "claude" | "grok" | "deepseek"  (optional, default auto)
 * }
 * returns: { reply, ai: { key, name, model }, reason, auto }
 */
app.post("/api/chat", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: "OPENROUTER_API_KEY is not set on the server." });
    }

    const { message = "", image, history = [], model = "auto" } = req.body || {};
    const text = String(message).trim();
    const hasImage = typeof image === "string" && image.startsWith("data:image/");

    if (!text && !hasImage) {
      return res.status(400).json({ error: "Send a message or an image." });
    }

    // 1. Choose the AI
    let choice;
    let auto = true;
    if (model !== "auto" && MODELS[model]) {
      auto = false;
      choice = { ai: model, reason: "Manually selected" };
      if (hasImage && !MODELS[model].vision) {
        choice = { ai: "chatgpt", reason: `${MODELS[model].name} can't read images, switched to ChatGPT` };
      }
    } else {
      choice = await pickAI(text, hasImage);
    }
    const chosen = MODELS[choice.ai];

    // 2. Build the conversation (last 10 text messages of history)
    const pastMessages = (Array.isArray(history) ? history : [])
      .filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    const userContent = hasImage
      ? [
          { type: "text", text: text || "Describe this image." },
          { type: "image_url", image_url: { url: image } },
        ]
      : text;

    const messages = [
      { role: "system", content: "You are a helpful assistant. Answer clearly and concisely." },
      ...pastMessages,
      { role: "user", content: userContent },
    ];

    // 3. Ask the chosen AI
    const reply = await callOpenRouter(chosen.id, messages);

    res.json({
      reply,
      ai: { key: choice.ai, name: chosen.name, model: chosen.id },
      reason: choice.reason,
      auto,
    });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message || "Something went wrong." });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
