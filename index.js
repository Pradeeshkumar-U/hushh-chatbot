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
  const res = await model.generateContent(prompt);
  return res.response.text().toUpperCase().includes("DB");
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

  const res = await model.generateContent(prompt);
  let sql = res.response.text().trim();

  if (!sql.toLowerCase().startsWith("select")) {
    throw new Error("Unsafe query generated");
  }

  return sql.replace(/```sql|```/g, "");
}

/**
 * Execute query (mapped safely)
 */
async function runSQL(sql) {
  // We only allow querying auth.users safely
  if (sql.toLowerCase().includes("auth.users")) {
    const { data, error } = await supabase
      .from("users")
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

  const res = await model.generateContent(prompt);
  return res.response.text();
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

    // If no DB needed → direct creative response
    if (!useDB) {
      const response = await model.generateContent(message);
      return res.json({ reply: response.response.text() });
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
