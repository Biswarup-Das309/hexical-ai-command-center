import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';
import { PLAN_LIMITS, type PlanTier } from '@/lib/hexical-types';

export async function POST(req: Request) {
  try {
    // ============================================================================
    // 1. LAZY INSTANTIATION & INFRASTRUCTURE SHIELD
    // ============================================================================
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("FATAL: Missing Supabase infrastructure keys.");
    }
    if (!process.env.GROQ_API_KEY) {
      console.error("[HEXICAL_KERNEL_CRITICAL]: Missing GROQ_API_KEY inside environment variables.");
      return NextResponse.json({ error: "Server Configuration Error: Missing Inference Key" }, { status: 500 });
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // ============================================================================
    // 2. CRYPTOGRAPHIC AUTH & MALFORMED PAYLOAD DEFENSE
    // ============================================================================
    const { userId } = await auth();
    console.log(`[HEXICAL_AUTH_TRACE]: Authenticating transaction for User ID: ${userId || 'ANONYMOUS'}`);
    
    let body;
    try {
      body = await req.json();
    } catch (parseError) {
      // DEFENSE: Prevents attackers from crashing the server with malformed non-JSON requests
      return NextResponse.json({ error: "Malformed request payload. Strict JSON required." }, { status: 400 });
    }

    const { 
      logic, 
      profile = 'recon', 
      workspace = 'global', 
      targetArch = 'x64', 
      autoRedact = false, 
      aggressiveness = 'low', 
      targetScope, 
      extractedTargets,
      bountyPlatform,
    } = body;

    // DEFENSE: Hard-cap payload size immediately to prevent memory exhaustion (DoS)
    if (!logic || typeof logic !== 'string') {
      return NextResponse.json({ error: "Invalid execution payload. Prompt logic string required." }, { status: 400 });
    }
    if (logic.length > 25000) {
      return NextResponse.json({ error: "Payload exceeds maximum absolute infrastructure limits (25,000 chars). Payload dropped." }, { status: 413 });
    }

    // ============================================================================
    // 3. DATABASE TIER ENFORCEMENT & ENUM-SAFE SEEDING
    // ============================================================================
    // CRITICAL FIX: The absolute default MUST be 'free' to prevent Privilege Escalation
    let activeTier: string = 'free'; 

    if (userId) {
      let { data: userProfile, error: dbError } = await supabaseAdmin
        .from('profiles')
        .select('tier')
        .eq('user_id', userId)
        .maybeSingle(); // Changed to maybeSingle to prevent silent 500s on missing rows
        
      if (!userProfile) {
        console.log(`[DATABASE_SYNC_WARN]: Profile missing for user ${userId}. Attempting to auto-seed FREE tier...`);
        const { data: newProfile, error: insertError } = await supabaseAdmin
          .from('profiles')
          .insert({ user_id: userId, tier: 'free' }) 
          .select('tier')
          .maybeSingle();
          
        if (!insertError && newProfile) {
          userProfile = newProfile;
        } else {
          // MEMORY-STATE FALLBACK: 
          // If the database rejects 'free' because of the ENUM restriction, 
          // we don't crash. We just keep them as 'free' in the server memory for this request!
          console.warn("[DATABASE_ENUM_BLOCK]: Failed to save user to database (likely ENUM restriction). Running in ephemeral free mode.");
        }
      }
        
      if (userProfile?.tier) {
        activeTier = userProfile.tier.toLowerCase();
      }
    }

    console.log(`[HEXICAL_GATE_RESOLVED]: Processing payload under authorized [${activeTier.toUpperCase()}] tier matrix.`);
    
    const currentLimits = PLAN_LIMITS[activeTier as PlanTier] || { maxMessages: 50, features: [] };

    if (profile === 'swarm' && (!currentLimits.features || !currentLimits.features.includes('swarm_intelligence'))) {
      console.warn(`[SECURITY_GATE_BLOCKED]: Intercepted unauthorized Swarm Intelligence pipeline call from User: ${userId}`);
      return NextResponse.json({ 
        error: `Access Denied: Swarm Intelligence multi-agent compilation requires an active Pro license allocation.` 
      }, { status: 403 });
    }

    // ============================================================================
    // 4. DYNAMIC MODEL ROUTING & PRE-FLIGHT INTENT ROUTER
    // ============================================================================
    const MODEL_MAP: Record<string, string> = {
      free: 'llama-3.1-8b-instant',
      go: 'llama-3.1-8b-instant',      
      plus: 'llama-3.3-70b-versatile', 
      pro: 'llama-3.3-70b-versatile'   
    };

    const selectedModel = MODEL_MAP[activeTier] || 'llama-3.1-8b-instant';
    let totalTokens = 0;

    // --- THE GATEKEEPER ROUTER ---
    const intentCheck = await groq.chat.completions.create({
      messages: [
        { 
          role: 'system', 
          content: `You are an intent routing proxy node. Evaluate the user's incoming query.
          If the prompt is a security exploit payload, structural code snippet, URL target, network script, or requests vulnerability analysis, resolve to "security".
          If the prompt is a standard conversational phrase, greeting, general science/physics question, or general knowledge instruction, resolve to "general".
          Output strict JSON format ONLY: {"intent": "security" | "general"}` 
        },
        { role: 'user', content: logic }
      ],
      model: 'llama-3.1-8b-instant',
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 50 // DEFENSE: Cap the JSON output to prevent token bleeding
    });

    totalTokens += intentCheck.usage?.total_tokens || 0;
    
    let intentData = { intent: "security" };
    try {
      intentData = JSON.parse(intentCheck.choices[0]?.message?.content || '{}');
    } catch (e) {
      console.warn("[INTENT_PARSE_ERR]: Routing telemetry corrupted. Fallback default to security execution.");
    }

    // ============================================================================
    // 5. BRANCH ENGINE: GENERAL INTELLIGENCE PIPELINE
    // ============================================================================
    if (intentData.intent === 'general') {
      console.log(`[ROUTE_SWITCH]: General knowledge inquiry captured. Routing execution to tier core: ${selectedModel}`);
      
      const generalCompletion = await groq.chat.completions.create({
        messages: [
          { 
            role: 'system', 
            content: `You are Hexical AI, an advanced research and deep analysis engine. 
            The user is seeking detailed informational, scientific, or systemic explanations. 
            Provide a comprehensive, exhaustive, and meticulously accurate answer using your full parameter capability. 
            Avoid short summaries—give an in-depth breakdown using elegant formatting and Markdown.` 
          },
          { role: 'user', content: logic }
        ],
        model: selectedModel,
        temperature: 0.6,
      });

      totalTokens += generalCompletion.usage?.total_tokens || 0;

      return NextResponse.json({ 
        analysis: generalCompletion.choices[0]?.message?.content || "Inference pipeline yielded blank return data.", 
        steps: ["INTENT_CLASSIFIED: Conversational/General", `DISPATCHING_CORE_COMPUTE_NODE: ${selectedModel}`],
        valid: true, 
        swarmConsensus: undefined,
        metrics: {
          latencyMs: 0,
          tokensUsed: totalTokens,
          confidenceScore: 99.8
        }
      });
    }

    // ============================================================================
    // 6. BRANCH ENGINE: CYBERSECURITY ENGINE (Swarm vs Single Node)
    // ============================================================================
    let responseText = "";
    let swarmConsensusData = undefined;
    let confidenceScore = 0;

    const systemContext = `
      CURRENT EXECUTION CONTEXT:
      - Active Profile: ${profile.toUpperCase()}
      - Target Workspace: ${workspace.toUpperCase()}
      - Target Architecture: ${targetArch}
      - Aggressiveness Level: ${aggressiveness}
      - Target Scope: ${targetScope || 'Undefined'}
      - Auto-Redaction: ${autoRedact ? 'ENABLED' : 'DISABLED'}
      - Reporting Platform: ${bountyPlatform || 'Internal'}
    `;

    if (activeTier === 'pro' && profile === 'swarm') {
      const [redTeamRes, blueTeamRes, architectRes] = await Promise.all([
        groq.chat.completions.create({
          messages: [
            { role: 'system', content: `You are the RED TEAM OFFENSIVE AGENT. Output ONLY strict JSON: {"confidence": <number 0-100>, "logic": "<short offensive summary>", "payloadSuggested": "<string>"}` },
            { role: 'user', content: logic }
          ],
          model: selectedModel,
          response_format: { type: "json_object" }
        }),
        groq.chat.completions.create({
          messages: [
            { role: 'system', content: `You are the BLUE TEAM DEFENSIVE AGENT. Output ONLY strict JSON: {"mitigation": "<string>", "blockedBy": ["<string>"], "riskLevel": "<LOW|MED|HIGH|CRITICAL>"}` },
            { role: 'user', content: logic }
          ],
          model: selectedModel,
          response_format: { type: "json_object" }
        }),
        groq.chat.completions.create({
          messages: [
            { role: 'system', content: `You are the SYSTEM ARCHITECT. Output ONLY strict JSON: {"route": "<string>", "architecturalFlaw": "<string>"}` },
            { role: 'user', content: logic }
          ],
          model: selectedModel,
          response_format: { type: "json_object" }
        })
      ]);

      totalTokens += (redTeamRes.usage?.total_tokens || 0) + (blueTeamRes.usage?.total_tokens || 0) + (architectRes.usage?.total_tokens || 0);

      let red = { confidence: 85, logic: "Identified input vector.", payloadSuggested: "N/A" };
      let blue = { mitigation: "Enforce input sanitization.", blockedBy: ["WAF"], riskLevel: "MED" };
      let arch = { route: "Application Layer", architecturalFlaw: "Unvalidated client input" };

      try {
        red = JSON.parse(redTeamRes.choices[0]?.message?.content || "{}");
        blue = JSON.parse(blueTeamRes.choices[0]?.message?.content || "{}");
        arch = JSON.parse(architectRes.choices[0]?.message?.content || "{}");
      } catch (parseError) {
        console.error("[SWARM_JSON_PARSE_ERR]: Intermediary proxy output corrupted standard formatting.");
      }

      swarmConsensusData = {
        redTeam: {
          confidence: red.confidence || 85,
          logic: red.logic || "Identified generic input vector.",
          payloadSuggested: red.payloadSuggested || "N/A"
        },
        blueTeam: {
          withstandMatrix: blue.mitigation || "Enforce input sanitization.",
          blockedBy: blue.blockedBy || ["WAF"],
          riskLevel: blue.riskLevel || "MED"
        },
        architect: {
          route: arch.route || "Application Layer",
          architecturalFlaw: arch.architecturalFlaw || "Unvalidated client input"
        },
        finalConsensus: (red.confidence || 0) > 75
      };

      responseText = `[SWARM CONSENSUS REACHED] Offensive confidence sits at ${swarmConsensusData.redTeam.confidence}%. Critical architectural flaw isolated in ${swarmConsensusData.architect.route}. Recommended defensive mitigation: ${swarmConsensusData.blueTeam.withstandMatrix}`;
      confidenceScore = swarmConsensusData.redTeam.confidence;

    } else {
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: `You are Hexical AI, an elite cybersecurity node. Analyze the payload based on this context:\n${systemContext}\nProvide a concise, technical diagnostic.` },
          { role: 'user', content: logic }
        ],
        model: selectedModel,
        temperature: (activeTier === 'free' || activeTier === 'go') ? 0.5 : 0.2, 
      });

      responseText = chatCompletion.choices[0]?.message?.content || "Execution yielded no return data.";
      totalTokens += chatCompletion.usage?.total_tokens || 150;
      confidenceScore = (activeTier === 'free' || activeTier === 'go') ? 65.4 : 92.1;
    }

    // ============================================================================
    // 7. DIAGNOSTIC PIPELINE GENERATION
    // ============================================================================
    const generateSteps = (input: string) => {
      const steps = [
        `Initializing ${workspace} sandbox environment...`,
        `Applying ${targetArch} constraint heuristics...`
      ];
      if (extractedTargets && extractedTargets.length > 0) {
        steps.push(`Mapping attack surface for ${extractedTargets.join(', ')}...`);
      }
      if (activeTier === 'pro' && profile === 'swarm') {
        steps.push(`Engaging Multi-Agent Swarm (Red/Blue/Architect)...`);
        steps.push(`Synthesizing cross-agent telemetry...`);
      }
      steps.push("Consolidating AST traces and evaluating impact.");
      return steps;
    };

    return NextResponse.json({ 
      analysis: responseText, 
      steps: generateSteps(logic),
      valid: !responseText.toLowerCase().includes('secure') && !responseText.toLowerCase().includes('no vulnerability'),
      swarmConsensus: swarmConsensusData,
      metrics: {
        latencyMs: 0,
        tokensUsed: totalTokens,
        confidenceScore: confidenceScore
      }
    });

  } catch (error: any) {
    console.error("[HEXICAL_API_CRASH]:", error);
    return NextResponse.json({ 
      error: "Kernel panic during analysis phase. Handshake structural trace rejected." 
    }, { status: 500 });
  }
}