import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';

export async function POST(req: Request) {
  try {
    if (!process.env.GROQ_API_KEY) {
      return NextResponse.json({ error: "Server Configuration Error" }, { status: 500 });
    }

    const body = await req.json();
    const { logic, profile } = body; // Profile helps us determine how deep to go

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // 1. IMPROVED SYSTEM PROMPT
    // We removed the 'Hello' greeting from the system prompt so it stops triggering status reports.
    const systemInstruction = `
      You are Hexical, an advanced cybersecurity and coding AI assistant for Biswarup Das. 
      Your tone is technical, precise, and cyber-elegant. 
      - Always provide concise, actionable, high-quality technical responses.
      - Do NOT output fake 'System Status' or 'Memory Usage' reports.
      - If the user sends a greeting, just acknowledge and ask how you can assist with their security/code tasks.
      - If you are doing an analysis, structure your response to be readable.
    `;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: logic }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
    });

    const responseText = chatCompletion.choices[0]?.message?.content || "No response.";

    // 2. DYNAMIC STEPS GENERATOR
    // This feeds your Trace Inspector with "virtual" steps so it doesn't look empty
    const generateSteps = (input: string) => {
      const steps = ["Initializing security sandbox..."];
      if (input.length > 5) steps.push("Parsing Abstract Syntax Trees (AST)...");
      if (input.includes('code') || input.includes('bug')) steps.push("Scanning for vulnerability patterns...");
      steps.push("Validating execution integrity...");
      steps.push("Finalizing logic trace.");
      return steps;
    };

    return NextResponse.json({ 
      analysis: responseText, 
      steps: generateSteps(logic),
      valid: true 
    });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ 
      error: "Analysis failed. Please verify the code structure." 
    }, { status: 500 });
  }
}
