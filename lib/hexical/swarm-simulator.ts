import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentRoleType, ConsensusVote, DebateRound } from '@/lib/hexical/types'

interface SimulationStep {
  delay: number
  agent?: AgentRoleType
  action?: string
  round?: Omit<DebateRound, 'timestampMs'>
  votes?: ConsensusVote[]
}

const MOCK_DEBATE_SCRIPT: SimulationStep[] = [
  { delay: 1000, agent: 'planner', action: 'START_PLANNING' },
  { delay: 2500, agent: 'coordinator', action: 'DISPATCH_AGENTS' },
  {
    delay: 4500,
    agent: 'red_team_exploit',
    round: {
      roundNumber: 1,
      proposingAgentId: 'red-1' as DebateRound['proposingAgentId'],
      proposingAgentRole: 'red_team_exploit',
      argument:
        'CRITICAL: Discovered latent command injection vulnerability in the input interpolation workflow. The `child_process.exec` wrapper fails to sanitize shell metacharacters before execution.',
      evidenceASTNodeIds: ['node_8f4a2b', 'node_9c1f3e'],
      concessionMade: false,
    },
  },
  { delay: 6000, agent: 'blue_team_defense', action: 'ANALYZING' },
  {
    delay: 8500,
    agent: 'blue_team_defense',
    round: {
      roundNumber: 2,
      proposingAgentId: 'blue-1' as DebateRound['proposingAgentId'],
      proposingAgentRole: 'blue_team_defense',
      argument:
        'Validating exploit path. Generating patch to replace `exec` with `spawn` to prevent subshell interpolation entirely, alongside a strict regex whitelist for the input parameters.',
      evidenceASTNodeIds: ['node_9c1f3e'],
      concessionMade: true,
    },
  },
  { delay: 10500, agent: 'red_team_exploit', action: 'VERIFYING_PATCH' },
  {
    delay: 13000,
    agent: 'consensus_engine',
    action: 'VOTING',
    votes: [
      {
        agentId: 'red-1' as ConsensusVote['agentId'],
        role: 'red_team_exploit',
        vote: 'SECURE',
        rationale: 'Bypass attempts mitigated. Shell execution isolated.',
      },
      {
        agentId: 'blue-1' as ConsensusVote['agentId'],
        role: 'blue_team_defense',
        vote: 'SECURE',
        rationale: 'Patch deployed successfully in sandbox.',
      },
    ],
  },
  { delay: 15000, action: 'COMPLETE' },
]

export function useSwarmSimulator() {
  const [isExecuting, setIsExecuting] = useState(false)
  const [activeAgent, setActiveAgent] = useState<AgentRoleType>()
  const [debateRounds, setDebateRounds] = useState<DebateRound[]>([])
  const [votes, setVotes] = useState<ConsensusVote[]>([])

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const runIdRef = useRef(0)

  const stopSimulation = useCallback(() => {
    // Invalidate every pending callback.
    runIdRef.current++

    timersRef.current.forEach(clearTimeout)
    timersRef.current = []

    setIsExecuting(false)
    setActiveAgent(undefined)
  }, [])

  const startSimulation = useCallback(() => {
    stopSimulation()

    // Create a unique ID for this run.
    const currentRunId = ++runIdRef.current

    setIsExecuting(true)
    setDebateRounds([])
    setVotes([])
    setActiveAgent('planner')

    MOCK_DEBATE_SCRIPT.forEach((step) => {
      const timer = setTimeout(() => {
        // Ignore stale callbacks from previous runs.
        if (currentRunId !== runIdRef.current) {
          return
        }

        if (step.agent) {
          setActiveAgent(step.agent)
        }

        if (step.round) {
          setDebateRounds((prev) => [
            ...prev,
            {
              ...step.round,
              timestampMs: Date.now(),
            } as DebateRound,
          ])
        }

        if (step.votes) {
          setVotes(step.votes)
        }

        if (step.action === 'COMPLETE') {
          setIsExecuting(false)
          setActiveAgent(undefined)
        }
      }, step.delay)

      timersRef.current.push(timer)
    })
  }, [stopSimulation])

  useEffect(() => {
    return () => {
      runIdRef.current++

      timersRef.current.forEach(clearTimeout)
      timersRef.current = []
    }
  }, [])

  return {
    isExecuting,
    activeAgent,
    debateRounds,
    votes,
    startSimulation,
    stopSimulation,
  }
}