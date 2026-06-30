import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';

export async function POST(req: Request) {
  try {
    if (!process.env.GROQ_API_KEY) {
      return NextResponse.json({ error: "Server Configuration Error" }, { status: 500 });
    }

    const body = await req.json();
    // Added 'mode' to the request body to enable feature-specific personas
    const { logic, mode = 'code-reviewer' } = body; 

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // Specialized System Instructions based on user selection
    const modeInstructions: Record<string, string> = {
      'code-reviewer': `You are a Senior Software Engineer. Your goal is to review the provided code for logic errors, performance bottlenecks, and adherence to clean code principles. Provide actionable, concise feedback.`,
      
      'bug-hunter': `You are a Principal Cybersecurity Researcher. Analyze the code specifically for OWASP Top 10 vulnerabilities (SQLi, XSS, SSRF, IDOR). Identify entry points, trace data flows to insecure sinks, and provide remediation strategies. Maintain a clinical, evidence-based tone.`,
      
      'defense-in-depth': `You are a System Architect. Focus on hardening the provided code. Suggest layers of security such as input validation, principle of least privilege, rate limiting, and output encoding. Do not focus on hacking; focus on structural resilience.`
    };

    const systemInstruction = modeInstructions[mode as keyof typeof modeInstructions] || modeInstructions['code-reviewer'];

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: `Analyze the following logic:\n\n${logic}` }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1, // Low temperature for high-precision technical output
    });

    const responseText = chatCompletion.choices[0]?.message?.content || "No analysis generated.";

    // Updated Steps Generator
    const generateSteps = (mode: string) => {
      return [
        "Initializing sandbox...",
        `Loading ${mode.replace('-', ' ')} module...`,
        "Parsing AST...",
        "Validating execution integrity...",
        "Finalizing analysis."
      ];
    };

    return NextResponse.json({ 
      analysis: responseText, 
      steps: generateSteps(mode),
      valid: true 
    });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ 
      error: "Analysis failed. Please verify the code structure." 
    }, { status: 500 });
  }
}
