import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Correct env key
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

function getText(res) {
  return res.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

/**
 * Schema: public.profiles
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

async function needsDatabase(question) {
  const prompt = `Reply ONLY "DB" or "CHAT". Question: "${question}"`;
  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
  return getText(res).toUpperCase().includes("DB");
}

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

  let sql = getText(res).trim().replace(/```sql|```/g, "");
  if (!sql.toLowerCase().startsWith("select"))
    throw new Error("Unsafe query");

  return sql;
}

async function runSQL(sql) {
  if (sql.toLowerCase().includes("profiles")) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, role, created_at");

    if (error) throw error;
    return data;
  }
  return [];
}

async function creativeReply(question, dbData) {
  const prompt = `
You are a friendly AI assistant.
User: ${question}
Database: ${JSON.stringify(dbData)}
Respond conversationally.
`;

  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return getText(res);
}

app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message required" });
    }

    const useDB = await needsDatabase(message);

    if (!useDB) {
      const response = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: message }] }],
      });
      return res.json({ reply: getText(response) });
    }

    const sql = await generateSQL(message);
    const dbData = await runSQL(sql);
    const reply = await creativeReply(message, dbData);

    res.json({ reply, debug: { sql, dbData } });
  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Gemini Supabase Chatbot running")
);
