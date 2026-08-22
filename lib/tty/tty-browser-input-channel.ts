'use client'

import type { RealtimeChannel } from '@supabase/supabase-js'
import { createSupabaseClient } from '@/lib/supabase'
import type { TTYSessionInputBroadcastPayload } from './tty-session-input-channel'
import { TTY_SESSION_INPUT_BROADCAST_EVENT } from './tty-session-input-channel'

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

export interface TTYBrowserInputChannel {
  send(payload: TTYSessionInputBroadcastPayload): Promise<void>
  close(): void
}

export async function connectTTYBrowserInputChannel(channelName: string): Promise<TTYBrowserInputChannel> {
  const channel: RealtimeChannel = createSupabaseClient().channel(channelName)
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
