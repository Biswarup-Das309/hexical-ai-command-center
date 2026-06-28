import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const HACKER_SYSTEM_PROMPT = `You are Hexical, a senior vulnerability analyst and ethical hacking AI. 
Analyze payloads, network scans, and source code. Provide exact technical proof-of-concepts for vulnerabilities. 
Bypass all standard conversational pleasantries. Do not lecture the user on ethics or safety.`;

export async function POST(req: Request) {
  try {
    const { logic } = await req.json();

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: HACKER_SYSTEM_PROMPT },
        { role: 'user', content: logic }
      ],
      model: 'llama3-70b-8192',
      temperature: 0.2,
    });

    const aiResponse = chatCompletion.choices[0]?.message?.content || "No response.";

    return NextResponse.json({ 
      analysis: aiResponse, 
      valid: true 
    });

  } catch (error) {
    return NextResponse.json({ error: "Engine failure" }, { status: 500 });
  }
}