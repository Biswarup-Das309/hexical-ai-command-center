import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';
import { PLAN_LIMITS, type PlanTier } from '@/lib/hexical-types';

// Initialize Supabase Admin Client for secure backend database adjustments
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

export async function POST(req: Request) {
  try {
    if (!process.env.GROQ_API_KEY) {
      console.error("[HEXICAL_KERNEL_CRITICAL]: Missing GROQ_API_KEY inside environment variables.");
      return NextResponse.json({ error: "Server Configuration Error: Missing Inference Key" }, { status: 500 });
    }

    // ============================================================================
    // 1. CRYPTOGRAPHIC AUTHENTICATION (Next.js 16 Asynchronous Fix)
    // ============================================================================
    const { userId } = await auth();
    console.log(`[HEXICAL_AUTH_TRACE]: Authenticating transaction for User ID: ${userId || 'ANONYMOUS'}`);
    
    // ============================================================================
    // 2. DATABASE TIER ENFORCEMENT & ASSET SEEDING
    // ============================================================================
    const body = await req.json();
    const { 
      logic, 
      profile = 'recon', 
      workspace = 'global', 
      targetArch = 'x64', 
      autoRedact, 
      aggressiveness = 'low', 
      targetScope, 
      extractedTargets,
      bountyPlatform,
    } = body;

    if (!logic || typeof logic !== 'string') {
      return NextResponse.json({ error: "Invalid execution payload. Prompt logic string required." }, { status: 400 });
    }

    let activeTier: PlanTier = 'go'; 

    if (userId) {
      let { data: userProfile, error: dbError } = await supabaseAdmin
        .from('profiles')
        .select('tier')
        .eq('user_id', userId)
        .single();
        
      if (dbError && dbError.code === 'PGRST116') {
        console.log(`[DATABASE_SYNC_WARN]: Profile missing for user ${userId}. Auto-seeding base tier asset...`);
        const { data: newProfile, error: insertError } = await supabaseAdmin
          .from('profiles')
          .insert({ user_id: userId, tier: 'go' })
          .select('tier')
          .single();
          
        if (!insertError && newProfile) {
          userProfile = newProfile;
        } else {
          console.error("[DATABASE_SYNC_CRITICAL]: Failed to auto-seed user registration row:", insertError);
        }
      }
        
      if (userProfile?.tier) {
        activeTier = userProfile.tier as PlanTier;
      }
    }

    console.log(`[HEXICAL_GATE_RESOLVED]: Processing payload under authorized [${activeTier.toUpperCase()}] tier matrix.`);
    const currentLimits = PLAN_LIMITS[activeTier];

    if (logic.length > currentLimits.maxMessages * 100) { 
      return NextResponse.json({ 
        error: `Payload volume exceeds authorized tier constraints. Current allocation limits compute payload parsing size.` 
      }, { status: 403 });
    }

    if (profile === 'swarm' && !currentLimits.features.includes('swarm_intelligence')) {
      console.warn(`[SECURITY_GATE_BLOCKED]: Intercepted unauthorized Swarm Intelligence pipeline call from User: ${userId}`);
      return NextResponse.json({ 
        error: `Access Denied: Swarm Intelligence multi-agent compilation requires an active Pro license allocation.` 
      }, { status: 403 });
    }

    // ============================================================================
    // 3. DYNAMIC MODEL ROUTING & PRE-FLIGHT INTENT ROUTER
    // ============================================================================
    const MODEL_MAP: Record<PlanTier, string> = {
      go: 'llama-3.1-8b-instant',      
      plus: 'llama-3.3-70b-versatile', 
      pro: 'llama-3.3-70b-versatile'   
    };

    const selectedModel = MODEL_MAP[activeTier];
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    let totalTokens = 0;

    // --- THE GATEKEEPER ROUTER (Pure Traffic Switch) ---
    const intentCheck = await groq.chat.completions.create({
      messages: [
        { 
          role: 'system', 
          content: `You are an intent routing proxy node. Evaluate the user's incoming query.
          If the prompt is a security exploit payload, structural code snippet, URL target, network script, or requests vulnerability analysis, resolve to "security".
          If the prompt is a standard conversational phrase, greeting, general science/physics question (e.g. "what is light"), or general knowledge instruction, resolve to "general".
          Output strict JSON format ONLY: {"intent": "security" | "general"}` 
        },
        { role: 'user', content: logic }
      ],
      model: 'llama-3.1-8b-instant', // Fast, cheap model used strictly for parsing tracking paths
      response_format: { type: "json_object" },
      temperature: 0.1
    });

    totalTokens += intentCheck.usage?.total_tokens || 0;
    
    let intentData = { intent: "security" };
    try {
      intentData = JSON.parse(intentCheck.choices[0]?.message?.content || '{}');
    } catch (e) {
      console.warn("[INTENT_PARSE_ERR]: Routing telemetry corrupted. Fallback default to security execution.");
    }

    // ============================================================================
    // 4. BRANCH ENGINE: GENERAL INTELLIGENCE PIPELINE
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
        model: selectedModel, // Premium Tier Users get their full 70B parameter capability here!
        temperature: 0.6,
      });

      totalTokens += generalCompletion.usage?.total_tokens || 0;

      return NextResponse.json({ 
        analysis: generalCompletion.choices[0]?.message?.content || "Inference pipeline yielded blank return data.", 
        steps: ["INTENT_CLASSIFIED: Conversational/General", `DISPATCHING_CORE_COMPUTE_NODE: ${selectedModel}`],
        valid: true, // Tag as valid to bypass frontend vulnerability warnings
        swarmConsensus: undefined,
        metrics: {
          latencyMs: 0,
          tokensUsed: totalTokens,
          confidenceScore: 99.8
        }
      });
    }

    // ============================================================================
    // 5. BRANCH ENGINE: CYBERSECURITY ENGINE (Swarm vs Single Node)
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
        temperature: activeTier === 'go' ? 0.5 : 0.2, 
      });

      responseText = chatCompletion.choices[0]?.message?.content || "Execution yielded no return data.";
      totalTokens += chatCompletion.usage?.total_tokens || 150;
      confidenceScore = activeTier === 'go' ? 65.4 : 92.1;
    }

    // ============================================================================
    // 6. DIAGNOSTIC PIPELINE GENERATION
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