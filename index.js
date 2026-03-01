import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Supabase (service role key required)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

/**
 * Helper: Gemini call wrapper
 */
async function askGemini(prompt) {
  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
  });

  return result.response.candidates[0].content.parts[0].text;
}

/**
 * Only expose safe parts of your schema
 */
const SAFE_SCHEMA = `
Table: auth.users
Allowed columns:
- id
- email
- created_at
- last_sign_in_at
- is_anonymous

Rules:
- Only SELECT queries
- Never expose passwords, tokens, or secrets
- Never modify or delete data
`;

/**
 * Decide if DB is required
 */
async function needsDatabase(question) {
  const prompt = `
Classify the intent.

Reply ONLY:
DB -> if database info needed
CHAT -> for general conversation

Question: "${question}"
`;

  const text = await askGemini(prompt);
  return text.toUpperCase().includes("DB");
}

/**
 * Generate safe SQL
 */
async function generateSQL(question) {
  const prompt = `
You are a PostgreSQL expert.

${SAFE_SCHEMA}

Generate ONLY a safe SELECT SQL query.
No explanations. No markdown.

Question: "${question}"
`;

  let sql = await askGemini(prompt);
  sql = sql.trim().replace(/```sql|```/g, "");

  if (!sql.toLowerCase().startsWith("select")) {
    throw new Error("Unsafe query generated");
  }

  return sql;
}

/**
 * Execute query (mapped safely)
 */
async function runSQL(sql) {
  if (sql.toLowerCase().includes("auth.users")) {
    const { data, error } = await supabase
      .from("users") // Supabase maps auth.users -> users
      .select("id, email, created_at, last_sign_in_at, is_anonymous");

    if (error) throw error;
    return data;
  }

  return [];
}

/**
 * Creative conversational response
 */
async function creativeReply(question, dbData) {
  const prompt = `
You are a friendly, witty AI assistant.

User Question:
${question}

Database Result:
${JSON.stringify(dbData)}

Respond conversationally, creatively, and clearly.
Avoid robotic tone.
`;

  return await askGemini(prompt);
}

/**
 * Chat API
 */
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message required" });
    }

    const useDB = await needsDatabase(message);

    // CHAT ONLY
    if (!useDB) {
      const reply = await askGemini(message);
      return res.json({ reply });
    }

    // Generate SQL safely
    const sql = await generateSQL(message);

    // Fetch data
    const dbData = await runSQL(sql);

    // Creative final answer
    const reply = await creativeReply(message, dbData);

    res.json({
      reply,
      debug: { sql, dbData },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Gemini Supabase Chatbot running")
);
