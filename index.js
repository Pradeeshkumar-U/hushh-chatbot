import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Supabase client (use service role key)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "models/gemini-2.5-flash" });

// Helper to safely extract text from Gemini response
function getText(res) {
  return res.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Clean SQL (remove comments, code fences, trim)
function cleanSQL(sql) {
  return sql
    .replace(/```sql|```/g, "")
    .replace(/--.*$/gm, "")
    .trim();
}

/**
 * Schema: public.profiles
 * Only SELECT allowed
 */
const SAFE_SCHEMA = `
Table: public.profiles
Columns:
- id
- full_name
- role
- created_at

Rules:
- Only SELECT queries
- Never modify or delete data
`;

// Determine if DB is needed
async function needsDatabase(question) {
  const prompt = `Reply ONLY "DB" or "CHAT". Question: "${question}"`;
  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
  return getText(res).toUpperCase().includes("DB");
}

// Generate safe SQL
async function generateSQL(question) {
  const prompt = `
You are a PostgreSQL expert.
${SAFE_SCHEMA}
Generate ONLY a SELECT SQL query.
Question: "${question}"
`;

  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const sql = cleanSQL(getText(res));

  // Only allow SELECT
  if (!sql.toLowerCase().startsWith("select"))
    throw new Error("Unsafe query generated");

  return sql;
}

// Execute safe SQL
async function runSQL(sql) {
  // Only allow querying public.profiles
  if (!sql.toLowerCase().includes("profiles")) return [];

  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, created_at");

  if (error) throw error;
  return data;
}

// Creative response using DB data
async function creativeReply(question, dbData) {
  const prompt = `
You are a friendly AI assistant.
User: ${question}
Database result: ${JSON.stringify(dbData)}
Respond conversationally and creatively.
`;

  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return getText(res);
}

// Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== "string")
      return res.status(400).json({ error: "Message required as a string" });

    const useDB = await needsDatabase(message);

    if (!useDB) {
      // Direct chat (no DB)
      const response = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: message }] }],
      });
      return res.json({ reply: getText(response) });
    }

    // Generate SQL safely
    const sql = await generateSQL(message);

    // Fetch data
    const dbData = await runSQL(sql);

    // Creative final answer
    const reply = await creativeReply(message, dbData);

    res.json({ reply, debug: { sql, dbData } });
  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Gemini Supabase Chatbot running")
);
