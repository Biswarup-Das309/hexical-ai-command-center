'use client'

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import type { TTYSessionInputBroadcastPayload } from './tty-session-input-channel'
import { TTY_SESSION_INPUT_BROADCAST_EVENT } from './tty-session-input-channel'

const GLOBAL_BROWSER_CLIENT_KEY = '__hexical_tty_browser_supabase_client__'

type BrowserClient = SupabaseClient

function subscribeRealtimeChannel(channel: RealtimeChannel, channelName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.subscribe((status, error) => {
      if (status === 'SUBSCRIBED') resolve()
      else if (error) reject(error)
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
        reject(new Error(`Supabase realtime channel ${channelName} returned ${status}.`))
    })
  })
}

function browserClient(): BrowserClient {
  const global = globalThis as Record<string, unknown>
  const existing = global[GLOBAL_BROWSER_CLIENT_KEY]
  if (existing) return existing as BrowserClient
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  if (!url || !anonKey) throw new Error('Supabase browser realtime is not configured.')
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 100 } },
  })
  global[GLOBAL_BROWSER_CLIENT_KEY] = client
  return client
}

export interface TTYBrowserInputChannel {
  send(payload: TTYSessionInputBroadcastPayload): Promise<void>
  close(): void
}

export async function connectTTYBrowserInputChannel(channelName: string): Promise<TTYBrowserInputChannel> {
  const channel: RealtimeChannel = browserClient().channel(channelName)
  try {
    await subscribeRealtimeChannel(channel, channelName)
  } catch {
    await channel.unsubscribe()
    throw new Error('The live PTY input channel could not be opened.')
  }
  return {
    async send(payload) {
      const sendStatus = await channel.send({
        type: 'broadcast',
        event: TTY_SESSION_INPUT_BROADCAST_EVENT,
        payload,
      })
      if (sendStatus !== 'ok') throw new Error(`The live PTY input channel returned ${sendStatus}.`)
    },
    close() {
      void channel.unsubscribe()
    },
  }
}
