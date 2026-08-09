/**
 * Minimal generated-equivalent Supabase schema for the scan history boundary.
 *
 * The production schema generator is not part of this repository, so this
 * checked-in contract keeps the persistence adapter typed and reproducible in
 * local, CI, and deployment environments. Regenerate this file from the
 * authoritative Supabase schema when the scan_history table changes.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          user_id: string
          tier: string
        }
        Insert: {
          user_id?: string
          tier?: string
        }
        Update: {
          user_id?: string
          tier?: string
        }
        Relationships: []
      }
      conversations: {
        Row: {
          id: string
          user_id: string
          title: string
          pinned: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id?: string
          title?: string
          pinned?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          title?: string
          pinned?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          id: string
          conversation_id: string
          user_id: string
          content: string
          role: string
          created_at: string
        }
        Insert: {
          id?: string
          conversation_id?: string
          user_id?: string
          content?: string
          role?: string
          created_at?: string
        }
        Update: {
          id?: string
          conversation_id?: string
          user_id?: string
          content?: string
          role?: string
          created_at?: string
        }
        Relationships: []
      }
      scan_history: {
        Row: {
          id: string
          project_id: string
          user_id: string
          created_at: string
          execution_profile_used: string
          active_plugins: Json
          model_config_used: Json
          ast_context: Json
          scan_size_bytes: number
          files_scanned_count: number
          skipped_files_count: number
          findings_list: Json
          overall_risk: string
          performance: Json
          swarm_execution_data: Json | null
        }
        Insert: {
          id?: string
          project_id?: string
          user_id?: string
          created_at?: string
          execution_profile_used?: string
          active_plugins?: Json
          model_config_used?: Json
          ast_context?: Json
          scan_size_bytes?: number
          files_scanned_count?: number
          skipped_files_count?: number
          findings_list?: Json
          overall_risk?: string
          performance?: Json
          swarm_execution_data?: Json | null
        }
        Update: {
          id?: string
          project_id?: string
          user_id?: string
          created_at?: string
          execution_profile_used?: string
          active_plugins?: Json
          model_config_used?: Json
          ast_context?: Json
          scan_size_bytes?: number
          files_scanned_count?: number
          skipped_files_count?: number
          findings_list?: Json
          overall_risk?: string
          performance?: Json
          swarm_execution_data?: Json | null
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
