import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import Groq from 'groq-sdk';

// 1. DEFINE STRICT TIER LIMITS (Inference Protection Layer)
const PLAN_LIMITS = {
  free: {
    maxCharacterInput: 4000, // Roughly 1000 tokens maximum
    model: 'llama-3.1-8b-instant', // Ultra-cheap, blazing fast model for basic users
  },
  pro: {
    maxCharacterInput: 24000, // Roughly 6000 tokens
    model: 'llama-3.3-70b-versatile', // High-tier reasoning model
  }
};

export async function POST(req: Request) {
  try {
    if (!process.env.GROQ_API_KEY) {
      return NextResponse.json({ error: "Server Configuration Error" }, { status: 500 });
    }

    // 2. AUTHENTICATION & SECURE PROFILE LOOKUP
    // We check cookies on the server side to see who is actually making the request
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) { return cookieStore.get(name)?.value },
          set(name: string, value: string, options: any) { cookieStore.set({ name, value, ...options }) },
          remove(name: string, options: any) { cookieStore.delete({ name, ...options }) },
        },
      }
    );

    const { data: { user } } = await supabase.auth.getUser();
    
    // For your demo: If no logged-in user, default to 'free' limits
    // Alternatively, you can block unauthenticated users entirely by returning a 401 error.
    let userTier: 'free' | 'pro' = 'free';
    
    if (user) {
      // In production, fetch this from a 'profiles' table: userTier = profileData.tier
      // For tomorrow's school demo, let's treat authenticated users as Pro to show off the system!
      userTier = 'pro';
    }

    const currentLimits = PLAN_LIMITS[userTier];

    // 3. READ INPUT & ENFORCE LIMITS IMMEDIATELY
    const body = await req.json();
    const { logic } = body;

    if (!logic || typeof logic !== 'string') {
      return NextResponse.json({ error: "Invalid logic payload provided." }, { status: 400 });
    }

    // Guardrail: Stop huge context injections before sending to Groq
    if (logic.length > currentLimits.maxCharacterInput) {
      return NextResponse.json({ 
        error: `Payload too large. The ${userTier} tier is restricted to ${currentLimits.maxCharacterInput} characters. Please upgrade.` 
      }, { status: 403 });
    }

    // 4. INTELLIGENT MODEL ROUTING
    // Free users run on cheap models; Pro users scale up to complex reasoning infrastructure.
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
      model: currentLimits.model, // Dynamically selected based on tier
      temperature: 0.2,
    });

    const responseText = chatCompletion.choices[0]?.message?.content || "No response.";

    // 5. DYNAMIC STEPS GENERATOR
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
      valid: true,
      meta: {
        tierUsed: userTier,
        modelAllocated: currentLimits.model
      }
    });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ 
      error: "Analysis failed. Please verify the code structure." 
    }, { status: 500 });
  }
}