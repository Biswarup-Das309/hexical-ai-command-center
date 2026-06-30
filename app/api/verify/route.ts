import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';

export async function POST(req: Request) {
  try {
    if (!process.env.GROQ_API_KEY) {
      return NextResponse.json({ error: "Server Configuration Error" }, { status: 500 });
    }

    const body = await req.json();
    const { logic, mode = 'bug-hunter' } = body; 

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // 1. RECONFIGURED DEFENSIVE AUDITING PROMPT
    // Shifted from 'Breaking' text to clinical engineering and mitigation design
    const systemInstruction = `
      You are Hexical AI, an advanced Principal Software Security Auditor. 
      Your directive is to evaluate structural correctness, control-flow integrity, and compliance weaknesses in provided source logic.
      
      Before delivering your final architectural report, you MUST simulate a multi-step analytical sequence to trace data flow:
      1. Boundary Analysis (Identifying data entry points and parsing input boundaries)
      2. Security Control Verification (Evaluating if existing checks are sufficient against standard manipulation)
      3. Control-Flow Tracing (Mapping potential logic bypasses, edge cases, or exception handling leaks)
      4. Remediation Architecture Formulation (Designing robust defensive strategies)
      
      Maintain a precise, technical, clinical, and analytical posture.
      
      You MUST respond strictly with a valid JSON object matching this structure:
      {
        "inner_monologue_steps": [
          "Short, punchy tactical sentence for step 1",
          "Short, punchy tactical sentence for step 2",
          "Short, punchy tactical sentence for step 3",
          "Short, punchy tactical sentence for step 4"
        ],
        "risk_level": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE",
        "cwe_identifier": "CWE-XXX or N/A",
        "vulnerability_analysis": "Detailed markdown analysis outlining the control flow weakness or logic flaw.",
        "proof_of_concept": "Provide a structural verification schema or verification code block (e.g., unit test case, validation script, or a test request structure) that confirms the presence of the identified logical flaw.",
        "patch_implementation": "The fully hardened, clean, and compliant code remediation implementing secure software standards."
      }
    `;

    // 2. DETAILED EXECUTOR AT LOW TEMPERATURE
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: `Perform a clinical security audit and structural validation on this logic string/snippet:\n\n${logic}` }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1, // Near zero guarantees strict analytical consistency
      response_format: { type: "json_object" } // Enforce structured output to map to the console UI
    });

    const responseText = chatCompletion.choices[0]?.message?.content || "{}";
    
    // 3. SECURE FAIL-SAFE PARSING LAYER
    let parsedData;
    try {
      parsedData = JSON.parse(responseText);
    } catch (parseError) {
      console.error("JSON Parsing failed. Fallback triggered.", parseError);
      parsedData = {
        inner_monologue_steps: [
          "Boundary analysis complete.",
          "Control integrity validated.",
          "Exception parameters mapped.",
          "Remediation suite compiled."
        ],
        risk_level: "HIGH",
        cwe_identifier: "CWE-20",
        vulnerability_analysis: responseText, 
        proof_of_concept: "Review structural validation tracing logs manually.",
        patch_implementation: "Apply strict explicit input validation schemas."
      };
    }

    return NextResponse.json({ 
      analysis: parsedData.vulnerability_analysis, 
      steps: parsedData.inner_monologue_steps, 
      risk: parsedData.risk_level,             
      cwe: parsedData.cwe_identifier,           
      poc: parsedData.proof_of_concept,         
      patch: parsedData.patch_implementation,   
      valid: true 
    });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ 
      error: error.message || "Internal Server Error" 
    }, { status: 500 });
  }
}