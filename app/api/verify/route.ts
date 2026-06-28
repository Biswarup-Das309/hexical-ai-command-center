import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';

export async function POST(req: Request) {
  try {
    // 1. Verify the key exists at runtime
    if (!process.env.GROQ_API_KEY) {
      console.error("CRITICAL: GROQ_API_KEY is undefined in environment variables.");
      return NextResponse.json({ error: "Server Configuration Error: API Key missing" }, { status: 500 });
    }

    // 2. Safely parse JSON
    let body;
    try {
      body = await req.json();
    } catch (e) {
      console.error("CRITICAL: Failed to parse request JSON");
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { logic } = body;
    console.log("DEBUG: Logic received:", logic);

    // 3. Init Groq
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // 4. Execute using a currently supported model
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: "You are Hexical, a vulnerability analyst." },
        { role: 'user', content: logic }
      ],
      model: 'llama-3.3-70b-versatile', // Updated to supported model
      temperature: 0.2,
    });

    return NextResponse.json({ 
      analysis: chatCompletion.choices[0]?.message?.content || "No response.", 
      valid: true 
    });

  } catch (error: any) {
    // Debug logging remains enabled to help you track issues
    console.error("--- BACKEND CRASH DETECTED ---");
    console.error("Error Name:", error.name);
    console.error("Error Message:", error.message);
    console.error("Stack Trace:", error.stack); 
    
    return NextResponse.json({ 
      error: error.message || "Internal Server Error" 
    }, { status: 500 });
  }
}